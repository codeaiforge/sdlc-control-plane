import assert from 'node:assert/strict';
import { constants, generateKeyPairSync, sign as rsaSign } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createAuthenticator } from '../../workload-identity/src/authenticate.mjs';
import { createKeySet } from '../../workload-identity/src/key-set.mjs';
import { createRegistry } from '../../workspace-registry/src/registry.mjs';
import {
  CONNECTIONS_CHECKING_INTERVAL_MS,
  HEADERS_TIMEOUT_MS,
  MAX_BODY_BYTES,
  REQUEST_TIMEOUT_MS,
  SUBMISSION_QUOTA,
  SUBMISSION_QUOTA_WINDOW_MS,
  createSubmissionQuota,
} from './admission.mjs';
import { createInMemoryEvidenceStore } from './evidence-store.mjs';
import { createApp, createRequestHandler, createSeamServer, routes } from './main.mjs';

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

// The seam's admission control, driven in-process: the real registry, the real authenticator
// over a real key set fed an in-test JWKS, and fake request/response objects that record what
// was written, in what order, and whether any body chunk was pulled. No socket, no network.

const ISSUER = 'https://token.actions.githubusercontent.com';
const AUDIENCE = 'urn:codeaiforge:sdlc-control-plane:production';
const START_MS = Date.UTC(2026, 9, 7, 12, 0, 0);
const PIN_REF = 'owner/gates/.github/workflows/mint.yml@refs/heads/main';
const PIN_SHA = 'c'.repeat(40);

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
const ABSENT = Symbol('absent');
function token(overrides = {}, atMs = START_MS) {
  const iat = Math.floor(atMs / 1000);
  const claims = {
    iss: ISSUER,
    aud: AUDIENCE,
    iat,
    nbf: iat - MEASURED.nbf_before_iat_s,
    exp: iat + MEASURED.lifetime_s,
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
  };
  for (const [key, value] of Object.entries(claims)) if (value === ABSENT) delete claims[key];
  return sign(claims);
}

const policy = {
  policy_version: 'guardrails/0',
  policy_id: 'test-policy@1',
  rules: {
    minimum_evidence_schema: 'evidence/0',
    require_verified_controls: ['CAF-SDLC-002:tier'],
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

const registration = (workspace_id, repository_id, overrides = {}, identity = {}) => ({
  workspace_id,
  display_name: workspace_id,
  value_stream: 'payments',
  repository_url: `https://example.invalid/${workspace_id}`,
  evidence_endpoint: 'https://example.invalid/e',
  owners: ['platform'],
  status: 'active',
  workload_identity: {
    issuer: ISSUER,
    repository_owner_id: '65',
    repository_id,
    admitted_events: ['push', 'pull_request'],
    ...identity,
  },
  ...overrides,
});

const REGISTRY_DOC = {
  registry_version: 'workspace-registry/1',
  workspaces: [
    registration('payments-art', '74'),
    registration('billing', '78'),
    registration('suspended-ws', '75', { status: 'suspended' }),
    registration('pinned-ref', '76', {}, { required_job_workflow_ref: PIN_REF }),
    registration(
      'pinned-sha',
      '77',
      {},
      { required_job_workflow_ref: PIN_REF, required_job_workflow_sha: PIN_SHA },
    ),
  ],
};

function seam({
  store = createInMemoryEvidenceStore(),
  registry = createRegistry(REGISTRY_DOC),
  clock = { ms: START_MS },
  keySetFetch,
  authenticate,
  quota,
  log = () => {},
} = {}) {
  const keySet = createKeySet({
    now: () => clock.ms,
    fetchKeySet:
      keySetFetch ??
      (async () => ({ body: Buffer.from(JSON.stringify(JWKS)), cacheControl: 'max-age=3600' })),
  });
  return createRequestHandler({
    registry,
    policy,
    evidenceStore: store,
    authenticate: authenticate ?? createAuthenticator({ keySet, now: () => clock.ms }),
    quota: quota ?? createSubmissionQuota({ now: () => clock.ms }),
    log,
    now: () => clock.ms,
  });
}

// A request whose body iterator records every pull. `chunks` is consumed one per next().
function request({ method = 'GET', url, authorization, rawHeaders, headers = {}, chunks = [] }) {
  const pulls = [];
  const raw = rawHeaders ?? (authorization === undefined ? [] : ['Authorization', authorization]);
  return {
    method,
    url,
    headers,
    rawHeaders: raw,
    pulls,
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        next: async () => {
          pulls.push(index);
          if (index < chunks.length) return { value: chunks[index++], done: false };
          return { value: undefined, done: true };
        },
      };
    },
  };
}
const bearer = (overrides, atMs) => `Bearer ${token(overrides, atMs)}`;
const getAs = (url, overrides) => request({ url, authorization: bearer(overrides) });
const postAs = (body, overrides, atMs) =>
  request({
    method: 'POST',
    url: '/v1/evidence',
    authorization: bearer(overrides, atMs),
    chunks: [typeof body === 'string' ? body : JSON.stringify(body)],
  });

