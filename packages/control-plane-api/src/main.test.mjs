import assert from 'node:assert/strict';
import { constants, generateKeyPairSync, sign as rsaSign } from 'node:crypto';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createAuthenticator } from '../../workload-identity/src/authenticate.mjs';
import { ISSUER as VERIFIER_ISSUER } from '../../workload-identity/src/constants.mjs';
import { createKeySet } from '../../workload-identity/src/key-set.mjs';
import { ACCEPTED_ISSUERS, createRegistry } from '../../workspace-registry/src/registry.mjs';
import { assertIssuerAgreement, assertUsablePolicy, createRequestHandler } from './main.mjs';
import { createInMemoryEvidenceStore } from './evidence-store.mjs';

// Claim shapes from AC-20's measured token (GitHub Actions run 39384901065, 2026-10-20), recorded in
// .ai/sprints/sprint-2/tasks/2.1.md; swap the values here and nowhere else.
const MEASURED = {
  provisional: false,
  lifetime_s: 300, // exp - iat, measured
  nbf_before_iat_s: 300, // iat - nbf, measured (ADR-0003's example payload had 600)
  job_workflow_claims_outside_reusable: true, // present, equal to workflow_ref / workflow_sha
  run_id: '39384901065',
  run_attempt: '1',
  sha: '445079d0e62a947dc442832eaeca02e99e673d98',
  // Measured equal to sha (the run built the commit holding the workflow); kept distinct here so a
  // test cannot pass by reading the wrong claim.
  job_workflow_sha: 'b'.repeat(40),
  actor_id: '3251178',
};

test(
  "fixtures take their claim shapes from AC-20's measured token",
  { todo: MEASURED.provisional },
  () => {
    assert.equal(MEASURED.provisional, false, 'MEASURED is provisional until AC-20 is recorded');
  },
);

// Every request below carries a real token, signed here with a key generated here, verified by
// the real authenticator over a real key set fed an in-test JWKS. Nothing reaches the network.
// The fixtures are inline literals, deliberately not shared and not imported from the contracts
// package (see openapi.contract.test.mjs for why).

const AUDIENCE = 'urn:codeaiforge:sdlc-control-plane:production';
const NOW_MS = Date.UTC(2026, 9, 7, 12, 0, 0);
const NOW_S = NOW_MS / 1000;

const signing = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWKS = {
  keys: [{ ...signing.publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' }],
};
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
function sign(claims, header = { alg: 'RS256', kid: 'k1', typ: 'JWT' }) {
  const input = `${b64(header)}.${b64(claims)}`;
  const signature = rsaSign('sha256', Buffer.from(input), {
    key: signing.privateKey,
    padding: constants.RSA_PKCS1_PADDING,
  });
  return `${input}.${signature.toString('base64url')}`;
}
const token = (overrides = {}) =>
  sign({
    iss: VERIFIER_ISSUER,
    aud: AUDIENCE,
    iat: NOW_S,
    nbf: NOW_S - MEASURED.nbf_before_iat_s,
    exp: NOW_S + MEASURED.lifetime_s,
    sub: 'repo:owner/payments:ref:refs/heads/main',
    repository: 'owner/payments',
    repository_owner_id: '65',
    repository_id: '74',
    actor: 'someone',
    actor_id: MEASURED.actor_id,
    run_id: MEASURED.run_id,
    run_attempt: MEASURED.run_attempt,
    sha: MEASURED.sha,
    ref: 'refs/heads/main',
    event_name: 'push',
    workflow_ref: 'owner/payments/.github/workflows/gate.yml@refs/heads/main',
    ...(MEASURED.job_workflow_claims_outside_reusable
      ? {
          job_workflow_ref: 'owner/payments/.github/workflows/gate.yml@refs/heads/main',
          job_workflow_sha: MEASURED.job_workflow_sha,
        }
      : {}),
    ...overrides,
  });

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
  workload_identity: {
    issuer: 'https://token.actions.githubusercontent.com',
    repository_owner_id: '65',
    repository_id: '74',
    admitted_events: ['push', 'pull_request'],
  },
};

const seam = (evidenceStore = createInMemoryEvidenceStore(), overrides = {}) => {
  const keySet = createKeySet({
    now: () => NOW_MS,
    fetchKeySet: async () => ({
      body: Buffer.from(JSON.stringify(JWKS)),
      cacheControl: 'max-age=3600',
    }),
  });
  return createRequestHandler({
    registry: createRegistry({ registry_version: 'workspace-registry/1', workspaces: [workspace] }),
    policy,
    evidenceStore,
    authenticate: createAuthenticator({ keySet, now: () => NOW_MS }),
    log: () => {},
    now: () => NOW_MS,
    ...overrides,
  });
};

const call = async (handler, request) => {
  let status;
  let body = '';
  request.destroy ??= () => {};
  await handler(request, {
    writeHead: (value) => {
      status = value;
    },
    end: (value, done) => {
      body = value;
      done?.();
    },
  });
  return { status, body: JSON.parse(body) };
};

const authed = (rest) => ({ rawHeaders: ['Authorization', `Bearer ${token()}`], ...rest });
const get = (url) => authed({ method: 'GET', url });
const post = (raw) =>
  authed({
    method: 'POST',
    url: '/v1/evidence',
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield raw;
    },
  });

