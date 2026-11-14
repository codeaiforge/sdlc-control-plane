import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test, { after } from 'node:test';
import { ExpiryRefused, RETENTION_WINDOW, expire } from './expire.mjs';
import { loadMigrations, migrate } from './migrate.mjs';
import {
  closeHarness,
  createEmptyDatabase,
  createTestDatabase,
  rolePassword,
} from './pg-harness.mjs';
import { createPostgresEvidenceStore } from './postgres-store.mjs';

// The retention expiry job on a real PostgreSQL 16 server, logged in as evidence_retention, under
// the trigger 0002 installs. received_at is the database's clock and no role but a superuser can
// set it, so aged rows are inserted by the superuser relative to the server's own clock, or
// appended by the service role and then aged by the harness. Fails without a server; never skips.

after(() => closeHarness());

const WORKSPACE = 'payments-art';

async function database(t) {
  const db = await createTestDatabase();
  t.after(() => db.dispose());
  return db;
}

// An envelope received `offset` before the window's edge: '1 minute' is a minute past the window,
// '-1 minute' a minute short of it.
const insertAt = async (db, change_id, offset) =>
  (
    await db.admin`
      INSERT INTO evidence.evidence_envelope
        (envelope_version, workspace_id, change_id, received_at, evidence)
      VALUES ('evidence-envelope/0', ${WORKSPACE}, ${change_id},
              statement_timestamp() - ${RETENTION_WINDOW}::interval - ${offset}::interval,
              '{"result":{"pass":true}}'::jsonb)
      RETURNING id`
  )[0].id;

// `count` envelopes an hour past the window.
const insertAged = (db, count, prefix = 'PR-') => db.admin`
  INSERT INTO evidence.evidence_envelope
    (envelope_version, workspace_id, change_id, received_at, evidence)
  SELECT 'evidence-envelope/0', ${WORKSPACE}, ${prefix} || n,
         statement_timestamp() - ${RETENTION_WINDOW}::interval - interval '1 hour', '{}'::jsonb
    FROM generate_series(1, ${count}::int) AS n`;

const payloadOf = async (db, id) =>
  (await db.admin`SELECT evidence FROM evidence.evidence_envelope WHERE id = ${id}`)[0].evidence;

const count = async (db, table) =>
  (await db.admin`SELECT count(*)::int AS n FROM ${db.admin(`evidence.${table}`)}`)[0].n;

const eligible = async (db) =>
  (
    await db.admin`
      SELECT count(*)::int AS n FROM evidence.evidence_envelope
       WHERE redacted_at IS NULL AND received_at < statement_timestamp() - ${RETENTION_WINDOW}::interval`
  )[0].n;

const redactionsPerEnvelope = async (db) =>
  (
    await db.admin`
      SELECT count(*)::int AS n FROM evidence.evidence_redaction
       GROUP BY envelope_id HAVING count(*) > 1`
  ).length;

const refusedWith = (code) => (error) => error instanceof ExpiryRefused && error.code === code;

// ---------------------------------------------------------------- AC-1: the window

test('one run redacts the envelope a minute past the window and keeps the one a minute short of it', async (t) => {
  const db = await database(t);
  const old = await insertAt(db, 'PR-old', '1 minute');
  const young = await insertAt(db, 'PR-young', '-1 minute');
  assert.deepEqual(await expire(db.connectAs('evidence_retention', { max: 1 })), {
    redacted: 1,
    batches: 1,
  });
  assert.equal(await payloadOf(db, old), null);
  assert.deepEqual(await payloadOf(db, young), { result: { pass: true } });
});

// ---------------------------------------------------------------- AC-2, AC-3: redacts, re-runs

function auditQueries() {
  const text = readFileSync(new URL('../sql/audit-queries.sql', import.meta.url), 'utf8');
  const queries = {};
  for (const block of text.split(/^-- name: /m).slice(1)) {
    const [name, ...rest] = block.split('\n');
    queries[name.trim()] = rest.join('\n').trim();
  }
  return queries;
}