async function call(handler, req) {
  const events = [];
  let status;
  let headers;
  let payload;
  req.destroy = () => events.push('destroy');
  await handler(req, {
    writeHead: (value, written) => {
      status = value;
      headers = written;
      events.push('writeHead');
    },
    end: (value, done) => {
      payload = value;
      events.push('end');
      done?.();
    },
  });
  return { status, headers, body: payload === undefined ? undefined : JSON.parse(payload), events };
}

// -------------------------------------------------------------------------------- AC-1, AC-7

test('every route except GET /health declares auth workload', () => {
  for (const route of routes) {
    const expected = route.method === 'GET' && route.path === '/health' ? 'none' : 'workload';
    assert.equal(route.auth, expected, `${route.method} ${route.path}`);
  }
});

test('a route with no auth field fails closed', async () => {
  // The dispatcher reads only `auth === 'none'` as unauthenticated; anything else authenticates.
  const source = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
  assert.match(source, /if \(route\.auth === 'none'\) return route\.handle/);
  assert.doesNotMatch(source, /route\.auth === 'workload'/);
});

// Records every credential-bearing read: rawHeaders, any named header, and the body. send()
// reads the two framing headers to learn whether a body is still unread; those name no credential.
const FRAMING_READS = ['headers.transfer-encoding', 'headers.content-length'];
function spyingRequest(base) {
  const reads = [];
  const req = { method: base.method, url: base.url };
  Object.defineProperty(req, 'rawHeaders', {
    get() {
      reads.push('rawHeaders');
      return ['Authorization', bearer()];
    },
  });
  const headers = new Proxy(
    {},
    {
      get(target, name) {
        reads.push(`headers.${String(name)}`);
        return undefined;
      },
    },
  );
  Object.defineProperty(req, 'headers', { get: () => headers });
  req[Symbol.asyncIterator] = () => {
    reads.push('body');
    return { next: async () => ({ done: true }) };
  };
  return { req, reads };
}

const throwingAuthenticate = async () => {
  throw new Error('a credential was read');
};

test('GET /health reads no credential even when one is sent', async () => {
  const { req, reads } = spyingRequest({ method: 'GET', url: '/health' });
  const { status, body } = await call(seam({ authenticate: throwingAuthenticate }), req);
  assert.equal(status, 200);
  assert.deepEqual(body, { status: 'ok' });
  assert.deepEqual(
    reads.filter((read) => !FRAMING_READS.includes(read)),
    [],
  );
});

test('an unmatched request is 404 before any credential read', async () => {
  for (const [method, url] of [
    ['GET', '/v1/nope'],
    ['GET', '/v1/workspaces?access_token=x'],
    ['GET', '/v1/evidence'],
    ['POST', '/health'],
    ['DELETE', '/v1/workspaces'],
  ]) {
    const { req, reads } = spyingRequest({ method, url });
    const { status, body } = await call(seam({ authenticate: throwingAuthenticate }), req);
    assert.equal(status, 404, `${method} ${url}`);
    assert.deepEqual(body, { error: 'not found' });
    assert.deepEqual(reads, [], `${method} ${url} read ${reads.join(', ')}`);
  }
});

