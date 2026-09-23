import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ENVELOPE_VERSION,
  createInMemoryEvidenceStore,
  idempotencyKey,
} from './evidence-store.mjs';
import { describeEvidenceStore } from './store-conformance.mjs';

// The port contract, run against the adapter 1.2 ships. Task 2.2 adds one more line like this
// one for the PostgreSQL adapter; if it has to edit the suite to make it pass, the adapter and
// the port have diverged and ADR-0002's claim that 2.2 writes against a tested contract is wrong.
describeEvidenceStore('in-memory', () => createInMemoryEvidenceStore());

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
    'payload_sha256',
    'evidence',
  ]);
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
