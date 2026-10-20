import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { loadMigrations } from './migrate.mjs';
import {
  STORE_QUERY_TIMEOUT_MS,
  StartupRefused,
  assertSchemaCurrent,
  assertServiceRole,
  createPostgresEvidenceStore,
} from './postgres-store.mjs';

// Unit tests, no database. A fake client records every statement and its bound values and answers
// from a script, so these tests can see what the adapter sends and in what order - and nothing
// about what PostgreSQL does with it. Every claim about the server (uniqueness under concurrency,
// grants, the trigger, the jsonb round trip) is postgres-store.integration.mjs's and
// database-roles.integration.mjs's, on a real PostgreSQL 16.

const SOURCE = readFileSync(new URL('./postgres-store.mjs', import.meta.url), 'utf8');
const CODE = SOURCE.split('\n')
  .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
  .join('\n');

// answer(text, values) -> rows, a rejection, or 'hang' for a query that never settles.
function fakeSql(answer = () => []) {
  const calls = [];
  const sql = (strings, ...values) => {
    const text = strings.join('$?').replace(/\s+/g, ' ').trim();
    const call = { text, values, cancelled: false };
    calls.push(call);
    let promise;
    const query = {
      cancel: () => {
        call.cancelled = true;
      },
      then: (resolve, reject) => {
        promise ??= (async () => {
          const result = await answer(text, values);
          if (result === 'hang') return new Promise(() => {});
          return result;
        })();
        return promise.then(resolve, reject);
      },
    };
    return query;
  };
  return { sql, calls };
}

const record = (overrides = {}) => ({
  schema_version: 'evidence/0',
  change_id: 'PR-1',
  ...overrides,
});
const at = new Date('2026-10-20T10:00:00.123Z');
const row = (overrides = {}) => ({
  envelope_version: 'evidence-envelope/0',
  workspace_id: 'payments-art',
  change_id: 'PR-1',
  received_at: at,
  policy_id: 'p@1',
  submitted_by: { run_id: '1' },
  evidence: record(),
  redacted_at: null,
  ...overrides,
});

