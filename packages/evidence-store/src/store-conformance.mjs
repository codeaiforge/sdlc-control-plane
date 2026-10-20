import assert from 'node:assert/strict';
import test from 'node:test';

// The contract every evidence-store adapter has to satisfy, written once so the in-memory
// adapter (task 1.2) and the PostgreSQL adapter (task 2.2) are held to the same claims
// rather than to two descriptions of the same claims. ADR-0002 is the reasoning behind it.
//
// Three properties keep it portable:
//
// 1. It takes a factory, not a store, so every test gets a fresh instance and the order the
//    runner happens to pick cannot make one test depend on another's appends.
// 2. Every store call is awaited. `await` on a synchronous value is a no-op, so the in-memory
//    adapter passes an awaiting suite unchanged, and the async PostgreSQL adapter passes this same
//    file. The synchronous-reads test that once stood here was deleted in the change that made
//    reads async (ADR-0002 Consequences); the seam has awaited every store call since task 2.1.
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

// The factory may be sync or async, and may return a store or a { store, dispose, redact } bundle
// — the PostgreSQL adapter has a connection to close, and a suite that leaked one per test would
// exhaust the pool long before it ran out of tests. `append` is the discriminator: a store has
// one, a bundle does not. `redact({ workspace_id, change_id })` is never a store method (see the
// MIT-14 test below): it is whatever the adapter's retention path is, performed here by the test.
async function openLog(t, createStore) {
  const created = await createStore();
  const bundle = typeof created?.append === 'function' ? { store: created } : created;
  if (bundle.dispose) t.after(() => bundle.dispose());
  return bundle;
}

