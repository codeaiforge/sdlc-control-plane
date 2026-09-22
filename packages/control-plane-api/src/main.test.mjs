import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { assertUsablePolicy, createRequestHandler } from './main.mjs';
import { createInMemoryEvidenceStore } from './evidence-store.mjs';

const policy = {
  policy_version: 'guardrails/0',
  policy_id: 'test-policy@1',
  rules: {
    minimum_evidence_schema: 'evidence/0',
    require_verified_controls: ['CAF-SDLC-002:tier'],
    require_ai_provenance_when_assisted: true,
  },
};

const validEvidence = {
  schema_version: 'evidence/0',
  change_id: 'PR-1',
  binding_used: 'origin/main..HEAD',
  computed_at: '2026-09-21T00:00:00Z',
  tier: 'T1',
  affected_set: ['packages/contracts'],
  tool: { name: 'sdlc-controls', version: 'v0.2.0' },
  verification: { verified: ['CAF-SDLC-002:tier'] },
  result: { pass: true },
};

const workspace = {
  workspace_id: 'payments-art',
  display_name: 'Payments',
  value_stream: 'payments',
  repository_url: 'https://example.invalid/r',
  evidence_endpoint: 'https://example.invalid/e',
  owners: ['platform'],
  status: 'active',
};

const seam = (evidenceStore = createInMemoryEvidenceStore()) =>
  createRequestHandler({ registry: { list: () => [workspace] }, policy, evidenceStore });

const call = async (handler, request) => {
  let status;
  let body = '';
  await handler(request, {
    writeHead: (value) => {
      status = value;
    },
    end: (value) => {
      body = value;
    },
  });
  return { status, body: JSON.parse(body) };
};

const post = (raw) => ({
  method: 'POST',
  url: '/v1/evidence',
  async *[Symbol.asyncIterator]() {
    yield raw;
  },
});

test('exposes health without requiring a network listener', async () => {
  const { status, body } = await call(seam(), { method: 'GET', url: '/health' });
  assert.equal(status, 200);
  assert.deepEqual(body, { status: 'ok' });
});

test('lists registered workspaces with their owners and value stream', async () => {
  const { status, body } = await call(seam(), { method: 'GET', url: '/v1/workspaces' });
  assert.equal(status, 200);
  assert.deepEqual(body.data[0].owners, ['platform']);
  assert.equal(body.data[0].value_stream, 'payments');
});

test('accepts evidence that satisfies the approved policy', async () => {
  const { status, body } = await call(seam(), post(JSON.stringify(validEvidence)));
  assert.equal(status, 202);
  assert.equal(body.decision.accepted, true);
  assert.equal(body.decision.disposition, 'accepted');
  assert.equal(body.decision.policy_id, 'test-policy@1');
});

test('rejects evidence missing a required control with actionable reasons', async () => {
  const unverified = { ...validEvidence, verification: { verified: [] } };
  const { status, body } = await call(seam(), post(JSON.stringify(unverified)));
  assert.equal(status, 422);
  assert.equal(body.decision.disposition, 'needs-remediation');
  assert.deepEqual(body.decision.reasons, ['required control not verified: CAF-SDLC-002:tier']);
});

test('rejects an unparseable body without claiming a policy disposition', async () => {
  const { status, body } = await call(seam(), post('{ not json'));
  assert.equal(status, 400);
  assert.deepEqual(body, { error: 'request body must be valid JSON' });
});

test('rejected evidence never reaches the indicator summary', async () => {
  const handler = seam();
  await call(handler, post(JSON.stringify({ ...validEvidence, tier: 'T9' })));
  const { status, body } = await call(handler, { method: 'GET', url: '/v1/indicators' });
  assert.equal(status, 200);
  assert.equal(body.data.total_records, 0);
  assert.match(body.data.note, /not a portfolio decision/);
});

test('counts accepted evidence by tier in the indicator summary', async () => {
  const handler = seam();
  await call(handler, post(JSON.stringify(validEvidence)));
  const { body } = await call(handler, { method: 'GET', url: '/v1/indicators' });
  assert.equal(body.data.total_records, 1);
  assert.equal(body.data.passing_records, 1);
  assert.equal(body.data.by_tier.T1, 1);
});