test('exposes health without requiring a network listener', async () => {
  const { status, body } = await call(seam(), { method: 'GET', url: '/health' });
  assert.equal(status, 200);
  assert.deepEqual(body, { status: 'ok' });
});

test("returns the caller's own registration with its owners and value stream", async () => {
  const { status, body } = await call(seam(), get('/v1/workspaces'));
  assert.equal(status, 200);
  assert.equal(body.data.length, 1);
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
  const unclaimed = { ...validEvidence, verification: { verified: [] } };
  const { status, body } = await call(seam(), post(JSON.stringify(unclaimed)));
  assert.equal(status, 422);
  assert.equal(body.decision.disposition, 'needs-remediation');
  assert.deepEqual(body.decision.reasons, ['required control not claimed: CAF-SDLC-002:tier']);
});

test('rejects an unparseable body without claiming a policy disposition', async () => {
  const { status, body } = await call(seam(), post('{ not json'));
  assert.equal(status, 400);
  assert.deepEqual(body, { error: 'request body must be valid JSON' });
});

test('rejected evidence never reaches the indicator summary', async () => {
  const handler = seam();
  await call(handler, post(JSON.stringify({ ...validEvidence, tier: 'T9' })));
  const { status, body } = await call(handler, get('/v1/indicators'));
  assert.equal(status, 200);
  assert.equal(body.data.total_records, 0);
  assert.match(body.data.note, /not a portfolio decision/);
});

test('counts accepted evidence by tier in the indicator summary', async () => {
  const handler = seam();
  await call(handler, post(JSON.stringify(validEvidence)));
  const { body } = await call(handler, get('/v1/indicators'));
  assert.equal(body.data.total_records, 1);
  assert.equal(body.data.passing_records, 1);
  assert.equal(body.data.by_tier.T1, 1);
});

test('an unknown path is a 404, not a silent success', async () => {
  const { status, body } = await call(seam(), get('/v1/nope'));
  assert.equal(status, 404);
  assert.deepEqual(body, { error: 'not found' });
});

// Regression — Phase 4 review of task 1.1 found the body read sitting outside the try, so a
// client that opened a POST and dropped the socket made `for await` throw, rejected the
// handler's promise, and terminated the process under Node's default unhandled-rejection
// behaviour. Driving the throw through the iterator reproduces the rejection without a socket.
test('a body stream that aborts mid-read is answered, not left to reject', async () => {
  const aborting = authed({
    method: 'POST',
    url: '/v1/evidence',
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield '{"partial":';
      throw Object.assign(new Error('aborted'), { code: 'ECONNRESET' });
    },
  });
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
  const { status } = await call(
    handler,
    authed({
      method: 'POST',
      url: '/v1/evidence',
      headers: {},
      async *[Symbol.asyncIterator]() {
        yield body.subarray(0, split);
        yield body.subarray(split);
      },
    }),
  );
  assert.equal(status, 202);
  assert.equal(store.list()[0].evidence.change_id, 'PR-é-☃');
});

// Regression — task 1.2. The seam used to store `Object.freeze(record)`, and Object.freeze is
// shallow: `stored.result.pass = false` succeeded on an accepted record and flipped
// passing_records from 1 to 0 in an indicator the control plane had already published. Nothing
// in the request path could catch it, because the mutation happens after the 202 is written.
// The conformance suite pins that an envelope *can* carry policy_id and *can* take the
// store's clock. Both are options at this call site, and no port test reaches a call site —
// the suite calls append() with options of its own. So until this test existed, the seam
// could stop passing either one and nothing would fail: NFR-6.1's approving decision
// reference, and the audit boundary's "the control plane's clock, never the submitter's",
// were conventions here rather than controls.
test('the seam stores the approving policy and its own receipt time', async () => {
  const store = createInMemoryEvidenceStore();
  const backdated = { ...validEvidence, received_at: '1999-01-01T00:00:00.000Z' };
  const { status, body } = await call(seam(store), post(JSON.stringify(backdated)));
  assert.equal(status, 202);
  const [envelope] = store.list();
  assert.equal(envelope.policy_id, policy.policy_id);
  assert.equal(
    envelope.policy_id,
    body.decision.policy_id,
    'the stored policy is the one the caller was told granted the acceptance',
  );
  assert.notEqual(
    envelope.received_at,
    backdated.received_at,
    'a submitter that sets its own receipt time would set its own retention clock',
  );
});