test('the job redacts and never deletes: one audit row per envelope, named for the retention role', async (t) => {
  const db = await database(t);
  await insertAged(db, 3);
  const young = await insertAt(db, 'PR-young', '-1 hour');
  const retention = db.connectAs('evidence_retention', { max: 1 });
  assert.deepEqual(await expire(retention), { redacted: 3, batches: 1 });
  assert.equal(await count(db, 'evidence_envelope'), 4, 'no row removed');
  assert.notEqual(await payloadOf(db, young), null);
  const audit = await db.admin`
    SELECT r.envelope_id, r.redacted_by, r.redacted_at = e.redacted_at AS same
      FROM evidence.evidence_redaction r JOIN evidence.evidence_envelope e ON e.id = r.envelope_id
     ORDER BY r.envelope_id`;
  assert.equal(audit.length, 3);
  for (const row of audit) {
    assert.equal(row.redacted_by, 'evidence_retention');
    assert.equal(row.same, true);
  }

  const [{ from, until }] = await db.admin`
    SELECT statement_timestamp() - interval '1 hour' AS from, statement_timestamp() + interval '1 hour' AS until`;
  const listed = await db
    .connectAs('evidence_audit', { max: 1 })
    .unsafe(auditQueries()['payloads-redacted'], [from, until]);
  assert.deepEqual(listed.map((row) => [row.change_id, row.redacted_by]).sort(), [
    ['PR-1', 'evidence_retention'],
    ['PR-2', 'evidence_retention'],
    ['PR-3', 'evidence_retention'],
  ]);

  // A second run over the same state: nothing to do, no trigger error, no new audit row.
  assert.deepEqual(await expire(retention), { redacted: 0, batches: 0 });
  assert.equal(await count(db, 'evidence_redaction'), 3);
});

test('three runs at once redact every eligible envelope exactly once', async (t) => {
  const db = await database(t);
  await insertAged(db, 300);
  const runs = await Promise.all(
    [1, 2, 3].map(() => expire(db.connectAs('evidence_retention', { max: 1 }), { batchSize: 10 })),
  );
  assert.equal(
    runs.reduce((sum, run) => sum + run.redacted, 0),
    300,
  );
  assert.equal(await count(db, 'evidence_redaction'), 300);
  assert.equal(await redactionsPerEnvelope(db), 0, 'no envelope redacted twice');
  assert.equal(await eligible(db), 0);
});

// Q-6's no-wait property (review cycle 1, S-2). Without SKIP LOCKED the batch waits on the held row
// until its statement timeout cancels it (57014); with it, the batch takes the others at once.
test('a row another session holds locked is skipped, not waited for, and a later run takes it', async (t) => {
  const db = await database(t);
  await insertAged(db, 5);
  const retention = db.connectAs('evidence_retention', { max: 1 });
  let release;
  const held = new Promise((resolve) => (release = resolve));
  let locked;
  const isLocked = new Promise((resolve) => (locked = resolve));
  const holder = db.admin.begin(async (tx) => {
    await tx`SELECT id FROM evidence.evidence_envelope ORDER BY id LIMIT 1 FOR UPDATE`;
    locked();
    await held;
  });
  await isLocked;
  const started = Date.now();
  try {
    assert.deepEqual(await expire(retention, { statementTimeoutMs: 1000 }), {
      redacted: 4,
      batches: 1,
    });
    assert.ok(Date.now() - started < 1000, 'no batch waited for the held row');
  } finally {
    release();
    await holder;
  }
  assert.deepEqual(await expire(retention), { redacted: 1, batches: 1 });
  assert.equal(await eligible(db), 0);
});

// ---------------------------------------------------------------- AC-4, AC-5: tombstones

test('a tombstone far past the window survives every run unchanged', async (t) => {
  const db = await database(t);
  const id = await insertAt(db, 'PR-ancient', '5000 hours');
  const retention = db.connectAs('evidence_retention', { max: 1 });
  await retention`UPDATE evidence.evidence_envelope SET evidence = NULL WHERE id = ${id}`;
  const before = (await db.admin`SELECT * FROM evidence.evidence_envelope WHERE id = ${id}`)[0];
  assert.equal(before.evidence, null);
  for (let run = 0; run < 2; run += 1)
    assert.deepEqual(await expire(retention), { redacted: 0, batches: 0 });
  assert.deepEqual(
    (await db.admin`SELECT * FROM evidence.evidence_envelope WHERE id = ${id}`)[0],
    before,
  );
  assert.equal(await count(db, 'evidence_redaction'), 1);
});

