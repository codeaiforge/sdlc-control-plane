import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test, { after } from 'node:test';
import { MigrationRefused, loadMigrations, migrate, status } from './migrate.mjs';
import { StartupRefused, assertSchemaCurrent } from './postgres-store.mjs';
import { adminEnv, closeHarness, createEmptyDatabase, roleEnv } from './pg-harness.mjs';

// The runner and the schema it produces, on a real PostgreSQL 16 server (stack.md "Migrations +
// verify": apply to an empty database, then check). Fails without a server; never skips.

after(() => closeHarness());

const refused = (code) => (error) => error instanceof MigrationRefused && error.code === code;

async function empty(t) {
  const db = await createEmptyDatabase();
  t.after(() => db.dispose());
  return db;
}

async function migrated(t) {
  const db = await empty(t);
  await migrate(db.connectAs('evidence_owner', { max: 1 }));
  return db;
}

test('an empty database is migrated by evidence_owner, and a second run applies nothing', async (t) => {
  const db = await empty(t);
  const owner = db.connectAs('evidence_owner', { max: 1 });
  assert.deepEqual(await status(owner), { applied: [], pending: [1] });
  assert.deepEqual(await migrate(owner), { applied: [1], current: 1 });
  assert.deepEqual(await migrate(owner), { applied: [], current: 1 });
  const { applied, pending } = await status(db.connectAs('evidence_app', { max: 1 }));
  assert.deepEqual(pending, []);
  assert.deepEqual(
    applied.map(({ version, name, checksum, applied_by }) => ({
      version,
      name,
      checksum,
      applied_by,
    })),
    [
      {
        version: 1,
        name: 'evidence-envelope',
        checksum: loadMigrations()[0].checksum,
        applied_by: 'evidence_owner',
      },
    ],
  );
});

test('two runners at once serialise on the advisory lock: one applies, the other finds it done', async (t) => {
  const db = await empty(t);
  const results = await Promise.all([
    migrate(db.connectAs('evidence_owner', { max: 1 })),
    migrate(db.connectAs('evidence_owner', { max: 1 })),
  ]);
  assert.deepEqual(results.map((result) => result.applied).sort(), [[], [1]]);
});

test('the runner refuses every role but evidence_owner, and a superuser', async (t) => {
  const db = await empty(t);
  for (const role of ['evidence_app', 'evidence_retention', 'evidence_audit'])
    await assert.rejects(migrate(db.connectAs(role, { max: 1 })), refused('not-owner'), role);
  await assert.rejects(migrate(db.admin), refused('superuser'));
  const [{ present }] = await db.admin`
    SELECT to_regclass('evidence.schema_migrations') IS NOT NULL AS present`;
  assert.equal(present, false, 'a refused run creates nothing');
});

test('an applied file whose checksum changed, or an applied version with no file, stops everything', async (t) => {
  const db = await migrated(t);
  const owner = db.connectAs('evidence_owner', { max: 1 });
  const app = db.connectAs('evidence_app', { max: 1 });
  await assertSchemaCurrent(app);
  await db.admin`UPDATE evidence.schema_migrations SET checksum = ${'0'.repeat(64)} WHERE version = 1`;
  await assert.rejects(migrate(owner), refused('checksum-mismatch'));
  await assert.rejects(
    assertSchemaCurrent(app),
    (error) => error instanceof StartupRefused && error.code === 'schema-mismatch',
  );
  await db.admin`UPDATE evidence.schema_migrations SET checksum = ${loadMigrations()[0].checksum}`;
  await db.admin`INSERT INTO evidence.schema_migrations (version, name, checksum) VALUES (2, 'ghost', 'x')`;
  await assert.rejects(migrate(owner), refused('unknown-applied'));
  await assert.rejects(assertSchemaCurrent(app), (error) => error.code === 'schema-mismatch');
});

test('the service refuses a database that has not been migrated', async (t) => {
  const db = await empty(t);
  await assert.rejects(
    assertSchemaCurrent(db.connectAs('evidence_app', { max: 1 })),
    (error) => error instanceof StartupRefused && error.code === 'schema-mismatch',
  );
});

// AC-4: the schema ADR-0002 describes, read back from the server's catalog.
test('the envelope table has exactly ADR-0002 and ADR-0004 columns, and no digest', async (t) => {
  const db = await migrated(t);
  const columns = await db.admin`
    SELECT column_name, data_type, is_nullable, is_identity, identity_generation, column_default
      FROM information_schema.columns
     WHERE table_schema = 'evidence' AND table_name = 'evidence_envelope'
     ORDER BY ordinal_position`;
  assert.deepEqual(
    columns.map((c) => [c.column_name, c.data_type, c.is_nullable]),
    [
      ['id', 'bigint', 'NO'],
      ['envelope_version', 'text', 'NO'],
      ['workspace_id', 'text', 'YES'],
      ['change_id', 'text', 'NO'],
      ['received_at', 'timestamp with time zone', 'NO'],
      ['policy_id', 'text', 'YES'],
      ['submitted_by', 'jsonb', 'YES'],
      ['evidence', 'jsonb', 'YES'],
      ['redacted_at', 'timestamp with time zone', 'YES'],
    ],
  );
  assert.equal(columns[0].is_identity, 'YES');
  assert.equal(columns[0].identity_generation, 'ALWAYS');
  assert.equal(columns[4].column_default, 'statement_timestamp()', 'the database clock');
  assert.equal(
    columns.some((c) => /digest|hash|sha/.test(c.column_name)),
    false,
  );

  const redaction = await db.admin`
    SELECT column_name, data_type, is_nullable FROM information_schema.columns
     WHERE table_schema = 'evidence' AND table_name = 'evidence_redaction' ORDER BY ordinal_position`;
  assert.deepEqual(
    redaction.map((c) => [c.column_name, c.data_type, c.is_nullable]),
    [
      ['id', 'bigint', 'NO'],
      ['envelope_id', 'bigint', 'NO'],
      ['redacted_at', 'timestamp with time zone', 'NO'],
      ['redacted_by', 'text', 'NO'],
    ],
  );
  const tables = await db.admin`
    SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
     ORDER BY 1, 2`;
  assert.deepEqual(
    tables.map((row) => `${row.nspname}.${row.relname}`),
    ['evidence.evidence_envelope', 'evidence.evidence_redaction', 'evidence.schema_migrations'],
    'nothing in public',
  );
});

