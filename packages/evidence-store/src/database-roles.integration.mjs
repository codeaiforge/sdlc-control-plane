import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after } from 'node:test';
import { closeHarness, createTestDatabase } from './pg-harness.mjs';
import {
  StartupRefused,
  assertServiceRole,
  createPostgresEvidenceStore,
} from './postgres-store.mjs';

// The database's security properties - ownership, grants, the redaction trigger, ON DELETE
// RESTRICT, the audit queries - proven by logging in AS EACH ROLE on a real PostgreSQL 16 server.
// A fake cannot show any of them (ADR-0002 records two mitigations that read as correct and failed
// on PostgreSQL 16). Fails without a server; never skips.

after(() => closeHarness());

const DENIED = '42501'; // insufficient_privilege, also "must be owner"
const TRIGGER = 'P0001'; // the guard's own refusals
const CHECK = '23514';

const record = (overrides = {}) => ({
  schema_version: 'evidence/0',
  change_id: 'PR-1',
  tier: 'T1',
  result: { pass: true },
  ...overrides,
});
const submitter = () => ({
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
});
const KEPT = [
  'issuer',
  'repository_owner_id',
  'repository_id',
  'run_id',
  'run_attempt',
  'sha',
  'job_workflow_sha',
];
const NULLED = ['ref', 'event_name', 'workflow_ref', 'job_workflow_ref'];

// A database with one envelope appended by the service role, and a client per role.
async function setup(t, { change_id = 'PR-1' } = {}) {
  const db = await createTestDatabase();
  t.after(() => db.dispose());
  const as = {
    owner: db.connectAs('evidence_owner', { max: 1 }),
    app: db.connectAs('evidence_app', { max: 1 }),
    retention: db.connectAs('evidence_retention', { max: 1 }),
    audit: db.connectAs('evidence_audit', { max: 1 }),
  };
  const store = createPostgresEvidenceStore({ sql: as.app, requireWorkspace: true });
  await store.append(record({ change_id }), {
    workspace_id: 'payments-art',
    policy_id: 'baseline@1',
    submitted_by: submitter(),
  });
  const [{ id }] =
    await db.admin`SELECT id FROM evidence.evidence_envelope WHERE change_id = ${change_id}`;
  const row = async () =>
    (await db.admin`SELECT * FROM evidence.evidence_envelope WHERE id = ${id}`)[0];
  return { db, as, store, id, row };
}

const refusedWith = (code) => (error) => {
  assert.equal(error.code, code, `${error.code} ${error.message}`);
  return true;
};

// ---------------------------------------------------------------- AC-5: the application role

test('evidence_app can append and read, and cannot update, delete, truncate, alter or create', async (t) => {
  const { as, id } = await setup(t);
  const attempts = {
    update: as.app`UPDATE evidence.evidence_envelope SET evidence = NULL WHERE id = ${id}`,
    delete: as.app`DELETE FROM evidence.evidence_envelope WHERE id = ${id}`,
    truncate: as.app`TRUNCATE evidence.evidence_envelope`,
    'drop constraint': as.app`ALTER TABLE evidence.evidence_envelope DROP CONSTRAINT evidence_envelope_idempotency`,
    'disable trigger': as.app`ALTER TABLE evidence.evidence_envelope DISABLE TRIGGER evidence_envelope_guard`,
    'drop table': as.app`DROP TABLE evidence.evidence_envelope`,
    'create in evidence': as.app`CREATE TABLE evidence.shadow (x int)`,
    'create in public': as.app`CREATE TABLE public.shadow (x int)`,
    'create temp': as.app`CREATE TEMP TABLE shadow (x int)`,
    'read redactions': as.app`SELECT * FROM evidence.evidence_redaction`,
    'forge a redaction': as.app`
      INSERT INTO evidence.evidence_redaction (envelope_id, redacted_at, redacted_by)
      VALUES (${id}, now(), 'evidence_retention')`,
    'write schema_migrations': as.app`DELETE FROM evidence.schema_migrations`,
  };
  for (const [what, attempt] of Object.entries(attempts))
    await assert.rejects(attempt, refusedWith(DENIED), what);
  const [{ n }] = await as.app`SELECT count(*)::int AS n FROM evidence.evidence_envelope`;
  assert.equal(n, 1);
});