test('a credential in a cookie, an access_token query or the body is never read', async () => {
  const handler = seam();
  const t = token();
  const cookie = request({ url: '/v1/workspaces', rawHeaders: ['Cookie', `access_token=${t}`] });
  assert.equal((await call(handler, cookie)).status, 401);
  const query = request({ url: `/v1/workspaces?access_token=${t}` });
  assert.equal(
    (await call(handler, query)).status,
    404,
    'a query string makes a request unmatched',
  );
  const inBody = request({
    method: 'POST',
    url: '/v1/evidence',
    chunks: [JSON.stringify({ access_token: t, ...validEvidence })],
  });
  const answered = await call(handler, inBody);
  assert.equal(answered.status, 401);
  assert.deepEqual(inBody.pulls, [], 'the body was read for a credential');
  const formBody = request({
    method: 'POST',
    url: '/v1/evidence',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    chunks: [`access_token=${t}`],
  });
  assert.equal((await call(handler, formBody)).status, 401);
  assert.deepEqual(formBody.pulls, []);
});

test('every 401 carries WWW-Authenticate: Bearer error="invalid_token"', async () => {
  const handler = seam();
  const expired = token({ exp: START_MS / 1000 - 61, iat: START_MS / 1000 - 300 });
  for (const authorization of [
    undefined,
    'Basic dXNlcjpwYXNz',
    'Bearer not-a-jws',
    `Bearer ${expired}`,
    `Bearer ${token({ aud: 'https://github.com/owner' })}`,
    `Bearer ${token({ repository_id: '074' })}`,
  ]) {
    for (const url of ['/v1/workspaces', '/v1/indicators']) {
      const { status, headers, body } = await call(handler, request({ url, authorization }));
      assert.equal(status, 401, `${url} ${authorization}`);
      assert.equal(headers['www-authenticate'], 'Bearer error="invalid_token"');
      assert.deepEqual(body, { error: 'invalid token' });
    }
  }
});

test('every 403 case returns one identical body and identical headers', async () => {
  const cases = {
    'no binding': { repository_id: '99' },
    'another owner': { repository_owner_id: '66' },
    suspended: { repository_id: '75' },
    'event not admitted': { event_name: 'workflow_dispatch' },
    'review event not admitted': { event_name: 'pull_request_review' },
    'ref pin absent': { repository_id: '76' },
    'ref pin unequal': { repository_id: '76', job_workflow_ref: `${PIN_REF}x` },
    'sha pin absent': { repository_id: '77', job_workflow_ref: PIN_REF },
    'sha pin unequal': {
      repository_id: '77',
      job_workflow_ref: PIN_REF,
      job_workflow_sha: 'd'.repeat(40),
    },
    'refused actor': { actor_id: '49699333' },
  };
  const answers = [];
  for (const [name, overrides] of Object.entries(cases)) {
    for (const make of [
      () => getAs('/v1/workspaces', overrides),
      () => getAs('/v1/indicators', overrides),
      () => postAs(validEvidence, overrides),
    ]) {
      const req = make();
      const answered = await call(seam(), req);
      assert.equal(answered.status, 403, name);
      assert.deepEqual(req.pulls, [], `${name}: the body was read`);
      answers.push({ headers: answered.headers, body: answered.body });
    }
  }
  for (const answer of answers) assert.deepEqual(answer, answers[0]);
  assert.deepEqual(answers[0].body, { error: 'forbidden' });
  // Control: the same seam does authorize a matching pin, so the 403s above are the pins'.
  const pinned = postAs(validEvidence, {
    repository_id: '77',
    job_workflow_ref: PIN_REF,
    job_workflow_sha: PIN_SHA,
  });
  assert.equal((await call(seam(), pinned)).status, 202);
});

test('a refused actor is 403 even where its event is admitted', async () => {
  const lines = [];
  const handler = seam({ log: (line) => lines.push(line) });
  for (const event_name of ['push', 'pull_request']) {
    const { status } = await call(
      handler,
      postAs(validEvidence, { actor_id: '49699333', event_name }),
    );
    assert.equal(status, 403, event_name);
  }
  assert.deepEqual(
    lines.map((line) => line.reason),
    ['refused-actor', 'refused-actor'],
  );
  // The refusal compares strings: a numeric or zero-padded actor_id is not the refused account,
  // and is refused earlier anyway, at step 5, as a non-canonical ID.
  const padded = await call(handler, postAs(validEvidence, { actor_id: '049699333' }));
  assert.equal(padded.status, 401);
});

