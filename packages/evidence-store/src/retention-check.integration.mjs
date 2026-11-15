import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test, { after } from 'node:test';
import { RETENTION_WINDOW, expire } from './expire.mjs';
import { bundledGuardBody } from './retention-check.mjs';
import { adminEnv, closeHarness, createTestDatabase, rolePassword } from './pg-harness.mjs';

// The retention check on a real PostgreSQL 16 server, as a real child process logged in as
// evidence_audit, under the trigger 0002 installs. received_at is the database's clock and no role
// but a superuser can set it, so aged rows are inserted by the superuser relative to the server's
// own clock, as expire.integration.mjs does. Every state it must find is made for real: a run that
// did not happen, a run that was refused, a row skipped under a held lock, and an owner disabling,
// replacing, dropping or bending the guard, or hiding rows from the check. Fails without a server;
// never skips.

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
// The report is nine lines; the last names what was found.
const VERDICT = 8;

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
  "retention-check: redactions stamped later than this run's clock: 0 found",
  "retention-check: envelopes stamped as received later than this run's clock: 0 found",
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
  assert.equal(line(missed, VERDICT), 'retention-check: violation found: overdue-payload');
  // A run of expire clears it: both payloads are past the window.
  assert.deepEqual(await expire(db.connectAs('evidence_retention', { max: 1 })), {
    redacted: 2,
    batches: 1,
  });
  const after = await check(db.env('evidence_audit'));
  assert.equal(after.code, 0);
  assert.deepEqual(lines(after).slice(1, 7), [
    'retention-check: payloads held past 2160 hours + 48 hours grace: 0 found',
    'retention-check: oldest payload still held: none held',
    'retention-check: redacted envelopes with no audit row: 0 found',
    'retention-check: redactions earlier than 2160 hours after receipt: 0 found',
    "retention-check: redactions stamped later than this run's clock: 0 found",
    "retention-check: envelopes stamped as received later than this run's clock: 0 found",
  ]);
});

test('a refused expire run leaves the payload overdue, and a good one clears it', async (t) => {
  const db = await database(t);
  await insertHeld(db, 'failed-run', '72 hours');
  const refused = await run(EXPIRE, db.env('evidence_app'));
  assert.deepEqual(refused, { code: 1, stdout: '', stderr: 'expire refused: not-retention\n' });
  const overdue = await check(db.env('evidence_audit'));
  assert.equal(overdue.code, 1);
  assert.equal(line(overdue, VERDICT), 'retention-check: violation found: overdue-payload');
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
  assert.equal(line(disabled, VERDICT), 'retention-check: violation found: guard-disabled');
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
    line(bypassed, VERDICT),
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
    line(reenabled, VERDICT),
    'retention-check: violation found: unaudited-redaction, early-redaction',
  );
});

