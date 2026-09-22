import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createRequestHandler, routes } from './main.mjs';
import { validateAgainstSchema } from './openapi-schema.mjs';

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
// main.test.mjs already hardcodes the same literals, for the same reasons.
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

const get = (url) => ({ method: 'GET', url });

const post = (raw, headers = { 'content-type': 'application/json' }) => ({
  method: 'POST',
  url: '/v1/evidence',
  headers,
  async *[Symbol.asyncIterator]() {
    yield raw;
  },
});

// One entry per documented (route, status) pair. The table is the bridge: the document is
// compared against it, and the seam is driven through it, so neither side can claim a status the
// other does not produce. Names follow the roadmap's wording - accepted, invalid and
// incompatible evidence - so the acceptance phase can cite a test name as evidence.
const scenarios = [
  {
    name: 'GET /health -> 200 liveness',
    method: 'GET',
    path: '/health',
    status: 200,
    request: () => get('/health'),
    claim: (body) => assert.deepEqual(body, { status: 'ok' }),
  },
  {
    name: 'GET /v1/workspaces -> 200 registered workspace listing',
    method: 'GET',
    path: '/v1/workspaces',
    status: 200,
    request: () => get('/v1/workspaces'),
    claim: (body) => {
      assert.deepEqual(body.data[0].owners, ['platform']);
      assert.equal(body.data[0].value_stream, 'payments');
    },
  },
  {
    name: 'GET /v1/indicators -> 200 descriptive indicator summary',
    method: 'GET',
    path: '/v1/indicators',
    status: 200,
    request: () => get('/v1/indicators'),
    claim: (body) => assert.match(body.data.note, /not a portfolio decision/),
  },
  {
    name: 'POST /v1/evidence -> 202 accepted evidence',
    method: 'POST',
    path: '/v1/evidence',
    status: 202,
    request: () => post(JSON.stringify(validEvidence)),
    claim: (body) => {
      assert.equal(body.decision.disposition, 'accepted');
      assert.equal(body.decision.reasons.length, 0);
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
  {
    name: 'POST /v1/evidence -> 422 evidence the contract or the policy did not accept',
    method: 'POST',
    path: '/v1/evidence',
    status: 422,
    request: () => post(JSON.stringify({ ...validEvidence, verification: { verified: [] } })),
    claim: (body) => {
      assert.equal(body.decision.accepted, false);
      assert.deepEqual(body.decision.reasons, ['required control not verified: CAF-SDLC-002:tier']);
    },
  },
];

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
    const { status } = await call(seam(), scenario.request());
    assert.equal(status, scenario.status);
    assert.ok(
      document.paths[scenario.path][scenario.method.toLowerCase()].responses[String(status)],
      `the seam answered ${status}, which this path does not declare`,
    );
  });

  test(`${scenario.name} answers with a body the documented schema accepts`, async () => {
    const { body } = await call(seam(), scenario.request());
    const schema = responseSchema(scenario.path, scenario.method.toLowerCase(), scenario.status);
    const { ok, errors } = conforms(body, schema);
    assert.deepEqual(errors, []);
    assert.equal(ok, true);
    scenario.claim(body);
  });
}

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
  const evidence = [];
  const { status, body } = await call(seam(evidence), post(JSON.stringify(record)));
  assert.equal(status, 202);
  assert.equal(body.decision.disposition, 'accepted');
  assert.equal(evidence.length, 1);
});

// Four divergence freezes. Each one is behaviour info.description admits to; freezing it here
// means a later change to any of them has to change the document in the same commit.
test('divergence: a query string on a documented path is unmatched, not a match', async () => {
  const { status, body } = await call(seam(), get('/health?x=1'));
  assert.equal(status, unmatched.status);
  assert.deepEqual(body, { error: 'not found' });
  assert.deepEqual(conforms(body, unmatched.content['application/json'].schema).errors, []);
});

test('divergence: an undeclared method on a documented path is a 404, never a 405', async () => {
  for (const request of [get('/v1/evidence'), { method: 'POST', url: '/health' }]) {
    const { status, body } = await call(seam(), request);
    assert.equal(status, unmatched.status);
    assert.deepEqual(body, { error: 'not found' });
    assert.deepEqual(conforms(body, unmatched.content['application/json'].schema).errors, []);
  }
});

test('divergence: a JSON body labelled text/plain is accepted, because content-type is never read', async () => {
  const evidence = [];
  const request = post(JSON.stringify(validEvidence), { 'content-type': 'text/plain' });
  const { status, body } = await call(seam(evidence), request);
  assert.equal(status, 202);
  assert.equal(body.decision.disposition, 'accepted');
  assert.equal(evidence.length, 1, 'there is no 415; the label is not inspected at all');
});

test('divergence: the 202 is synchronous, so it promises nothing about later work', async () => {
  const evidence = [];
  const { status } = await call(seam(evidence), post(JSON.stringify(validEvidence)));
  assert.equal(status, 202);
  assert.equal(
    evidence.length,
    1,
    'the record is already stored when the response is written; nothing is queued',
  );
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