test("the job's tombstone is ADR-0002's, and a replay of the expired submission is a duplicate", async (t) => {
  const db = await database(t);
  const store = createPostgresEvidenceStore({
    sql: db.connectAs('evidence_app', { max: 1 }),
    requireWorkspace: true,
  });
  const submitter = {
    issuer: 'https://token.actions.githubusercontent.com',
    repository_owner_id: '65',
    repository_id: '74',
    run_id: '18203345671',
    run_attempt: '1',
    sha: 'a'.repeat(40),
    ref: 'refs/heads/main',
    event_name: 'push',
    workflow_ref: 'owner/repo/.github/workflows/gate.yml@refs/heads/main',
    job_workflow_ref: 'owner/repo/.github/workflows/gate.yml@refs/heads/main',
    job_workflow_sha: 'b'.repeat(40),
  };
  const record = {
    schema_version: 'evidence/0',
    change_id: 'PR-1',
    tier: 'T1',
    result: { pass: true },
  };
  await store.append(record, {
    workspace_id: WORKSPACE,
    policy_id: 'baseline@1',
    submitted_by: submitter,
  });
  assert.equal(await db.age({ workspace_id: WORKSPACE, change_id: 'PR-1' }), true);
  const [aged] = await store.list();

  assert.deepEqual(await expire(db.connectAs('evidence_retention', { max: 1 })), {
    redacted: 1,
    batches: 1,
  });
  const [tombstone] = await store.list();
  assert.equal(tombstone.evidence, null);
  assert.equal(typeof tombstone.redacted_at, 'string');
  assert.deepEqual(tombstone.submitted_by, {
    ...submitter,
    ref: null,
    event_name: null,
    workflow_ref: null,
    job_workflow_ref: null,
  });
  for (const field of [
    'envelope_version',
    'workspace_id',
    'received_at',
    'idempotency_key',
    'policy_id',
  ])
    assert.equal(tombstone[field], aged[field], field);
  const [{ change_id }] = await db.admin`SELECT change_id FROM evidence.evidence_envelope`;
  assert.equal(change_id, 'PR-1');

  const replay = await store.append(record, { workspace_id: WORKSPACE });
  assert.equal(replay.outcome, 'duplicate');
  assert.deepEqual(replay.envelope, tombstone);
  assert.equal(await count(db, 'evidence_envelope'), 1);
});

// ---------------------------------------------------------------- AC-9: bounded work

test('a backlog larger than one batch is expired in one run, a batch at a time', async (t) => {
  const db = await database(t);
  await insertAged(db, 25);
  assert.deepEqual(
    await expire(db.connectAs('evidence_retention', { max: 1 }), { batchSize: 10 }),
    { redacted: 25, batches: 3 },
  );
  assert.equal(await eligible(db), 0);
});

test('a batch that cannot finish is cancelled by its statement timeout, and a later run completes', async (t) => {
  const db = await database(t);
  await insertAged(db, 1);
  const retention = db.connectAs('evidence_retention', { max: 1 });
  let release;
  const held = new Promise((resolve) => (release = resolve));
  let locked;
  const isLocked = new Promise((resolve) => (locked = resolve));
  const holder = db.admin.begin(async (tx) => {
    await tx`LOCK TABLE evidence.evidence_envelope IN ACCESS EXCLUSIVE MODE`;
    locked();
    await held;
  });
  await isLocked;
  const started = Date.now();
  try {
    await assert.rejects(expire(retention, { statementTimeoutMs: 200 }), { code: '57014' });
    assert.ok(Date.now() - started < 5000, 'bounded by the timeout, not by the lock');
  } finally {
    release();
    await holder;
  }
  assert.equal(await count(db, 'evidence_redaction'), 0, 'the cancelled batch rolled back');
  assert.deepEqual(await expire(retention), { redacted: 1, batches: 1 });
});

// ---------------------------------------------------------------- AC-7: who and against what

test('every role but evidence_retention is refused, a superuser as role-unsafe, and nothing is redacted', async (t) => {
  const db = await database(t);
  const id = await insertAt(db, 'PR-old', '1 hour');
  for (const role of ['evidence_app', 'evidence_owner', 'evidence_audit'])
    await assert.rejects(
      expire(db.connectAs(role, { max: 1 })),
      refusedWith('not-retention'),
      role,
    );
  await assert.rejects(expire(db.admin), refusedWith('role-unsafe'));
  assert.notEqual(await payloadOf(db, id), null);
  assert.equal(await count(db, 'evidence_redaction'), 0);
});