test('an unknown path is a 404, not a silent success', async () => {
  const { status, body } = await call(seam(), { method: 'GET', url: '/v1/nope' });
  assert.equal(status, 404);
  assert.deepEqual(body, { error: 'not found' });
});

// Regression — Phase 4 review of task 1.1 found the body read sitting outside the try, so a
// client that opened a POST and dropped the socket made `for await` throw, rejected the
// handler's promise, and terminated the process under Node's default unhandled-rejection
// behaviour. Driving the throw through the iterator reproduces the rejection without a socket.
test('a body stream that aborts mid-read is answered, not left to reject', async () => {
  const aborting = {
    method: 'POST',
    url: '/v1/evidence',
    async *[Symbol.asyncIterator]() {
      yield '{"partial":';
      throw Object.assign(new Error('aborted'), { code: 'ECONNRESET' });
    },
  };
  const { status, body } = await call(seam(), aborting);
  assert.equal(status, 400);
  assert.deepEqual(body, { error: 'request body must be valid JSON' });
});

// Regression — Phase 4 cycle 2 found the guardrail policy was the one configuration loaded
// without validation, so a policy file missing policy_id made the seam emit a 202 that its own
// published schema rejects, and an unsupported policy version made a valid record come back as
// disposition "rejected" - telling the caller its evidence was malformed when the fault was ours.
test('a policy that cannot honour the published contract is refused at load', () => {
  assert.deepEqual(assertUsablePolicy({ policy_version: 'guardrails/0', policy_id: 'p@1' }), []);
  assert.deepEqual(assertUsablePolicy({ policy_version: 'guardrails/0' }), [
    'policy_id must be a non-empty string',
  ]);
  assert.deepEqual(assertUsablePolicy({ policy_version: 'guardrails/0', policy_id: '' }), [
    'policy_id must be a non-empty string',
  ]);
  assert.deepEqual(assertUsablePolicy({ policy_version: 'guardrails/1', policy_id: 'p@1' }), [
    'policy_version must be guardrails/0',
  ]);
  assert.deepEqual(assertUsablePolicy(null), ['policy must be an object']);
  assert.deepEqual(assertUsablePolicy([]), ['policy must be an object']);
});

test('the shipped guardrail policy satisfies that guard', () => {
  const shipped = JSON.parse(
    readFileSync(new URL('../../../config/control-plane/guardrails.json', import.meta.url)),
  );
  assert.deepEqual(assertUsablePolicy(shipped), []);
});

// Regression — Phase 4 cycle 2 found `raw += chunk` stringified each Buffer independently, so a
// multi-byte character split across a chunk boundary became U+FFFD. The record still parsed and
// still satisfied every published schema, so no contract check could ever catch it.
test('a multi-byte character split across body chunks is not corrupted', async () => {
  const record = { ...validEvidence, change_id: 'PR-é-☃' };
  const body = Buffer.from(JSON.stringify(record), 'utf8');
  const split = body.indexOf(Buffer.from('é', 'utf8')) + 1;
  const store = createInMemoryEvidenceStore();
  const handler = seam(store);
  const { status } = await call(handler, {
    method: 'POST',
    url: '/v1/evidence',
    async *[Symbol.asyncIterator]() {
      yield body.subarray(0, split);
      yield body.subarray(split);
    },
  });
  assert.equal(status, 202);
  assert.equal(store.list()[0].evidence.change_id, 'PR-é-☃');
});

// Regression — task 1.2. The seam used to store `Object.freeze(record)`, and Object.freeze is
// shallow: `stored.result.pass = false` succeeded on an accepted record and flipped
// passing_records from 1 to 0 in an indicator the control plane had already published. Nothing
// in the request path could catch it, because the mutation happens after the 202 is written.
test('a stored record cannot be edited into a different indicator', async () => {
  const store = createInMemoryEvidenceStore();
  const handler = seam(store);
  await call(handler, post(JSON.stringify(validEvidence)));
  assert.throws(() => {
    store.list()[0].evidence.result.pass = false;
  }, TypeError);
  const { status, body } = await call(handler, { method: 'GET', url: '/v1/indicators' });
  assert.equal(status, 200);
  assert.equal(body.data.total_records, 1);
  assert.equal(body.data.passing_records, 1);
});