test('the idempotency key is a server-side unique constraint, NULLS DISTINCT, and the FK restricts', async (t) => {
  const db = await migrated(t);
  const [unique] = await db.admin`
    SELECT con.contype, i.indnullsnotdistinct,
           array_to_string(array(SELECT a.attname FROM unnest(con.conkey) k
                   JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k), ',') AS columns
      FROM pg_constraint con JOIN pg_index i ON i.indexrelid = con.conindid
     WHERE con.conname = 'evidence_envelope_idempotency'`;
  assert.deepEqual(
    { ...unique },
    { contype: 'u', indnullsnotdistinct: false, columns: 'workspace_id,change_id' },
  );
  const [fk] = await db.admin`
    SELECT confdeltype, confupdtype, conrelid::regclass::text AS child, confrelid::regclass::text AS parent
      FROM pg_constraint WHERE contype = 'f' AND conrelid = 'evidence.evidence_redaction'::regclass`;
  assert.deepEqual(
    { ...fk },
    {
      confdeltype: 'r',
      confupdtype: 'a',
      child: 'evidence.evidence_redaction',
      parent: 'evidence.evidence_envelope',
    },
  );
  const [index] = await db.admin`
    SELECT indexdef FROM pg_indexes WHERE indexname = 'evidence_envelope_received_at'`;
  assert.match(index.indexdef, /\(received_at\)$/);
});

// No role but the owner can create an object today, so a missing search_path pin changes no
// behaviour any other test can see; only the catalog can hold it (review cycle 1, N-1).
test('the trigger function is SECURITY DEFINER, owned by evidence_owner, with its search path pinned', async (t) => {
  const db = await migrated(t);
  const [guard] = await db.admin`
    SELECT p.prosecdef, array_to_string(p.proconfig, ';') AS proconfig,
           pg_get_userbyid(p.proowner) AS owner
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'evidence' AND p.proname = 'guard_envelope_update'`;
  assert.deepEqual(
    { ...guard },
    {
      prosecdef: true,
      proconfig: 'search_path=pg_catalog, pg_temp',
      owner: 'evidence_owner',
    },
  );
});

test('the CHECK constraints refuse a string-scalar payload and a payload/redaction mismatch', async (t) => {
  const db = await migrated(t);
  const insert = (evidence, redactedAt, submitter = null) => db.admin`
    INSERT INTO evidence.evidence_envelope
      (envelope_version, workspace_id, change_id, submitted_by, evidence, redacted_at)
    VALUES ('evidence-envelope/0', 'w', ${String(Math.random())}, ${submitter}::text::jsonb,
            ${evidence}::text::jsonb, ${redactedAt}::timestamptz)`;
  for (const [evidence, redactedAt, submitter] of [
    ['"a string scalar"', null, null],
    ['[1,2]', null, null],
    [null, null, null],
    ['{"a":1}', '2026-01-01T00:00:00Z', null],
    ['{"a":1}', null, '"not an object"'],
  ])
    await assert.rejects(
      insert(evidence, redactedAt, submitter),
      { code: '23514' },
      `${evidence} ${redactedAt}`,
    );
  await insert('{"a":1}', null);
});

// The CLI, as an operator runs it: bootstrap as the cluster admin, migrate as evidence_owner.
function cli(args, env) {
  const script = new URL('./migrate.mjs', import.meta.url).pathname;
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

test('the CLI bootstraps, migrates and reports, with exit codes 0, 1 and 2', async (t) => {
  const admin = await adminEnv();
  const name = `evidence_cli_${process.pid}`;
  t.after(async () => {
    const db = await createEmptyDatabase();
    await db.admin`DROP DATABASE IF EXISTS ${db.admin(name)} WITH (FORCE)`;
    await db.dispose();
  });
  const boot = await cli(['bootstrap', '--database', name], admin);
  assert.deepEqual(boot, {
    code: 0,
    stdout: `bootstrap done: database ${name}, owner evidence_owner\n`,
    stderr: '',
  });
  const asApp = await cli(['migrate'], roleEnv('evidence_app', name));
  assert.deepEqual(asApp, { code: 1, stdout: '', stderr: 'migrate refused: not-owner\n' });
  const first = await cli(['migrate'], roleEnv('evidence_owner', name));
  assert.deepEqual(first, {
    code: 0,
    stdout: 'migrate done: applied [1], current 1\n',
    stderr: '',
  });
  const again = await cli(['migrate'], roleEnv('evidence_owner', name));
  assert.equal(again.stdout, 'migrate done: applied [], current 1\n');
  const report = await cli(['status'], roleEnv('evidence_app', name));
  assert.equal(report.code, 0);
  assert.deepEqual(JSON.parse(report.stdout).pending, []);
  const wrong = await cli(['migrate'], {
    ...roleEnv('evidence_owner', name),
    PGPASSWORD: 'CANARY-wrong',
  });
  assert.equal(wrong.code, 1);
  assert.equal(wrong.stderr, 'migrate refused: 28P01\n', 'a code, never the driver message');
  assert.equal((await cli(['nonsense'], admin)).code, 2);
});
