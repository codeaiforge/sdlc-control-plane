import assert from 'node:assert/strict';
import { constants, generateKeyPairSync, sign as rsaSign } from 'node:crypto';
import test from 'node:test';
import { createAuthenticator } from '../../workload-identity/src/authenticate.mjs';
import { createKeySet } from '../../workload-identity/src/key-set.mjs';
import { createRegistry } from '../../workspace-registry/src/registry.mjs';
import { createSubmissionQuota } from './admission.mjs';
import { createInMemoryEvidenceStore } from './evidence-store.mjs';
import { createRequestHandler } from './main.mjs';
import { REFUSAL_REASONS, refusalEvent, stderrLog } from './refusal-log.mjs';

// Claim shapes from AC-20's measured token. PROVISIONAL until the measurement in
// .ai/sprints/sprint-2/tasks/2.1.md is recorded; swap the values here and nowhere else.
const MEASURED = {
  provisional: true,
  lifetime_s: 300, // exp - iat
  nbf_before_iat_s: 600,
  job_workflow_claims_outside_reusable: false,
  run_id: '18203345671', // digits only; length provisional
  run_attempt: '1',
  sha: 'a'.repeat(40),
  job_workflow_sha: 'b'.repeat(40),
  actor_id: '1000001',
};

test(
  "fixtures take their claim shapes from AC-20's measured token",
  { todo: MEASURED.provisional },
  () => {
    assert.equal(MEASURED.provisional, false, 'MEASURED is provisional until AC-20 is recorded');
  },
);

// AC-19 / MIT-17. Every refusal reason is driven through the seam, and every line logged and
// every body answered is checked two ways: against the closed shape - the primary check, because
// a schema has no next spelling - and against a list of things that must never appear in it.
//
// Canaries: the token's claims carry CANARY-CLAIM in every name a person chooses; the
// Authorization value carries CANARY-AUTH where it is not a token; the same token is also sent in
// a cookie and an access_token query; the body carries CANARY-BODY.

const ISSUER = 'https://token.actions.githubusercontent.com';
const AUDIENCE = 'urn:codeaiforge:sdlc-control-plane:production';
const NOW_MS = Date.UTC(2026, 9, 7, 12, 0, 0);
const NOW_S = NOW_MS / 1000;

