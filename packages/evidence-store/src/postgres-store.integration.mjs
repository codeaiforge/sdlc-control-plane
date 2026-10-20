import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { closeHarness, createTestDatabase } from './pg-harness.mjs';
import { STORE_QUERY_TIMEOUT_MS, createPostgresEvidenceStore } from './postgres-store.mjs';
import { describeEvidenceStore } from './store-conformance.mjs';

// Against a real PostgreSQL 16 server (pg-harness.mjs). Fails without one; never skips.

after(() => closeHarness());

// No driver error may surface as an unhandled rejection: under Node's default that terminates
// the process (2.1 SEC-6). Any one seen while this file runs fails the last test below.
const unhandled = [];
process.on('unhandledRejection', (reason) => unhandled.push(reason));

// AC-1: the port's suite, unedited, on the PostgreSQL adapter - logged in as the service's own
// role, evidence_app, on a fresh database per test; redaction through the retention role.
describeEvidenceStore('postgres', async () => {
  const db = await createTestDatabase();
  return {
    store: createPostgresEvidenceStore({ sql: db.connectAs('evidence_app') }),
    redact: (key) => db.redact(key),
    dispose: () => db.dispose(),
  };
});

const record = (overrides = {}) => ({
  schema_version: 'evidence/0',
  change_id: 'PR-1',
  binding_used: 'origin/main..HEAD',
  computed_at: '2026-09-21T00:00:00Z',
  tier: 'T1',
  affected_set: ['packages/contracts'],
  tool: { name: 'sdlc-controls', version: 'v0.2.0' },
  verification: { verified: ['CAF-SDLC-002:tier'] },
  result: { pass: true },
  ...overrides,
});

async function database(t) {
  const db = await createTestDatabase();
  t.after(() => db.dispose());
  return db;
}

const rowsFor = async (db, workspace, change) =>
  (
    await db.connectAs('evidence_audit')`
      SELECT count(*)::int AS n FROM evidence.evidence_envelope
       WHERE workspace_id = ${workspace} AND change_id = ${change}`
  )[0].n;

// AC-3(b): uniqueness is the server's. Two independent pools, forty concurrent appends of one
// (workspace, change), some written with their keys in another order: one row, one `appended`.
test('concurrent appends of one key over two pools produce one row and one appended', async (t) => {
  const db = await database(t);
  const pools = [
    db.connectAs('evidence_app', { max: 5 }),
    db.connectAs('evidence_app', { max: 5 }),
  ];
  const stores = pools.map((sql) => createPostgresEvidenceStore({ sql, requireWorkspace: true }));
  const reordered = Object.fromEntries(Object.entries(record()).reverse());
  const results = await Promise.all(
    Array.from({ length: 40 }, (_, i) =>
      stores[i % 2].append(i % 3 === 0 ? reordered : record(), { workspace_id: 'payments-art' }),
    ),
  );
  const outcomes = results.map((result) => result.outcome).sort();
  assert.deepEqual(outcomes, ['appended', ...Array(39).fill('duplicate')]);
  assert.equal(await rowsFor(db, 'payments-art', 'PR-1'), 1);
  const stored = results.find((result) => result.outcome === 'appended').envelope;
  for (const result of results)
    assert.deepEqual(result.envelope, stored, 'every answer is the row');
});

test('concurrent conflicting bodies still leave one row, and every loser is told which it was', async (t) => {
  const db = await database(t);
  const stores = [
    db.connectAs('evidence_app', { max: 5 }),
    db.connectAs('evidence_app', { max: 5 }),
  ].map((sql) => createPostgresEvidenceStore({ sql }));
  const bodies = [record(), record({ result: { pass: false } })];
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      stores[i % 2].append(bodies[i % 2], { workspace_id: 'payments-art' }),
    ),
  );
  assert.equal(results.filter((result) => result.outcome === 'appended').length, 1);
  assert.equal(await rowsFor(db, 'payments-art', 'PR-1'), 1);
  const winner = results.find((result) => result.outcome === 'appended');
  for (const [i, result] of results.entries()) {
    if (result === winner) continue;
    const same = isDeepStrictEqual(bodies[i % 2], winner.envelope.evidence);
    assert.equal(result.outcome, same ? 'duplicate' : 'conflict');
  }
});

// AC-14 on a real server: the service's adapter refuses a null workspace before any statement.
test('requireWorkspace refuses a null workspace_id, and nothing reaches the table', async (t) => {
  const db = await database(t);
  const store = createPostgresEvidenceStore({
    sql: db.connectAs('evidence_app'),
    requireWorkspace: true,
  });
  assert.throws(() => store.append(record()), { name: 'EvidenceStoreFault' });
  const [{ n }] = await db.admin`SELECT count(*)::int AS n FROM evidence.evidence_envelope`;
  assert.equal(n, 0);
});