test('evidence_app owns no object, and cannot insert a pre-redacted tombstone', async (t) => {
  const { db, as } = await setup(t);
  const [owned] = await db.admin`
    SELECT (SELECT count(*) FROM pg_class WHERE relowner = r.oid)
         + (SELECT count(*) FROM pg_proc WHERE proowner = r.oid)
         + (SELECT count(*) FROM pg_namespace WHERE nspowner = r.oid)
         + (SELECT count(*) FROM pg_type WHERE typowner = r.oid)
         + (SELECT count(*) FROM pg_database WHERE datdba = r.oid) AS n
      FROM pg_roles r WHERE rolname = 'evidence_app'`;
  assert.equal(Number(owned.n), 0);
  // A row that arrives already redacted would make every later replay a duplicate with no
  // evidence_redaction row behind it. The pairing CHECK alone allows one (NULL payload, redaction
  // time set); the column-limited INSERT grant is what refuses it, and the CHECK refuses the rest.
  await assert.rejects(
    as.app`
      INSERT INTO evidence.evidence_envelope
        (envelope_version, workspace_id, change_id, evidence, redacted_at)
      VALUES ('evidence-envelope/0', 'payments-art', 'PR-forged', NULL, now())`,
    refusedWith(DENIED),
  );
  await assert.rejects(
    as.app`
      INSERT INTO evidence.evidence_envelope (envelope_version, workspace_id, change_id, evidence)
      VALUES ('evidence-envelope/0', 'payments-art', 'PR-forged', NULL)`,
    refusedWith(CHECK),
  );
});

// ---------------------------------------------------------------- D-16: startup role checks

test('only evidence_app passes the startup role check; TLS is checked on the live connection', async (t) => {
  const { db, as } = await setup(t);
  await assertServiceRole(as.app, { requireTls: false });
  for (const [role, sql] of [
    ['evidence_owner', as.owner],
    ['evidence_retention', as.retention],
    ['evidence_audit', as.audit],
    ['superuser', db.admin],
  ])
    await assert.rejects(
      assertServiceRole(sql, { requireTls: false }),
      (error) => error instanceof StartupRefused && error.code === 'role-unsafe',
      role,
    );
  // The harness connects over loopback without TLS, so a required TLS check must refuse here.
  await assert.rejects(
    assertServiceRole(as.app, { requireTls: true }),
    (error) => error instanceof StartupRefused && error.code === 'tls-not-negotiated',
  );
  // A grant that would let the service rewrite evidence is caught on the next start.
  await db.admin`GRANT UPDATE (policy_id) ON evidence.evidence_envelope TO evidence_app`;
  await assert.rejects(assertServiceRole(as.app, { requireTls: false }), { code: 'role-unsafe' });
});

// ---------------------------------------------------------------- AC-6: the redaction trigger

