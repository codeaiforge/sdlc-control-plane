import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequestHandler } from './main.mjs';

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

const seam = (evidence = []) =>
  createRequestHandler({ registry: { list: () => [workspace] }, policy, evidence });

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
  const evidence = [];
  const handler = createRequestHandler({ registry: { list: () => [workspace] }, policy, evidence });
  await call(handler, post(JSON.stringify({ ...validEvidence, tier: 'T9' })));
  const { status, body } = await call(handler, { method: 'GET', url: '/v1/indicators' });
  assert.equal(status, 200);
  assert.equal(body.data.total_records, 0);
  assert.match(body.data.note, /not a portfolio decision/);
});

test('counts accepted evidence by tier in the indicator summary', async () => {
  const evidence = [];
  const handler = createRequestHandler({ registry: { list: () => [workspace] }, policy, evidence });
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