// M-1: bound as text and cast, the payload is stored as a jsonb object, compared as one, and read
// back value-equal (NFR-1.1).
test('the payload and the submitter are stored as jsonb objects, not as string scalars', async (t) => {
  const db = await database(t);
  const store = createPostgresEvidenceStore({ sql: db.connectAs('evidence_app') });
  await store.append(record({ upstream: { added: [1, { deeper: true }] } }), {
    workspace_id: 'payments-art',
    submitted_by: { issuer: 'https://token.actions.githubusercontent.com', run_id: '1' },
  });
  const [row] = await db.admin`
    SELECT jsonb_typeof(evidence) AS evidence, jsonb_typeof(submitted_by) AS submitter,
           evidence -> 'upstream' -> 'added' -> 1 ->> 'deeper' AS deeper
      FROM evidence.evidence_envelope`;
  assert.deepEqual({ ...row }, { evidence: 'object', submitter: 'object', deeper: 'true' });
});

test('the receipt time is the database clock, and the control plane cannot pass one', async (t) => {
  const db = await database(t);
  const store = createPostgresEvidenceStore({ sql: db.connectAs('evidence_app') });
  const [{ before }] = await db.admin`SELECT statement_timestamp() AS before`;
  const { envelope } = await store.append(record(), { workspace_id: 'payments-art' });
  const [{ afterwards }] = await db.admin`SELECT statement_timestamp() AS afterwards`;
  const stamped = Date.parse(envelope.received_at);
  assert.ok(stamped >= before.getTime() - 1 && stamped <= afterwards.getTime());
  assert.throws(
    () =>
      store.append(record({ change_id: 'PR-2' }), {
        workspace_id: 'payments-art',
        received_at: '2026-09-22T10:30:00.000Z',
      }),
    { name: 'EvidenceStoreFault' },
  );
  assert.equal((await store.list()).length, 1, 'nothing was stored');
});

// D-9: a statement held by a lock never answers; the adapter cancels it after the literal timeout
// and the next statement succeeds once the lock is gone.
test('a statement blocked past STORE_QUERY_TIMEOUT_MS becomes a fault, and the store recovers', async (t) => {
  const db = await database(t);
  const store = createPostgresEvidenceStore({ sql: db.connectAs('evidence_app') });
  // Held in a transaction on the admin connection. (Not sql.reserve(): with fetch_types off, a
  // cold reserve() never resolves in postgres.js 3.4.9 - measured; the adapter never reserves.)
  let release;
  const released = new Promise((resolve) => (release = resolve));
  let locked;
  const isLocked = new Promise((resolve) => (locked = resolve));
  const holder = db.admin.begin(async (tx) => {
    await tx`LOCK TABLE evidence.evidence_envelope IN ACCESS EXCLUSIVE MODE`;
    locked();
    await released;
  });
  await isLocked;
  const started = Date.now();
  await assert.rejects(store.append(record(), { workspace_id: 'payments-art' }), (error) => {
    assert.equal(error.name, 'EvidenceStoreFault');
    assert.match(error.message, /in time/);
    return true;
  });
  const waited = Date.now() - started;
  assert.ok(waited >= STORE_QUERY_TIMEOUT_MS - 50, `gave up after ${waited} ms`);
  assert.ok(waited < STORE_QUERY_TIMEOUT_MS + 3000, `waited ${waited} ms`);
  release();
  await holder;
  const { outcome } = await store.append(record(), { workspace_id: 'payments-art' });
  assert.equal(outcome, 'appended', 'the cancelled insert did not commit');
});

// M-9: a backend killed under the pool costs at most the one statement already bound to it - a
// fast fault, answered 503 by the seam - and the next statement reconnects. Never a crash.
test('a terminated backend fails at most one statement, quickly, and the store recovers', async (t) => {
  const db = await database(t);
  const store = createPostgresEvidenceStore({ sql: db.connectAs('evidence_app', { max: 1 }) });
  await store.append(record(), { workspace_id: 'payments-art' });
  await db.terminate('evidence_app');
  const started = Date.now();
  const first = await store
    .append(record({ change_id: 'PR-2' }), { workspace_id: 'payments-art' })
    .then(
      (result) => result.outcome,
      (error) => error.name,
    );
  assert.ok(['appended', 'EvidenceStoreFault'].includes(first), first);
  assert.ok(Date.now() - started < 1000, 'the fault is immediate, not a timeout');
  const second = await store.append(record({ change_id: 'PR-2' }), {
    workspace_id: 'payments-art',
  });
  assert.equal(second.outcome, first === 'appended' ? 'duplicate' : 'appended');
});

test('a server that refuses the role is a fault on every method, and the process stays up', async (t) => {
  const db = await database(t);
  const store = createPostgresEvidenceStore({ sql: db.connectAs('evidence_app') });
  await store.append(record(), { workspace_id: 'payments-art' });
  await db.revokeConnect('evidence_app');
  await db.terminate('evidence_app');
  for (const call of [
    () => store.append(record({ change_id: 'PR-2' }), { workspace_id: 'payments-art' }),
    () => store.list({ workspace_id: 'payments-art' }),
    () => store.listRecords(),
  ])
    await assert.rejects(call(), { name: 'EvidenceStoreFault' });
  await db.grantConnect('evidence_app');
  assert.equal((await store.list()).length, 1);
});

test('no driver error surfaced as an unhandled rejection while this file ran', async () => {
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandled, []);
});
