import assert from 'node:assert/strict';
import { constants, generateKeyPairSync, sign as rsaSign } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { createAuthenticator } from '../../workload-identity/src/authenticate.mjs';
import { createKeySet } from '../../workload-identity/src/key-set.mjs';
import { createRegistry } from '../../workspace-registry/src/registry.mjs';
import { createRequestHandler, routes } from './main.mjs';
import { createInMemoryEvidenceStore } from './evidence-store.mjs';
import { validateAgainstSchema } from './openapi-schema.mjs';

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

// openapi.json is read by URL rather than imported, so the workspace's Nx-edge control - which
// derives the project graph from import statements - sees exactly the dependencies this package
// declares, and reading the published contract does not invent one.
const document = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'));
const source = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const PATH_ITEM_ANNOTATIONS = ['summary', 'description'];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sorted = (values) => [...values].sort();

const operations = Object.entries(document.paths).flatMap(([path, item]) =>
  Object.entries(item)
    .filter(([key]) => METHODS.includes(key))
    .map(([method, operation]) => ({ path, method, operation })),
);

const responseSchema = (path, method, status) =>
  document.paths[path][method].responses[String(status)].content['application/json'].schema;

const recordSchema =
  document.paths['/v1/evidence'].post.requestBody.content['application/json'].schema;
const unmatched = document['x-unmatched-request'];

const conforms = (value, schema) => validateAgainstSchema(value, schema, document);

// Every fixture below is an inline literal, deliberately not imported from the contracts package.
// Two reasons, both structural.
//
// 1. A fixture that read the supported schema version out of the contracts package would follow
//    a version bump silently. These tests exist to notice when the published document and the
//    seam stop agreeing about which version is supported, and a fixture that moves with the code
//    under test cannot detect drift in that code.
// 2. The import would declare a control-plane-api edge onto the contracts project, taking that
//    project's fan-in from 2 to 3. At 3 the generated component map flips its `shared` flag to
//    true, which permanently raises the blast-radius tier of every future change under the
//    contracts package. A test fixture is not a reason to retier a package.
//
// main.test.mjs already hardcodes the same literals, for the same reasons. Every request is
// authenticated by a real token signed here with a key generated here, verified by the real
// authenticator over a key set fed an in-test JWKS; nothing reaches the network.
const ISSUER = 'https://token.actions.githubusercontent.com';
const AUDIENCE = 'urn:codeaiforge:sdlc-control-plane:production';
const NOW_MS = Date.UTC(2026, 9, 7, 12, 0, 0);
const NOW_S = NOW_MS / 1000;

