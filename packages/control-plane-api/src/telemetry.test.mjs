import assert from 'node:assert/strict';
import { constants, generateKeyPairSync, sign as rsaSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createAuthenticator } from '../../workload-identity/src/authenticate.mjs';
import { ISSUER } from '../../workload-identity/src/constants.mjs';
import { createKeySet } from '../../workload-identity/src/key-set.mjs';
import { createRegistry } from '../../workspace-registry/src/registry.mjs';
import { createInMemoryEvidenceStore } from '../../evidence-store/src/evidence-store.mjs';
import { createSubmissionQuota } from './admission.mjs';
import { announceStartup, createRequestHandler } from './main.mjs';
import { createReadiness } from './readiness.mjs';
import { REFUSAL_REASONS } from './refusal-log.mjs';
import {
  OUTCOMES,
  SLOW_RESPONSE_MS,
  TELEMETRY_INTERVAL_MS,
  acceptedEvent,
  createTelemetry,
  readinessEvent,
  servedEvent,
  snapshotEvent,
  startupEvent,
} from './telemetry.mjs';

// MIT-18 (task 2.3). The roadmap's named trap is a telemetry layer that misses a path and so reads
// as coverage. AC-1 is therefore proved twice: from main.mjs's source - every send() call site and
// the outcome it names - and by driving every (status, outcome) pair that source can produce and
// counting exactly one record and exactly one line (none for a probe). AC-5 puts a canary carrying
// bidi and format characters in every field a caller writes and finds it in no line. Fixtures are
// inline literals (stack.md, Test fixtures).

const MAIN = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
const AUTHENTICATE = readFileSync(
  new URL('../../workload-identity/src/authenticate.mjs', import.meta.url),
  'utf8',
);
const REGISTRY_SOURCE = readFileSync(
  new URL('../../workspace-registry/src/registry.mjs', import.meta.url),
  'utf8',
);

const NOW_MS = Date.UTC(2026, 10, 15, 12, 0, 0);
const NOW_S = NOW_MS / 1000;
const AT = '2026-11-15T12:00:00.000Z';
const AUDIENCE = 'urn:codeaiforge:sdlc-control-plane:production';
const PIN_REF = 'owner/gates/.github/workflows/mint.yml@refs/heads/main';

const policy = {
  policy_version: 'guardrails/0',
  policy_id: 'test-policy@1',
  effective_from: '2026-01-01T00:00:00Z',
  approval: {
    decision_id: 'TEST-DECISION-1',
    approved_by: 'test-approver',
    approved_at: '2026-01-01T00:00:00Z',
  },
  rules: {
    minimum_evidence_schema: 'evidence/0',
    blocked_tiers: [],
    require_ai_provenance_when_assisted: true,
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
  ai_assisted: false,
};

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

// A verified principal, as the authenticator builds one.
const principal = (overrides = {}) =>
  Object.freeze({
    issuer: ISSUER,
    repository_owner_id: '65',
    repository_id: '74',
    actor_id: '3251178',
    run_id: '39384901065',
    run_attempt: '1',
    sha: 'a'.repeat(40),
    ref: 'refs/heads/main',
    event_name: 'push',
    workflow_ref: 'owner/payments/.github/workflows/gate.yml@refs/heads/main',
    job_workflow_ref: null,
    job_workflow_sha: null,
    ...overrides,
  });
const verified = (overrides) => async () => ({ ok: true, principal: principal(overrides) });
const refusedWith =
  (reason, status = 401) =>
  async () => ({ ok: false, status, reason });

// One seam with its own telemetry. Lines are serialised exactly as stderrLog serialises them.
function seamWith({
  authenticate = verified(),
  store,
  quota,
  readiness,
  telemetry,
  log,
  monotonic,
} = {}) {
  const lines = [];
  const recorder =
    telemetry ??
    createTelemetry({
      log: log ?? ((event) => lines.push(JSON.stringify(event))),
      now: () => NOW_MS,
      ...(monotonic ? { monotonic } : {}),
    });
  const handler = createRequestHandler({
    registry: createRegistry(REGISTRY_DOC),
    policy,
    evidenceStore: store ?? createInMemoryEvidenceStore(),
    authenticate,
    quota: quota ?? createSubmissionQuota({ now: () => NOW_MS }),
    readiness,
    telemetry: recorder,
    now: () => NOW_MS,
  });
  return { handler, lines, telemetry: recorder };
}

function request({ method = 'GET', url, body, fails = false, headers = {}, rawHeaders = [] }) {
  return {
    method,
    url,
    headers,
    rawHeaders,
    destroy: () => {},
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield body;
      if (fails) throw Object.assign(new Error('aborted'), { code: 'ECONNRESET' });
    },
  };
}
const post = (body, extra = {}) =>
  request({
    method: 'POST',
    url: '/v1/evidence',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...extra,
  });