test('a legitimate redaction nulls the payload and the four names, and the trigger writes the audit row', async (t) => {
  const { db, as, id, row } = await setup(t);
  const before = await row();
  const [{ low }] = await db.admin`SELECT statement_timestamp() AS low`;
  // The statement tries to backdate itself; the database's clock wins.
  const result = await as.retention`
    UPDATE evidence.evidence_envelope SET evidence = NULL, redacted_at = '1999-01-01T00:00:00Z'
     WHERE id = ${id} AND redacted_at IS NULL`;
  assert.equal(result.count, 1);
  const [{ high }] = await db.admin`SELECT statement_timestamp() AS high`;
  const after = await row();
  assert.equal(after.evidence, null);
  assert.ok(
    after.redacted_at >= low && after.redacted_at <= high,
    'redacted_at is the database clock',
  );
  for (const field of ['id', 'envelope_version', 'workspace_id', 'change_id', 'policy_id'])
    assert.equal(after[field], before[field], field);
  assert.equal(after.received_at.getTime(), before.received_at.getTime());
  assert.deepEqual(after.submitted_by, {
    ...submitter(),
    ...Object.fromEntries(NULLED.map((field) => [field, null])),
  });
  const audit =
    await db.admin`SELECT envelope_id, redacted_at, redacted_by FROM evidence.evidence_redaction`;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].envelope_id, String(id));
  assert.equal(audit[0].redacted_at.getTime(), after.redacted_at.getTime());
  assert.equal(audit[0].redacted_by, 'evidence_retention', 'the role that logged in');
});

test('the trigger refuses a forged payload, a redacted_at-only update, and any update to a tombstone', async (t) => {
  const { as, id } = await setup(t);
  const refuse = (what, attempt) => assert.rejects(attempt, refusedWith(TRIGGER), what);
  await refuse(
    'forged payload',
    as.retention`
    UPDATE evidence.evidence_envelope SET evidence = '{"result":{"pass":false}}'::jsonb WHERE id = ${id}`,
  );
  await refuse(
    'redacted_at only',
    as.retention`
    UPDATE evidence.evidence_envelope SET redacted_at = now() WHERE id = ${id}`,
  );
  await refuse(
    'submitted_by only, payload present',
    as.retention`
    UPDATE evidence.evidence_envelope SET submitted_by = '{"ref":null}'::jsonb WHERE id = ${id}`,
  );
  await as.retention`UPDATE evidence.evidence_envelope SET evidence = NULL WHERE id = ${id}`;
  await refuse(
    'redacted_at back to NULL',
    as.retention`
    UPDATE evidence.evidence_envelope SET redacted_at = NULL WHERE id = ${id}`,
  );
  await refuse(
    'redact twice',
    as.retention`
    UPDATE evidence.evidence_envelope SET evidence = NULL WHERE id = ${id}`,
  );
  await refuse(
    'payload back on a tombstone',
    as.retention`
    UPDATE evidence.evidence_envelope SET evidence = '{}'::jsonb, redacted_at = NULL WHERE id = ${id}`,
  );
  await refuse(
    'edit a tombstone identifier',
    as.owner`
    UPDATE evidence.evidence_envelope SET submitted_by = submitted_by || '{"run_id":"9"}'::jsonb WHERE id = ${id}`,
  );
});

test('even the owner cannot change an identity column, and the trigger is the reason', async (t) => {
  const { as, id } = await setup(t);
  for (const [column, value] of [
    ['envelope_version', 'evidence-envelope/1'],
    ['workspace_id', 'another-workspace'],
    ['change_id', 'PR-rewritten'],
    ['policy_id', 'other-policy@1'],
  ])
    await assert.rejects(
      as.owner`UPDATE evidence.evidence_envelope SET evidence = NULL, ${as.owner(column)} = ${value} WHERE id = ${id}`,
      refusedWith(TRIGGER),
      column,
    );
  await assert.rejects(
    as.owner`UPDATE evidence.evidence_envelope SET evidence = NULL, received_at = received_at - interval '91 days' WHERE id = ${id}`,
    refusedWith(TRIGGER),
    'received_at',
  );
  await assert.rejects(
    as.owner`UPDATE evidence.evidence_envelope SET evidence = '{"forged":true}'::jsonb WHERE id = ${id}`,
    refusedWith(TRIGGER),
  );
});