test('a stored record cannot be edited into a different indicator', async () => {
  const store = createInMemoryEvidenceStore();
  const handler = seam(store);
  await call(handler, post(JSON.stringify(validEvidence)));
  assert.throws(() => {
    store.list()[0].evidence.result.pass = false;
  }, TypeError);
  const { status, body } = await call(handler, get('/v1/indicators'));
  assert.equal(status, 200);
  assert.equal(body.data.total_records, 1);
  assert.equal(body.data.passing_records, 1);
});

// AC-12. Every disposition says what it rests on - the workload's own claims (ADR-0004) - and
// that includes a 'rejected' one, where no policy was reached at all.
test('202 and every 422, rejected included, carry evidence_attestation self-attested', async () => {
  const handler = seam();
  const cases = [
    [validEvidence, 202, 'accepted'],
    [
      { ...validEvidence, change_id: 'PR-2', verification: { verified: [] } },
      422,
      'needs-remediation',
    ],
    [{ ...validEvidence, change_id: 'PR-3', tier: 'T9' }, 422, 'rejected'],
    [{ ...validEvidence, change_id: 'PR-4', schema_version: 'evidence/1' }, 422, 'rejected'],
  ];
  for (const [record, expected, disposition] of cases) {
    const { status, body } = await call(handler, post(JSON.stringify(record)));
    assert.equal(status, expected, disposition);
    assert.equal(body.decision.disposition, disposition);
    assert.equal(body.decision.evidence_attestation, 'self-attested', disposition);
  }
  const { body } = await call(handler, get('/v1/indicators'));
  assert.equal(body.data.evidence_attestation, 'self-attested');
});

// AC-3, D-2. The issuer is written twice because workload-identity imports nothing; the startup
// check is what holds the copies equal, and this pins the check.
test('startup refuses when ACCEPTED_ISSUERS is not exactly [ISSUER]', () => {
  assert.deepEqual(assertIssuerAgreement(), []);
  assert.deepEqual(ACCEPTED_ISSUERS, [VERIFIER_ISSUER]);
  for (const accepted of [
    [],
    [`${VERIFIER_ISSUER}/`],
    [VERIFIER_ISSUER, 'https://gitlab.com'],
    ['https://gitlab.com', VERIFIER_ISSUER],
    VERIFIER_ISSUER,
    null,
  ]) {
    assert.deepEqual(
      assertIssuerAgreement(accepted, VERIFIER_ISSUER),
      ['ACCEPTED_ISSUERS must be exactly [ISSUER]'],
      JSON.stringify(accepted),
    );
  }
  assert.deepEqual(assertIssuerAgreement([VERIFIER_ISSUER], `${VERIFIER_ISSUER}/`), [
    'ACCEPTED_ISSUERS must be exactly [ISSUER]',
  ]);
  const source = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
  assert.match(
    source,
    /const issuerErrors = assertIssuerAgreement\(\);\nif \(issuerErrors\.length > 0\)/,
  );
});

// AC-3, AC-10: no reviewed constant, limit or quota can come from the environment. PORT is the
// one variable the seam reads, and it chooses a socket, not a policy.
test('main.mjs reads no environment variable but PORT', () => {
  const source = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
  const reads = [...source.matchAll(/\bprocess\s*(?:\.|\?\.|\[)\s*['"]?env\b[^\n]*/g)].map(
    (match) => match[0],
  );
  assert.deepEqual(reads, ['process.env.PORT ?? 3000);']);
  for (const spelling of [/\benv\s*\}\s*=\s*process/, /['"]node:process['"]/, /import\.meta\.env/])
    assert.doesNotMatch(source, spelling);
});

test('a handler cannot be built without an authenticator', () => {
  assert.throws(
    () =>
      createRequestHandler({
        registry: createRegistry({ registry_version: 'workspace-registry/1', workspaces: [] }),
        policy,
        evidenceStore: createInMemoryEvidenceStore(),
      }),
    /needs an authenticate function/,
  );
});