test('the predicate reads the registration through registry.get', async () => {
  const real = createRegistry(REGISTRY_DOC);
  const looked = [];
  const watched = {
    bindingFor: (principal) => real.bindingFor(principal),
    list: () => real.list(),
    get: (id) => {
      looked.push(id);
      return real.get(id);
    },
  };
  assert.equal((await call(seam({ registry: watched }), getAs('/v1/indicators'))).status, 200);
  assert.deepEqual(looked, ['payments-art']);
  // And it is the registration get() returns that decides: suspended there is 403 here, though
  // the binding resolved.
  const suspendedView = { ...watched, get: (id) => ({ ...real.get(id), status: 'suspended' }) };
  assert.equal(
    (await call(seam({ registry: suspendedView }), getAs('/v1/indicators'))).status,
    403,
  );
});

// ------------------------------------------------------------------------------------- AC-8

test('GET /v1/workspaces returns exactly [registration W]', async () => {
  const { status, body } = await call(seam(), getAs('/v1/workspaces'));
  assert.equal(status, 200);
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].workspace_id, 'payments-art');
  assert.deepEqual(body.data[0], JSON.parse(JSON.stringify(REGISTRY_DOC.workspaces[0])));
  const other = await call(seam(), getAs('/v1/workspaces', { repository_id: '78' }));
  assert.deepEqual(
    other.body.data.map((entry) => entry.workspace_id),
    ['billing'],
  );
});

test("GET /v1/indicators summarises only W's envelopes and skips redacted ones", async () => {
  const envelope = (workspace_id, evidence) => ({ workspace_id, evidence });
  const fakeStore = {
    append: () => assert.fail('no append on a read'),
    list: async () => [
      envelope('payments-art', { tier: 'T1', result: { pass: true } }),
      envelope('payments-art', { tier: 'T2', result: { pass: false } }),
      envelope('payments-art', null),
      envelope('billing', { tier: 'T3', result: { pass: true } }),
      envelope('billing', { tier: 'T3', result: { pass: true } }),
      envelope(null, { tier: 'T0', result: { pass: true } }),
    ],
    listRecords: () => assert.fail('listRecords is unscoped and must not be used'),
  };
  const { status, body } = await call(seam({ store: fakeStore }), getAs('/v1/indicators'));
  assert.equal(status, 200);
  assert.equal(body.data.total_records, 2);
  assert.equal(body.data.passing_records, 1);
  assert.deepEqual(body.data.by_tier, { T0: 0, T1: 1, T2: 1, T3: 0 });
  assert.equal(body.data.evidence_attestation, 'self-attested');
});

test('POST writes workspace_id W from the principal even when the body names another', async () => {
  const store = createInMemoryEvidenceStore();
  const handler = seam({ store });
  const record = { ...validEvidence, workspace_id: 'billing', submitted_by: { run_id: '1' } };
  assert.equal((await call(handler, postAs(record))).status, 202);
  const [stored] = store.list();
  assert.equal(stored.workspace_id, 'payments-art');
  assert.equal(stored.evidence.workspace_id, 'billing', 'the field stays payload, never identity');
  assert.notEqual(stored.idempotency_key, null, 'a principal-bound submission claims uniqueness');
});

// ------------------------------------------------------------------------------------- AC-9

test('401, 403 and 503 on POST are written, then the socket is destroyed, and no body chunk is pulled', async () => {
  const outage = async () => {
    throw new Error('outage');
  };
  const cases = [
    [401, seam(), request({ method: 'POST', url: '/v1/evidence', chunks: ['{}'] })],
    [403, seam(), postAs(validEvidence, { repository_id: '99' })],
    [503, seam({ keySetFetch: outage }), postAs(validEvidence)],
  ];
  for (const [expected, handler, req] of cases) {
    const { status, headers, events } = await call(handler, req);
    assert.equal(status, expected);
    assert.deepEqual(events, ['writeHead', 'end', 'destroy'], `${expected}: wrong order`);
    assert.equal(headers.connection, 'close');
    assert.deepEqual(req.pulls, [], `${expected}: a body chunk was pulled`);
  }
});

test('503 is the answer on every authenticated route when no key set can be had', async () => {
  const handler = seam({
    keySetFetch: async () => {
      throw new Error('outage');
    },
  });
  for (const url of ['/v1/workspaces', '/v1/indicators']) {
    const { status, body, events } = await call(handler, getAs(url));
    assert.equal(status, 503);
    assert.deepEqual(body, { error: 'key set unavailable' });
    assert.deepEqual(events, ['writeHead', 'end', 'destroy']);
  }
});