test('the retention role cannot forge a redaction row, read a payload, or delete', async (t) => {
  const { as, id } = await setup(t);
  for (const [what, attempt] of Object.entries({
    'insert a redaction': as.retention`
      INSERT INTO evidence.evidence_redaction (envelope_id, redacted_at, redacted_by)
      VALUES (${id}, now(), 'evidence_retention')`,
    'read the payload': as.retention`SELECT evidence FROM evidence.evidence_envelope`,
    'read the workspace': as.retention`SELECT workspace_id FROM evidence.evidence_envelope`,
    'update a kept column': as.retention`UPDATE evidence.evidence_envelope SET policy_id = 'x' WHERE id = ${id}`,
    delete: as.retention`DELETE FROM evidence.evidence_envelope WHERE id = ${id}`,
    'read redactions': as.retention`SELECT * FROM evidence.evidence_redaction`,
  }))
    await assert.rejects(attempt, refusedWith(DENIED), what);
});

// ON DELETE RESTRICT is declared (migrate.integration.mjs reads it from the catalog), but a DELETE
// never gets as far as it. The foreign-key check runs as evidence_owner, the referencing table's
// owner, and locks evidence_redaction rows FOR KEY SHARE - which needs the UPDATE the owner gave up.
// So a delete of any envelope is refused, a superuser's included, with permission denied on
// evidence_redaction (measured on 16.15).
test('nothing deletes an envelope: the owner gave up DELETE, and even a superuser is refused', async (t) => {
  const { db, as, store, id } = await setup(t);
  await store.append(record({ change_id: 'PR-2' }), { workspace_id: 'payments-art' });
  await as.retention`UPDATE evidence.evidence_envelope SET evidence = NULL WHERE id = ${id}`;
  await assert.rejects(
    as.owner`DELETE FROM evidence.evidence_envelope WHERE id = ${id}`,
    refusedWith(DENIED),
  );
  await assert.rejects(as.owner`TRUNCATE evidence.evidence_envelope CASCADE`, refusedWith(DENIED));
  await assert.rejects(
    as.owner`UPDATE evidence.evidence_redaction SET redacted_by = 'x'`,
    refusedWith(DENIED),
  );
  await assert.rejects(as.owner`DELETE FROM evidence.evidence_redaction`, refusedWith(DENIED));
  for (const change of ['PR-1', 'PR-2'])
    await assert.rejects(
      db.admin`DELETE FROM evidence.evidence_envelope WHERE change_id = ${change}`,
      (error) => {
        assert.equal(error.code, DENIED);
        assert.match(error.message, /evidence_redaction/);
        return true;
      },
      change,
    );
  const [{ n }] = await db.admin`SELECT count(*)::int AS n FROM evidence.evidence_envelope`;
  assert.equal(n, 2);
});

// ---------------------------------------------------------------- AC-7: ADR-0004's extension

test('a redaction that changes any of the seven kept submitted_by identifiers is refused', async (t) => {
  const { as, id, row } = await setup(t);
  for (const field of KEPT) {
    const tombstone = {
      ...submitter(),
      ...Object.fromEntries(NULLED.map((f) => [f, null])),
      [field]: 'changed',
    };
    await assert.rejects(
      as.retention`
        UPDATE evidence.evidence_envelope
           SET evidence = NULL, submitted_by = ${JSON.stringify(tombstone)}::text::jsonb
         WHERE id = ${id}`,
      refusedWith(TRIGGER),
      field,
    );
  }
  assert.notEqual((await row()).evidence, null, 'nothing was redacted by a refused statement');
});

test('the four names change only to null, only all together, and only with the payload', async (t) => {
  const { as, id, row } = await setup(t);
  // Partial nulling, and a name changed to something other than null, are both refused.
  for (const partial of [
    { ref: null },
    { ref: null, event_name: null, workflow_ref: null },
    { ref: 'refs/heads/other' },
  ]) {
    const value = { ...submitter(), ...partial };
    await assert.rejects(
      as.retention`
        UPDATE evidence.evidence_envelope SET evidence = NULL, submitted_by = ${JSON.stringify(value)}::text::jsonb
         WHERE id = ${id}`,
      refusedWith(TRIGGER),
      JSON.stringify(partial),
    );
  }
  // The full tombstone, supplied by the statement, is accepted and is what the trigger would set.
  const tombstone = { ...submitter(), ...Object.fromEntries(NULLED.map((f) => [f, null])) };
  await as.retention`
    UPDATE evidence.evidence_envelope SET evidence = NULL, submitted_by = ${JSON.stringify(tombstone)}::text::jsonb
     WHERE id = ${id}`;
  assert.deepEqual((await row()).submitted_by, tombstone);
});