const signing = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWKS = {
  keys: [{ ...signing.publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' }],
};
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
function sign(claims) {
  const input = `${b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' })}.${b64(claims)}`;
  const signature = rsaSign('sha256', Buffer.from(input), {
    key: signing.privateKey,
    padding: constants.RSA_PKCS1_PADDING,
  });
  return `${input}.${signature.toString('base64url')}`;
}
const token = (overrides = {}) =>
  sign({
    iss: ISSUER,
    aud: AUDIENCE,
    iat: NOW_S,
    nbf: NOW_S - MEASURED.nbf_before_iat_s,
    exp: NOW_S + MEASURED.lifetime_s,
    repository_owner_id: '65',
    repository_id: '74',
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
    issuer: ISSUER,
    repository_owner_id: '65',
    repository_id: '74',
    admitted_events: ['push', 'pull_request'],
  },
};

const okKeySet = async () => ({
  body: Buffer.from(JSON.stringify(JWKS)),
  cacheControl: 'max-age=3600',
});
const outage = async () => {
  throw new Error('outage');
};

const seam = (evidenceStore = createInMemoryEvidenceStore(), overrides = {}) => {
  const { fetchKeySet = okKeySet, ...rest } = overrides;
  const keySet = createKeySet({ now: () => NOW_MS, fetchKeySet });
  return createRequestHandler({
    registry: createRegistry({ registry_version: 'workspace-registry/1', workspaces: [workspace] }),
    policy,
    evidenceStore,
    authenticate: createAuthenticator({ keySet, now: () => NOW_MS }),
    log: () => {},
    now: () => NOW_MS,
    ...rest,
  });
};

// The harness records the status, the headers writeHead was given and the body, so the headers a
// response declares can be held to the ones the seam sends.
const call = async (handler, request) => {
  let status;
  let headers = {};
  let body = '';
  request.destroy ??= () => {};
  await handler(request, {
    writeHead: (value, written = {}) => {
      status = value;
      headers = written;
    },
    end: (value, done) => {
      body = value;
      done?.();
    },
  });
  return { status, headers, body: JSON.parse(body) };
};

const credential = (overrides) => ['Authorization', `Bearer ${token(overrides)}`];
const get = (url, rawHeaders = credential()) => ({ method: 'GET', url, rawHeaders });
const anonymous = (url) => ({ method: 'GET', url, rawHeaders: [] });

const post = (
  raw,
  headers = { 'content-type': 'application/json' },
  rawHeaders = credential(),
) => ({
  method: 'POST',
  url: '/v1/evidence',
  headers,
  rawHeaders,
  async *[Symbol.asyncIterator]() {
    yield raw;
  },
});

const exhausted = { take: () => ({ ok: false, retryAfterS: 42 }) };

// One entry per documented (route, status) pair. The table is the bridge: the document is
// compared against it, and the seam is driven through it, so neither side can claim a status the
// other does not produce. Names follow the roadmap's wording - accepted, invalid and
// incompatible evidence - so the acceptance phase can cite a test name as evidence.
const authenticatedRefusals = (method, path, request) => [
  {
    name: `${method} ${path} -> 401 a request with no usable credential`,
    method,
    path,
    status: 401,
    request: () => request([]),
    claim: (body) => assert.deepEqual(body, { error: 'invalid token' }),
  },
  {
    name: `${method} ${path} -> 403 a verified token bound to no registered workspace`,
    method,
    path,
    status: 403,
    request: () => request(credential({ repository_id: '99' })),
    claim: (body) => assert.deepEqual(body, { error: 'forbidden' }),
  },
  {
    name: `${method} ${path} -> 503 no key set available to verify against`,
    method,
    path,
    status: 503,
    seam: () => seam(undefined, { fetchKeySet: outage }),
    request: () => request(credential()),
    claim: (body) => assert.deepEqual(body, { error: 'key set unavailable' }),
  },
];

const scenarios = [
  {
    name: 'GET /health -> 200 liveness',
    method: 'GET',
    path: '/health',
    status: 200,
    request: () => anonymous('/health'),
    claim: (body) => assert.deepEqual(body, { status: 'ok' }),
  },
  {
    name: "GET /v1/workspaces -> 200 the caller's own registration",
    method: 'GET',
    path: '/v1/workspaces',
    status: 200,
    request: () => get('/v1/workspaces'),
    claim: (body) => {
      assert.equal(body.data.length, 1);
      assert.deepEqual(body.data[0].owners, ['platform']);
      assert.equal(body.data[0].value_stream, 'payments');
    },
  },
  ...authenticatedRefusals('GET', '/v1/workspaces', (raw) => get('/v1/workspaces', raw)),
  {
    name: 'GET /v1/indicators -> 200 descriptive indicator summary',
    method: 'GET',
    path: '/v1/indicators',
    status: 200,
    request: () => get('/v1/indicators'),
    claim: (body) => {
      assert.match(body.data.note, /not a portfolio decision/);
      assert.equal(body.data.evidence_attestation, 'self-attested');
    },
  },
  ...authenticatedRefusals('GET', '/v1/indicators', (raw) => get('/v1/indicators', raw)),
  {
    name: 'POST /v1/evidence -> 202 accepted evidence',
    method: 'POST',
    path: '/v1/evidence',
    status: 202,
    request: () => post(JSON.stringify(validEvidence)),
    claim: (body) => {
      assert.equal(body.decision.disposition, 'accepted');
      assert.equal(body.decision.reasons.length, 0);
      assert.equal(body.decision.evidence_attestation, 'self-attested');
    },
  },
  {
    name: 'POST /v1/evidence -> 400 invalid evidence that is not parseable JSON',
    method: 'POST',
    path: '/v1/evidence',
    status: 400,
    request: () => post('{ not json'),
    claim: (body) => assert.deepEqual(body, { error: 'request body must be valid JSON' }),
  },
  ...authenticatedRefusals('POST', '/v1/evidence', (raw) =>
    post(JSON.stringify(validEvidence), undefined, raw),
  ),
  {
    name: 'POST /v1/evidence -> 413 a body over the byte cap',
    method: 'POST',
    path: '/v1/evidence',
    status: 413,
    request: () => post(`"${'x'.repeat(1048576)}"`),
    claim: (body) => assert.deepEqual(body, { error: 'request body too large' }),
  },
  {
    name: 'POST /v1/evidence -> 422 evidence the contract or the policy did not accept',
    method: 'POST',
    path: '/v1/evidence',
    status: 422,
    request: () => post(JSON.stringify({ ...validEvidence, verification: { verified: [] } })),
    claim: (body) => {
      assert.equal(body.decision.accepted, false);
      assert.deepEqual(body.decision.reasons, ['required control not claimed: CAF-SDLC-002:tier']);
      assert.equal(body.decision.evidence_attestation, 'self-attested');
    },
  },
  {
    name: 'POST /v1/evidence -> 429 a principal over its submission quota',
    method: 'POST',
    path: '/v1/evidence',
    status: 429,
    seam: () => seam(undefined, { quota: exhausted }),
    request: () => post(JSON.stringify(validEvidence)),
    claim: (body) => assert.deepEqual(body, { error: 'submission quota exceeded' }),
  },
];

const handlerFor = (scenario) => (scenario.seam ? scenario.seam() : seam());

test('the document declares an OpenAPI version, a title and a contract version', () => {
  assert.equal(typeof document.openapi, 'string');
  assert.ok(document.openapi.length > 0, 'openapi version must not be empty');
  assert.equal(typeof document.info.title, 'string');
  assert.equal(typeof document.info.version, 'string');
});

test('the document exposes its paths and component schemas as objects', () => {
  assert.equal(isObject(document.paths), true);
  assert.equal(isObject(document.components.schemas), true);
});

test('the document states what happens to a request it never declared', () => {
  assert.equal(typeof unmatched.status, 'number');
  assert.equal(typeof unmatched.description, 'string');
  assert.equal(typeof unmatched.content['application/json'].schema.$ref, 'string');
});

test('every key in a path item is an HTTP method or a path-level annotation', () => {
  for (const [path, item] of Object.entries(document.paths)) {
    for (const key of Object.keys(item)) {
      assert.ok(
        METHODS.includes(key) || PATH_ITEM_ANNOTATIONS.includes(key),
        `${path} carries "${key}", so an operation could hide behind a key this suite ignores`,
      );
    }
  }
});

test('the documented route set equals the route table the seam dispatches on', () => {
  assert.deepEqual(
    sorted(operations.map(({ method, path }) => `${method.toUpperCase()} ${path}`)),
    sorted(routes.map((route) => `${route.method} ${route.path}`)),
  );
});

test('the documented (route, status) pairs are exactly the pairs exercised here', () => {
  const documented = operations.flatMap(({ method, path, operation }) =>
    Object.keys(operation.responses).map(
      (status) => `${method.toUpperCase()} ${path} -> ${status}`,
    ),
  );
  const exercised = scenarios.map(({ method, path, status }) => `${method} ${path} -> ${status}`);
  assert.deepEqual(sorted(documented), sorted(exercised));
});

for (const scenario of scenarios) {
  test(`${scenario.name} answers with the status the document declares`, async () => {
    const { status } = await call(handlerFor(scenario), scenario.request());
    assert.equal(status, scenario.status);
    assert.ok(
      document.paths[scenario.path][scenario.method.toLowerCase()].responses[String(status)],
      `the seam answered ${status}, which this path does not declare`,
    );
  });

  test(`${scenario.name} answers with a body the documented schema accepts`, async () => {
    const { body } = await call(handlerFor(scenario), scenario.request());
    const schema = responseSchema(scenario.path, scenario.method.toLowerCase(), scenario.status);
    const { ok, errors } = conforms(body, schema);
    assert.deepEqual(errors, []);
    assert.equal(ok, true);
    scenario.claim(body);
  });
}

// AC-14. A response that declares a header is held to the header the seam sends, by name and by
// schema; and the seam sends no header a response does not declare, beyond the two transport
// headers every response carries.
const TRANSPORT_HEADERS = ['content-type', 'connection'];

for (const scenario of scenarios) {
  test(`${scenario.name} sends exactly the headers the document declares`, async () => {
    const { headers } = await call(handlerFor(scenario), scenario.request());
    const declared =
      document.paths[scenario.path][scenario.method.toLowerCase()].responses[
        String(scenario.status)
      ].headers ?? {};
    const sent = Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
    );
    for (const [name, header] of Object.entries(declared)) {
      const value = sent[name.toLowerCase()];
      assert.notEqual(value, undefined, `${scenario.name}: ${name} is declared and not sent`);
      assert.deepEqual(conforms(value, header.schema).errors, [], `${scenario.name}: ${name}`);
    }
    const declaredNames = Object.keys(declared).map((name) => name.toLowerCase());
    for (const name of Object.keys(sent)) {
      if (TRANSPORT_HEADERS.includes(name)) continue;
      assert.ok(declaredNames.includes(name), `${scenario.name}: sends undeclared ${name}`);
    }
  });
}

// The POST description's connection claim, held to the seam: a status decided before the body is
// read, x-unmatched-request included, is written with connection: close and then the request is
// destroyed; so is any other response sent while a declared body is unread. For a request with no
// body the seam itself closes and destroys nothing - what Node then does with the connection is
// not part of the claim.
const disposition = async (handler, request) => {
  const events = [];
  let headers = {};
  request.destroy = () => events.push('destroy');
  await handler(request, {
    writeHead: (value, written = {}) => {
      headers = written;
      events.push('writeHead');
    },
    end: (value, done) => {
      events.push('end');
      done?.();
    },
  });
  return { connection: headers.connection, events };
};
const CLOSED = { connection: 'close', events: ['writeHead', 'end', 'destroy'] };
const KEPT = { connection: undefined, events: ['writeHead', 'end'] };

test('x-unmatched-request and the refusals close the connection after the response is written', async () => {
  // The POSTs declare a two-byte body the seam never reads.
  const declared = (request) => ({
    ...request,
    headers: { 'content-length': '2' },
    complete: false,
  });
  const cases = [
    ['404', seam(), anonymous('/v1/nope')],
    ['404', seam(), { method: 'POST', url: '/health', rawHeaders: [] }],
    ['401', seam(), declared(post('{}', undefined, []))],
    ['403', seam(), declared(post('{}', undefined, credential({ repository_id: '99' })))],
    ['503', seam(undefined, { fetchKeySet: outage }), declared(post('{}'))],
    ['429', seam(undefined, { quota: exhausted }), declared(post('{}'))],
  ];
  for (const [status, handler, request] of cases)
    assert.deepEqual(await disposition(handler, request), CLOSED, `${status} ${request.url}`);
});

test('a response sent while a declared body is unread closes the connection; for one with no body the seam closes nothing', async () => {
  const unread = { headers: { 'transfer-encoding': 'chunked' }, complete: false };
  assert.deepEqual(await disposition(seam(), { ...anonymous('/health'), ...unread }), CLOSED);
  assert.deepEqual(
    await disposition(seam(), { ...anonymous('/health'), headers: {}, complete: false }),
    KEPT,
  );
});

test('declared response headers match the headers the seam sends', () => {
  // Guard on the loop above: the two headers 2.1 introduced are both declared and both exercised.
  const declared = operations.flatMap(({ path, method, operation }) =>
    Object.entries(operation.responses).flatMap(([status, response]) =>
      Object.keys(response.headers ?? {}).map(
        (name) => `${method.toUpperCase()} ${path} ${status} ${name}`,
      ),
    ),
  );
  assert.deepEqual(sorted(declared), [
    'GET /v1/indicators 401 WWW-Authenticate',
    'GET /v1/workspaces 401 WWW-Authenticate',
    'POST /v1/evidence 401 WWW-Authenticate',
    'POST /v1/evidence 429 Retry-After',
  ]);
});

test('security is declared on exactly the routes that require a workload', () => {
  const schemes = document.components.securitySchemes;
  assert.deepEqual(Object.keys(schemes), ['githubActionsOidc']);
  assert.equal(schemes.githubActionsOidc.type, 'http');
  assert.equal(schemes.githubActionsOidc.scheme, 'bearer');
  for (const { path, method, operation } of operations) {
    assert.ok(
      Array.isArray(operation.security),
      `${method.toUpperCase()} ${path} states no security requirement, so its default is implicit`,
    );
    for (const requirement of operation.security)
      for (const name of Object.keys(requirement))
        assert.ok(Object.hasOwn(schemes, name), `${path} names an undeclared scheme ${name}`);
  }
  const secured = operations
    .filter(({ operation }) => operation.security.length > 0)
    .map(({ method, path }) => `${method.toUpperCase()} ${path}`);
  const workload = routes
    .filter((route) => route.auth !== 'none')
    .map((route) => `${route.method} ${route.path}`);
  assert.deepEqual(sorted(secured), sorted(workload));
});

test('every operation but GET /health declares 401, 403 and 503, and the POST 413 and 429', () => {
  for (const { path, method, operation } of operations) {
    const statuses = Object.keys(operation.responses);
    if (path === '/health') {
      assert.deepEqual(statuses, ['200']);
      continue;
    }
    for (const status of ['401', '403', '503'])
      assert.ok(statuses.includes(status), `${method} ${path} does not declare ${status}`);
  }
  const post = Object.keys(document.paths['/v1/evidence'].post.responses);
  for (const status of ['413', '429']) assert.ok(post.includes(status));
});

test('info.version is 0.2.0', () => {
  // Bumped once, by task 2.1, for the authentication statuses, the 413, the 429, Workspace /1 and
  // evidence_attestation together.
  assert.equal(document.info.version, '0.2.0');
});

test('evidence_attestation is required and single-valued on the three schemas ADR-0004 names', () => {
  for (const name of ['AcceptedDecision', 'UnacceptedDecision', 'IndicatorSummary']) {
    const schema = document.components.schemas[name];
    assert.ok(schema.required.includes('evidence_attestation'), name);
    assert.deepEqual(schema.properties.evidence_attestation.enum, ['self-attested'], name);
    assert.equal(schema.additionalProperties, false, name);
  }
});

test('the Workspace schema is workspace-registry/1: the binding is required and closed', () => {
  const ws = document.components.schemas.Workspace;
  assert.ok(ws.required.includes('workload_identity'));
  assert.deepEqual(ws.properties.status.enum, ['active', 'suspended']);
  const wi = document.components.schemas.WorkloadIdentity;
  assert.equal(wi.additionalProperties, false);
  assert.deepEqual(wi.properties.issuer.enum, [ISSUER]);
  assert.deepEqual(wi.properties.admitted_events.items.enum, [
    'push',
    'pull_request',
    'pull_request_review',
  ]);
  const registration = (overrides) => ({ ...workspace, ...overrides });
  assert.deepEqual(conforms(registration(), { $ref: '#/components/schemas/Workspace' }).errors, []);
  for (const bad of [
    { status: 'retired' },
    { workload_identity: { ...workspace.workload_identity, required_workflow_ref: 'x' } },
    { workload_identity: undefined },
  ]) {
    const value = JSON.parse(JSON.stringify(registration(bad)));
    assert.equal(conforms(value, { $ref: '#/components/schemas/Workspace' }).ok, false);
  }
});

// No status can be written outside the sweep below: the verifier package writes no response at
// all. Its one `.end(` is the client side of the key-set fetch, ending the outgoing request.
test('no module in workload-identity can write an HTTP response', () => {
  const dir = new URL('../../workload-identity/src/', import.meta.url);
  for (const file of readdirSync(dir).filter(
    (name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs'),
  )) {
    const text = readFileSync(new URL(file, dir), 'utf8');
    assert.doesNotMatch(text, /\bwriteHead\b/, file);
    assert.doesNotMatch(text, /\bstatusCode\s*=(?!=)/, file);
    assert.doesNotMatch(text, /\bcreateServer\b/, file);
    const ends = [...text.matchAll(/\.end\(/g)].length;
    const allowed =
      file === 'https-transport.mjs' ? [...text.matchAll(/\boutgoing\.end\(\);/g)].length : 0;
    assert.equal(
      ends,
      allowed,
      `${file} calls .end( on something other than its own outgoing request`,
    );
  }
});

// Reading the module as text is the technique tools/sdlc-controls/graph-fidelity.test.mjs already
// uses: a claim about source is checked against that source rather than against a second
// description of it.
test('every status the seam can send is a status the document declares', () => {
  const literals = [...source.matchAll(/(?<!function )send\(\s*response,\s*(\d{3})/g)];
  const documented = operations.flatMap(({ operation }) => Object.keys(operation.responses));
  assert.deepEqual(
    sorted(new Set(literals.map((match) => match[1]))),
    sorted(new Set([...documented, String(unmatched.status)])),
  );
});

test('every send() call site passes a numeric status literal, so the sweep cannot miss one', () => {
  // The guard on the guard: the sweep above only sees three-digit literals, so a future
  // `send(response, status, ...)` would quietly drop out of it. Counting call sites makes that
  // refactor fail here instead of passing silently with a smaller status set.
  const callSites = [...source.matchAll(/(?<!function )send\(\s*response,\s*/g)];
  const literals = [...source.matchAll(/(?<!function )send\(\s*response,\s*(\d{3})/g)];
  assert.equal(
    callSites.length,
    literals.length,
    'a send() call site passes a computed status, so the status sweep no longer sees every status',
  );
});

test('accepted evidence satisfies the documented record and is accepted', async () => {
  assert.deepEqual(conforms(validEvidence, recordSchema).errors, []);
  const { status, body } = await call(seam(), post(JSON.stringify(validEvidence)));
  assert.equal(status, 202);
  assert.equal(body.decision.accepted, true);
  assert.equal(body.decision.policy_id, 'test-policy@1');
});

test('evidence that satisfies the documented record but not the policy is needs-remediation and names the policy', async () => {
  const record = { ...validEvidence, verification: { verified: [] } };
  assert.deepEqual(conforms(record, recordSchema).errors, []);
  const { status, body } = await call(seam(), post(JSON.stringify(record)));
  assert.equal(status, 422);
  assert.equal(body.decision.disposition, 'needs-remediation');
  assert.equal(body.decision.policy_id, 'test-policy@1');
});

test('incompatible evidence (an unsupported schema version) is rejected and names no policy', async () => {
  const record = { ...validEvidence, schema_version: 'evidence/1' };
  assert.equal(conforms(record, recordSchema).ok, false);
  const { status, body } = await call(seam(), post(JSON.stringify(record)));
  assert.equal(status, 422);
  assert.equal(body.decision.disposition, 'rejected');
  assert.equal(
    Object.hasOwn(body.decision, 'policy_id'),
    false,
    'no policy was reached, so naming one would claim an evaluation that never happened',
  );
});

test('invalid evidence (an unknown tier) is rejected and names no policy', async () => {
  const record = { ...validEvidence, tier: 'T9' };
  assert.equal(conforms(record, recordSchema).ok, false);
  const { status, body } = await call(seam(), post(JSON.stringify(record)));
  assert.equal(status, 422);
  assert.equal(body.decision.disposition, 'rejected');
  assert.equal(Object.hasOwn(body.decision, 'policy_id'), false);
});

test('an unrecognised additive field satisfies the document and is still accepted (NFR-1.1)', async () => {
  const record = { ...validEvidence, upstream_addition: { added: 'in a later evidence version' } };
  assert.deepEqual(conforms(record, recordSchema).errors, []);
  const store = createInMemoryEvidenceStore();
  const { status, body } = await call(seam(store), post(JSON.stringify(record)));
  assert.equal(status, 202);
  assert.equal(body.decision.disposition, 'accepted');
  assert.equal(store.list().length, 1);
});

// Divergence freezes. Each one is behaviour info.description admits to; freezing it here
// means a later change to any of them has to change the document in the same commit.
test('divergence: a query string on a documented path is unmatched, not a match', async () => {
  const { status, body } = await call(seam(), anonymous('/health?x=1'));
  assert.equal(status, unmatched.status);
  assert.deepEqual(body, { error: 'not found' });
  assert.deepEqual(conforms(body, unmatched.content['application/json'].schema).errors, []);
});

test('divergence: an undeclared method on a documented path is a 404, never a 405', async () => {
  for (const request of [get('/v1/evidence'), { method: 'POST', url: '/health', rawHeaders: [] }]) {
    const { status, body } = await call(seam(), request);
    assert.equal(status, unmatched.status);
    assert.deepEqual(body, { error: 'not found' });
    assert.deepEqual(conforms(body, unmatched.content['application/json'].schema).errors, []);
  }
});

test('divergence: a JSON body labelled text/plain is accepted, because content-type is never read', async () => {
  const store = createInMemoryEvidenceStore();
  const request = post(JSON.stringify(validEvidence), { 'content-type': 'text/plain' });
  const { status, body } = await call(seam(store), request);
  assert.equal(status, 202);
  assert.equal(body.decision.disposition, 'accepted');
  assert.equal(store.list().length, 1, 'there is no 415; the label is not inspected at all');
});

test('divergence: the 202 is synchronous, so it promises nothing about later work', async () => {
  const store = createInMemoryEvidenceStore();
  const { status } = await call(seam(store), post(JSON.stringify(validEvidence)));
  assert.equal(status, 202);
  assert.equal(
    store.list().length,
    1,
    'the record is already stored when the response is written; nothing is queued',
  );
});

test('divergence 6: a conflicting replay is answered 202 and the first record stands', async () => {
  const store = createInMemoryEvidenceStore();
  const handler = seam(store);
  assert.equal((await call(handler, post(JSON.stringify(validEvidence)))).status, 202);
  const changed = { ...validEvidence, result: { pass: false } };
  const { status, body } = await call(handler, post(JSON.stringify(changed)));
  assert.equal(status, 202, 'until 2.2 assigns a conflict its own status (ADR-0002)');
  assert.equal(body.decision.disposition, 'accepted');
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].evidence.result.pass, true, 'the first record stands');
  assert.match(document.info.description, /6\. A conflicting replay is answered 202\./);
});

// Phase 4 cycle 3 found the drift protection above to be one-directional. Every request-schema
// assertion was of the form "this fixture conforms" or "this fixture does not", so a constraint
// the document DROPPED was a constraint nothing missed: reducing EvidenceRecord.required to
// ["schema_version"], deleting a minLength, removing policy_id from AcceptedDecision and widening
// the health enum all left the suite green, while the weakened document declared records valid
// that the seam answers 422 to. The tests below close that direction by deriving the cases from
// the document itself, so a relaxed constraint has nothing left to hide behind.

// recordSchema is a $ref; validateAgainstSchema resolves it internally, but introspecting the
// document's own constraints needs the resolved node.
const evidenceSchema = document.components.schemas.EvidenceRecord;

test('every required evidence field the document names is one the seam also requires', async () => {
  const required = evidenceSchema.required;
  assert.ok(
    required.length >= 9,
    'EvidenceRecord.required has been relaxed below the enforced set',
  );
  for (const field of required) {
    const { [field]: _dropped, ...withoutField } = validEvidence;
    assert.equal(
      conforms(withoutField, recordSchema).ok,
      false,
      `document accepts a record missing "${field}"`,
    );
    const { status, body } = await call(seam(), post(JSON.stringify(withoutField)));
    assert.equal(status, 422, `seam accepted a record missing "${field}"`);
    assert.equal(body.decision.disposition, 'rejected');
  }
});

test('every minLength the document claims on an evidence field is one the seam also rejects', async () => {
  const constrained = Object.entries(evidenceSchema.properties).filter(
    ([name, schema]) => schema.minLength === 1 && evidenceSchema.required.includes(name),
  );
  assert.ok(constrained.length >= 3, 'the minLength constraints have been relaxed');
  for (const [field] of constrained) {
    const emptied = { ...validEvidence, [field]: '' };
    assert.equal(conforms(emptied, recordSchema).ok, false, `document accepts empty "${field}"`);
    const { status, body } = await call(seam(), post(JSON.stringify(emptied)));
    assert.equal(status, 422, `seam accepted empty "${field}"`);
    assert.equal(body.decision.disposition, 'rejected');
  }
});

test('every enum the document claims on an evidence field is one the seam also enforces', async () => {
  const enums = Object.entries(evidenceSchema.properties).filter(([, schema]) =>
    Array.isArray(schema.enum),
  );
  assert.deepEqual(
    sorted(enums.map(([name]) => name)),
    ['schema_version', 'tier'],
    'the documented evidence enums have changed',
  );
  for (const [field, schema] of enums) {
    const offEnum = { ...validEvidence, [field]: `${schema.enum[0]}-not-a-member` };
    assert.equal(conforms(offEnum, recordSchema).ok, false, `document accepts off-enum "${field}"`);
    const { status, body } = await call(seam(), post(JSON.stringify(offEnum)));
    assert.equal(status, 422, `seam accepted off-enum "${field}"`);
    assert.equal(body.decision.disposition, 'rejected');
  }
});

test('the accepted decision still names the policy that granted it', () => {
  // policy_id is what makes an acceptance traceable to an approved decision (FR-3.1, NFR-6.1),
  // and dropping it from required was one of the relaxations cycle 3 slipped past the suite.
  const accepted = document.components.schemas.AcceptedDecision;
  assert.ok(accepted.required.includes('policy_id'));
  assert.equal(accepted.additionalProperties, false);
  assert.equal(document.components.schemas.HealthResponse.properties.status.enum.length, 1);
});

// Phase 4 review of task 1.2 found a valid, policy-accepted record deeper than JSON.stringify's
// recursion limit answered 400 and silently dropped: JSON.parse is iterative in V8 while
// JSON.stringify is recursive, so the seam parsed a body the store could not project. The seam
// now projects before evaluating policy, so the control plane never computes an acceptance for a
// record it would then fail to store. Divergence 5 in info.description records what remains.
test('divergence: a record too deep to project is refused, and never reaches the store', async () => {
  const depth = 6000;
  const body =
    '{"schema_version":"evidence/0","change_id":"PR-deep","binding_used":"b","computed_at":"t",' +
    '"tier":"T1","affected_set":[],"tool":{"name":"n","version":"v"},' +
    '"verification":{"verified":["CAF-SDLC-002:tier"]},"result":{"pass":true},' +
    '"deep":' +
    '{"n":'.repeat(depth) +
    '"x"' +
    '}'.repeat(depth) +
    '}';
  assert.doesNotThrow(() => JSON.parse(body), 'the seam can parse this body');
  const store = createInMemoryEvidenceStore();
  const { status, body: answered } = await call(seam(store), post(body));
  assert.equal(status, 400);
  assert.deepEqual(answered, { error: 'request body must be valid JSON' });
  assert.equal(store.list().length, 0, 'nothing is stored');
});

// The 400 above was also the answer before the fix - what changed is the order, and the order is
// not observable on the wire. evaluateGuardrails reads policy.policy_version first, so a getter on
// it records whether policy was reached at all. If this fails, the seam is computing a disposition
// for a record it cannot store, which is how an acceptance gets granted and then lost.
test('a record well past the serialiser limit is refused before policy is evaluated', async () => {
  const depth = 6000;
  const body =
    '{"schema_version":"evidence/0","change_id":"PR-deep","binding_used":"b","computed_at":"t",' +
    '"tier":"T1","affected_set":[],"tool":{"name":"n","version":"v"},' +
    '"verification":{"verified":["CAF-SDLC-002:tier"]},"result":{"pass":true},' +
    '"deep":' +
    '{"n":'.repeat(depth) +
    '"x"' +
    '}'.repeat(depth) +
    '}';
  let policyRead = false;
  const watched = { ...policy };
  Object.defineProperty(watched, 'policy_version', {
    get() {
      policyRead = true;
      return 'guardrails/0';
    },
  });
  const store = createInMemoryEvidenceStore();
  const handler = seam(store, { policy: watched });
  const { status } = await call(handler, post(body));
  assert.equal(status, 400);
  assert.equal(policyRead, false, 'the policy was evaluated for a record that cannot be stored');
  // Not a universal, and the difference matters. The seam projects and then append projects
  // again one stack frame deeper, so there is a narrow band - about seven levels wide on this
  // runtime - where the first projection fits and the second does not, and policy IS evaluated
  // for a record that is then refused. The wire outcome is identical at every depth (400,
  // nothing stored) and evaluateGuardrails is pure, so no acceptance escapes; what fails inside
  // the band is the ordering claim, not the behaviour. This fixture sits well clear of it.

  // The same watcher must see a storable record reach policy, or the test proves nothing.
  policyRead = false;
  await call(handler, post(JSON.stringify(validEvidence)));
  assert.equal(policyRead, true, 'control: a normal record does reach policy');
});
