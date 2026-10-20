import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ENVELOPE_VERSION,
  EvidenceStoreFault,
  canonicalText,
  createInMemoryEvidenceLog,
  createInMemoryEvidenceStore,
  idempotencyKey,
  isStorableString,
  project,
} from './evidence-store.mjs';
import { describeEvidenceStore } from './store-conformance.mjs';

// The port contract, run against the in-memory adapter. postgres-store.integration.mjs runs the
// same suite against the PostgreSQL adapter on a real server; if either had to edit the suite to
// pass, the adapter and the port would have diverged. The bundle carries the in-memory redaction,
// which is not a store method (see createInMemoryEvidenceLog).
describeEvidenceStore('in-memory', () => createInMemoryEvidenceLog());

// Below: the parts that are this adapter's own, and are not portable claims about every store.

test('the default clock stamps a receipt time the store itself produced', () => {
  const before = Date.now();
  const { envelope } = createInMemoryEvidenceStore().append({ change_id: 'PR-1' });
  const stamped = Date.parse(envelope.received_at);
  assert.ok(Number.isFinite(stamped), 'received_at must be a parseable ISO timestamp');
  assert.equal(envelope.received_at, new Date(stamped).toISOString());
  assert.ok(stamped >= before && stamped <= Date.now(), 'received_at is outside the call window');
});

test('an injected clock is the only source of received_at', () => {
  const store = createInMemoryEvidenceStore({ now: () => '2026-09-22T09:00:00.000Z' });
  const { envelope } = store.append({ change_id: 'PR-1', received_at: '1999-01-01T00:00:00.000Z' });
  assert.equal(envelope.received_at, '2026-09-22T09:00:00.000Z');
  assert.equal(store.list()[0].received_at, '2026-09-22T09:00:00.000Z');
});

test('a caller-supplied received_at overrides the clock, but a submitted field never can', () => {
  // The control plane owns this option; the submitter does not reach it. It exists so 2.2 can
  // stamp the receipt time once, at the transport boundary, and pass the same value to the store.
  const store = createInMemoryEvidenceStore({ now: () => '2026-09-22T09:00:00.000Z' });
  const { envelope } = store.append(
    { change_id: 'PR-1', received_at: '1999-01-01T00:00:00.000Z' },
    { received_at: '2026-09-22T10:30:00.000Z' },
  );
  assert.equal(envelope.received_at, '2026-09-22T10:30:00.000Z');
});

test('a record that is not a non-null, non-array object is refused before anything is stored', () => {
  const store = createInMemoryEvidenceStore();
  for (const notARecord of [null, undefined, 'PR-1', 42, true, ['PR-1'], () => 'PR-1']) {
    assert.throws(() => store.append(notARecord), TypeError);
  }
  assert.deepEqual(store.list(), []);
});

test('the exported key encodes the pair rather than joining it', () => {
  assert.equal(idempotencyKey('payments-art', 'PR-1'), '["payments-art","PR-1"]');
  assert.notEqual(idempotencyKey('a|b', 'c'), idempotencyKey('a', 'b|c'));
  assert.equal(['a|b', 'c'].join('|'), ['a', 'b|c'].join('|'));
});

test('the envelope version is the one the port exports', () => {
  const { envelope } = createInMemoryEvidenceStore().append({ change_id: 'PR-1' });
  assert.equal(envelope.envelope_version, ENVELOPE_VERSION);
  assert.deepEqual(Object.keys(envelope), [
    'envelope_version',
    'workspace_id',
    'received_at',
    'idempotency_key',
    'policy_id',
    'submitted_by',
    'evidence',
    'redacted_at',
  ]);
  // submitted_by (task 2.1) and redacted_at (task 2.2) joined the envelope without a version
  // bump (ADR-0004's argument): no envelope was durable before 2.2, so no stored
  // evidence-envelope/0 ever lacks either.
  assert.equal(ENVELOPE_VERSION, 'evidence-envelope/0');
  assert.equal(envelope.submitted_by, null);
});

// The portable suite can only compare a replay against what the store holds, because it has no
// way to control a PostgreSQL adapter's clock. On this adapter both appends land in the same
// millisecond, so an envelope fabricated for the replay and stamped with a fresh now() compares
// equal on every field and the suite's assertions cannot see it. An advancing clock can, and
// this is the adapter whose clock the test owns.
test('a duplicate hands back the stored envelope, not one minted for the replay', () => {
  let tick = 0;
  const store = createInMemoryEvidenceStore({
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
  });
  const record = { schema_version: 'evidence/0', change_id: 'PR-1' };
  const first = store.append(record, { workspace_id: 'payments-art' });
  const replay = store.append(record, { workspace_id: 'payments-art' });
  assert.equal(first.outcome, 'appended');
  assert.equal(replay.outcome, 'duplicate');
  assert.equal(replay.envelope.received_at, first.envelope.received_at);
  assert.notEqual(
    replay.envelope.received_at,
    new Date(Date.UTC(2026, 0, 1, 0, 0, 1)).toISOString(),
  );
  assert.equal(store.list().length, 1);
});