test('a redaction that does not mention submitted_by still nulls the four names', async (t) => {
  const { as, id, row } = await setup(t);
  await as.retention`UPDATE evidence.evidence_envelope SET evidence = NULL WHERE id = ${id}`;
  const { submitted_by } = await row();
  for (const field of NULLED) assert.equal(submitted_by[field], null, field);
  for (const field of KEPT) assert.equal(submitted_by[field], submitter()[field], field);
});

test('a replay of a redacted record through the service role is a duplicate, and appends nothing', async (t) => {
  const { db, as, store, id } = await setup(t);
  await as.retention`UPDATE evidence.evidence_envelope SET evidence = NULL WHERE id = ${id}`;
  const replay = await store.append(record({ result: { pass: false } }), {
    workspace_id: 'payments-art',
  });
  assert.equal(replay.outcome, 'duplicate');
  assert.equal(replay.envelope.evidence, null);
  const [{ n }] = await db.admin`SELECT count(*)::int AS n FROM evidence.evidence_envelope`;
  assert.equal(n, 1);
});

// ---------------------------------------------------------------- AC-10: the audit queries

function auditQueries() {
  const text = readFileSync(new URL('../sql/audit-queries.sql', import.meta.url), 'utf8');
  const queries = {};
  for (const block of text.split(/^-- name: /m).slice(1)) {
    const [name, ...rest] = block.split('\n');
    queries[name.trim()] = rest.join('\n').trim();
  }
  return queries;
}

test('the two documented audit queries run as evidence_audit and answer both events', async (t) => {
  const { db, as, store, id } = await setup(t);
  await store.append(record({ change_id: 'PR-2' }), { workspace_id: 'payments-art' });
  await store.append(record({ change_id: 'PR-3' }), { workspace_id: 'another-workspace' });
  await as.retention`UPDATE evidence.evidence_envelope SET evidence = NULL WHERE id = ${id}`;
  const queries = auditQueries();
  assert.deepEqual(Object.keys(queries), ['envelopes-appended', 'payloads-redacted']);
  for (const query of Object.values(queries)) assert.doesNotMatch(query, /\bevidence\b(?!\.|_)/);
  const [{ from, until }] = await db.admin`
    SELECT statement_timestamp() - interval '1 hour' AS from, statement_timestamp() + interval '1 hour' AS until`;

  const appended = await as.audit.unsafe(queries['envelopes-appended'], [
    'payments-art',
    from,
    until,
  ]);
  assert.deepEqual(
    appended.map((r) => [r.change_id, r.redacted_at === null]),
    [
      ['PR-1', false],
      ['PR-2', true],
    ],
  );
  assert.equal(appended[0].policy_id, 'baseline@1');
  assert.equal(appended[0].submitted_by.repository_id, '74');
  const none = await as.audit.unsafe(queries['envelopes-appended'], ['payments-art', until, until]);
  assert.deepEqual([...none], [], 'the range is half-open');

  const redacted = await as.audit.unsafe(queries['payloads-redacted'], [from, until]);
  assert.equal(redacted.length, 1);
  assert.equal(redacted[0].change_id, 'PR-1');
  assert.equal(redacted[0].workspace_id, 'payments-art');
  assert.equal(redacted[0].redacted_by, 'evidence_retention');
  assert.equal(redacted[0].envelope_id, String(id));
});