async function openStore(t, createStore) {
  return (await openLog(t, createStore)).store;
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

  test(`${name}: a replay is compared with the caller's own record, never another workspace's`, async (t) => {
    // Two workspaces may each submit a PR-1. A lookup that matched change_id alone would compare
    // the second workspace's replay with the first's record - a 409 for a true duplicate - and
    // answer with the other workspace's envelope and key, a disclosure across tenants.
    const store = await openStore(t, createStore);
    const other = 'another-workspace';
    const theirs = await store.append(evidenceRecord(), { workspace_id: WORKSPACE });
    const body = evidenceRecord({ result: { pass: false } });
    const ours = await store.append(body, { workspace_id: other });
    assert.equal(ours.outcome, 'appended');
    assert.notEqual(ours.key, theirs.key);

    const replay = await store.append(body, { workspace_id: other });
    assert.equal(replay.outcome, 'duplicate');
    assert.equal(replay.key, ours.key);
    assert.equal(replay.envelope.workspace_id, other);
    assert.equal(replay.envelope.idempotency_key, ours.key);
    assert.equal(replay.envelope.evidence.result.pass, false);

    const conflict = await store.append(evidenceRecord({ tier: 'T2' }), { workspace_id: other });
    assert.equal(conflict.outcome, 'conflict');
    assert.equal(conflict.key, ours.key);
    assert.equal(conflict.envelope.workspace_id, other);
    assert.equal(conflict.envelope.evidence.result.pass, false, 'our first record, not theirs');
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
    // Without a workspace there is no identity to be unique against, and keying on
    // [null, change_id] would make two unrelated workspaces collide on a shared change_id. The
    // seam always passes one since task 2.1; a direct caller of the port need not.
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

  // "Append-only is structural, not a convention" is ADR-0002's central claim. At the database
  // layer that is a missing UPDATE grant; at this layer it is the absence of any method that
  // could remove or rewrite a record.
  //
  // The list is exact, not a denylist of scary names. Redaction is the one deliberate exception
  // to append-only, and it is not a method here and never will be: in the durable store it is a
  // different database role on a different connection, constrained by a trigger the application
  // role cannot reach, so nothing holding a store can redact through it. A new mutating method
  // should not be able to appear without touching the file that documents why there are none.
  test(`${name}: the port exposes no method that could remove or rewrite a record`, async (t) => {
    const store = await openStore(t, createStore);
    assert.deepEqual(Object.keys(store).sort(), ['append', 'list', 'listRecords']);
  });

  // ADR-0004: the envelope records which verified run submitted the record, built from token
  // claims by the seam. A store that dropped it, or let it be edited, would lose the one thing
  // that makes a self-attested claim traceable to a run a human can reopen. The fixture is an
  // inline literal in ADR-0004's field order, like every other fixture here.
  const submitter = (overrides = {}) => ({
    issuer: 'https://token.actions.githubusercontent.com',
    repository_owner_id: '65',
    repository_id: '74',
    run_id: '18203345671',
    run_attempt: '1',
    sha: 'a'.repeat(40),
    ref: 'refs/heads/main',
    event_name: 'push',
    workflow_ref: 'owner/repo/.github/workflows/gate.yml@refs/heads/main',
    job_workflow_ref: null,
    job_workflow_sha: null,
    ...overrides,
  });

  test(`${name}: the submitting identity is retained and cannot be mutated`, async (t) => {
    const store = await openStore(t, createStore);
    const submitted = submitter();
    const { envelope } = await store.append(evidenceRecord(), {
      workspace_id: WORKSPACE,
      submitted_by: submitted,
    });
    submitted.repository_id = '999';
    submitted.run_id = 'rewritten';
    const [stored] = await store.list();
    assert.deepEqual(stored.submitted_by, submitter());
    assert.throws(() => {
      envelope.submitted_by.run_id = '1';
    }, TypeError);
    assert.throws(() => {
      stored.submitted_by.sha = 'b'.repeat(40);
    }, TypeError);
    await store.append(evidenceRecord({ change_id: 'PR-2' }), { workspace_id: WORKSPACE });
    assert.equal(
      (await store.list())[1].submitted_by,
      null,
      'absent rather than guessed when no principal is named',
    );
  });

  test(`${name}: a duplicate and a conflict keep the first envelope's submitted_by`, async (t) => {
    const store = await openStore(t, createStore);
    await store.append(evidenceRecord(), {
      workspace_id: WORKSPACE,
      submitted_by: submitter(),
    });
    const replay = await store.append(evidenceRecord(), {
      workspace_id: WORKSPACE,
      submitted_by: submitter({ run_id: '2', run_attempt: '2' }),
    });
    const conflict = await store.append(evidenceRecord({ result: { pass: false } }), {
      workspace_id: WORKSPACE,
      submitted_by: submitter({ run_id: '3', sha: 'c'.repeat(40) }),
    });
    assert.equal(replay.outcome, 'duplicate');
    assert.equal(conflict.outcome, 'conflict');
    for (const answered of [replay, conflict])
      assert.deepEqual(answered.envelope.submitted_by, submitter());
    const stored = await store.list();
    assert.equal(stored.length, 1);
    assert.deepEqual(stored[0].submitted_by, submitter());
  });

  // ADR-0002 "Expiry behaviour": a redacted envelope keeps its identity and loses its payload, and
  // a replay of it is a duplicate on the key alone - there is no body left to compare and no digest
  // kept to compare against. Pinned in the change that implements redaction, against both
  // adapters, with the redaction performed by the adapter's own retention path.
  const REDACTED_ENVELOPE_KEYS = [
    'envelope_version',
    'workspace_id',
    'received_at',
    'idempotency_key',
    'policy_id',
    'submitted_by',
    'evidence',
    'redacted_at',
  ];

  test(`${name}: a redacted envelope keeps its identity, loses its payload, and a replay is a duplicate`, async (t) => {
    const { store, redact } = await openLog(t, createStore);
    assert.equal(typeof redact, 'function', `${name}: the factory must hand the suite a redact()`);
    const first = await store.append(evidenceRecord(), {
      workspace_id: WORKSPACE,
      policy_id: 'baseline-engineering-controls@1',
      submitted_by: submitter(),
    });
    await store.append(evidenceRecord({ change_id: 'PR-2' }), { workspace_id: WORKSPACE });
    assert.equal(await redact({ workspace_id: WORKSPACE, change_id: 'PR-1' }), true);

    const [tombstone, kept] = await store.list();
    assert.deepEqual(Object.keys(tombstone), REDACTED_ENVELOPE_KEYS);
    assert.equal(tombstone.evidence, null, 'nothing derived from the payload survives');
    assert.equal(typeof tombstone.redacted_at, 'string');
    assert.ok(Number.isFinite(Date.parse(tombstone.redacted_at)), 'redacted_at is a timestamp');
    assert.equal(kept.redacted_at, null);
    assert.equal(kept.evidence.change_id, 'PR-2');
    for (const field of [
      'envelope_version',
      'workspace_id',
      'received_at',
      'idempotency_key',
      'policy_id',
    ])
      assert.equal(tombstone[field], first.envelope[field], `${field} is kept`);
    // ADR-0004: the seven identifiers stay, the four names a person chose are nulled.
    assert.deepEqual(tombstone.submitted_by, {
      ...submitter(),
      ref: null,
      event_name: null,
      workflow_ref: null,
      job_workflow_ref: null,
    });
    assert.throws(() => {
      tombstone.submitted_by.ref = 'refs/heads/main';
    }, TypeError);
    assert.deepEqual(
      (await store.listRecords()).map((record) => record.change_id),
      ['PR-2'],
      'a redacted envelope is no longer a record',
    );

    const replay = await store.append(evidenceRecord(), { workspace_id: WORKSPACE });
    assert.equal(replay.outcome, 'duplicate');
    assert.deepEqual(replay.envelope, tombstone, 'the stored tombstone is the answer');
    const different = await store.append(evidenceRecord({ result: { pass: false } }), {
      workspace_id: WORKSPACE,
    });
    assert.equal(different.outcome, 'duplicate', 'there is no body left to disagree with');
    assert.equal((await store.list()).length, 2, 'a replay of a redacted record appends nothing');
    assert.equal(
      await redact({ workspace_id: WORKSPACE, change_id: 'PR-1' }),
      false,
      'a tombstone is not redacted twice',
    );
    assert.equal(await redact({ workspace_id: WORKSPACE, change_id: 'PR-absent' }), false);
  });

  test(`${name}: an envelope that has not been redacted says so`, async (t) => {
    const store = await openStore(t, createStore);
    const { envelope } = await store.append(evidenceRecord(), { workspace_id: WORKSPACE });
    assert.deepEqual(Object.keys(envelope), REDACTED_ENVELOPE_KEYS);
    assert.equal(envelope.redacted_at, null);
    assert.deepEqual(Object.keys((await store.list())[0]), REDACTED_ENVELOPE_KEYS);
  });

  // AC-15. Key order carries no meaning in JSON, and jsonb compares values, not text; a body that
  // differs from the stored one only in the order its keys were written is the same submission.
  test(`${name}: two bodies differing only in key order are a duplicate`, async (t) => {
    const store = await openStore(t, createStore);
    const first = await store.append(evidenceRecord({ nested: { a: 1, b: [{ x: 1, y: 2 }] } }), {
      workspace_id: WORKSPACE,
    });
    const reordered = Object.fromEntries(
      Object.entries(evidenceRecord({ nested: { b: [{ y: 2, x: 1 }], a: 1 } })).reverse(),
    );
    const replay = await store.append(reordered, { workspace_id: WORKSPACE });
    assert.equal(first.outcome, 'appended');
    assert.equal(replay.outcome, 'duplicate');
    assert.equal((await store.list()).length, 1);
    // Array order is meaning, not notation: reordering an array is a different body.
    const swapped = await store.append(
      evidenceRecord({ nested: { a: 1, b: [{ x: 1, y: 2 }] }, affected_set: ['b', 'a'] }),
      { workspace_id: WORKSPACE },
    );
    assert.equal(swapped.outcome, 'conflict');
  });

  // AC-16. PostgreSQL cannot hold U+0000 in text or jsonb, nor an unpaired surrogate in jsonb, and
  // stores one in a text column as U+FFFD (measured). Both adapters refuse such a record as the
  // caller's fault, before anything is stored, wherever the string sits.
  test(`${name}: a record holding U+0000 or an unpaired surrogate is refused and nothing is stored`, async (t) => {
    const store = await openStore(t, createStore);
    const unstorable = [
      evidenceRecord({ binding_used: 'origin/main\u0000..HEAD' }),
      evidenceRecord({ tool: { name: 'sdlc-controls', version: 'v0.2.0\ud800' } }),
      evidenceRecord({ affected_set: ['packages/\udc00contracts'] }),
      evidenceRecord({ extra: { 'key\u0000': 'value' } }),
      evidenceRecord({ extra: { 'key\ud83d': 'value' } }),
      evidenceRecord({ change_id: 'PR-\u0000' }),
      evidenceRecord({ change_id: 'PR-\udfff' }),
    ];
    for (const record of unstorable) {
      await assert.rejects(
        async () => store.append(record, { workspace_id: WORKSPACE }),
        TypeError,
      );
    }
    assert.deepEqual(await store.list(), []);
    // A well-formed pair is an ordinary character and is stored unchanged.
    const { outcome } = await store.append(evidenceRecord({ change_id: 'PR-😀' }), {
      workspace_id: WORKSPACE,
    });
    assert.equal(outcome, 'appended');
    assert.equal((await store.list())[0].evidence.change_id, 'PR-😀');
  });

  // The envelope options are built by the control plane from the verified principal, never by the
  // caller, so a wrong one is the control plane's fault: refused before anything is stored, and
  // not as a TypeError, which the seam would answer as the caller's.
  test(`${name}: an unstorable envelope option is refused as the control plane's fault`, async (t) => {
    const store = await openStore(t, createStore);
    const faults = [
      { workspace_id: 'payments\u0000' },
      { workspace_id: '' },
      { workspace_id: 42 },
      { policy_id: 'p\ud800' },
      { submitted_by: 'not an object' },
      { submitted_by: submitter({ ref: 'refs/heads/\u0000' }) },
    ];
    for (const options of faults) {
      await assert.rejects(
        async () => store.append(evidenceRecord(), options),
        (error) => error.name === 'EvidenceStoreFault' && !(error instanceof TypeError),
        JSON.stringify(options),
      );
    }
    assert.deepEqual(await store.list(), []);
  });

  // RR-10. The read the indicators route makes is one workspace's envelopes, never the whole
  // store; the filter is optional, so the method set is unchanged.
  test(`${name}: list() filtered by workspace returns that workspace's envelopes in append order`, async (t) => {
    const store = await openStore(t, createStore);
    await store.append(evidenceRecord({ change_id: 'PR-1' }), { workspace_id: 'ws-a' });
    await store.append(evidenceRecord({ change_id: 'PR-2' }), { workspace_id: 'ws-b' });
    await store.append(evidenceRecord({ change_id: 'PR-3' }), { workspace_id: 'ws-a' });
    await store.append(evidenceRecord({ change_id: 'PR-4' }));
    const changes = (envelopes) => envelopes.map((envelope) => envelope.evidence.change_id);
    assert.deepEqual(changes(await store.list({ workspace_id: 'ws-a' })), ['PR-1', 'PR-3']);
    assert.deepEqual(changes(await store.list({ workspace_id: 'ws-b' })), ['PR-2']);
    assert.deepEqual(await store.list({ workspace_id: 'ws-none' }), []);
    assert.deepEqual(changes(await store.list()), ['PR-1', 'PR-2', 'PR-3', 'PR-4']);
    assert.deepEqual(changes(await store.list({})), ['PR-1', 'PR-2', 'PR-3', 'PR-4']);
    for (const filter of [null, 42, ['ws-a']])
      await assert.rejects(async () => store.list({ workspace_id: filter }), TypeError);
  });

  // NFR-1.1: an unrecognised additive field survives the store unchanged. jsonb keeps values, not
  // text, so this is value equality - and an object stays an object (a JSON string bound as jsonb
  // is stored as a string scalar, which only a round trip notices).
  test(`${name}: an unrecognised additive field round-trips unchanged in value`, async (t) => {
    const store = await openStore(t, createStore);
    const addition = {
      text: 'é ☃ 😀 "quoted" \\ back',
      numbers: [0, -1, 1.5, 1e21, 123456789012345],
      flags: [true, false, null],
      nested: { empty: {}, list: [], deeper: { key: 'value' } },
    };
    const { envelope } = await store.append(evidenceRecord({ upstream_addition: addition }), {
      workspace_id: WORKSPACE,
    });
    const [stored] = await store.list();
    for (const read of [envelope, stored]) {
      assert.equal(typeof read.evidence, 'object');
      assert.deepEqual(
        read.evidence,
        JSON.parse(JSON.stringify(evidenceRecord({ upstream_addition: addition }))),
      );
    }
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