// Review cycle 1, S-3 and N-2. Membership cannot be granted to the shared evidence_retention role
// (other test processes use it), but the job checks membership and attributes before the role's
// name, so a disposable login role shows each refusal on a real server. As
// database-roles.integration.mjs's serviceRoleCopy, it is dropped before the database is disposed.
test('a member of any role, or a role with an elevated attribute, is refused as role-unsafe', async (t) => {
  const db = await database(t);
  const id = await insertAt(db, 'PR-old', '1 hour');
  const name = `evidence_copy_${process.pid}_${Math.random().toString(16).slice(2, 10)}`;
  const role = db.admin(name);
  await db.admin.unsafe(
    `CREATE ROLE ${name} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${rolePassword(process.env.PGPASSWORD, name)}'`,
  );
  const copy = db.connectAs(name, { max: 1 });
  try {
    await db.admin`GRANT CONNECT ON DATABASE ${db.admin(db.name)} TO ${role}`;
    // Neither a member nor elevated: refused only because it is not evidence_retention.
    await assert.rejects(expire(copy), refusedWith('not-retention'));
    await db.admin`GRANT evidence_audit TO ${role}`;
    await assert.rejects(expire(copy), refusedWith('role-unsafe'), 'member');
    await db.admin`REVOKE evidence_audit FROM ${role}`;
    for (const attribute of ['CREATEROLE', 'CREATEDB', 'REPLICATION', 'BYPASSRLS']) {
      await db.admin.unsafe(`ALTER ROLE ${name} ${attribute}`);
      await assert.rejects(expire(copy), refusedWith('role-unsafe'), attribute);
      await db.admin.unsafe(`ALTER ROLE ${name} NO${attribute}`);
    }
    await assert.rejects(expire(copy), refusedWith('not-retention'));
  } finally {
    await copy.end({ timeout: 1 }).catch(() => {});
    await db.admin`DROP OWNED BY ${role}`;
    await db.admin`DROP ROLE ${role}`;
  }
  assert.notEqual(await payloadOf(db, id), null);
  assert.equal(await count(db, 'evidence_redaction'), 0);
});

test('a database still at 0001, or with a tampered schema record, is refused as schema-mismatch', async (t) => {
  const stale = await createEmptyDatabase();
  t.after(() => stale.dispose());
  await migrate(stale.connectAs('evidence_owner', { max: 1 }), {
    migrations: loadMigrations().slice(0, 1),
  });
  await assert.rejects(
    expire(stale.connectAs('evidence_retention', { max: 1 })),
    refusedWith('schema-mismatch'),
  );

  const db = await database(t);
  const id = await insertAt(db, 'PR-old', '1 hour');
  await db.admin`UPDATE evidence.schema_migrations SET checksum = ${'0'.repeat(64)} WHERE version = 2`;
  await assert.rejects(
    expire(db.connectAs('evidence_retention', { max: 1 })),
    refusedWith('schema-mismatch'),
  );
  assert.notEqual(await payloadOf(db, id), null);
});

// ---------------------------------------------------------------- AC-8: the CLI

function cli(args, env) {
  const script = new URL('./expire.mjs', import.meta.url).pathname;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { PATH: process.env.PATH, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('the CLI prints one line, a count or a code, with exit codes 0 and 1', async (t) => {
  const db = await database(t);
  await insertAt(db, 'PR-old', '1 hour');
  assert.deepEqual(await cli([], db.env('evidence_retention')), {
    code: 0,
    stdout: 'expire done: redacted 1\n',
    stderr: '',
  });
  assert.deepEqual(await cli([], db.env('evidence_app')), {
    code: 1,
    stdout: '',
    stderr: 'expire refused: not-retention\n',
  });
  assert.deepEqual(
    await cli([], { ...db.env('evidence_retention'), PGPASSWORD: 'CANARY-wrong' }),
    { code: 1, stdout: '', stderr: 'expire refused: 28P01\n' },
    'a code, never the driver message',
  );
});