test('evidence_audit cannot read a payload or write anything', async (t) => {
  const { as, id } = await setup(t);
  for (const [what, attempt] of Object.entries({
    'read the payload': as.audit`SELECT evidence FROM evidence.evidence_envelope`,
    'read everything': as.audit`SELECT * FROM evidence.evidence_envelope`,
    insert: as.audit`
      INSERT INTO evidence.evidence_envelope (envelope_version, change_id, evidence)
      VALUES ('evidence-envelope/0', 'x', '{}'::jsonb)`,
    update: as.audit`UPDATE evidence.evidence_envelope SET evidence = NULL WHERE id = ${id}`,
    'forge a redaction': as.audit`
      INSERT INTO evidence.evidence_redaction (envelope_id, redacted_at, redacted_by) VALUES (${id}, now(), 'x')`,
  }))
    await assert.rejects(attempt, refusedWith(DENIED), what);
});

// ---------------------------------------------------------------- AC-11: the grants snapshot

// The executable copy of stack.md "Access control" and threat-model MIT-16. Every privilege any
// role holds on any object in the evidence schema, on the schema, on the trigger function and on
// the database, read from the server's ACLs. PUBLIC holds nothing. A grant added or taken back
// anywhere - including the owner re-granting itself DELETE - changes this list.
const GRANTS = `
column evidence_envelope.change_id | evidence_app | INSERT
column evidence_envelope.change_id | evidence_audit | SELECT
column evidence_envelope.envelope_version | evidence_app | INSERT
column evidence_envelope.envelope_version | evidence_audit | SELECT
column evidence_envelope.evidence | evidence_app | INSERT
column evidence_envelope.evidence | evidence_retention | UPDATE
column evidence_envelope.id | evidence_audit | SELECT
column evidence_envelope.id | evidence_retention | SELECT
column evidence_envelope.policy_id | evidence_app | INSERT
column evidence_envelope.policy_id | evidence_audit | SELECT
column evidence_envelope.received_at | evidence_app | INSERT
column evidence_envelope.received_at | evidence_audit | SELECT
column evidence_envelope.received_at | evidence_retention | SELECT
column evidence_envelope.redacted_at | evidence_audit | SELECT
column evidence_envelope.redacted_at | evidence_retention | SELECT
column evidence_envelope.redacted_at | evidence_retention | UPDATE
column evidence_envelope.submitted_by | evidence_app | INSERT
column evidence_envelope.submitted_by | evidence_audit | SELECT
column evidence_envelope.submitted_by | evidence_retention | UPDATE
column evidence_envelope.workspace_id | evidence_app | INSERT
column evidence_envelope.workspace_id | evidence_audit | SELECT
database | evidence_app | CONNECT
database | evidence_audit | CONNECT
database | evidence_owner | CONNECT
database | evidence_owner | CREATE
database | evidence_owner | TEMPORARY
database | evidence_retention | CONNECT
function guard_envelope_update | evidence_owner | EXECUTE
schema evidence | evidence_app | USAGE
schema evidence | evidence_audit | USAGE
schema evidence | evidence_owner | CREATE
schema evidence | evidence_owner | USAGE
schema evidence | evidence_retention | USAGE
table evidence_envelope | evidence_app | SELECT
table evidence_envelope | evidence_owner | INSERT
table evidence_envelope | evidence_owner | REFERENCES
table evidence_envelope | evidence_owner | SELECT
table evidence_envelope | evidence_owner | TRIGGER
table evidence_envelope | evidence_owner | UPDATE
table evidence_envelope_id_seq | evidence_owner | SELECT
table evidence_envelope_id_seq | evidence_owner | UPDATE
table evidence_envelope_id_seq | evidence_owner | USAGE
table evidence_redaction | evidence_audit | SELECT
table evidence_redaction | evidence_owner | INSERT
table evidence_redaction | evidence_owner | REFERENCES
table evidence_redaction | evidence_owner | SELECT
table evidence_redaction | evidence_owner | TRIGGER
table evidence_redaction_id_seq | evidence_owner | SELECT
table evidence_redaction_id_seq | evidence_owner | UPDATE
table evidence_redaction_id_seq | evidence_owner | USAGE
table schema_migrations | evidence_app | SELECT
table schema_migrations | evidence_owner | DELETE
table schema_migrations | evidence_owner | INSERT
table schema_migrations | evidence_owner | REFERENCES
table schema_migrations | evidence_owner | SELECT
table schema_migrations | evidence_owner | TRIGGER
table schema_migrations | evidence_owner | TRUNCATE
table schema_migrations | evidence_owner | UPDATE
`
  .trim()
  .split('\n');

