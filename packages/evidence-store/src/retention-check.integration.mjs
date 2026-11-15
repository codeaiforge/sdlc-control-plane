import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test, { after } from 'node:test';
import { RETENTION_WINDOW, expire } from './expire.mjs';
import { adminEnv, closeHarness, createTestDatabase, rolePassword } from './pg-harness.mjs';

// The retention check on a real PostgreSQL 16 server, as a real child process logged in as
// evidence_audit, under the trigger 0002 installs. received_at is the database's clock and no role
// but a superuser can set it, so aged rows are inserted by the superuser relative to the server's
// own clock, as expire.integration.mjs does. Every state it must find is made for real: a run that
// did not happen, a run that was refused, a row skipped under a held lock, and an owner disabling,
// replacing or dropping the guard. Fails without a server; never skips.

after(() => closeHarness());

// Distinctive values in every row, so a leak of an id, a key or a row value into any output shows.
const WORKSPACE = 'zq7-workspace-canary';
const CHANGE = 'zq7-change-canary';
const LEAKS = /zq7|CANARY|password|PostgresError|ECONNREFUSED/i;

const SCRIPT = new URL('./retention-check.mjs', import.meta.url).pathname;
const EXPIRE = new URL('./expire.mjs', import.meta.url).pathname;
const outputs = [];

function run(script, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { env: { PATH: process.env.PATH, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => {
      outputs.push(stdout, stderr);
      resolve({ code, stdout, stderr });
    });
  });
}

const check = (env) => run(SCRIPT, env);
const lines = ({ stdout }) => stdout.trimEnd().split('\n');
const line = (result, index) => lines(result)[index];

async function database(t) {
  const db = await createTestDatabase();
  t.after(() => db.dispose());
  return db;
}

// An envelope holding its payload, received `offset` past the window's edge ('49 hours' is 49
// hours past it, '-1 hour' an hour short of it).
const insertHeld = async (db, suffix, offset) =>
  (
    await db.admin`
      INSERT INTO evidence.evidence_envelope
        (envelope_version, workspace_id, change_id, received_at, evidence)
      VALUES ('evidence-envelope/0', ${WORKSPACE}, ${`${CHANGE}-${suffix}`},
              statement_timestamp() - ${RETENTION_WINDOW}::interval - ${offset}::interval,
              '{"result":{"pass":true}}'::jsonb)
      RETURNING id`
  )[0].id;

const CLEAN_TAIL = [
  'retention-check: cannot see deleted rows, redacted bytes still in dead tuples, WAL or backups, or any value the owner or a superuser rewrote, received_at included',
  'retention-check: no violation found',
];

// ---------------------------------------------------------------- AC-8: clean, then overdue

test('a clean store exits 0, reports the guard enabled and every count, and finds no violation', async (t) => {
  const db = await database(t);
  const empty = await check(db.env('evidence_audit'));
  assert.equal(empty.code, 0, empty.stderr);
  assert.equal(empty.stderr, '');
  assert.deepEqual(lines(empty), [
    'retention-check: guard trigger evidence_envelope_guard: enabled',
    'retention-check: payloads held past 2160 hours + 48 hours grace: 0 found',
    'retention-check: oldest payload still held: none held',
    'retention-check: redacted envelopes with no audit row: 0 found',
    'retention-check: redactions earlier than 2160 hours after receipt: 0 found',
    ...CLEAN_TAIL,
  ]);
  await insertHeld(db, 'young', '-2000 hours');
  const young = await check(db.env('evidence_audit'));
  assert.equal(young.code, 0);
  assert.equal(line(young, 2), 'retention-check: oldest payload still held: 160 hours');
});