const signing = generateKeyPairSync('rsa', { modulusLength: 2048 });
const stranger = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWKS = {
  keys: [{ ...signing.publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' }],
};
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
function sign(claims, header = { alg: 'RS256', kid: 'k1', typ: 'JWT' }, key = signing.privateKey) {
  const input = `${b64(header)}.${b64(claims)}`;
  const signature = rsaSign('sha256', Buffer.from(input), {
    key,
    padding: constants.RSA_PKCS1_PADDING,
  });
  return `${input}.${signature.toString('base64url')}`;
}

const FOUR_IDS = ['repository_owner_id', 'repository_id', 'run_id', 'run_attempt'];
const claims = (overrides = {}) => ({
  iss: ISSUER,
  aud: AUDIENCE,
  iat: NOW_S,
  nbf: NOW_S - MEASURED.nbf_before_iat_s,
  exp: NOW_S + MEASURED.lifetime_s,
  jti: 'CANARY-CLAIM-jti',
  sub: 'repo:CANARY-CLAIM-owner/CANARY-CLAIM-repo:ref:refs/heads/CANARY-CLAIM-branch',
  repository: 'CANARY-CLAIM-owner/CANARY-CLAIM-repo',
  repository_owner: 'CANARY-CLAIM-owner',
  repository_owner_id: '65',
  repository_id: '74',
  actor: 'CANARY-CLAIM-actor',
  actor_id: MEASURED.actor_id,
  run_id: MEASURED.run_id,
  run_attempt: MEASURED.run_attempt,
  sha: MEASURED.sha,
  ref: 'refs/heads/CANARY-CLAIM-branch',
  event_name: 'push',
  workflow_ref: 'CANARY-CLAIM-owner/CANARY-CLAIM-repo/.github/workflows/gate.yml@refs/heads/main',
  ...(MEASURED.job_workflow_claims_outside_reusable
    ? {
        job_workflow_ref: 'CANARY-CLAIM-owner/r/.github/workflows/gate.yml@refs/heads/main',
        job_workflow_sha: MEASURED.job_workflow_sha,
      }
    : {}),
  ...overrides,
});

const policy = {
  policy_version: 'guardrails/0',
  policy_id: 'test-policy@1',
  rules: { require_verified_controls: ['CAF-SDLC-002:tier'] },
};
const evidence = (overrides = {}) => ({
  schema_version: 'evidence/0',
  change_id: 'CANARY-BODY-change',
  binding_used: 'CANARY-BODY-binding',
  computed_at: '2026-09-21T00:00:00Z',
  tier: 'T1',
  affected_set: ['CANARY-BODY-path'],
  tool: { name: 'sdlc-controls', version: 'v0.2.0' },
  verification: { verified: ['CAF-SDLC-002:tier'] },
  result: { pass: true },
  ...overrides,
});

const PIN_REF = 'owner/gates/.github/workflows/mint.yml@refs/heads/main';
const registration = (workspace_id, repository_id, overrides = {}, identity = {}) => ({
  workspace_id,
  display_name: workspace_id,
  value_stream: 'payments',
  repository_url: 'https://example.invalid/r',
  evidence_endpoint: 'https://example.invalid/e',
  owners: ['platform'],
  status: 'active',
  workload_identity: {
    issuer: ISSUER,
    repository_owner_id: '65',
    repository_id,
    admitted_events: ['push'],
    ...identity,
  },
  ...overrides,
});
const REGISTRY_DOC = {
  registry_version: 'workspace-registry/1',
  workspaces: [
    registration('payments-art', '74'),
    registration('suspended-ws', '75', { status: 'suspended' }),
    registration('pinned-ref', '76', {}, { required_job_workflow_ref: PIN_REF }),
    registration(
      'pinned-sha',
      '77',
      {},
      { required_job_workflow_ref: PIN_REF, required_job_workflow_sha: 'c'.repeat(40) },
    ),
  ],
};

const okFetch = async () => ({
  body: Buffer.from(JSON.stringify(JWKS)),
  cacheControl: 'max-age=3600',
});

function seam({ fetchKeySet = okFetch, keySet, log, quota } = {}) {
  const set = keySet ?? createKeySet({ now: () => NOW_MS, fetchKeySet });
  return createRequestHandler({
    registry: createRegistry(REGISTRY_DOC),
    policy,
    evidenceStore: createInMemoryEvidenceStore(),
    authenticate: createAuthenticator({ keySet: set, now: () => NOW_MS }),
    quota: quota ?? createSubmissionQuota({ now: () => NOW_MS }),
    log,
    now: () => NOW_MS,
  });
}

// One request per scenario. The token rides in the Authorization header (unless the scenario
// replaces it), and again in a cookie and in the body, so a leak from any of the three shows.
function request({ method = 'POST', url = '/v1/evidence', authorization, compact, body }) {
  const rawHeaders = [];
  if (authorization !== undefined) {
    for (const value of [].concat(authorization)) rawHeaders.push('Authorization', value);
  }
  if (compact) rawHeaders.push('Cookie', `access_token=${compact}`);
  const text = body ?? JSON.stringify(evidence({ access_token: compact ?? 'CANARY-BODY-token' }));
  return {
    method,
    url,
    headers: {},
    rawHeaders,
    destroy: () => {},
    async *[Symbol.asyncIterator]() {
      yield text;
    },
  };
}

async function call(handler, req) {
  let status;
  let payload = '';
  await handler(req, {
    writeHead: (value) => {
      status = value;
    },
    end: (value, done) => {
      payload = value;
      done?.();
    },
  });
  return { status, payload };
}

// Every scenario: the reason it must log, the status it must answer, and how to provoke it.
// `secrets` is what must never appear in a line or a body for that scenario.
function scenarios() {
  const good = sign(claims());
  const make = (overrides, header, key) => sign(claims(overrides), header, key);
  const list = [];
  const add = (reason, status, compact, extra = {}) =>
    list.push({
      reason,
      status,
      compact,
      authorization: extra.authorization ?? (compact ? `Bearer ${compact}` : undefined),
      ...extra,
    });

  add('credential-missing', 401, good, { authorization: undefined });
  add('credential-repeated', 401, good, { authorization: [`Bearer ${good}`, `Bearer ${good}`] });
  add('credential-malformed', 401, good, { authorization: 'Bearer CANARY-AUTH-not-a-jws' });
  add('token-too-large', 401, good, { authorization: `Bearer CANARY-AUTH-${'x'.repeat(8200)}` });
  add('header-invalid', 401, make({}, { alg: 'RS256' }));
  add('alg-unsupported', 401, make({}, { alg: 'HS256', kid: 'k1' }));
  add('kid-unknown', 401, make({}, { alg: 'RS256', kid: 'CANARY-CLAIM-kid' }));
  add('signature-invalid', 401, make({}, undefined, stranger.privateKey));
  add('iss-mismatch', 401, make({ iss: 'https://CANARY-CLAIM.invalid' }));
  add('aud-mismatch', 401, make({ aud: 'https://github.com/CANARY-CLAIM-owner' }));
  add('token-expired', 401, make({ iat: NOW_S - 400, nbf: NOW_S - 400, exp: NOW_S - 61 }));
  add('token-not-yet-valid', 401, make({ nbf: NOW_S + 61 }));
  add('iat-in-future', 401, make({ iat: NOW_S + 61, nbf: NOW_S, exp: NOW_S + 300 }));
  add('lifetime-exceeded', 401, make({ exp: NOW_S + 901 }));
  add('claim-invalid', 401, make({ repository_id: 'CANARY-CLAIM-074' }));
  add('key-set-unavailable', 503, good, {
    fetchKeySet: async () => {
      throw new Error('CANARY-ERROR-outage');
    },
  });
  add('verifier-fault', 503, good, {
    keySet: {
      current: async () => {
        throw new Error(`CANARY-ERROR-${good}`);
      },
      refreshForUnknownKid: async () => null,
    },
  });
  add('no-binding', 403, make({ repository_id: '99' }));
  add('not-active', 403, make({ repository_id: '75' }));
  add('event-not-admitted', 403, make({ event_name: 'pull_request' }));
  add('pin-ref', 403, make({ repository_id: '76' }));
  add('pin-sha', 403, make({ repository_id: '77', job_workflow_ref: PIN_REF }));
  add('refused-actor', 403, make({ actor_id: '49699333' }));
  add('quota-exceeded', 429, good, { quota: { take: () => ({ ok: false, retryAfterS: 7 }) } });
  add('body-too-large', 413, good, { body: `"CANARY-BODY-${'x'.repeat(1048576)}"` });
  add('body-not-json', 400, good, { body: '{ CANARY-BODY not json' });
  add('rejected', 422, good, { body: JSON.stringify(evidence({ tier: 'CANARY-BODY-tier' })) });
  add('needs-remediation', 422, good, {
    body: JSON.stringify(evidence({ verification: { verified: ['CANARY-BODY-control'] } })),
  });
  add('unmatched-route', 404, good, { url: `/v1/evidence?access_token=${good}` });
  return list;
}

const ALLOWED_KEYS = ['event', 'at', 'route', 'status', 'reason', 'principal'];
const PRINCIPAL_KEYS = [...FOUR_IDS, 'workspace_id'];
const AFTER_STEP_5 = new Set([400, 403, 413, 422, 429]);

async function runAll() {
  const results = [];
  for (const scenario of scenarios()) {
    const lines = [];
    const handler = seam({
      fetchKeySet: scenario.fetchKeySet,
      keySet: scenario.keySet,
      quota: scenario.quota,
      // Serialised exactly as the stderr sink serialises it.
      log: (event) => lines.push(JSON.stringify(event)),
    });
    const answered = await call(handler, request(scenario));
    results.push({ scenario, lines, answered });
  }
  return results;
}

test('every refusal writes one JSON line with route, status and a known reason', async () => {
  const results = await runAll();
  for (const { scenario, lines, answered } of results) {
    assert.equal(answered.status, scenario.status, scenario.reason);
    assert.equal(lines.length, 1, `${scenario.reason}: expected one line, got ${lines.length}`);
    const event = JSON.parse(lines[0]);
    assert.equal(event.event, 'refusal');
    assert.equal(event.reason, scenario.reason);
    assert.equal(event.status, scenario.status);
    assert.equal(event.at, '2026-10-07T12:00:00.000Z');
    assert.equal(
      event.route,
      scenario.reason === 'unmatched-route' ? 'unmatched' : 'POST /v1/evidence',
    );
    assert.ok(REFUSAL_REASONS.includes(event.reason));
  }
  // Every reason in the closed list was driven, so none of them is untested vocabulary.
  assert.deepEqual(
    results.map(({ scenario }) => scenario.reason).sort(),
    [...REFUSAL_REASONS].sort(),
  );
});

test('no line carries a principal before step 5, and after it only the four ids and workspace_id', async () => {
  for (const { scenario, lines } of await runAll()) {
    const event = JSON.parse(lines[0]);
    for (const key of Object.keys(event))
      assert.ok(ALLOWED_KEYS.includes(key), `${scenario.reason}: unexpected key ${key}`);
    if (!AFTER_STEP_5.has(scenario.status)) {
      assert.equal(Object.hasOwn(event, 'principal'), false, scenario.reason);
      continue;
    }
    assert.ok(event.principal, `${scenario.reason}: no principal after step 5`);
    for (const key of Object.keys(event.principal))
      assert.ok(PRINCIPAL_KEYS.includes(key), `${scenario.reason}: principal carries ${key}`);
    assert.deepEqual(
      FOUR_IDS.map((key) => event.principal[key]),
      ['65', event.principal.repository_id, MEASURED.run_id, MEASURED.run_attempt],
    );
    for (const value of Object.values(event.principal))
      assert.match(value, /^[a-z0-9-]+$/, `${scenario.reason}: ${value}`);
  }
});

test('no line or response body contains the token, a segment, the Authorization value, a cookie or query token, or a body canary', async () => {
  for (const { scenario, lines, answered } of await runAll()) {
    const forbidden = ['CANARY', 'Bearer', 'bearer', 'access_token', 'Authorization'];
    if (scenario.compact) {
      forbidden.push(scenario.compact, ...scenario.compact.split('.'));
      const payloadSegment = scenario.compact.split('.')[1];
      forbidden.push(Buffer.from(payloadSegment, 'base64url').toString('utf8').slice(0, 24));
    }
    for (const value of [].concat(scenario.authorization ?? [])) forbidden.push(value);
    // Claim values a person chooses, and every other claim value outside the four IDs.
    const sent = claims();
    for (const [key, value] of Object.entries(sent)) {
      if (FOUR_IDS.includes(key) || typeof value !== 'string' || value.length < 6) continue;
      forbidden.push(value);
    }
    for (const text of [...lines, answered.payload]) {
      for (const needle of forbidden)
        assert.equal(
          text.includes(needle),
          false,
          `${scenario.reason}: output contains ${needle.slice(0, 40)}`,
        );
    }
  }
});

test('an error thrown while decoding is logged as a reason, never as its message', async () => {
  const lines = [];
  const handler = seam({
    keySet: {
      current: async () => {
        // A V8 JSON.parse error quotes its input; this is that shape, with a canary in it.
        JSON.parse('{"CANARY-ERROR-from-a-token-segment');
      },
      refreshForUnknownKid: async () => null,
    },
    log: (event) => lines.push(JSON.stringify(event)),
  });
  const { status, payload } = await call(
    handler,
    request({ authorization: `Bearer ${sign(claims())}` }),
  );
  assert.equal(status, 503);
  assert.equal(JSON.parse(lines[0]).reason, 'verifier-fault');
  assert.doesNotMatch(lines[0], /CANARY|SyntaxError|JSON/);
  assert.doesNotMatch(payload, /CANARY|SyntaxError/);
});

test('a sink that throws does not break the response', async () => {
  const handler = seam({
    log: () => {
      throw new Error('disk full');
    },
  });
  const { status, payload } = await call(handler, request({ authorization: 'Bearer x' }));
  assert.equal(status, 401);
  assert.deepEqual(JSON.parse(payload), { error: 'invalid token' });
});

test('an unknown reason is refused when the event is built', () => {
  assert.throws(
    () => refusalEvent({ at: 'x', route: null, status: 401, reason: 'free text' }),
    TypeError,
  );
  assert.equal(Object.isFrozen(REFUSAL_REASONS), true);
});

test('the stderr sink writes one JSON line and survives a failing stream', (t) => {
  const written = [];
  t.mock.method(process.stderr, 'write', (chunk) => {
    written.push(String(chunk));
    return true;
  });
  stderrLog({ event: 'refusal', reason: 'credential-missing' });
  assert.deepEqual(written, ['{"event":"refusal","reason":"credential-missing"}\n']);
  t.mock.method(process.stderr, 'write', () => {
    throw new Error('EPIPE');
  });
  assert.doesNotThrow(() => stderrLog({ event: 'refusal' }));
});