// ------------------------------------------------------------------------------------ AC-10

test('an honest content-length over 1048576 is 413 before the body is read', async () => {
  const req = postAs(validEvidence);
  req.headers = { 'content-length': String(MAX_BODY_BYTES + 1) };
  const { status, body, events } = await call(seam(), req);
  assert.equal(status, 413);
  assert.deepEqual(body, { error: 'request body too large' });
  assert.deepEqual(req.pulls, []);
  assert.deepEqual(events, ['writeHead', 'end', 'destroy']);
});

test('a chunked body crossing the cap is 413 at that chunk, with no later chunk pulled and JSON.parse never reached', async () => {
  // The tail after the cap is not JSON. Had the seam parsed what it read, the answer would be
  // 400; a 413 shows the refusal happened inside the read loop, before JSON.parse.
  const req = request({
    method: 'POST',
    url: '/v1/evidence',
    authorization: bearer(),
    chunks: ['x'.repeat(600000), 'x'.repeat(600000), '}not json{', 'never pulled'],
  });
  const { status, events } = await call(seam(), req);
  assert.equal(status, 413);
  assert.deepEqual(req.pulls, [0, 1], 'a chunk after the one that crossed the cap was pulled');
  assert.deepEqual(events, ['writeHead', 'end', 'destroy']);
});

test('exactly 1048576 bytes is read and 1048577 is refused', async () => {
  const sized = (bytes) => {
    const base = JSON.stringify({ ...validEvidence, padding: '' });
    const record = { ...validEvidence, padding: 'p'.repeat(bytes - Buffer.byteLength(base)) };
    const text = JSON.stringify(record);
    assert.equal(Buffer.byteLength(text), bytes);
    return text;
  };
  const store = createInMemoryEvidenceStore();
  const atCap = await call(seam({ store }), postAs(sized(MAX_BODY_BYTES)));
  assert.equal(atCap.status, 202);
  assert.equal(store.list().length, 1);
  const overCap = await call(seam({ store }), postAs(sized(MAX_BODY_BYTES + 1), { run_id: '2' }));
  assert.equal(overCap.status, 413);
  assert.equal(store.list().length, 1, 'an oversized body reached the store');
});

test('413 is written, then the socket is destroyed', async () => {
  const req = request({
    method: 'POST',
    url: '/v1/evidence',
    authorization: bearer(),
    chunks: [Buffer.alloc(MAX_BODY_BYTES + 1, 0x20)],
  });
  const { status, events } = await call(seam(), req);
  assert.equal(status, 413);
  assert.deepEqual(events, ['writeHead', 'end', 'destroy']);
});

test('the 61st authorized POST in a window is 429 with Retry-After, before the body is read', async () => {
  const clock = { ms: START_MS };
  const handler = seam({ clock });
  for (let index = 0; index < SUBMISSION_QUOTA; index += 1) {
    clock.ms = START_MS + index * 100;
    const record = { ...validEvidence, change_id: `PR-${index}` };
    const { status } = await call(handler, postAs(record, {}, START_MS));
    assert.equal(status, 202, `submission ${index + 1}`);
  }
  clock.ms = START_MS + 20_000;
  const req = postAs(validEvidence, {}, START_MS);
  const { status, headers, body, events } = await call(handler, req);
  assert.equal(status, 429);
  assert.equal(headers['retry-after'], '40');
  assert.deepEqual(body, { error: 'submission quota exceeded' });
  assert.deepEqual(req.pulls, []);
  assert.deepEqual(events, ['writeHead', 'end', 'destroy']);
});

// Refusals count too: a 413, a 400 and a 422 have each already cost a read.
test('every authorized POST counts against the quota, whatever its outcome', async () => {
  const clock = { ms: START_MS };
  const handler = seam({ clock });
  for (let index = 0; index < SUBMISSION_QUOTA; index += 1) {
    const { status } = await call(handler, postAs('{ not json'));
    assert.equal(status, 400);
  }
  assert.equal((await call(handler, postAs(validEvidence))).status, 429);
});