const grantsOf = async (sql) =>
  (
    await sql`
      WITH objects AS (
        SELECT 'table ' || c.relname AS object,
               COALESCE(c.relacl, acldefault(CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END::"char", c.relowner)) AS acl
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'evidence' AND c.relkind IN ('r', 'S', 'v', 'm', 'p', 'f')
        UNION ALL
        SELECT 'column ' || c.relname || '.' || a.attname, a.attacl
          FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'evidence' AND a.attacl IS NOT NULL
        UNION ALL
        SELECT 'schema ' || nspname, COALESCE(nspacl, acldefault('n', nspowner))
          FROM pg_namespace WHERE nspname = 'evidence'
        UNION ALL
        SELECT 'function ' || p.proname, COALESCE(p.proacl, acldefault('f', p.proowner))
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'evidence'
        UNION ALL
        SELECT 'database', COALESCE(datacl, acldefault('d', datdba))
          FROM pg_database WHERE datname = current_database()
      )
      SELECT o.object || ' | ' || CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END
             || ' | ' || x.privilege_type AS line
        FROM objects o, aclexplode(o.acl) x
       ORDER BY 1`
  ).map((row) => row.line);

test('the grants on the evidence store are exactly the recorded list, and PUBLIC holds nothing', async (t) => {
  const { db } = await setup(t);
  const actual = await grantsOf(db.admin);
  assert.deepEqual(actual, [...GRANTS].sort());
  assert.equal(
    actual.some((line) => line.includes('| PUBLIC |')),
    false,
  );
  // The snapshot sees a re-grant the owner can always make: that is why the owner gave it up.
  await db.connectAs('evidence_owner', {
    max: 1,
  })`GRANT DELETE ON evidence.evidence_envelope TO evidence_owner`;
  assert.notDeepEqual(await grantsOf(db.admin), [...GRANTS].sort());
});

// MIT-16: who can read evidence at rest. Two roles can, for two reasons: the service (it serves
// the indicators) and the owner (it owns the table). Neither the retention job nor an auditor can.
// A cluster superuser can read everything; that, backups and operator copies are deploy-target
// requirements stated in stack.md, not properties this database has.
test('exactly evidence_owner and evidence_app can read a payload at rest', async (t) => {
  const { db } = await setup(t);
  const readers = await db.admin`
    SELECT rolname FROM pg_roles
     WHERE rolname IN ('evidence_owner', 'evidence_app', 'evidence_retention', 'evidence_audit')
       AND has_column_privilege(rolname, 'evidence.evidence_envelope', 'evidence', 'SELECT')
     ORDER BY rolname`;
  assert.deepEqual(
    readers.map((row) => row.rolname),
    ['evidence_app', 'evidence_owner'],
  );
  const [{ redactions }] = await db.admin`
    SELECT array_to_string(array(
      SELECT rolname FROM pg_roles
       WHERE rolname IN ('evidence_owner', 'evidence_app', 'evidence_retention', 'evidence_audit')
         AND has_table_privilege(rolname, 'evidence.evidence_redaction', 'SELECT')
       ORDER BY rolname), ',') AS redactions`;
  assert.equal(redactions, 'evidence_audit,evidence_owner');
});