test('the in-memory redaction takes its time from the injected clock and freezes the tombstone', () => {
  let tick = 0;
  const { store, redact } = createInMemoryEvidenceLog({
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
  });
  store.append({ change_id: 'PR-1' }, { workspace_id: 'payments-art' });
  assert.equal(redact({ workspace_id: 'payments-art', change_id: 'PR-1' }), true);
  const [tombstone] = store.list();
  assert.equal(tombstone.received_at, '2026-01-01T00:00:00.000Z');
  assert.equal(tombstone.redacted_at, '2026-01-01T00:00:01.000Z');
  assert.equal(Object.isFrozen(tombstone), true);
  assert.equal(tombstone.submitted_by, null, 'no submitter is invented for a null one');
  assert.equal(store.listRecords().length, 0);
});

test('redaction is not reachable through the store, and two logs share nothing', () => {
  const first = createInMemoryEvidenceLog();
  const second = createInMemoryEvidenceLog();
  first.store.append({ change_id: 'PR-1' }, { workspace_id: 'payments-art' });
  assert.equal(second.redact({ workspace_id: 'payments-art', change_id: 'PR-1' }), false);
  assert.equal(first.store.list()[0].evidence.change_id, 'PR-1');
  assert.equal(Object.hasOwn(first.store, 'redact'), false);
  assert.deepEqual(Object.keys(createInMemoryEvidenceStore()).sort(), [
    'append',
    'list',
    'listRecords',
  ]);
});

test('a null workspace_id envelope has no key and cannot be redacted by one', () => {
  const { store, redact } = createInMemoryEvidenceLog();
  store.append({ change_id: 'PR-1' });
  assert.equal(redact({ workspace_id: null, change_id: 'PR-1' }), false);
  assert.equal(store.list()[0].evidence.change_id, 'PR-1');
});

test('the canonical text ignores key order and nothing else', () => {
  assert.equal(
    canonicalText({ b: 1, a: { d: [2, 1], c: null } }),
    '{"a":{"c":null,"d":[2,1]},"b":1}',
  );
  assert.equal(canonicalText({ a: 1, b: 2 }), canonicalText({ b: 2, a: 1 }));
  assert.notEqual(canonicalText({ a: [1, 2] }), canonicalText({ a: [2, 1] }));
  assert.notEqual(canonicalText({ a: 1 }), canonicalText({ a: '1' }));
  // An own __proto__ key from JSON.parse stays an own key through the sort.
  const parsed = JSON.parse('{"__proto__":{"x":1},"a":1}');
  assert.equal(canonicalText(parsed), '{"__proto__":{"x":1},"a":1}');
});

test('the storable-string predicate refuses U+0000 and unpaired surrogates only', () => {
  for (const ok of ['', 'plain', 'é ☃', '\ud83d\ude00', '\\u0000 is six characters'])
    assert.equal(isStorableString(ok), true, JSON.stringify(ok));
  for (const bad of ['\u0000', 'a\u0000b', '\ud800', '\udfff', 'x\ud83d', '\ude00\ud83d'])
    assert.equal(isStorableString(bad), false, JSON.stringify(bad));
  assert.equal(isStorableString(42), false);
});

test('project() refuses an unstorable string as a TypeError, wherever it sits', () => {
  for (const record of [
    { change_id: '\u0000' },
    { deep: [[[{ v: '\ud800' }]]] },
    { ['k\u0000']: 1 },
    { nested: { ['\udc00']: 1 } },
  ])
    assert.throws(() => project(record), TypeError);
  // The walk is iterative: a record as deep as JSON.stringify accepts is walked without a
  // RangeError, which the seam would not read as a record fault.
  let deep = 'x';
  for (let i = 0; i < 3000; i += 1) deep = [deep];
  assert.doesNotThrow(() => project({ change_id: 'PR-1', deep }));
});

test("EvidenceStoreFault is the control plane's fault, not a TypeError", () => {
  const fault = new EvidenceStoreFault('down', { cause: new Error('ECONNREFUSED') });
  assert.equal(fault.name, 'EvidenceStoreFault');
  assert.equal(fault instanceof TypeError, false);
  assert.equal(fault.cause.message, 'ECONNREFUSED');
});