test("another principal's quota is independent", async () => {
  const clock = { ms: START_MS };
  const handler = seam({ clock });
  for (let index = 0; index < SUBMISSION_QUOTA; index += 1)
    await call(handler, postAs({ ...validEvidence, change_id: `PR-${index}` }));
  assert.equal((await call(handler, postAs(validEvidence))).status, 429);
  const billing = await call(handler, postAs(validEvidence, { repository_id: '78' }));
  assert.equal(billing.status, 202);
});

test('a new window admits again', async () => {
  const clock = { ms: START_MS };
  const handler = seam({ clock });
  for (let index = 0; index < SUBMISSION_QUOTA; index += 1)
    await call(handler, postAs({ ...validEvidence, change_id: `PR-${index}` }));
  clock.ms = START_MS + SUBMISSION_QUOTA_WINDOW_MS - 1;
  assert.equal((await call(handler, postAs(validEvidence, {}, START_MS))).status, 429);
  clock.ms = START_MS + SUBMISSION_QUOTA_WINDOW_MS;
  const next = await call(handler, postAs({ ...validEvidence, change_id: 'PR-new' }, {}, START_MS));
  assert.equal(next.status, 202);
});

test('the quota answers whole seconds, never zero', () => {
  const clock = { ms: 0 };
  const quota = createSubmissionQuota({ now: () => clock.ms });
  for (let index = 0; index < SUBMISSION_QUOTA; index += 1) assert.equal(quota.take('k').ok, true);
  clock.ms = 59_999;
  assert.deepEqual(quota.take('k'), { ok: false, retryAfterS: 1 });
  clock.ms = 1;
  assert.deepEqual(quota.take('k'), { ok: false, retryAfterS: 60 });
});

test('createApp sets headersTimeout 10000 and requestTimeout 30000', () => {
  const server = createApp({ log: () => {} });
  assert.equal(server.headersTimeout, 10000);
  assert.equal(server.requestTimeout, 30000);
  assert.equal(server.listening, false, 'createApp must not listen');
});

// Node checks both timeouts on one timer, every connectionsCheckingInterval (30 s by default), so
// the value read back above is not the bound a slow peer meets. Pinning the interval is what makes
// 10 s and 30 s the bound to within a second. A behavioural test would take 10 s: the check runs
// on Node's own monotonic clock, which mock.timers cannot advance.
test('createApp checks the read timeouts every 1000 ms, not every 30 s', () => {
  const server = createApp({ log: () => {} });
  assert.equal(server.connectionsCheckingInterval, 1000);
  assert.equal(createSeamServer(seam()).connectionsCheckingInterval, 1000);
});