test('a replica-only, replaced or dropped guard is reported, and never as no violation', async (t) => {
  const db = await database(t);
  const owner = db.connectAs('evidence_owner', { max: 1 });
  const guardLine = async () => {
    const result = await check(db.env('evidence_audit'));
    return [result.code, line(result, 0), line(result, VERDICT)];
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

// Review B-1 and S-6. Each guard below has the bundled name, function and enabled state, but never
// fires on the update it exists to refuse, or runs a body that is not the bundled one while it
// still holds the window's literal. The owner can make every one; each reads replaced. Recreating
// the bundled trigger and function exactly reads enabled again, so exactness costs no false alarm.
test('a guard recreated so that it does not fire, or a body that only quotes the window, is replaced', async (t) => {
  const db = await database(t);
  const owner = db.connectAs('evidence_owner', { max: 1 });
  const guardLine = async () => {
    const result = await check(db.env('evidence_audit'));
    return [result.code, line(result, 0), line(result, VERDICT)];
  };
  const REPLACED = [
    1,
    'retention-check: guard trigger evidence_envelope_guard: replaced',
    'retention-check: violation found: guard-replaced',
  ];
  const ENABLED = [
    0,
    'retention-check: guard trigger evidence_envelope_guard: enabled',
    'retention-check: no violation found',
  ];
  const id = await insertHeld(db, 'disarmed', '-1000 hours');
  // The owner's DDL is test code, so it may be raw text; the check's is never.
  const recreate = async (timing, { when = '', args = '' } = {}) => {
    await owner`DROP TRIGGER evidence_envelope_guard ON evidence.evidence_envelope`;
    await owner.unsafe(
      `CREATE TRIGGER evidence_envelope_guard ${timing} ON evidence.evidence_envelope ` +
        `FOR EACH ROW ${when} EXECUTE FUNCTION evidence.guard_envelope_update(${args})`,
    );
  };
  await recreate('BEFORE UPDATE', { when: 'WHEN (false)' });
  assert.deepEqual(await guardLine(), REPLACED);
  // Disarmed, the guard lets the owner rewrite the retention clock, which no count here sees.
  await owner`
    UPDATE evidence.evidence_envelope SET received_at = received_at - interval '1 hour'
     WHERE id = ${id}`;
  await recreate('BEFORE UPDATE OF policy_id');
  assert.deepEqual(await guardLine(), REPLACED);
  await recreate('BEFORE UPDATE OR DELETE');
  assert.deepEqual(await guardLine(), REPLACED);
  await recreate('BEFORE UPDATE', { args: "'x'" });
  assert.deepEqual(await guardLine(), REPLACED);
  await recreate('BEFORE UPDATE');
  assert.deepEqual(await guardLine(), ENABLED);

  // A body that keeps the window only in a comment, under the same name and oid.
  const define = (body) =>
    owner.unsafe(
      'CREATE OR REPLACE FUNCTION evidence.guard_envelope_update() RETURNS trigger ' +
        'LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp ' +
        `AS $guard$${body}$guard$`,
    );
  await define(`\nBEGIN\n  -- interval '${RETENTION_WINDOW}'\n  RETURN NEW;\nEND\n`);
  assert.deepEqual(await guardLine(), REPLACED);
  await define(bundledGuardBody());
  assert.deepEqual(await guardLine(), ENABLED);
});

// Review B2-2, the class of B-1: each attribute below is one the owner can change, and each bends
// what the guard refuses while the trigger, its name, function, body and enabled state are all
// still the bundled ones. Each reads replaced, exit 1, and is undone before the next, so no case
// is read through another's; the exact bundled guard reads enabled at the end.
const REPLACED = [
  1,
  'retention-check: guard trigger evidence_envelope_guard: replaced',
  'retention-check: violation found: guard-replaced',
];
const ENABLED = [
  0,
  'retention-check: guard trigger evidence_envelope_guard: enabled',
  'retention-check: no violation found',
];
const guardLineOf = (db) => async () => {
  const result = await check(db.env('evidence_audit'));
  return [result.code, line(result, 0), line(result, VERDICT)];
};

test("a guard function under another search path, security, volatility or language is replaced, and the shadowed clock's redaction is found", async (t) => {
  const db = await database(t);
  const owner = db.connectAs('evidence_owner', { max: 1 });
  const guardLine = guardLineOf(db);
  const FN = 'evidence.guard_envelope_update()';
  // The reviewer's measurement: a clock 100 days fast, earlier in the function's search path.
  await owner`
    CREATE FUNCTION evidence.statement_timestamp() RETURNS timestamptz LANGUAGE sql
      AS $$ SELECT pg_catalog.statement_timestamp() + interval '100 days' $$`;
  await owner.unsafe(`ALTER FUNCTION ${FN} SET search_path = evidence, pg_catalog, pg_temp`);
  const young = await insertHeld(db, 'shadowed-clock', '-2150 hours');
  const retention = db.connectAs('evidence_retention', { max: 1 });
  const redacted = await retention`
    UPDATE evidence.evidence_envelope SET evidence = NULL WHERE id = ${young}`;
  assert.equal(redacted.count, 1, 'a 10-hour-old payload was redacted under the shadowed clock');
  const shadowed = await check(db.env('evidence_audit'));
  assert.equal(shadowed.code, 1);
  assert.equal(
    line(shadowed, 0),
    'retention-check: guard trigger evidence_envelope_guard: replaced',
  );
  // Stamped 100 days ahead, so it is not early; only the future stamp shows the redaction.
  assert.deepEqual(lines(shadowed).slice(3, 6), [
    'retention-check: redacted envelopes with no audit row: 0 found',
    'retention-check: redactions earlier than 2160 hours after receipt: 0 found',
    "retention-check: redactions stamped later than this run's clock: 1 found",
  ]);
  assert.equal(
    line(shadowed, VERDICT),
    'retention-check: violation found: guard-replaced, future-redaction',
  );
  // The redacted row stays found; everything below is read on the guard line alone.
  await db.admin`DELETE FROM evidence.evidence_redaction WHERE envelope_id = ${young}`;
  await db.admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`DELETE FROM evidence.evidence_envelope WHERE id = ${young}`;
  });
  const restore = `ALTER FUNCTION ${FN} SET search_path = pg_catalog, pg_temp`;
  for (const alteration of [
    `ALTER FUNCTION ${FN} RESET ALL`,
    `ALTER FUNCTION ${FN} SET search_path = pg_catalog, evidence, pg_temp`,
    `ALTER FUNCTION ${FN} SET TimeZone = 'UTC'`,
  ]) {
    await owner.unsafe(alteration);
    assert.deepEqual(await guardLine(), REPLACED, alteration);
    await owner.unsafe(`ALTER FUNCTION ${FN} RESET ALL`);
    await owner.unsafe(restore);
  }
  for (const [alteration, undo] of [
    ['SECURITY INVOKER', 'SECURITY DEFINER'],
    ['STABLE', 'VOLATILE'],
  ]) {
    await owner.unsafe(`ALTER FUNCTION ${FN} ${alteration}`);
    assert.deepEqual(await guardLine(), REPLACED, alteration);
    await owner.unsafe(`ALTER FUNCTION ${FN} ${undo}`);
  }
  // No owner path to another language exists on this image (plperl and pltcl do not load, and a
  // SQL function cannot return trigger), so the superuser writes the catalog.
  const setLanguage = (name) => db.admin`
    UPDATE pg_catalog.pg_proc
       SET prolang = (SELECT oid FROM pg_catalog.pg_language WHERE lanname = ${name})
     WHERE oid = ${FN}::pg_catalog.regprocedure`;
  await setLanguage('sql');
  assert.deepEqual(await guardLine(), REPLACED, 'LANGUAGE sql');
  await setLanguage('plpgsql');
  assert.deepEqual(await guardLine(), ENABLED);
});

test('another trigger or rule on either table, a table inheriting the log, or a column of another type is replaced', async (t) => {
  const db = await database(t);
  const owner = db.connectAs('evidence_owner', { max: 1 });
  const guardLine = guardLineOf(db);
  await owner`
    CREATE FUNCTION evidence.rewrite() RETURNS trigger LANGUAGE plpgsql
      AS $$ BEGIN NEW.redacted_at := NEW.redacted_at + interval '3000 hours'; RETURN NEW; END $$`;
  for (const [alteration, undo] of [
    // Fires after the guard (by name) and rewrites the row the guard let through.
    [
      'CREATE TRIGGER zz_after_guard BEFORE UPDATE ON evidence.evidence_envelope ' +
        'FOR EACH ROW EXECUTE FUNCTION evidence.rewrite()',
      'DROP TRIGGER zz_after_guard ON evidence.evidence_envelope',
    ],
    // Rewrites the audit row the guard writes.
    [
      'CREATE TRIGGER forge BEFORE INSERT ON evidence.evidence_redaction ' +
        'FOR EACH ROW EXECUTE FUNCTION evidence.rewrite()',
      'DROP TRIGGER forge ON evidence.evidence_redaction',
    ],
    [
      'CREATE RULE skip AS ON UPDATE TO evidence.evidence_envelope DO INSTEAD NOTHING',
      'DROP RULE skip ON evidence.evidence_envelope',
    ],
    [
      'CREATE RULE skip AS ON INSERT TO evidence.evidence_redaction DO INSTEAD NOTHING',
      'DROP RULE skip ON evidence.evidence_redaction',
    ],
    // Its rows are read through the log, and the log's trigger never fires on them.
    [
      'CREATE TABLE evidence.child () INHERITS (evidence.evidence_envelope)',
      'DROP TABLE evidence.child',
    ],
    // The window then reads in the caller's TimeZone.
    [
      'ALTER TABLE evidence.evidence_envelope ALTER COLUMN received_at TYPE timestamp',
      'ALTER TABLE evidence.evidence_envelope ALTER COLUMN received_at TYPE timestamptz',
    ],
    [
      'ALTER TABLE evidence.evidence_redaction ALTER COLUMN redacted_by TYPE varchar(63)',
      'ALTER TABLE evidence.evidence_redaction ALTER COLUMN redacted_by TYPE text',
    ],
  ]) {
    await owner.unsafe(alteration);
    assert.deepEqual(await guardLine(), REPLACED, alteration);
    await owner.unsafe(undo);
  }
  assert.deepEqual(await guardLine(), ENABLED);
});

// Review S3-1: each route below leaves the trigger, its function and its enabled state as bundled,
// and each read enabled, exit 0, before the fix (the reviewer's cycle-3 probes). Each runs in its
// own database, since a decoy log or a dropped column cannot be undone in place.
test('a received_at renamed away and replaced, a pairing CHECK or audit key dropped, unvalidated or changed, or a decoy log is replaced', async (t) => {
  const cases = {
    // A new received_at with the owner's default; the guard then lets a 10-hour-old payload go.
    async swapReceivedAt(db, owner) {
      await owner`ALTER TABLE evidence.evidence_envelope RENAME COLUMN received_at TO received_at_true`;
      await owner`
        ALTER TABLE evidence.evidence_envelope
          ADD COLUMN received_at timestamptz NOT NULL DEFAULT '2000-01-01'`;
      await owner`
        GRANT SELECT (received_at) ON evidence.evidence_envelope
          TO evidence_audit, evidence_retention`;
      const retention = db.connectAs('evidence_retention', { max: 1 });
      const redacted = await retention`
        UPDATE evidence.evidence_envelope SET evidence = NULL WHERE redacted_at IS NULL`;
      assert.equal(redacted.count, 2, 'the 10-hour-old payload was redacted with the old one');
    },
    // With the CHECK gone, a held payload can be marked redacted and read as a tombstone.
    async dropPairCheck(db, owner, id) {
      await owner`
        ALTER TABLE evidence.evidence_envelope DROP CONSTRAINT evidence_envelope_redaction_pair`;
      // DDL takes no bound parameter; the owner's DDL is test code, so it may be raw text.
      await owner.unsafe(
        'ALTER TABLE evidence.evidence_envelope ALTER COLUMN redacted_at TYPE timestamptz ' +
          `USING CASE WHEN id = ${Number(id)} THEN received_at + interval '2200 hours' END`,
      );
    },
    async unvalidatedPairCheck(db, owner) {
      await owner`
        ALTER TABLE evidence.evidence_envelope DROP CONSTRAINT evidence_envelope_redaction_pair`;
      await owner`
        ALTER TABLE evidence.evidence_envelope ADD CONSTRAINT evidence_envelope_redaction_pair
          CHECK ((evidence IS NULL) = (redacted_at IS NOT NULL)) NOT VALID`;
    },
    // A weaker CHECK under the same name: a payload and a redaction time may then coexist.
    async otherPairCheck(db, owner) {
      await owner`
        ALTER TABLE evidence.evidence_envelope DROP CONSTRAINT evidence_envelope_redaction_pair`;
      await owner`
        ALTER TABLE evidence.evidence_envelope ADD CONSTRAINT evidence_envelope_redaction_pair
          CHECK ((evidence IS NOT NULL) OR (redacted_at IS NOT NULL))`;
    },
    // The audit table's key dropped and restated without validating what it already holds.
    async unvalidatedForeignKey(db, owner) {
      await owner`
        ALTER TABLE evidence.evidence_redaction DROP CONSTRAINT evidence_redaction_envelope_id_fkey`;
      await owner`
        ALTER TABLE evidence.evidence_redaction ADD CONSTRAINT evidence_redaction_envelope_id_fkey
          FOREIGN KEY (envelope_id) REFERENCES evidence.evidence_envelope (id)
          ON DELETE RESTRICT NOT VALID`;
    },
    // The payload column dropped (its CHECKs with it) and re-added under its name, with the
    // pairing CHECK restated over the new column.
    async payloadReadded(db, owner) {
      await owner`ALTER TABLE evidence.evidence_envelope DROP COLUMN evidence`;
      await owner`
        ALTER TABLE evidence.evidence_envelope ADD COLUMN evidence jsonb DEFAULT '{"fake":1}'::jsonb`;
      await owner`
        ALTER TABLE evidence.evidence_envelope ADD CONSTRAINT evidence_envelope_redaction_pair
          CHECK ((evidence IS NULL) = (redacted_at IS NOT NULL))`;
    },
    // The log renamed away, a decoy with the same guard in its place, and the real guard off.
    async decoyLog(db, owner) {
      await owner`ALTER TABLE evidence.evidence_envelope RENAME TO evidence_envelope_real`;
      await owner`
        CREATE TABLE evidence.evidence_envelope
          (LIKE evidence.evidence_envelope_real INCLUDING ALL)`;
      await owner`
        CREATE TRIGGER evidence_envelope_guard BEFORE UPDATE ON evidence.evidence_envelope
          FOR EACH ROW EXECUTE FUNCTION evidence.guard_envelope_update()`;
      await owner`
        GRANT SELECT (id, envelope_version, workspace_id, change_id, received_at, policy_id,
                      submitted_by, redacted_at)
          ON evidence.evidence_envelope TO evidence_audit`;
      await owner`
        ALTER TABLE evidence.evidence_envelope_real DISABLE TRIGGER evidence_envelope_guard`;
    },
  };
  for (const [name, alter] of Object.entries(cases)) {
    const db = await database(t);
    await insertHeld(db, 'young', '-2150 hours');
    const old = await insertHeld(db, 'old', '49 hours');
    const owner = db.connectAs('evidence_owner', { max: 1 });
    await alter(db, owner, old);
    const result = await check(db.env('evidence_audit'));
    assert.equal(result.code, 1, `${name} ${result.stderr}`);
    assert.equal(
      line(result, 0),
      'retention-check: guard trigger evidence_envelope_guard: replaced',
      name,
    );
    assert.match(line(result, VERDICT), /violation found: guard-replaced/, name);
  }
});

// Review S3-2: a collation on an identity column changes what rule 3 calls the same value. With a
// nondeterministic one, an owner redaction that also renames change_id `old` to `OLD` passes the
// guard (measured below); a deterministic non-default one reads replaced too, as the exact
// bundled column is the only one pinned. Restored, it reads enabled.
test('an identity column under a non-default collation is replaced', async (t) => {
  const db = await database(t);
  const owner = db.connectAs('evidence_owner', { max: 1 });
  const guardLine = guardLineOf(db);
  const [{ id }] = await db.admin`
    INSERT INTO evidence.evidence_envelope
      (envelope_version, workspace_id, change_id, received_at, evidence)
    VALUES ('evidence-envelope/0', ${WORKSPACE}, 'old',
            statement_timestamp() - ${RETENTION_WINDOW}::interval - interval '1 hour', '{}'::jsonb)
    RETURNING id`;
  await owner`
    CREATE COLLATION evidence.ci (provider = icu, locale = 'und-u-ks-level2', deterministic = false)`;
  await owner`ALTER TABLE evidence.evidence_envelope DROP CONSTRAINT evidence_envelope_idempotency`;
  await owner`ALTER TABLE evidence.evidence_envelope ALTER COLUMN change_id TYPE text COLLATE evidence.ci`;
  assert.deepEqual(await guardLine(), REPLACED, 'nondeterministic');
  const renamed = await owner`
    UPDATE evidence.evidence_envelope SET evidence = NULL, change_id = 'OLD' WHERE id = ${id}`;
  assert.equal(renamed.count, 1, 'rule 3 let the identity change through');
  await owner`ALTER TABLE evidence.evidence_envelope ALTER COLUMN workspace_id TYPE text COLLATE "C"`;
  await owner`ALTER TABLE evidence.evidence_envelope ALTER COLUMN change_id TYPE text COLLATE "default"`;
  assert.deepEqual(await guardLine(), REPLACED, 'deterministic "C"');
  await owner`ALTER TABLE evidence.evidence_envelope ALTER COLUMN workspace_id TYPE text COLLATE "default"`;
  assert.deepEqual(await guardLine(), ENABLED);
});

// The check's own reads, not the guard: a row-level policy hides rows from evidence_audit, and the
// database's default search path - the owner's to set - puts an owner's operator before
// pg_catalog's. Measured before the fix: with either, an overdue payload read 0 and exit 0.
test('rows hidden from the check refuse it, and an owner search path does not change what it counts', async (t) => {
  const db = await database(t);
  const owner = db.connectAs('evidence_owner', { max: 1 });
  await insertHeld(db, 'hidden', '72 hours');
  await owner`ALTER TABLE evidence.evidence_envelope ENABLE ROW LEVEL SECURITY`;
  await owner`CREATE POLICY everyone ON evidence.evidence_envelope USING (true) WITH CHECK (true)`;
  await owner`
    CREATE POLICY hide ON evidence.evidence_envelope AS RESTRICTIVE FOR SELECT TO evidence_audit
      USING (false)`;
  assert.deepEqual(await check(db.env('evidence_audit')), {
    code: 3,
    stdout: '',
    stderr: 'retention-check refused: schema-mismatch\n',
  });
  await owner`ALTER TABLE evidence.evidence_envelope DISABLE ROW LEVEL SECURITY`;
  await owner`ALTER TABLE evidence.evidence_redaction ENABLE ROW LEVEL SECURITY`;
  assert.equal((await check(db.env('evidence_audit'))).code, 3, 'either table');
  await owner`ALTER TABLE evidence.evidence_redaction DISABLE ROW LEVEL SECURITY`;

  await owner`
    CREATE FUNCTION evidence.never(timestamptz, timestamptz) RETURNS boolean LANGUAGE sql
      IMMUTABLE AS 'SELECT false'`;
  await owner`
    CREATE OPERATOR evidence.< (LEFTARG = timestamptz, RIGHTARG = timestamptz,
                                FUNCTION = evidence.never)`;
  await owner`
    CREATE FUNCTION evidence.never(name, name) RETURNS boolean LANGUAGE sql
      IMMUTABLE AS 'SELECT false'`;
  await owner`
    CREATE OPERATOR evidence.= (LEFTARG = name, RIGHTARG = name, FUNCTION = evidence.never)`;
  await owner.unsafe(`ALTER DATABASE ${db.name} SET search_path = evidence, pg_catalog`);
  const shadowed = await check(db.env('evidence_audit'));
  assert.equal(shadowed.code, 1, shadowed.stderr);
  assert.equal(
    line(shadowed, 0),
    'retention-check: guard trigger evidence_envelope_guard: enabled',
  );
  assert.equal(
    line(shadowed, 1),
    'retention-check: payloads held past 2160 hours + 48 hours grace: 1 found',
  );
  assert.equal(line(shadowed, VERDICT), 'retention-check: violation found: overdue-payload');
});

// A redaction stamp later than the clock is impossible under the bundled guard, which stamps its
// statement's start; only a bypass or a bent guard writes one. Inserted by the superuser with its
// audit row and past the window, so only the future count can move.
test('a redaction stamped later than the check clock is a violation', async (t) => {
  const db = await database(t);
  const [{ id }] = await db.admin`
    INSERT INTO evidence.evidence_envelope
      (envelope_version, workspace_id, change_id, received_at, redacted_at, evidence)
    VALUES ('evidence-envelope/0', ${WORKSPACE}, ${`${CHANGE}-future`},
            statement_timestamp() - interval '3000 hours',
            statement_timestamp() + interval '1 hour', NULL)
    RETURNING id`;
  await db.admin`
    INSERT INTO evidence.evidence_redaction (envelope_id, redacted_at, redacted_by)
    SELECT id, redacted_at, 'evidence_retention' FROM evidence.evidence_envelope WHERE id = ${id}`;
  const result = await check(db.env('evidence_audit'));
  assert.equal(result.code, 1);
  assert.deepEqual(lines(result).slice(3, 6), [
    'retention-check: redacted envelopes with no audit row: 0 found',
    'retention-check: redactions earlier than 2160 hours after receipt: 0 found',
    "retention-check: redactions stamped later than this run's clock: 1 found",
  ]);
  assert.equal(line(result, VERDICT), 'retention-check: violation found: future-redaction');
});

// Follow-up B: received_at's default is the owner's to change, and a row stamped as received in
// the future never comes due. The service's own insert is stamped by that default here, as it
// would be in a deployment; the guard is untouched, so only the receipt count moves.
test('an envelope stamped as received later than the check clock is a violation', async (t) => {
  const db = await database(t);
  const owner = db.connectAs('evidence_owner', { max: 1 });
  await owner`
    ALTER TABLE evidence.evidence_envelope
      ALTER COLUMN received_at SET DEFAULT statement_timestamp() + interval '1 year'`;
  const app = db.connectAs('evidence_app', { max: 1 });
  await app`
    INSERT INTO evidence.evidence_envelope (envelope_version, workspace_id, change_id, evidence)
    VALUES ('evidence-envelope/0', ${WORKSPACE}, ${`${CHANGE}-future-receipt`}, '{}'::jsonb)`;
  const result = await check(db.env('evidence_audit'));
  assert.equal(result.code, 1, result.stderr);
  assert.deepEqual(lines(result).slice(0, 7), [
    'retention-check: guard trigger evidence_envelope_guard: enabled',
    'retention-check: payloads held past 2160 hours + 48 hours grace: 0 found',
    'retention-check: oldest payload still held: 0 hours',
    'retention-check: redacted envelopes with no audit row: 0 found',
    'retention-check: redactions earlier than 2160 hours after receipt: 0 found',
    "retention-check: redactions stamped later than this run's clock: 0 found",
    "retention-check: envelopes stamped as received later than this run's clock: 1 found",
  ]);
  assert.equal(line(result, VERDICT), 'retention-check: violation found: future-receipt');
  // The default restored and the row re-stamped an hour ago, nothing is found.
  await owner`
    ALTER TABLE evidence.evidence_envelope ALTER COLUMN received_at SET DEFAULT statement_timestamp()`;
  await db.admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`
      UPDATE evidence.evidence_envelope SET received_at = statement_timestamp() - interval '1 hour'`;
  });
  const restored = await check(db.env('evidence_audit'));
  assert.equal(restored.code, 0, restored.stderr);
  assert.equal(line(restored, 2), 'retention-check: oldest payload still held: 1 hours');
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
  assert.equal(line(result, VERDICT), 'retention-check: violation found: early-redaction');
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