test('a payload 47 hours past the window is held but not overdue; at 49 hours it is a missed run', async (t) => {
  const db = await database(t);
  await insertHeld(db, 'within-grace', '47 hours');
  const within = await check(db.env('evidence_audit'));
  assert.equal(within.code, 0);
  assert.equal(
    line(within, 1),
    'retention-check: payloads held past 2160 hours + 48 hours grace: 0 found',
  );
  assert.equal(line(within, 2), 'retention-check: oldest payload still held: 2207 hours');
  await insertHeld(db, 'missed', '49 hours');
  const missed = await check(db.env('evidence_audit'));
  assert.equal(missed.code, 1);
  assert.equal(
    line(missed, 1),
    'retention-check: payloads held past 2160 hours + 48 hours grace: 1 found',
  );
  assert.equal(line(missed, 2), 'retention-check: oldest payload still held: 2209 hours');
  assert.equal(line(missed, 6), 'retention-check: violation found: overdue-payload');
  // A run of expire clears it: both payloads are past the window.
  assert.deepEqual(await expire(db.connectAs('evidence_retention', { max: 1 })), {
    redacted: 2,
    batches: 1,
  });
  const after = await check(db.env('evidence_audit'));
  assert.equal(after.code, 0);
  assert.deepEqual(lines(after).slice(1, 5), [
    'retention-check: payloads held past 2160 hours + 48 hours grace: 0 found',
    'retention-check: oldest payload still held: none held',
    'retention-check: redacted envelopes with no audit row: 0 found',
    'retention-check: redactions earlier than 2160 hours after receipt: 0 found',
  ]);
});

test('a refused expire run leaves the payload overdue, and a good one clears it', async (t) => {
  const db = await database(t);
  await insertHeld(db, 'failed-run', '72 hours');
  const refused = await run(EXPIRE, db.env('evidence_app'));
  assert.deepEqual(refused, { code: 1, stdout: '', stderr: 'expire refused: not-retention\n' });
  const overdue = await check(db.env('evidence_audit'));
  assert.equal(overdue.code, 1);
  assert.equal(line(overdue, 6), 'retention-check: violation found: overdue-payload');
  assert.equal((await run(EXPIRE, db.env('evidence_retention'))).code, 0);
  assert.equal((await check(db.env('evidence_audit'))).code, 0);
});

// 2.5 SEC-1: expire skips a row another session holds locked and reports success. The check takes
// no lock, so it sees the skipped row while the lock is still held.
test('a row expire skipped under a held lock is reported overdue while the lock is held', async (t) => {
  const db = await database(t);
  await insertHeld(db, 'locked', '72 hours');
  await insertHeld(db, 'free', '72 hours');
  let release;
  const held = new Promise((resolve) => (release = resolve));
  let locked;
  const isLocked = new Promise((resolve) => (locked = resolve));
  const holder = db.admin.begin(async (tx) => {
    await tx`SELECT id FROM evidence.evidence_envelope WHERE change_id = ${`${CHANGE}-locked`} FOR UPDATE`;
    locked();
    await held;
  });
  await Promise.race([isLocked, holder]);
  try {
    assert.deepEqual(await expire(db.connectAs('evidence_retention', { max: 1 })), {
      redacted: 1,
      batches: 1,
    });
    const skipped = await check(db.env('evidence_audit'));
    assert.equal(skipped.code, 1);
    assert.equal(
      line(skipped, 1),
      'retention-check: payloads held past 2160 hours + 48 hours grace: 1 found',
    );
  } finally {
    release();
    await holder;
  }
  assert.deepEqual(await expire(db.connectAs('evidence_retention', { max: 1 })), {
    redacted: 1,
    batches: 1,
  });
  assert.equal((await check(db.env('evidence_audit'))).code, 0);
});

// ---------------------------------------------------------------- AC-9, AC-10: the owner's bypass