async function call(handler, req) {
  let status;
  let body;
  await handler(req, {
    writeHead: (value) => {
      status = value;
    },
    end: (value, done) => {
      body = value;
      done?.();
    },
  });
  return { status, body };
}

const failing = async () => {
  throw new Error('CANARY driver ECONNREFUSED');
};
const faultingStore = () => ({ append: failing, list: failing, listRecords: failing });
const holding = (record) => {
  const store = createInMemoryEvidenceStore();
  store.append(record, { workspace_id: 'payments-art' });
  return store;
};
const readinessOf = (answer) => ({ probe: async () => answer });

// ------------------------------------------------------------- AC-1, half 1: from the source

// Each send() call site's argument list, read with its parentheses balanced and its string
// literals skipped, so a comma or a parenthesis inside a string cannot end it early.
function sendCallSites(source) {
  const sites = [];
  const start = /(?<!function )\bsend\(\s*response,\s*/g;
  for (const match of source.matchAll(start)) {
    let index = match.index + match[0].indexOf('(');
    let depth = 0;
    let quote = null;
    const from = index;
    for (; index < source.length; index += 1) {
      const char = source[index];
      if (quote) {
        if (char === '\\') index += 1;
        else if (char === quote) quote = null;
        continue;
      }
      if (char === "'" || char === '"' || char === '`') quote = char;
      else if (char === '(') depth += 1;
      else if (char === ')' && --depth === 0) break;
    }
    sites.push(source.slice(from, index + 1));
  }
  return sites;
}

// The verifier's refusals, read from its own source: every one is a refuse('<reason>'[, 503]).
const verifierReasons = (status) => [
  ...new Set(
    [...AUTHENTICATE.matchAll(/\brefuse\('([a-z-]+)'(?:,\s*(\d{3}))?\)/g)]
      .filter((match) => Number(match[2] ?? 401) === status)
      .map((match) => match[1]),
  ),
];

// The domain of each named expression a call site may pass as its outcome. 401/503 come from the
// verifier's source; 403 from the predicate's own literals in main.mjs and admits() in the
// registry; 422 and 202 are the two non-accepted dispositions and the two non-conflict outcomes.
const EXPRESSIONS = {
  'result.reason': (status) => verifierReasons(status),
  'decision.reason': () => [
    ...[...MAIN.matchAll(/return \{ ok: false, reason: '([a-z-]+)'/g)].map((m) => m[1]),
    ...[
      ...REGISTRY_SOURCE.slice(REGISTRY_SOURCE.indexOf('export function admits')).matchAll(
        /return '([a-z-]+)';/g,
      ),
    ].map((m) => m[1]),
  ],
  'decision.disposition': () => ['rejected', 'needs-remediation'],
  'appended.outcome': () => ['appended', 'duplicate'],
};

function derivedPairs() {
  const pairs = new Set();
  const problems = [];
  for (const site of sendCallSites(MAIN)) {
    const status = Number(/^\(\s*response,\s*(\d{3})/.exec(site)?.[1]);
    const outcomes = [...site.matchAll(/\boutcome:\s*('([a-z-]+)'|[A-Za-z_.]+)/g)];
    if (!Number.isInteger(status) || outcomes.length !== 1) {
      problems.push(`a send() call site names ${outcomes.length} outcomes: ${site}`);
      continue;
    }
    const [, expression, literal] = outcomes[0];
    const domain = literal ? [literal] : EXPRESSIONS[expression]?.(status);
    if (!domain || domain.length === 0) {
      problems.push(`outcome expression ${expression} has no pinned domain: ${site}`);
      continue;
    }
    for (const outcome of domain) pairs.add(`${status} ${outcome}`);
  }
  return { pairs, problems };
}

test('AC-1 from source: every send() call site names exactly one outcome, from a literal or a pinned expression', () => {
  const sites = sendCallSites(MAIN);
  // The parser read every call site the plain sweep sees (openapi.contract.test.mjs's regex).
  assert.equal(sites.length, [...MAIN.matchAll(/(?<!function )send\(\s*response,/g)].length);
  assert.ok(sites.length >= 19, `only ${sites.length} send() call sites were read`);
  const { pairs, problems } = derivedPairs();
  assert.deepEqual(problems, []);
  // The verifier's reasons as read from its source are exactly the 401 and 503 vocabulary.
  assert.equal(verifierReasons(401).length, 15);
  assert.deepEqual(
    new Set(verifierReasons(503)),
    new Set(['key-set-unavailable', 'verifier-fault']),
  );
  // And nothing in the verifier refuses other than through refuse().
  assert.equal([...AUTHENTICATE.matchAll(/\bok: false\b/g)].length, 1);
  // No dead vocabulary: the outcomes the source can produce are exactly OUTCOMES.
  const outcomes = new Set([...pairs].map((pair) => pair.slice(4)));
  assert.deepEqual([...outcomes].sort(), [...OUTCOMES].sort());
});

test('AC-1 from source: nothing in main.mjs writes a line except through send(), but the refused-start line', () => {
  const code = MAIN.split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
  assert.deepEqual(
    [...code.matchAll(/(?<!console\.)\blog\(/g)].length,
    0,
    'main.mjs calls log( directly',
  );
  assert.deepEqual(
    [...code.matchAll(/\bconsole\.\w+\(/g)].map((m) => m[0]),
    ['console.log('],
    'the one console call is the stdout listening line',
  );
  assert.deepEqual(
    [...code.matchAll(/\bstderr\.write\(([^)]*)\)/g)].map((m) => m[1]),
    ['`${line}\\n`'],
  );
  assert.doesNotMatch(code, /\blogRefusal\b|\brefusalEvent\b/);
  assert.equal([...code.matchAll(/\.record\(/g)].length, 1, 'record() is called from send() only');
});

// ------------------------------------------------------------- AC-1, half 2: driven

const WORKLOAD_ROUTES = [
  ['GET /v1/workspaces', () => request({ url: '/v1/workspaces' })],
  ['GET /v1/indicators', () => request({ url: '/v1/indicators' })],
  ['POST /v1/evidence', () => post(validEvidence)],
];
const onEveryRoute = (options) => WORKLOAD_ROUTES.map(([route, req]) => ({ route, options, req }));

const FORBIDDEN = {
  'no-binding': { repository_id: '99' },
  'not-active': { repository_id: '75' },
  'event-not-admitted': { event_name: 'workflow_dispatch' },
  'pin-ref': { repository_id: '76' },
  'pin-sha': { repository_id: '77', job_workflow_ref: PIN_REF },
  'refused-actor': { actor_id: '49699333' },
};

// "<status> <outcome>" -> every case that produces it. A case is a seam's options, the request,
// and the route the record must name.
const DRIVERS = {
  '404 unmatched-route': () => [
    { route: 'unmatched', req: () => request({ url: '/v1/nope' }) },
    { route: 'unmatched', req: () => request({ url: '/health?x=1' }) },
  ],
  '200 live': () => [{ route: 'GET /health', req: () => request({ url: '/health' }) }],
  '200 ready': () => [
    {
      route: 'GET /ready',
      options: { readiness: readinessOf({ ready: true, reason: 'ready' }) },
      req: () => request({ url: '/ready' }),
    },
  ],
  '503 not-ready': () => [
    {
      route: 'GET /ready',
      options: { readiness: readinessOf({ ready: false, reason: 'database-unreachable' }) },
      req: () => request({ url: '/ready' }),
    },
  ],
  ...Object.fromEntries(
    verifierReasons(401).map((reason) => [
      `401 ${reason}`,
      () => onEveryRoute({ authenticate: refusedWith(reason) }),
    ]),
  ),
  ...Object.fromEntries(
    ['key-set-unavailable', 'verifier-fault'].map((reason) => [
      `503 ${reason}`,
      () => onEveryRoute({ authenticate: refusedWith(reason, 503) }),
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(FORBIDDEN).map(([reason, overrides]) => [
      `403 ${reason}`,
      () => onEveryRoute({ authenticate: verified(overrides) }),
    ]),
  ),
  '200 served': () => [
    { route: 'GET /v1/workspaces', req: () => request({ url: '/v1/workspaces' }) },
    { route: 'GET /v1/indicators', req: () => request({ url: '/v1/indicators' }) },
  ],
  '503 store-unavailable': () => [
    {
      route: 'GET /v1/indicators',
      options: { store: faultingStore() },
      req: () => request({ url: '/v1/indicators' }),
    },
    {
      route: 'POST /v1/evidence',
      options: { store: faultingStore() },
      req: () => post(validEvidence),
    },
  ],
  '429 quota-exceeded': () => [
    {
      route: 'POST /v1/evidence',
      options: { quota: { take: () => ({ ok: false, retryAfterS: 9 }) } },
      req: () => post(validEvidence),
    },
  ],
  '413 body-too-large': () => [
    { route: 'POST /v1/evidence', req: () => post(`"${'x'.repeat(1048577)}"`) },
  ],
  '400 body-read-failed': () => [
    { route: 'POST /v1/evidence', req: () => post('{"partial":', { fails: true }) },
  ],
  '400 body-not-json': () => [{ route: 'POST /v1/evidence', req: () => post('{ not json') }],
  '422 rejected': () => [
    { route: 'POST /v1/evidence', req: () => post({ ...validEvidence, tier: 'T9' }) },
  ],
  '422 needs-remediation': () => [
    {
      route: 'POST /v1/evidence',
      req: () => post({ ...validEvidence, verification: { verified: [] } }),
    },
  ],
  '409 conflict': () => [
    {
      route: 'POST /v1/evidence',
      options: { store: holding({ ...validEvidence, result: { pass: false } }) },
      req: () => post(validEvidence),
    },
  ],
  '202 appended': () => [{ route: 'POST /v1/evidence', req: () => post(validEvidence) }],
  '202 duplicate': () => [
    {
      route: 'POST /v1/evidence',
      options: { store: holding(validEvidence) },
      req: () => post(validEvidence),
    },
  ],
  '503 handler-fault': () => [
    {
      route: 'POST /v1/evidence',
      options: {
        quota: {
          take: () => {
            throw new Error('CANARY quota down');
          },
        },
      },
      req: () => post(validEvidence),
    },
    {
      route: 'GET /ready',
      options: {
        readiness: {
          probe: async () => {
            throw new Error('CANARY probe down');
          },
        },
      },
      req: () => request({ url: '/ready' }),
    },
  ],
};

const EVENT_FOR = (outcome) =>
  ['live', 'ready', 'not-ready'].includes(outcome)
    ? null
    : ['appended', 'duplicate'].includes(outcome)
      ? 'accepted'
      : outcome === 'served'
        ? 'served'
        : 'refusal';

test('AC-1 driven: the drivers cover exactly the (status, outcome) pairs the source can produce', () => {
  assert.deepEqual(Object.keys(DRIVERS).sort(), [...derivedPairs().pairs].sort());
});

for (const [pair, cases] of Object.entries(DRIVERS)) {
  const [status, outcome] = [Number(pair.slice(0, 3)), pair.slice(4)];
  test(`AC-1 driven: ${pair} is counted once and lined ${EVENT_FOR(outcome) ? 'once' : 'never'}`, async () => {
    for (const { route, options = {}, req } of cases()) {
      const { handler, lines, telemetry } = seamWith(options);
      const answered = await call(handler, req());
      assert.equal(answered.status, status, `${route}: wire status`);
      // Read before the snapshot below, which writes a telemetry line of its own.
      const events = lines.map((line) => JSON.parse(line)).filter((e) => e.event !== 'readiness');
      assert.deepEqual(
        telemetry.snapshot().counts,
        [{ route, status, outcome, n: 1 }],
        `${route}: exactly one count`,
      );
      const expected = EVENT_FOR(outcome);
      if (expected === null) {
        assert.deepEqual(events, [], `${route}: a probe writes no line`);
        continue;
      }
      assert.equal(events.length, 1, `${route}: exactly one line`);
      const [event] = events;
      assert.equal(event.event, expected);
      assert.equal(event.route, route);
      assert.equal(event.status, status);
      if (expected === 'refusal') assert.equal(event.reason, outcome);
      if (expected === 'accepted') assert.equal(event.outcome, outcome);
    }
  });
}

test('AC-1 driven: a sink that throws, or a record that throws, changes no response', async () => {
  for (const [pair, cases] of Object.entries(DRIVERS)) {
    for (const { options = {}, req } of cases()) {
      const plain = await call(seamWith(options).handler, req());
      const throwingLog = await call(
        seamWith({
          ...options,
          log: () => {
            throw new Error('disk full');
          },
        }).handler,
        req(),
      );
      const base = createTelemetry({ log: () => {}, now: () => NOW_MS });
      const throwingRecord = await call(
        seamWith({
          ...options,
          telemetry: {
            ...base,
            record: () => {
              throw new Error('telemetry defect');
            },
          },
        }).handler,
        req(),
      );
      // The three seams share a case's store, and a held record answers each of them alike.
      assert.deepEqual(throwingLog, plain, `${pair}: a throwing log changed the response`);
      assert.deepEqual(throwingRecord, plain, `${pair}: a throwing record changed the response`);
    }
  }
});

// The interval timer and the signal handler call snapshot() with nobody to catch a throw: a sink
// that throws there would end the process. Every entry point swallows it.
test('a sink that throws never escapes any entry point: record, snapshot, readiness, startup', () => {
  const telemetry = createTelemetry({
    log: () => {
      throw new Error('EPIPE');
    },
  });
  assert.doesNotThrow(() =>
    telemetry.record({ route: null, status: 404, outcome: 'unmatched-route', durationMs: 0 }),
  );
  assert.doesNotThrow(() => telemetry.snapshot('interval'));
  assert.doesNotThrow(() => telemetry.snapshot('shutdown'));
  assert.doesNotThrow(() => telemetry.readinessChanged({ ready: false, reason: 'role-refused' }));
  assert.doesNotThrow(() =>
    telemetry.startup({ policyId: 'p@1', decisionId: 'D-1', schemaVersion: 2, workspaces: 1 }),
  );
  assert.equal(telemetry.snapshot().counts[0].n, 1, 'the count moved although the line was lost');
});

test('an outcome outside OUTCOMES is refused before anything moves', () => {
  const telemetry = createTelemetry({ log: () => {} });
  assert.throws(
    () => telemetry.record({ route: null, status: 404, outcome: 'free text', durationMs: 0 }),
    TypeError,
  );
  assert.throws(
    () =>
      telemetry.record({ route: null, status: '404', outcome: 'unmatched-route', durationMs: 0 }),
    TypeError,
  );
  assert.deepEqual(telemetry.snapshot().counts, []);
  assert.equal(Object.isFrozen(OUTCOMES), true);
  assert.deepEqual(OUTCOMES.slice(0, REFUSAL_REASONS.length), [...REFUSAL_REASONS]);
  assert.deepEqual(OUTCOMES.slice(REFUSAL_REASONS.length), [
    'appended',
    'duplicate',
    'served',
    'live',
    'ready',
    'not-ready',
  ]);
});

// A response whose write throws already has its event; the catch-all's second attempt is a late
// fault, never a second event.
test('a fault after the first write attempt is one event and one late fault, never two events', async () => {
  const { handler, lines, telemetry } = seamWith();
  const events = [];
  await handler(request({ url: '/v1/workspaces' }), {
    headersSent: false,
    writeHead: () => {
      events.push('writeHead');
      throw new Error('socket gone');
    },
    end: () => events.push('end'),
  });
  assert.equal(lines.length, 1, 'one line for one response');
  const snapshot = telemetry.snapshot();
  assert.deepEqual(snapshot.counts, [
    { route: 'GET /v1/workspaces', status: 200, outcome: 'served', n: 1 },
  ]);
  assert.equal(snapshot.late_faults, 1);
  // The second attempt is the catch-all's 503, which the dead socket refuses too.
  assert.deepEqual(events, ['writeHead', 'writeHead']);
});

// ------------------------------------------------------------- C3: closed shapes

test('every event has exactly its closed key set', () => {
  const route = { method: 'POST', path: '/v1/evidence' };
  const who = { principal: principal(), workspaceId: 'payments-art' };
  assert.deepEqual(
    Object.keys(
      acceptedEvent({ at: AT, route, status: 202, outcome: 'duplicate', durationMs: 3, ...who }),
    ),
    ['event', 'at', 'route', 'status', 'outcome', 'duration_ms', 'principal'],
  );
  assert.deepEqual(
    Object.keys(servedEvent({ at: AT, route, status: 200, durationMs: 3, ...who })),
    ['event', 'at', 'route', 'status', 'duration_ms', 'principal'],
  );
  assert.deepEqual(Object.keys(readinessEvent({ at: AT, ready: false, reason: 'role-refused' })), [
    'event',
    'at',
    'ready',
    'reason',
  ]);
  assert.deepEqual(
    Object.keys(
      startupEvent({ at: AT, policyId: 'p@1', decisionId: 'D-1', schemaVersion: 2, workspaces: 1 }),
    ),
    ['event', 'at', 'policy_id', 'decision_id', 'schema_version', 'workspaces'],
  );
  assert.deepEqual(Object.keys(createTelemetry({ log: () => {} }).snapshot()), [
    'event',
    'at',
    'kind',
    'started_at',
    'uptime_s',
    'counts',
    'slow_threshold_ms',
    'slow',
    'late_faults',
    'connections_without_request',
    'ready',
  ]);
  assert.deepEqual(
    Object.keys(
      acceptedEvent({ at: AT, route, status: 202, outcome: 'appended', durationMs: 0, ...who })
        .principal,
    ),
    ['repository_owner_id', 'repository_id', 'run_id', 'run_attempt', 'workspace_id'],
  );
  assert.throws(
    () => acceptedEvent({ at: AT, route, status: 202, outcome: 'conflict', durationMs: 0, ...who }),
    TypeError,
  );
  assert.throws(() => snapshotEvent({ kind: 'CANARY' }), TypeError);
  assert.throws(
    () => startupEvent({ at: AT, policyId: 1, decisionId: 'D', schemaVersion: 2, workspaces: 1 }),
    TypeError,
  );
});

// ------------------------------------------------------------- AC-2: counts with reasons

test('AC-2: a burst of 25 refusals of one reason is one count of 25; appended, duplicate and conflict stay separate', async () => {
  const { handler, telemetry } = seamWith({ authenticate: refusedWith('token-expired') });
  for (let index = 0; index < 25; index += 1)
    await call(handler, request({ url: '/v1/indicators' }));
  assert.deepEqual(telemetry.snapshot().counts, [
    { route: 'GET /v1/indicators', status: 401, outcome: 'token-expired', n: 25 },
  ]);

  const store = createInMemoryEvidenceStore();
  const posting = seamWith({ store });
  for (const record of [
    validEvidence,
    validEvidence,
    validEvidence,
    { ...validEvidence, result: { pass: false } },
    { ...validEvidence, change_id: 'PR-2' },
  ])
    await call(posting.handler, post(record));
  assert.deepEqual(posting.telemetry.snapshot().counts, [
    { route: 'POST /v1/evidence', status: 202, outcome: 'appended', n: 2 },
    { route: 'POST /v1/evidence', status: 202, outcome: 'duplicate', n: 2 },
    { route: 'POST /v1/evidence', status: 409, outcome: 'conflict', n: 1 },
  ]);
});

test('AC-2: the snapshot is cumulative, sorted by route, status and outcome, non-zero only, and says since when', async () => {
  const clock = { ms: 5000 };
  const telemetry = createTelemetry({
    log: () => {},
    now: () => NOW_MS,
    monotonic: () => clock.ms,
  });
  const record = (route, status, outcome) =>
    telemetry.record({ route, status, outcome, durationMs: 0 });
  const evidenceRoute = { method: 'POST', path: '/v1/evidence' };
  const health = { method: 'GET', path: '/health' };
  record(evidenceRoute, 409, 'conflict');
  record(health, 200, 'live');
  record(evidenceRoute, 202, 'duplicate');
  record(null, 404, 'unmatched-route');
  record(evidenceRoute, 202, 'appended');
  record(health, 200, 'live');
  telemetry.recordLateFault();
  clock.ms += 3_599_999;
  const snapshot = telemetry.snapshot();
  assert.deepEqual(snapshot.counts, [
    { route: 'GET /health', status: 200, outcome: 'live', n: 2 },
    { route: 'POST /v1/evidence', status: 202, outcome: 'appended', n: 1 },
    { route: 'POST /v1/evidence', status: 202, outcome: 'duplicate', n: 1 },
    { route: 'POST /v1/evidence', status: 409, outcome: 'conflict', n: 1 },
    { route: 'unmatched', status: 404, outcome: 'unmatched-route', n: 1 },
  ]);
  assert.equal(snapshot.started_at, AT);
  assert.equal(snapshot.uptime_s, 3599);
  assert.equal(snapshot.late_faults, 1);
  assert.equal(snapshot.connections_without_request, 0);
  assert.equal(snapshot.ready, null, 'never probed');
  assert.equal(snapshot.kind, 'interval');
  assert.equal(telemetry.snapshot('shutdown').kind, 'shutdown');
  assert.throws(() => telemetry.snapshot('other'), TypeError);
  telemetry.readinessChanged({ ready: false, reason: 'role-refused' });
  assert.equal(telemetry.snapshot().ready, false);
});

test('the interval snapshot runs every 60000 ms on a timer that holds no process open, and stop() clears it', (t) => {
  assert.equal(TELEMETRY_INTERVAL_MS, 60000);
  const lines = [];
  const timers = [];
  const realSetInterval = globalThis.setInterval;
  t.mock.method(globalThis, 'setInterval', (fn, ms) => {
    const timer = realSetInterval(fn, ms);
    timers.push({ timer, ms, fn });
    return timer;
  });
  const cleared = [];
  const realClearInterval = globalThis.clearInterval;
  t.mock.method(globalThis, 'clearInterval', (timer) => {
    cleared.push(timer);
    realClearInterval(timer);
  });
  const telemetry = createTelemetry({ log: (event) => lines.push(event) });
  telemetry.startInterval();
  telemetry.startInterval();
  assert.equal(timers.length, 1, 'one timer however often it is started');
  assert.equal(timers[0].ms, TELEMETRY_INTERVAL_MS);
  assert.equal(timers[0].timer.hasRef(), false, 'the timer keeps no process alive');
  timers[0].fn();
  assert.deepEqual(
    lines.map(({ event, kind }) => [event, kind]),
    [['telemetry', 'interval']],
  );
  telemetry.stop();
  assert.deepEqual(cleared, [timers[0].timer]);
});

// ------------------------------------------------------------- AC-7: slow requests

test('AC-7: a response taking 1000 ms is counted slow, 999 ms is not, and every line carries whole milliseconds', async () => {
  for (const [took, slow] of [
    [999, []],
    [SLOW_RESPONSE_MS, [{ route: 'POST /v1/evidence', n: 1 }]],
  ]) {
    const clock = { ms: 0 };
    const store = createInMemoryEvidenceStore();
    const slowStore = {
      ...store,
      append: async (...args) => {
        clock.ms += took;
        return store.append(...args);
      },
    };
    const { handler, lines, telemetry } = seamWith({
      store: slowStore,
      monotonic: () => clock.ms + 0.4,
    });
    await call(handler, post(validEvidence));
    const snapshot = telemetry.snapshot();
    assert.deepEqual(snapshot.slow, slow, `${took} ms`);
    assert.equal(snapshot.slow_threshold_ms, 1000);
    assert.equal(JSON.parse(lines[0]).duration_ms, took);
  }
  const { handler, lines } = seamWith({
    monotonic: (() => {
      // A clock that steps backwards cannot produce a negative duration.
      let ms = 100;
      return () => (ms -= 7);
    })(),
  });
  await call(handler, request({ url: '/v1/nope' }));
  assert.equal(JSON.parse(lines[0]).duration_ms, 0);
});

// ------------------------------------------------------------- AC-5: the canary

// 2.4 I-4: a caller-written field can carry Trojan-source characters. Bidi overrides, isolates
// and a zero-width space; JSON.stringify escapes C0 but leaves these raw, so a leak would show.
const CANARY = 'zq7canary\u202E\u2066\u200B';
const DANGEROUS = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/;

const signing = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWKS = {
  keys: [{ ...signing.publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' }],
};
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
function token(overrides = {}) {
  const input = `${b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' })}.${b64({
    iss: ISSUER,
    aud: AUDIENCE,
    iat: NOW_S,
    nbf: NOW_S - 300,
    exp: NOW_S + 300,
    sub: `repo:owner/payments:ref:refs/heads/${CANARY}`,
    repository: 'owner/payments',
    repository_owner_id: '65',
    repository_id: '74',
    actor: CANARY,
    actor_id: '3251178',
    run_id: '39384901065',
    run_attempt: '1',
    sha: 'a'.repeat(40),
    ref: `refs/heads/${CANARY}`,
    event_name: 'push',
    workflow_ref: `owner/payments/.github/workflows/${CANARY}.yml@refs/heads/main`,
    ...overrides,
  })}`;
  const signature = rsaSign('sha256', Buffer.from(input), {
    key: signing.privateKey,
    padding: constants.RSA_PKCS1_PADDING,
  });
  return `${input}.${signature.toString('base64url')}`;
}

test('AC-5: a canary in every field a caller writes appears in no line, and the principal is four ids and a workspace', async () => {
  const lines = [];
  const telemetry = createTelemetry({
    log: (event) => lines.push(JSON.stringify(event)),
    now: () => NOW_MS,
  });
  const readiness = createReadiness({
    check: async () => ({ ready: false, reason: 'database-unreachable', detail: CANARY }),
    onChange: (answer) => telemetry.readinessChanged(answer),
  });
  const handler = createRequestHandler({
    registry: createRegistry(REGISTRY_DOC),
    policy,
    evidenceStore: createInMemoryEvidenceStore(),
    authenticate: createAuthenticator({
      keySet: createKeySet({
        now: () => NOW_MS,
        fetchKeySet: async () => ({
          body: Buffer.from(JSON.stringify(JWKS)),
          cacheControl: 'max-age=3600',
        }),
      }),
      now: () => NOW_MS,
    }),
    quota: createSubmissionQuota({ now: () => NOW_MS }),
    readiness,
    telemetry,
    now: () => NOW_MS,
  });
  const noisy = { 'user-agent': CANARY, 'x-forwarded-for': CANARY, cookie: `session=${CANARY}` };
  const send = (method, url, { body, authorization = `Bearer ${token()}` } = {}) =>
    call(
      handler,
      request({
        method,
        url,
        body,
        headers: noisy,
        rawHeaders: [
          'User-Agent',
          CANARY,
          'X-Forwarded-For',
          CANARY,
          'Cookie',
          `session=${CANARY}`,
          ...(authorization === null ? [] : ['Authorization', authorization]),
        ],
      }),
    );
  const record = (overrides = {}) =>
    JSON.stringify({
      ...validEvidence,
      change_id: `PR-${CANARY}`,
      computed_at: CANARY,
      affected_set: [`packages/${CANARY}`],
      ai_assisted: true,
      ai_tool: CANARY,
      ...overrides,
    });
  const statuses = [
    (await send('POST', '/v1/evidence', { body: record() })).status,
    (await send('POST', '/v1/evidence', { body: record() })).status,
    (await send('POST', '/v1/evidence', { body: record({ result: { pass: false } }) })).status,
    (
      await send('POST', '/v1/evidence', {
        body: record({ change_id: `PR2-${CANARY}`, verification: { verified: [CANARY] } }),
      })
    ).status,
    (await send('POST', '/v1/evidence', { body: `{"change_id":"${CANARY}` })).status,
    (await send('POST', '/v1/evidence', { body: `"${CANARY}${'x'.repeat(1048576)}"` })).status,
    (await send('GET', `/v1/${CANARY}?access_token=${CANARY}`)).status,
    (await send('GET', '/v1/workspaces', { authorization: `Bearer ${CANARY}` })).status,
    (
      await send('GET', '/v1/indicators', {
        authorization: `Bearer ${token({ event_name: 'workflow_dispatch' })}`,
      })
    ).status,
    (await send('GET', '/v1/indicators')).status,
    (await send('GET', '/ready', { authorization: null })).status,
    (await send('GET', '/health', { authorization: null })).status,
  ];
  assert.deepEqual(statuses, [202, 202, 409, 422, 400, 413, 404, 401, 403, 200, 503, 200]);
  telemetry.snapshot('interval');
  telemetry.snapshot('shutdown');
  announceStartup({
    telemetry,
    policy,
    registry: createRegistry(REGISTRY_DOC),
    schemaVersion: 2,
  });
  const events = lines.map((line) => JSON.parse(line));
  assert.deepEqual(
    events.map((event) => event.event),
    [
      'accepted',
      'accepted',
      'refusal',
      'refusal',
      'refusal',
      'refusal',
      'refusal',
      'refusal',
      'refusal',
      'served',
      'readiness',
      'telemetry',
      'telemetry',
      'startup',
    ],
  );
  for (const line of lines) {
    assert.equal(line.includes('zq7canary'), false, line.slice(0, 120));
    assert.doesNotMatch(line, DANGEROUS, line.slice(0, 120));
    assert.doesNotMatch(line, /access_token|Bearer|session=/);
  }
  for (const event of events.filter((e) => e.principal)) {
    assert.deepEqual(Object.keys(event.principal), [
      'repository_owner_id',
      'repository_id',
      'run_id',
      'run_attempt',
      'workspace_id',
    ]);
    for (const key of ['repository_owner_id', 'repository_id', 'run_id', 'run_attempt'])
      assert.match(event.principal[key], /^(0|[1-9]\d*)$/, key);
    assert.equal(event.principal.workspace_id, 'payments-art');
  }
});