test('the cap, timeouts and quota are literal constants', () => {
  assert.equal(MAX_BODY_BYTES, 1048576);
  assert.equal(HEADERS_TIMEOUT_MS, 10000);
  assert.equal(REQUEST_TIMEOUT_MS, 30000);
  assert.equal(CONNECTIONS_CHECKING_INTERVAL_MS, 1000);
  assert.equal(SUBMISSION_QUOTA, 60);
  assert.equal(SUBMISSION_QUOTA_WINDOW_MS, 60000);
  const source = readFileSync(new URL('./admission.mjs', import.meta.url), 'utf8');
  const code = source
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
  for (const spelling of [/\bprocess\b/, /['"]node:process['"]/, /import\.meta\.env/])
    assert.doesNotMatch(code, spelling);
});

// ----------------------------------------------------------- connection disposition, socket

// A real socket on 127.0.0.1 around the seam, built by createSeamServer exactly as createApp
// builds the service, with the in-test key set and registry. The client is raw TCP so a test sees
// every byte the server writes, an interim 100 Continue included, and the client never closes
// first, so a close is the server's.
async function listening(handler) {
  const server = createSeamServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

async function rawClient(server) {
  const socket = connect(server.address().port, '127.0.0.1');
  await once(socket, 'connect');
  const client = { socket, text: '', closed: false };
  socket.setEncoding('latin1');
  socket.on('data', (chunk) => (client.text += chunk));
  socket.on('error', () => {});
  socket.on('close', () => (client.closed = true));
  return client;
}

async function until(predicate, what) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await delay(5);
  }
}

const statusLines = (text) => text.match(/^HTTP\/1\.1 \d{3}/gm) ?? [];
const closes = (text) => /\r\nconnection: close\r\n/i.test(text);

async function withServer(handler, body) {
  const server = await listening(handler);
  try {
    await body(server);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

test('a 404 and a GET /health sent a streaming body get their status, then the server closes the connection', async () => {
  await withServer(seam(), async (server) => {
    // Both framings: a chunked body that never ends, and a declared Content-Length of which only
    // 64 KiB arrives. Either way the peer would keep streaming into a socket nobody reads.
    const framings = {
      chunked: `Transfer-Encoding: chunked\r\n\r\n10000\r\n${'x'.repeat(0x10000)}\r\n`,
      'content-length': `Content-Length: ${MAX_BODY_BYTES}\r\n\r\n${'x'.repeat(0x10000)}`,
    };
    for (const [line, expected] of [
      ['POST /v1/nope', 'HTTP/1.1 404'],
      ['GET /health', 'HTTP/1.1 200'],
    ]) {
      for (const [framing, rest] of Object.entries(framings)) {
        const at = `${line} (${framing})`;
        const client = await rawClient(server);
        client.socket.write(`${line} HTTP/1.1\r\nHost: x\r\n${rest}`);
        await until(() => client.closed, `${at}: the server to close the connection`);
        assert.deepEqual(statusLines(client.text), [expected], at);
        assert.ok(closes(client.text), `${at}: no connection: close`);
      }
    }
  });
});

test('a request read to its end keeps its connection', async () => {
  await withServer(seam(), async (server) => {
    const client = await rawClient(server);
    const body = JSON.stringify(validEvidence);
    const exchanges = [
      ['GET /health HTTP/1.1\r\nHost: x\r\n\r\n', 'HTTP/1.1 200'],
      [
        `POST /v1/evidence HTTP/1.1\r\nHost: x\r\nAuthorization: ${bearer()}\r\n` +
          `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
        'HTTP/1.1 202',
      ],
      ['GET /health HTTP/1.1\r\nHost: x\r\n\r\n', 'HTTP/1.1 200'],
    ];
    for (const [index, [raw]] of exchanges.entries()) {
      client.socket.write(raw);
      await until(() => statusLines(client.text).length === index + 1, `response ${index + 1}`);
    }
    assert.deepEqual(
      statusLines(client.text),
      exchanges.map(([, expected]) => expected),
    );
    assert.equal(closes(client.text), false, 'a fully read request was answered connection: close');
    await delay(50);
    assert.equal(client.closed, false, 'the server closed a connection whose request it had read');
  });
});

// S-3. Without a 'checkContinue' listener Node answers 100 Continue before the handler runs, so
// an unauthenticated client would be invited to send its body and then refused.
test('Expect: 100-continue is answered only once a POST is admitted; every refusal gets no 100 and a close', async () => {
  const exhausted = { take: () => ({ ok: false, retryAfterS: 42 }) };
  const expecting = (line, extra = '', length = 2) =>
    `${line} HTTP/1.1\r\nHost: x\r\nExpect: 100-continue\r\n${extra}Content-Length: ${length}\r\n\r\n`;
  const refused = [
    [seam(), expecting('POST /v1/evidence'), 'HTTP/1.1 401'],
    [
      seam(),
      expecting('POST /v1/evidence', `Authorization: ${bearer({ repository_id: '99' })}\r\n`),
      'HTTP/1.1 403',
    ],
    [
      seam({ quota: exhausted }),
      expecting('POST /v1/evidence', `Authorization: ${bearer()}\r\n`),
      'HTTP/1.1 429',
    ],
    [
      seam(),
      expecting('POST /v1/evidence', `Authorization: ${bearer()}\r\n`, MAX_BODY_BYTES + 1),
      'HTTP/1.1 413',
    ],
    [seam(), expecting('GET /health'), 'HTTP/1.1 200'],
    [seam(), expecting('POST /v1/nope', `Authorization: ${bearer()}\r\n`), 'HTTP/1.1 404'],
  ];
  for (const [handler, raw, expected] of refused)
    await withServer(handler, async (server) => {
      const client = await rawClient(server);
      client.socket.write(raw);
      await until(() => client.closed, `${expected}: the server to close the connection`);
      assert.deepEqual(statusLines(client.text), [expected], `${expected}: a 100 was sent`);
    });

  await withServer(seam(), async (server) => {
    const client = await rawClient(server);
    const body = JSON.stringify(validEvidence);
    client.socket.write(
      expecting('POST /v1/evidence', `Authorization: ${bearer()}\r\n`, Buffer.byteLength(body)),
    );
    await until(() => statusLines(client.text).length === 1, 'the 100 Continue');
    assert.deepEqual(statusLines(client.text), ['HTTP/1.1 100']);
    client.socket.write(body);
    await until(() => statusLines(client.text).length === 2, 'the 202');
    assert.deepEqual(statusLines(client.text), ['HTTP/1.1 100', 'HTTP/1.1 202']);
  });
});

// B-2. Without a 'checkExpectation' listener Node answers any other Expect value with 417 itself,
// bypassing send(), keeps the connection and reads the body until requestTimeout.
test('an unknown Expect value is ignored: refusals close unread, an admitted POST keeps its connection', async () => {
  const body = JSON.stringify(validEvidence);
  const unread = `Content-Length: ${MAX_BODY_BYTES}\r\n\r\n${'x'.repeat(0x10000)}`;
  for (const [raw, expected] of [
    [`POST /v1/evidence HTTP/1.1\r\nHost: x\r\nExpect: foo\r\n${unread}`, 'HTTP/1.1 401'],
    [`GET /health HTTP/1.1\r\nHost: x\r\nExpect: foo\r\n${unread}`, 'HTTP/1.1 200'],
  ])
    await withServer(seam(), async (server) => {
      const client = await rawClient(server);
      client.socket.write(raw);
      await until(() => client.closed, `${expected}: the server to close the connection`);
      assert.deepEqual(statusLines(client.text), [expected]);
      assert.ok(closes(client.text), `${expected}: no connection: close`);
    });

  await withServer(seam(), async (server) => {
    const client = await rawClient(server);
    client.socket.write(
      `POST /v1/evidence HTTP/1.1\r\nHost: x\r\nExpect: foo\r\nAuthorization: ${bearer()}\r\n` +
        `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
    await until(() => statusLines(client.text).length === 1, 'the 202');
    assert.deepEqual(statusLines(client.text), ['HTTP/1.1 202']);
    assert.equal(closes(client.text), false, 'an admitted POST was answered connection: close');
    await delay(50);
    assert.equal(client.closed, false, 'the server closed an admitted request it had read');
  });
});

// ------------------------------------------------------------------------- AC-11 envelope side

test('an accepted envelope carries submitted_by from the token, never from the body', async () => {
  const store = createInMemoryEvidenceStore();
  const forged = {
    issuer: 'https://attacker.invalid',
    repository_id: '1',
    run_id: '1',
  };
  const record = { ...validEvidence, submitted_by: forged };
  const { status } = await call(
    seam({ store }),
    postAs(record, { run_id: '424242', run_attempt: '3' }),
  );
  assert.equal(status, 202);
  const [envelope] = store.list();
  assert.deepEqual(envelope.submitted_by, {
    issuer: ISSUER,
    repository_owner_id: '65',
    repository_id: '74',
    run_id: '424242',
    run_attempt: '3',
    sha: MEASURED.sha,
    ref: 'refs/heads/main',
    event_name: 'push',
    workflow_ref: 'owner/payments/.github/workflows/gate.yml@refs/heads/main',
    job_workflow_ref: MEASURED.job_workflow_claims_outside_reusable
      ? 'owner/payments/.github/workflows/gate.yml@refs/heads/main'
      : null,
    job_workflow_sha: MEASURED.job_workflow_claims_outside_reusable
      ? MEASURED.job_workflow_sha
      : null,
  });
  assert.deepEqual(envelope.evidence.submitted_by, forged, 'the body field stays payload');
});

test("a duplicate and a conflict keep the first envelope's submitted_by", async () => {
  const store = createInMemoryEvidenceStore();
  const handler = seam({ store });
  assert.equal((await call(handler, postAs(validEvidence, { run_id: '1' }))).status, 202);
  const replay = await call(handler, postAs(validEvidence, { run_id: '2', run_attempt: '2' }));
  const conflict = await call(
    handler,
    postAs({ ...validEvidence, result: { pass: false } }, { run_id: '3' }),
  );
  // Divergence 6: both are answered 202 until 2.2 assigns a conflict its status.
  assert.equal(replay.status, 202);
  assert.equal(conflict.status, 202);
  const stored = store.list();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].submitted_by.run_id, '1');
  assert.equal(stored[0].evidence.result.pass, true);
});