// 2.5 SEC-2, made for real in this test's throwaway database: the owner disables the trigger and
// redacts a young row itself, so no audit row is written and the window is not held.
test("an owner's bypass is found: guard disabled, then a redaction with no audit row and inside the window", async (t) => {
  const db = await database(t);
  const id = await insertHeld(db, 'bypassed', '-1000 hours');
  const owner = db.connectAs('evidence_owner', { max: 1 });
  await owner`ALTER TABLE evidence.evidence_envelope DISABLE TRIGGER evidence_envelope_guard`;
  const disabled = await check(db.env('evidence_audit'));
  assert.equal(disabled.code, 1);
  assert.equal(
    line(disabled, 0),
    'retention-check: guard trigger evidence_envelope_guard: disabled',
  );
  assert.equal(line(disabled, 6), 'retention-check: violation found: guard-disabled');
  assert.ok(!lines(disabled).includes('retention-check: no violation found'));

  await owner`
    UPDATE evidence.evidence_envelope SET evidence = NULL, redacted_at = received_at + interval '1 hour'
     WHERE id = ${id}`;
  const bypassed = await check(db.env('evidence_audit'));
  assert.equal(bypassed.code, 1);
  assert.deepEqual(lines(bypassed).slice(3, 5), [
    'retention-check: redacted envelopes with no audit row: 1 found',
    'retention-check: redactions earlier than 2160 hours after receipt: 1 found',
  ]);
  assert.equal(
    line(bypassed, 6),
    'retention-check: violation found: guard-disabled, unaudited-redaction, early-redaction',
  );

  await owner`ALTER TABLE evidence.evidence_envelope ENABLE TRIGGER evidence_envelope_guard`;
  const reenabled = await check(db.env('evidence_audit'));
  assert.equal(reenabled.code, 1);
  assert.equal(
    line(reenabled, 0),
    'retention-check: guard trigger evidence_envelope_guard: enabled',
  );
  assert.equal(
    line(reenabled, 6),
    'retention-check: violation found: unaudited-redaction, early-redaction',
  );
});

test('a replica-only, replaced or dropped guard is reported, and never as no violation', async (t) => {
  const db = await database(t);
  const owner = db.connectAs('evidence_owner', { max: 1 });
  const guardLine = async () => {
    const result = await check(db.env('evidence_audit'));
    return [result.code, line(result, 0), line(result, 6)];
  };
  await owner`ALTER TABLE evidence.evidence_envelope ENABLE REPLICA TRIGGER evidence_envelope_guard`;
  assert.deepEqual(await guardLine(), [
    1,
    'retention-check: guard trigger evidence_envelope_guard: disabled',
    'retention-check: violation found: guard-disabled',
  ]);
  await owner`ALTER TABLE evidence.evidence_envelope ENABLE ALWAYS TRIGGER evidence_envelope_guard`;
  assert.deepEqual(await guardLine(), [
    0,
    'retention-check: guard trigger evidence_envelope_guard: enabled',
    'retention-check: no violation found',
  ]);
  await owner`ALTER TABLE evidence.evidence_envelope ENABLE TRIGGER evidence_envelope_guard`;
  // A function that no longer holds the window, under the same name and oid.
  await owner`
    CREATE OR REPLACE FUNCTION evidence.guard_envelope_update() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
    AS $guard$ BEGIN RETURN NEW; END $guard$`;
  assert.deepEqual(await guardLine(), [
    1,
    'retention-check: guard trigger evidence_envelope_guard: replaced',
    'retention-check: violation found: guard-replaced',
  ]);
  await owner`DROP TRIGGER evidence_envelope_guard ON evidence.evidence_envelope`;
  assert.deepEqual(await guardLine(), [
    1,
    'retention-check: guard trigger evidence_envelope_guard: absent',
    'retention-check: violation found: guard-absent',
  ]);
});