test('the adapter builds no SQL text: no raw-text or identifier helper, no concatenated query', () => {
  assert.doesNotMatch(CODE, /\.unsafe\s*\(/);
  assert.doesNotMatch(CODE, /\bsql\s*\(/, 'sql(...) is the identifier/values helper');
  assert.doesNotMatch(CODE, /\bsql\s*\.\s*(?!begin\b)\w+\s*\(/, 'no other driver helper');
  // Every statement is a tagged template literal; no template is assembled from pieces.
  const tagged = [...CODE.matchAll(/\bsql`/g)].length;
  assert.ok(tagged >= 7, `expected the adapter's statements as tagged templates, saw ${tagged}`);
  assert.doesNotMatch(CODE, /['"`]\s*\+\s*\w|\w\s*\+\s*['"`]\s*(SELECT|INSERT|WHERE)/i);
});

test('every jsonb value is bound as text and cast, never bound to a jsonb parameter', () => {
  const casts = [...CODE.matchAll(/\$\{[^}]+\}(::[a-z]+)+/g)].map((match) => match[0]);
  const jsonb = casts.filter((cast) => cast.endsWith('::jsonb'));
  assert.equal(jsonb.length, 3, 'submitted_by, evidence on insert, evidence on compare');
  for (const cast of jsonb) assert.match(cast, /::text::jsonb$/, cast);
});

test('the store timeout is a reviewed literal and nothing here reads the environment', () => {
  assert.equal(STORE_QUERY_TIMEOUT_MS, 5000);
  assert.match(SOURCE, /export const STORE_QUERY_TIMEOUT_MS = 5000;/);
  for (const spelling of [/\bprocess\b/, /['"]node:process['"]/, /import\.meta\.env/])
    assert.doesNotMatch(CODE, spelling);
});

test('the store has exactly the port methods, and needs a client', () => {
  const { sql } = fakeSql();
  assert.deepEqual(Object.keys(createPostgresEvidenceStore({ sql })).sort(), [
    'append',
    'list',
    'listRecords',
  ]);
  assert.throws(() => createPostgresEvidenceStore({}), TypeError);
});

test('a record fault is a TypeError, decided before any statement is sent', () => {
  const { sql, calls } = fakeSql();
  const store = createPostgresEvidenceStore({ sql });
  const cyclic = record();
  cyclic.self = cyclic;
  for (const bad of [
    null,
    ['PR-1'],
    'PR-1',
    cyclic,
    record({ change_id: '' }),
    record({ change_id: 7 }),
    record({ note: 'nul\u0000' }),
    record({ ['k\ud800']: 1 }),
  ])
    assert.throws(() => store.append(bad, { workspace_id: 'payments-art' }), TypeError);
  assert.deepEqual(calls, []);
});

test("an envelope-option fault is the control plane's, decided before any statement is sent", () => {
  const { sql, calls } = fakeSql();
  const store = createPostgresEvidenceStore({ sql });
  for (const options of [
    { workspace_id: '' },
    { workspace_id: 'w\u0000' },
    { policy_id: 3 },
    { submitted_by: [] },
    { received_at: 'yesterday' },
    { received_at: 1700000000 },
    // The database stamps received_at; even a well-formed one is refused, never stored.
    { received_at: '2026-09-22T10:30:00.000Z' },
  ])
    assert.throws(
      () => store.append(record(), { workspace_id: 'payments-art', ...options }),
      (error) => error.name === 'EvidenceStoreFault',
      JSON.stringify(options),
    );
  assert.deepEqual(calls, []);
});

test('requireWorkspace refuses a null workspace_id before any statement; without it the row is sent', async () => {
  const required = fakeSql();
  const strict = createPostgresEvidenceStore({ sql: required.sql, requireWorkspace: true });
  assert.throws(
    () => strict.append(record()),
    (error) =>
      error.name === 'EvidenceStoreFault' && /workspace_id is required/.test(error.message),
  );
  assert.throws(() => strict.append(record(), { workspace_id: null }), {
    name: 'EvidenceStoreFault',
  });
  assert.deepEqual(required.calls, []);

  const lenient = fakeSql(() => [row({ workspace_id: null })]);
  const { outcome, key } = await createPostgresEvidenceStore({ sql: lenient.sql }).append(record());
  assert.equal(outcome, 'appended');
  assert.equal(key, null);
  assert.equal(lenient.calls.length, 1);
});

test('an append is one INSERT; nothing is read before it, so there is no select-then-insert path', async () => {
  const { sql, calls } = fakeSql(() => [row()]);
  const store = createPostgresEvidenceStore({ sql });
  const result = await store.append(record({ extra: { b: 1, a: 2 } }), {
    workspace_id: 'payments-art',
    policy_id: 'p@1',
    submitted_by: { run_id: '1' },
  });
  assert.equal(result.outcome, 'appended');
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /^INSERT INTO evidence\.evidence_envelope/);
  assert.match(calls[0].text, /ON CONFLICT ON CONSTRAINT evidence_envelope_idempotency DO NOTHING/);
  // Every value is a bound parameter, in order; none of them is in the statement text.
  // received_at is not among them: the column default stamps it (the service holds no INSERT on it).
  assert.doesNotMatch(calls[0].text, /received_at[^]*VALUES/);
  assert.deepEqual(calls[0].values, [
    'evidence-envelope/0',
    'payments-art',
    'PR-1',
    'p@1',
    '{"run_id":"1"}',
    JSON.stringify(record({ extra: { b: 1, a: 2 } })),
  ]);
  for (const value of calls[0].values.filter((v) => typeof v === 'string'))
    assert.equal(calls[0].text.includes(value), false, value);
});

test('a key that exists is looked up after the INSERT and answered from the stored row', async () => {
  for (const [same, outcome] of [
    [true, 'duplicate'],
    [false, 'conflict'],
  ]) {
    const { sql, calls } = fakeSql((text) =>
      text.startsWith('INSERT') ? [] : [row({ submitted_by: { run_id: 'first' }, same })],
    );
    const result = await createPostgresEvidenceStore({ sql }).append(record(), {
      workspace_id: 'payments-art',
      submitted_by: { run_id: 'second' },
    });
    assert.equal(result.outcome, outcome);
    assert.deepEqual(
      result.envelope.submitted_by,
      { run_id: 'first' },
      'the first submitter stands',
    );
    assert.equal(Object.hasOwn(result.envelope, 'same'), false);
    assert.deepEqual(
      calls.map((call) => call.text.split(' ')[0]),
      ['INSERT', 'SELECT'],
    );
    assert.deepEqual(calls[1].values, [JSON.stringify(record()), 'payments-art', 'PR-1']);
  }
});

test('a lookup that finds no row after DO NOTHING is a fault, not a guess', async () => {
  const { sql } = fakeSql(() => []);
  await assert.rejects(
    createPostgresEvidenceStore({ sql }).append(record(), { workspace_id: 'payments-art' }),
    { name: 'EvidenceStoreFault' },
  );
});

test('a driver rejection becomes an EvidenceStoreFault that keeps the cause out of its message', async () => {
  const driverError = Object.assign(new Error('password authentication failed CANARY-SECRET'), {
    code: '28P01',
  });
  const { sql } = fakeSql(() => Promise.reject(driverError));
  const store = createPostgresEvidenceStore({ sql });
  for (const call of [
    () => store.append(record(), { workspace_id: 'payments-art' }),
    () => store.list(),
    () => store.list({ workspace_id: 'payments-art' }),
    () => store.listRecords(),
  ]) {
    const error = await call().then(
      () => assert.fail('expected a rejection'),
      (rejection) => rejection,
    );
    assert.equal(error.name, 'EvidenceStoreFault');
    assert.equal(error instanceof TypeError, false);
    assert.equal(error.cause, driverError);
    assert.doesNotMatch(error.message, /CANARY|password|28P01/);
  }
});

test('a statement with no answer in STORE_QUERY_TIMEOUT_MS is cancelled and becomes a fault', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { sql, calls } = fakeSql(() => 'hang');
  const pending = createPostgresEvidenceStore({ sql }).append(record(), {
    workspace_id: 'payments-art',
  });
  let settled = false;
  pending.then(
    () => (settled = true),
    () => (settled = true),
  );
  await Promise.resolve();
  t.mock.timers.tick(STORE_QUERY_TIMEOUT_MS - 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'not before the timeout');
  t.mock.timers.tick(1);
  await assert.rejects(
    pending,
    (error) => error.name === 'EvidenceStoreFault' && /in time/.test(error.message),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls[0].cancelled, true, 'the statement was cancelled');
});

test('rows are read back in the port key order, timestamps as ISO strings, deep-frozen', async () => {
  const redactedAt = new Date('2026-10-21T00:00:00.000Z');
  const { sql } = fakeSql(() => [
    row(),
    row({ workspace_id: null, change_id: 'PR-2', evidence: null, redacted_at: redactedAt }),
  ]);
  const [first, second] = await createPostgresEvidenceStore({ sql }).list();
  assert.deepEqual(Object.keys(first), [
    'envelope_version',
    'workspace_id',
    'received_at',
    'idempotency_key',
    'policy_id',
    'submitted_by',
    'evidence',
    'redacted_at',
  ]);
  assert.equal(first.received_at, '2026-10-20T10:00:00.123Z');
  assert.equal(first.idempotency_key, '["payments-art","PR-1"]');
  assert.equal(first.redacted_at, null);
  assert.equal(second.idempotency_key, null);
  assert.equal(second.redacted_at, '2026-10-21T00:00:00.000Z');
  assert.throws(() => {
    first.evidence.change_id = 'PR-x';
  }, TypeError);
  assert.throws(() => {
    first.submitted_by.run_id = '2';
  }, TypeError);
});

test('list() binds its workspace filter, refuses a non-string one before any statement, and orders by id', async () => {
  const { sql, calls } = fakeSql(() => []);
  const store = createPostgresEvidenceStore({ sql });
  for (const filter of [null, 7, { $ne: 'x' }])
    assert.throws(() => store.list({ workspace_id: filter }), TypeError);
  assert.deepEqual(calls, []);
  await store.list({ workspace_id: "payments-art' OR '1'='1" });
  assert.deepEqual(calls[0].values, ["payments-art' OR '1'='1"]);
  assert.match(calls[0].text, /WHERE workspace_id = \$\? ORDER BY id$/);
  await store.list();
  assert.match(calls[1].text, /ORDER BY id$/);
  assert.deepEqual(calls[1].values, []);
  await store.listRecords();
  assert.match(calls[2].text, /WHERE evidence IS NOT NULL ORDER BY id$/);
});

// D-16 against a fake catalog. Which rows a real server returns for each role is
// database-roles.integration.mjs's; this pins what the check does with them.
const roleRow = (overrides = {}) => ({
  superuser: false,
  attributes: false,
  member: false,
  schema_present: true,
  owns: false,
  ssl: true,
  ...overrides,
});
function catalog(role, privileges = { rewrites: false, appends: true }) {
  return fakeSql((text) => (text.includes('pg_stat_ssl') ? [role] : [privileges])).sql;
}
const refused = (code) => (error) => error instanceof StartupRefused && error.code === code;

test('startup refuses a superuser, an elevated role, a member, an owner, a role that could rewrite, and one that cannot append', async () => {
  await assertServiceRole(catalog(roleRow()));
  for (const [sql, code] of [
    [catalog(roleRow({ superuser: true })), 'role-unsafe'],
    [catalog(roleRow({ attributes: true })), 'role-unsafe'],
    [catalog(roleRow({ member: true })), 'role-unsafe'],
    [catalog(roleRow({ owns: true })), 'role-unsafe'],
    [catalog(roleRow(), { rewrites: true, appends: true }), 'role-unsafe'],
    [catalog(roleRow(), { rewrites: false, appends: false }), 'role-unsafe'],
    [catalog(roleRow({ schema_present: false })), 'schema-mismatch'],
    [catalog(undefined), 'schema-mismatch'],
  ])
    await assert.rejects(assertServiceRole(sql), refused(code));
});

// What a real server answers for each attribute, membership and grant is
// database-roles.integration.mjs's; this pins that the statement asks for every one of them.
test('the startup check reads every role attribute, any membership, and both stamped columns', async () => {
  const { sql, calls } = fakeSql((text) =>
    text.includes('pg_stat_ssl') ? [roleRow()] : [{ rewrites: false, appends: true }],
  );
  await assertServiceRole(sql);
  const [attributes, privileges] = calls.map((call) => call.text);
  for (const read of [
    'r.rolsuper',
    'r.rolcreaterole',
    'r.rolcreatedb',
    'r.rolreplication',
    'r.rolbypassrls',
    'pg_catalog.pg_auth_members m WHERE m.member = r.oid',
    'd.datdba = r.oid',
  ])
    assert.ok(attributes.includes(read), read);
  for (const column of ['received_at', 'redacted_at'])
    assert.ok(
      privileges.includes(`'evidence.evidence_envelope', '${column}', 'INSERT'`),
      `INSERT on ${column}`,
    );
});

test('startup refuses a connection that did not negotiate TLS where TLS is required (AC-24)', async () => {
  await assert.rejects(
    assertServiceRole(catalog(roleRow({ ssl: false })), { requireTls: true }),
    refused('tls-not-negotiated'),
  );
  await assert.rejects(
    assertServiceRole(catalog(roleRow({ ssl: false }))),
    refused('tls-not-negotiated'),
  );
  await assertServiceRole(catalog(roleRow({ ssl: false })), { requireTls: false });
  assert.equal(
    new StartupRefused('tls-not-negotiated').message,
    'control plane refused to start: tls-not-negotiated',
  );
});

test('startup refuses a schema that is not exactly the bundled migrations', async () => {
  const bundled = loadMigrations().map(({ version, checksum }) => ({ version, checksum }));
  const schema = (present, rows) =>
    fakeSql((text) => (text.includes('to_regclass') ? [{ present }] : rows)).sql;
  await assertSchemaCurrent(schema(true, bundled));
  for (const sql of [
    schema(false, bundled),
    schema(true, []),
    schema(true, [...bundled, { version: bundled.length + 1, checksum: 'f'.repeat(64) }]),
    schema(
      true,
      bundled.map((entry) => ({ ...entry, checksum: '0'.repeat(64) })),
    ),
  ])
    await assert.rejects(assertSchemaCurrent(sql), refused('schema-mismatch'));
});
