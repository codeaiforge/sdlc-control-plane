import assert from 'node:assert/strict';
import test from 'node:test';

// The contract every evidence-store adapter has to satisfy, written once so the in-memory
// adapter shipped in 1.2 and the PostgreSQL adapter written in 2.2 are held to the same claims
// rather than to two descriptions of the same claims. ADR-0002 is the reasoning behind it.
//
// Three properties keep it portable:
//
// 1. It takes a factory, not a store, so every test gets a fresh instance and the order the
//    runner happens to pick cannot make one test depend on another's appends.
// 2. Every store call is awaited. `await` on a synchronous value is a no-op, so the in-memory
//    adapter passes an awaiting suite unchanged, and 2.2's async adapter passes this same file
//    unedited. The one deliberate exception is the synchronous-reads test, which says so.
// 3. It imports nothing from packages/contracts and nothing adapter-specific, and every fixture
//    below is an inline literal. An import of the contracts package would take that project's
//    fan-in from 2 to 3, which flips its `shared` flag and permanently retiers every future
//    change under it; and a fixture that followed the contracts package would follow a version
//    bump silently, which is the drift these tests exist to notice.

const evidenceRecord = (overrides = {}) => ({
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

const WORKSPACE = 'payments-art';

// The factory may be sync or async, and may return a store or a { store, dispose } pair — 2.2's
// adapter has a connection to close, and a suite that leaked one per test would exhaust the pool
// long before it ran out of tests. `append` is the discriminator: a store has one, a pair does not.
async function openStore(t, createStore) {
  const created = await createStore();
  const { store, dispose } = typeof created?.append === 'function' ? { store: created } : created;
  if (dispose) t.after(() => dispose());
  return store;
}

export function describeEvidenceStore(name, createStore) {
  test(`${name}: an appended record is readable in append order`, async (t) => {
    const store = await openStore(t, createStore);
    await store.append(evidenceRecord({ change_id: 'PR-1' }));
    await store.append(evidenceRecord({ change_id: 'PR-2' }));
    const stored = await store.list();
    assert.deepEqual(
      stored.map((envelope) => envelope.evidence.change_id),
      ['PR-1', 'PR-2'],
    );
  });

  test(`${name}: mutating the caller's object after the append does not reach the store`, async (t) => {
    const store = await openStore(t, createStore);
    const submitted = evidenceRecord();
    await store.append(submitted);
    submitted.result.pass = false;
    submitted.change_id = 'PR-rewritten';
    submitted.affected_set.push('packages/forged');
    const [envelope] = await store.list();
    assert.equal(envelope.evidence.result.pass, true);
    assert.equal(envelope.evidence.change_id, 'PR-1');
    assert.deepEqual(envelope.evidence.affected_set, ['packages/contracts']);
  });

  test(`${name}: a returned envelope cannot be mutated`, async (t) => {
    // Object.freeze is shallow, so a store that froze only the envelope would leave
    // envelope.evidence.result.pass writable — and a write there restates a published indicator.
    const store = await openStore(t, createStore);
    const { envelope } = await store.append(evidenceRecord());
    assert.throws(() => {
      envelope.evidence.result.pass = false;
    }, TypeError);
    assert.throws(() => {
      envelope.evidence.affected_set.push('packages/forged');
    }, TypeError);
    const [stored] = await store.list();
    assert.equal(stored.evidence.result.pass, true);
    assert.deepEqual(stored.evidence.affected_set, ['packages/contracts']);
  });

  test(`${name}: mutating the array a read returns does not affect the store`, async (t) => {
    const store = await openStore(t, createStore);
    await store.append(evidenceRecord());
    const first = await store.list();
    first.pop();
    first.push('not an envelope at all');
    const second = await store.list();
    assert.equal(second.length, 1);
    assert.equal(second[0].evidence.change_id, 'PR-1');
  });

  test(`${name}: what is stored is the JSON projection of the record`, async (t) => {
    // A jsonb column reshapes values on the way in. An adapter that kept a Date as a Date, or
    // kept an undefined-valued key, would accept records the durable store silently rewrites.
    const store = await openStore(t, createStore);
    await store.append(
      evidenceRecord({
        computed_at: new Date('2026-09-21T00:00:00.000Z'),
        dropped_by_json: undefined,
      }),
    );
    const [envelope] = await store.list();
    assert.equal(envelope.evidence.computed_at, '2026-09-21T00:00:00.000Z');
    assert.equal(Object.hasOwn(envelope.evidence, 'dropped_by_json'), false);
  });

  test(`${name}: a record that cannot be serialised is refused and nothing is stored`, async (t) => {
    const store = await openStore(t, createStore);
    const cyclic = evidenceRecord();
    cyclic.self = cyclic;
    await assert.rejects(async () => store.append(cyclic), TypeError);
    assert.deepEqual(await store.list(), []);
  });

  test(`${name}: a record without a non-empty string change_id is refused`, async (t) => {
    const store = await openStore(t, createStore);
    const unkeyable = [
      evidenceRecord({ change_id: undefined }),
      evidenceRecord({ change_id: '' }),
      evidenceRecord({ change_id: 42 }),
      evidenceRecord({ change_id: null }),
      evidenceRecord({ change_id: ['PR-1'] }),
    ];
    for (const record of unkeyable) {
      await assert.rejects(
        async () => store.append(record, { workspace_id: WORKSPACE }),
        TypeError,
      );
    }
    assert.deepEqual(await store.list(), []);
  });

  test(`${name}: a replay of the same key and the same body is a duplicate`, async (t) => {
    const store = await openStore(t, createStore);
    const first = await store.append(evidenceRecord(), { workspace_id: WORKSPACE });
    assert.equal(first.outcome, 'appended');
    const replay = await store.append(evidenceRecord(), { workspace_id: WORKSPACE });
    assert.equal(replay.outcome, 'duplicate');
    assert.equal(replay.key, first.key);
    assert.equal(replay.envelope.received_at, first.envelope.received_at);
    assert.equal((await store.list()).length, 1);
    // Compared against what is actually stored, not only against the first return value: an
    // adapter that fabricated a fresh envelope for the replay would satisfy every assertion
    // above, since the fabrication would copy the fields they read.
    assert.deepEqual(replay.envelope, (await store.list())[0]);
  });

  test(`${name}: the same key with a different body is a conflict and the first record stands`, async (t) => {
    const store = await openStore(t, createStore);
    await store.append(evidenceRecord(), { workspace_id: WORKSPACE });
    const conflicting = await store.append(evidenceRecord({ result: { pass: false } }), {
      workspace_id: WORKSPACE,
    });
    assert.equal(conflicting.outcome, 'conflict');
    assert.equal(
      conflicting.envelope.evidence.result.pass,
      true,
      'the first record is authoritative; the conflicting body is not stored',
    );
    assert.equal((await store.list()).length, 1);
  });

  test(`${name}: the key does not alias two pairs that a delimiter join would merge`, async (t) => {
    // ['a|b','c'].join('|') === ['a','b|c'].join('|'), so a joined key would drop one of these
    // two records as a replay of the other.
    const store = await openStore(t, createStore);
    const left = await store.append(evidenceRecord({ change_id: 'c' }), { workspace_id: 'a|b' });
    const right = await store.append(evidenceRecord({ change_id: 'b|c' }), { workspace_id: 'a' });
    assert.equal(left.outcome, 'appended');
    assert.equal(right.outcome, 'appended');
    assert.notEqual(left.key, right.key);
    assert.equal((await store.list()).length, 2);
  });

  test(`${name}: a change_id that names an inherited property is keyed like any other`, async (t) => {
    // change_id is caller-controlled. A plain-object index resolves 'constructor' to an
    // inherited function, so the first submission carrying it would be answered as a replay of
    // a record that was never appended.
    const store = await openStore(t, createStore);
    const inherited = ['__proto__', 'constructor', 'toString'];
    for (const change_id of inherited) {
      const { outcome } = await store.append(evidenceRecord({ change_id }), {
        workspace_id: WORKSPACE,
      });
      assert.equal(outcome, 'appended', `change_id "${change_id}" was not appended`);
    }
    assert.deepEqual(
      (await store.list()).map((envelope) => envelope.evidence.change_id),
      inherited,
    );
    for (const change_id of inherited) {
      const { outcome } = await store.append(evidenceRecord({ change_id }), {
        workspace_id: WORKSPACE,
      });
      assert.equal(outcome, 'duplicate', `change_id "${change_id}" did not replay as itself`);
    }
    assert.equal((await store.list()).length, 3);
  });

  test(`${name}: without a workspace_id no uniqueness is claimed`, async (t) => {
    // There is no identity to be unique against until 2.1 authenticates one, and keying on
    // [null, change_id] would make two unrelated workspaces collide on a shared change_id.
    const store = await openStore(t, createStore);
    const first = await store.append(evidenceRecord());
    const second = await store.append(evidenceRecord());
    assert.equal(first.outcome, 'appended');
    assert.equal(second.outcome, 'appended');
    assert.equal(first.key, null);
    assert.equal(second.key, null);
    const stored = await store.list();
    assert.equal(stored.length, 2);
    for (const envelope of stored) assert.equal(envelope.idempotency_key, null);
  });

  test(`${name}: received_at is the store's clock, not a field in the record`, async (t) => {
    // A submitter that sets its own receipt time sets its own retention clock with it.
    const store = await openStore(t, createStore);
    const backdated = '1999-01-01T00:00:00.000Z';
    const { envelope } = await store.append(evidenceRecord({ received_at: backdated }));
    assert.notEqual(envelope.received_at, backdated);
    assert.equal(typeof envelope.received_at, 'string');
    assert.ok(
      Number.isFinite(Date.parse(envelope.received_at)),
      'received_at must be a parseable timestamp',
    );
    assert.equal(
      envelope.evidence.received_at,
      backdated,
      'the submitted field is preserved in the payload; it is just not the receipt time',
    );
  });

  test(`${name}: listRecords() returns the payloads in append order and nothing else`, async (t) => {
    const store = await openStore(t, createStore);
    await store.append(evidenceRecord({ change_id: 'PR-1' }));
    await store.append(evidenceRecord({ change_id: 'PR-2' }));
    const records = await store.listRecords();
    assert.deepEqual(
      records.map((record) => record.change_id),
      ['PR-1', 'PR-2'],
    );
    assert.deepEqual(
      records,
      (await store.list()).map((envelope) => envelope.evidence),
    );
    for (const record of records) {
      assert.equal(Object.hasOwn(record, 'envelope_version'), false);
      assert.equal(Object.hasOwn(record, 'idempotency_key'), false);
    }
  });

  test(`${name}: reads are synchronous`, async (t) => {
    // The one call in this suite that is deliberately not awaited. GET /v1/indicators summarises
    // store.listRecords() inside a synchronous send(), so a read that returned a promise today
    // would serialise a pending promise into the response body. This is the test task 2.2
    // deletes in the same change that makes reads async and awaits them at the seam.
    const store = await openStore(t, createStore);
    await store.append(evidenceRecord());
    const envelopes = store.list();
    const records = store.listRecords();
    assert.equal(Array.isArray(envelopes), true);
    assert.equal(Array.isArray(records), true);
    assert.notEqual(typeof envelopes.then, 'function');
    assert.notEqual(typeof records.then, 'function');
  });

  // NFR-6.1's first clause is "retain the approving decision reference". A store that keeps the
  // record but not the policy that accepted it can say when evidence arrived and not under which
  // approved policy - and guardrails.json is editable between two appends, so the answer is not
  // recoverable from the record alone afterwards. 2.2's adapter must carry this column.
  test(`${name}: the approving policy is retained with the record`, async (t) => {
    const store = await openStore(t, createStore);
    await store.append(evidenceRecord(), { policy_id: 'baseline-engineering-controls@1' });
    await store.append({ ...evidenceRecord(), change_id: 'PR-2' });
    const [first, second] = await store.list();
    assert.equal(first.policy_id, 'baseline-engineering-controls@1');
    assert.equal(second.policy_id, null, 'absent rather than guessed when no policy is named');
  });

  // Retention redacts the payload and keeps the identity, so an adapter whose collision rule
  // reads the body stops being able to decide one the moment a row expires: a replay of an
  // expired submission would match nothing and fall to `conflict`, which ADR-0002 reserves for a
  // producer fault or tampering. The digest is the part that has to outlive the body. The
  // post-expiry replay itself is 2.2's test to write, because 1.2 implements no expiry; what is
  // pinned here is the column that test will need, and the two properties that make it decidable.
  //
  // Deliberately not asserted: that the digest equals a hash of the evidence read back out.
  // `jsonb` does not preserve key order, so 2.2 would re-serialise to a different string than it
  // digested at insert. The rule the collision table needs is same-body-same-digest, and that is
  // what this checks.
  test(`${name}: the payload digest is retained, stable per body, and differs across bodies`, async (t) => {
    const store = await openStore(t, createStore);
    await store.append(evidenceRecord(), { workspace_id: WORKSPACE });
    await store.append(evidenceRecord(), { workspace_id: 'ledger-art' });
    await store.append(evidenceRecord({ result: { pass: false } }), {
      workspace_id: 'billing-art',
    });
    const [first, same, different] = await store.list();
    assert.equal(typeof first.payload_sha256, 'string');
    assert.ok(first.payload_sha256.length > 0, 'a digest is retained with the record');
    assert.equal(same.payload_sha256, first.payload_sha256, 'the same body digests the same');
    assert.notEqual(
      different.payload_sha256,
      first.payload_sha256,
      'a different body must not digest the same, or a conflict would read as a duplicate',
    );
  });

  // "Append-only is structural, not a convention" is ADR-0002's central claim. At the database
  // layer that is a missing UPDATE grant; at this layer it is the absence of any method that
  // could remove or rewrite a record. 2.2 writes its adapter against this suite, so without
  // this an adapter carrying a destructive method would pass it unedited.
  //
  // The list is exact, not a denylist of scary names. Retention in 2.2 adds the one deliberate
  // exception to append-only, so 2.2 will have to edit this line — which is the point: a new
  // mutating method should not be able to appear without touching the file that documents why
  // there are none.
  test(`${name}: the port exposes no method that could remove or rewrite a record`, async (t) => {
    const store = await openStore(t, createStore);
    assert.deepEqual(Object.keys(store).sort(), ['append', 'list', 'listRecords']);
  });

  test(`${name}: every envelope declares the envelope version`, async (t) => {
    // The literal is spelled out rather than imported: a version bump in the module under test
    // is exactly what this assertion exists to notice.
    const store = await openStore(t, createStore);
    await store.append(evidenceRecord({ change_id: 'PR-1' }));
    await store.append(evidenceRecord({ change_id: 'PR-2' }), { workspace_id: WORKSPACE });
    const stored = await store.list();
    assert.equal(stored.length, 2);
    for (const envelope of stored) assert.equal(envelope.envelope_version, 'evidence-envelope/0');
  });
}