// The trigger refuses a redaction while received_at >= now - window, so a legal one is strictly
// later than the window; exactly at it is early, a second past it is not. Rows inserted already
// redacted by the superuser, each with its audit row, so only the early count can move.
test('a redaction exactly 2160 hours after receipt is early; one a second later is not', async (t) => {
  const db = await database(t);
  const redactedAt = async (suffix, after) => {
    const [{ id }] = await db.admin`
      INSERT INTO evidence.evidence_envelope
        (envelope_version, workspace_id, change_id, received_at, redacted_at, evidence)
      VALUES ('evidence-envelope/0', ${WORKSPACE}, ${`${CHANGE}-${suffix}`},
              statement_timestamp() - interval '3000 hours',
              statement_timestamp() - interval '3000 hours' + ${after}::interval, NULL)
      RETURNING id`;
    await db.admin`
      INSERT INTO evidence.evidence_redaction (envelope_id, redacted_at, redacted_by)
      SELECT id, redacted_at, 'evidence_retention' FROM evidence.evidence_envelope WHERE id = ${id}`;
  };
  await redactedAt('at-window', '2160 hours');
  await redactedAt('past-window', '2160 hours 1 second');
  const result = await check(db.env('evidence_audit'));
  assert.equal(result.code, 1);
  assert.deepEqual(lines(result).slice(3, 5), [
    'retention-check: redacted envelopes with no audit row: 0 found',
    'retention-check: redactions earlier than 2160 hours after receipt: 1 found',
  ]);
  assert.equal(line(result, 6), 'retention-check: violation found: early-redaction');
});

// ---------------------------------------------------------------- AC-11: who reads

test('every other role, a superuser and an unreachable server are refused with exit 3 and nothing on stdout', async (t) => {
  const db = await database(t);
  await insertHeld(db, 'refused', '72 hours');
  for (const [env, code] of [
    [db.env('evidence_app'), 'not-audit'],
    [db.env('evidence_retention'), 'not-audit'],
    [db.env('evidence_owner'), 'not-audit'],
    [{ ...(await adminEnv()), PGDATABASE: db.name }, 'role-unsafe'],
    [{ ...db.env('evidence_audit'), PGPASSWORD: 'CANARY-wrong-password' }, 'database-unreachable'],
    [{ ...db.env('evidence_audit'), PGPORT: '1' }, 'database-unreachable'],
    [{ ...db.env('evidence_audit'), PGHOST: 'localhost' }, 'database-unreachable'],
  ]) {
    const result = await check(env);
    assert.deepEqual(
      result,
      { code: 3, stdout: '', stderr: `retention-check refused: ${code}\n` },
      code,
    );
  }
});

// As expire.integration.mjs: membership cannot be granted to the shared evidence_audit role (other
// test processes use it), so a disposable login role shows the refusal; it is dropped first.
test('a member of any role, or a role with an elevated attribute, is refused as role-unsafe', async (t) => {
  const db = await database(t);
  const name = `evidence_copy_${process.pid}_${Math.random().toString(16).slice(2, 10)}`;
  const role = db.admin(name);
  await db.admin.unsafe(
    `CREATE ROLE ${name} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${rolePassword(process.env.PGPASSWORD, name)}'`,
  );
  try {
    await db.admin`GRANT CONNECT ON DATABASE ${db.admin(db.name)} TO ${role}`;
    const env = {
      ...db.env('evidence_audit'),
      PGUSER: name,
      PGPASSWORD: rolePassword(process.env.PGPASSWORD, name),
    };
    assert.equal((await check(env)).stderr, 'retention-check refused: not-audit\n');
    await db.admin`GRANT evidence_audit TO ${role}`;
    assert.deepEqual(await check(env), {
      code: 3,
      stdout: '',
      stderr: 'retention-check refused: role-unsafe\n',
    });
    await db.admin`REVOKE evidence_audit FROM ${role}`;
    await db.admin.unsafe(`ALTER ROLE ${name} BYPASSRLS`);
    assert.equal((await check(env)).stderr, 'retention-check refused: role-unsafe\n');
  } finally {
    await db.admin`DROP OWNED BY ${role}`;
    await db.admin`DROP ROLE ${role}`;
  }
});

test('no output of any run above carried a row value, an id, a key, a password or a driver message', () => {
  assert.ok(outputs.length > 0, 'no run was recorded');
  for (const text of outputs) assert.doesNotMatch(text, LEAKS);
});
