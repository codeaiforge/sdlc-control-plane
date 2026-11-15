import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { constants, generateKeyPairSync, sign as rsaSign } from 'node:crypto';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import test, { after } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  adminEnv,
  clientFor,
  closeHarness,
  createTestDatabase,
  roleEnv,
} from '../../evidence-store/src/pg-harness.mjs';

// Across a real process boundary, against a real PostgreSQL 16 server: the service accepts a
// record, is killed with SIGKILL, and a new process on the same database still has it, counts it
// once and answers its replay as a duplicate. Each child is durable-service.fixture.mjs - the real
// seam over the real durable store - with keys signed here. Fails without a server; never skips.

after(() => closeHarness());

const FIXTURE = new URL('./durable-service.fixture.mjs', import.meta.url).pathname;
const ISSUER = 'https://token.actions.githubusercontent.com';
const AUDIENCE = 'urn:codeaiforge:sdlc-control-plane:production';

const signing = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWKS = {
  keys: [{ ...signing.publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' }],
};
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
function token(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' })}.${b64({
    iss: ISSUER,
    aud: AUDIENCE,
    iat: now,
    nbf: now - 300,
    exp: now + 300,
    sub: 'repo:owner/payments:ref:refs/heads/main',
    repository: 'owner/payments',
    repository_owner_id: '65',
    repository_id: '74',
    actor: 'someone',
    actor_id: '3251178',
    run_id: '39384901065',
    run_attempt: '1',
    sha: '445079d0e62a947dc442832eaeca02e99e673d98',
    ref: 'refs/heads/main',
    event_name: 'push',
    workflow_ref: 'owner/payments/.github/workflows/gate.yml@refs/heads/main',
    job_workflow_ref: 'owner/payments/.github/workflows/gate.yml@refs/heads/main',
    job_workflow_sha: 'b'.repeat(40),
    ...overrides,
  })}`;
  const signature = rsaSign('sha256', Buffer.from(input), {
    key: signing.privateKey,
    padding: constants.RSA_PKCS1_PADDING,
  });
  return `${input}.${signature.toString('base64url')}`;
}

const REGISTRY = {
  registry_version: 'workspace-registry/1',
  workspaces: [
    {
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
        admitted_events: ['push'],
      },
    },
  ],
};
const POLICY = {
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
const evidence = (overrides = {}) => ({
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
  ...overrides,
});

// Starts a child and waits for its {port} line (or its exit) - readiness is awaited, never slept.
function startService(env) {
  const child = spawn(process.execPath, [FIXTURE], {
    env: { PATH: process.env.PATH, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const output = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk) => (output.stdout += chunk));
  child.stderr.on('data', (chunk) => (output.stderr += chunk));
  child.stdin.end(JSON.stringify({ jwks: JWKS, registry: REGISTRY, policy: POLICY }));
  const exited = once(child, 'exit').then(([code, signal]) => ({ code, signal }));
  const ready = new Promise((resolve, reject) => {
    const check = () => {
      const line = output.stdout.split('\n')[0];
      if (line.startsWith('{')) resolve(JSON.parse(line).port);
    };
    child.stdout.on('data', check);
    exited.then(({ code, signal }) =>
      reject(new Error(`service exited ${code ?? signal}: ${output.stderr.trim()}`)),
    );
  });
  ready.catch(() => {});
  return { child, output, exited, ready };
}

async function service(t, env) {
  const started = startService(env);
  t.after(() => {
    if (started.child.exitCode === null && started.child.signalCode === null)
      started.child.kill('SIGKILL');
  });
  return { ...started, port: await started.ready };
}

function call(port, { method = 'GET', path, body, auth = true, headers = {} }) {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        agent: false,
        headers: {
          ...headers,
          ...(auth === true ? { authorization: `Bearer ${token()}` } : {}),
          ...(typeof auth === 'string' ? { authorization: auth } : {}),
          ...(body === undefined ? {} : { 'content-length': Buffer.byteLength(body) }),
        },
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (text += chunk));
        response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
      },
    );
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

async function rows(db, change = 'PR-1') {
  const [{ n }] = await db.connectAs('evidence_audit', { max: 1 })`
    SELECT count(*)::int AS n FROM evidence.evidence_envelope
     WHERE workspace_id = 'payments-art' AND change_id = ${change}`;
  return n;
}

async function database(t) {
  const db = await createTestDatabase();
  t.after(() => db.dispose());
  return db;
}

// AC-2, AC-3(a).
test('an accepted record survives SIGKILL; the next process counts it once and answers its replay 202', async (t) => {
  const db = await database(t);
  const env = roleEnv('evidence_app', db.name);
  const body = JSON.stringify(evidence());

  const first = await service(t, env);
  assert.equal(
    (await call(first.port, { method: 'POST', path: '/v1/evidence', body })).status,
    202,
  );
  first.child.kill('SIGKILL');
  assert.deepEqual(await first.exited, { code: null, signal: 'SIGKILL' });

  const second = await service(t, env);
  const indicators = await call(second.port, { path: '/v1/indicators' });
  assert.equal(indicators.status, 200);
  assert.equal(indicators.body.data.total_records, 1);
  assert.equal(indicators.body.data.passing_records, 1);
  const replay = await call(second.port, { method: 'POST', path: '/v1/evidence', body });
  assert.equal(replay.status, 202);
  assert.equal(replay.body.decision.disposition, 'accepted');
  assert.equal(await rows(db), 1, 'the replay appended nothing');
  const [stored] = await db.connectAs('evidence_audit', { max: 1 })`
    SELECT workspace_id, policy_id, submitted_by ->> 'run_id' AS run_id
      FROM evidence.evidence_envelope`;
  assert.deepEqual(
    { ...stored },
    {
      workspace_id: 'payments-art',
      policy_id: 'test-policy@1',
      run_id: '39384901065',
    },
  );
});

// AC-3(b)(ii): two processes, two pools, one key.
test('concurrent submissions of one key through two processes are all 202 and leave one row', async (t) => {
  const db = await database(t);
  const env = roleEnv('evidence_app', db.name);
  const [a, b] = await Promise.all([service(t, env), service(t, env)]);
  const body = JSON.stringify(evidence({ change_id: 'PR-race' }));
  const answers = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      call((i % 2 ? a : b).port, { method: 'POST', path: '/v1/evidence', body }),
    ),
  );
  assert.deepEqual(
    answers.map((answer) => answer.status),
    Array(20).fill(202),
  );
  assert.equal(await rows(db, 'PR-race'), 1);
});

// AC-13(c): the database goes away under a running service. The store routes answer 503, health
// stays 200, the process stays up, and it recovers when the database comes back.
test('with the database refusing the service, store routes answer 503, the process lives, and it recovers', async (t) => {
  const db = await database(t);
  const running = await service(t, roleEnv('evidence_app', db.name));
  const body = JSON.stringify(evidence({ change_id: 'PR-outage' }));
  assert.equal((await call(running.port, { path: '/v1/indicators' })).status, 200);

  await db.revokeConnect('evidence_app');
  await db.terminate('evidence_app');
  assert.deepEqual(await call(running.port, { path: '/health', auth: false }), {
    status: 200,
    body: { status: 'ok' },
  });
  for (const attempt of [
    { path: '/v1/indicators' },
    { method: 'POST', path: '/v1/evidence', body },
  ]) {
    const answer = await call(running.port, attempt);
    assert.equal(answer.status, 503, attempt.path);
    assert.deepEqual(answer.body, { error: 'evidence store unavailable' });
  }
  assert.equal(running.child.exitCode, null, 'the service is still running');
  assert.equal(running.child.signalCode, null);

  await db.grantConnect('evidence_app');
  const deadline = Date.now() + 10000;
  let recovered;
  do {
    recovered = await call(running.port, { method: 'POST', path: '/v1/evidence', body });
    if (recovered.status === 202) break;
    await delay(100);
  } while (Date.now() < deadline);
  assert.equal(recovered.status, 202, 'the service recovered once the database came back');
  assert.equal((await call(running.port, { path: '/v1/indicators' })).body.data.total_records, 1);
  assert.equal(running.child.exitCode, null);
  assert.doesNotMatch(running.output.stderr, /ECONNREFUSED|permission denied|PostgresError/i);
});

// AC-24 and D-16, on the real server: the service refuses to start rather than run unsafely, with
// one fixed line, and no credential appears in anything it prints.
test('the service refuses to start on a wrong password, an unsafe role, or a host that needs TLS', async (t) => {
  const db = await database(t);
  const SENTINEL = 'CANARY-PGPASSWORD-sentinel';
  const cases = [
    [{ ...roleEnv('evidence_app', db.name), PGPASSWORD: SENTINEL }, 'database-unreachable'],
    [roleEnv('evidence_owner', db.name), 'role-unsafe'],
    [roleEnv('evidence_audit', db.name), 'role-unsafe'],
    // localhost is a name, not loopback: TLS is required, and this server offers none.
    [{ ...roleEnv('evidence_app', db.name), PGHOST: 'localhost' }, 'database-unreachable'],
    [{ ...roleEnv('evidence_app', db.name), PGDATABASE: undefined }, 'config-invalid'],
  ];
  for (const [env, code] of cases) {
    const started = startService(env);
    const { code: exit } = await started.exited;
    assert.equal(exit, 1, code);
    assert.equal(started.output.stderr, `control plane refused to start: ${code}\n`, code);
    assert.equal(started.output.stdout, '');
    for (const secret of [SENTINEL, env.PGPASSWORD].filter(Boolean))
      assert.equal(`${started.output.stdout}${started.output.stderr}`.includes(secret), false);
  }
  // A running service prints its port and refusal lines, never its password.
  const running = await service(t, roleEnv('evidence_app', db.name));
  await call(running.port, { method: 'POST', path: '/v1/evidence', body: '{ not json' });
  await call(running.port, { path: '/v1/indicators' });
  const printed = `${running.output.stdout}${running.output.stderr}`;
  assert.match(printed, /"reason":"body-not-json"/);
  assert.equal(printed.includes(roleEnv('evidence_app', db.name).PGPASSWORD), false);
});

// ---------------------------------------------------------------- task 2.3: operating the service

const eventLines = (output) =>
  output.stderr
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line));
const readinessReasons = (output) =>
  eventLines(output)
    .filter((event) => event.event === 'readiness')
    .map((event) => event.reason);

// Polls GET /ready until it answers `status`, within `withinMs`, and records the slowest probe.
async function readyBecomes(port, status, withinMs = 6000) {
  const deadline = Date.now() + withinMs;
  let slowest = 0;
  for (;;) {
    const started = Date.now();
    const answer = await call(port, { path: '/ready', auth: false });
    slowest = Math.max(slowest, Date.now() - started);
    if (answer.status === status) return { answer, slowest };
    if (Date.now() > deadline)
      assert.fail(`GET /ready did not answer ${status} within ${withinMs} ms`);
    await delay(100);
  }
}

// An administrator on another database, for what cannot be done from inside the test database.
async function clusterAdmin(t) {
  const sql = clientFor({ ...(await adminEnv()), PGDATABASE: 'postgres' }, { max: 1 });
  t.after(() => sql.end({ timeout: 1 }));
  return sql;
}

// AC-6 and C-9: the stdout contract is unchanged, and stderr names the policy in force first.
test('the service prints {"port"} on stdout and one startup line naming the policy, its decision, the schema and the registrations', async (t) => {
  const db = await database(t);
  const running = await service(t, roleEnv('evidence_app', db.name));
  assert.equal(running.output.stdout, `${JSON.stringify({ port: running.port })}\n`);
  const startup = eventLines(running.output).filter((event) => event.event === 'startup');
  assert.equal(startup.length, 1);
  assert.deepEqual(
    { ...startup[0], at: undefined },
    {
      event: 'startup',
      at: undefined,
      policy_id: 'test-policy@1',
      decision_id: 'TEST-DECISION-1',
      schema_version: 2,
      workspaces: 1,
    },
  );
  assert.deepEqual(await call(running.port, { path: '/ready', auth: false }), {
    status: 200,
    body: { status: 'ready' },
  });
  assert.deepEqual(await call(running.port, { path: '/health', auth: false }), {
    status: 200,
    body: { status: 'ok' },
  });
});

// AC-3 over a real process boundary: the database is taken away under a running service.
test('GET /ready turns 503 within 6 s when the database stops accepting connections, and 200 again without a restart', async (t) => {
  const db = await database(t);
  const admin = await clusterAdmin(t);
  const running = await service(t, roleEnv('evidence_app', db.name));
  const pid = running.child.pid;
  await readyBecomes(running.port, 200);

  await admin`ALTER DATABASE ${admin(db.name)} WITH ALLOW_CONNECTIONS false`;
  try {
    await db.terminate('evidence_app');
    const down = await readyBecomes(running.port, 503);
    assert.deepEqual(down.answer.body, { status: 'not-ready' });
    assert.ok(down.slowest < 2500, `a probe took ${down.slowest} ms`);
    assert.deepEqual(await call(running.port, { path: '/health', auth: false }), {
      status: 200,
      body: { status: 'ok' },
    });
    const post = await call(running.port, {
      method: 'POST',
      path: '/v1/evidence',
      body: JSON.stringify(evidence({ change_id: 'PR-down' })),
    });
    assert.deepEqual(post, { status: 503, body: { error: 'evidence store unavailable' } });
  } finally {
    await admin`ALTER DATABASE ${admin(db.name)} WITH ALLOW_CONNECTIONS true`;
  }
  const up = await readyBecomes(running.port, 200);
  assert.ok(up.slowest < 2500, `a probe took ${up.slowest} ms`);
  assert.equal(running.child.pid, pid);
  assert.equal(running.child.exitCode, null, 'the same process, never restarted');
  assert.deepEqual(readinessReasons(running.output), ['ready', 'database-unreachable', 'ready']);
  assert.doesNotMatch(running.output.stderr, /PostgresError|not currently accepting|ECONNREFUSED/i);
});

test('GET /ready reads role-refused while CONNECT is revoked from the service role, and recovers on re-grant', async (t) => {
  const db = await database(t);
  const running = await service(t, roleEnv('evidence_app', db.name));
  await readyBecomes(running.port, 200);
  await db.revokeConnect('evidence_app');
  await db.terminate('evidence_app');
  await readyBecomes(running.port, 503);
  await db.grantConnect('evidence_app');
  await readyBecomes(running.port, 200);
  assert.deepEqual(readinessReasons(running.output), ['ready', 'role-refused', 'ready']);
  assert.doesNotMatch(running.output.stderr, /permission denied/i);
});

test('GET /ready reads schema-mismatch while the applied schema is not the bundled one, and recovers', async (t) => {
  const db = await database(t);
  const running = await service(t, roleEnv('evidence_app', db.name));
  await readyBecomes(running.port, 200);
  const [{ checksum }] =
    await db.admin`SELECT checksum FROM evidence.schema_migrations WHERE version = 2`;
  await db.admin`UPDATE evidence.schema_migrations SET checksum = ${'0'.repeat(64)} WHERE version = 2`;
  await readyBecomes(running.port, 503);
  await db.admin`UPDATE evidence.schema_migrations SET checksum = ${checksum} WHERE version = 2`;
  await readyBecomes(running.port, 200);
  assert.deepEqual(readinessReasons(running.output), ['ready', 'schema-mismatch', 'ready']);
});

// The supervisor's view: SIGTERM still kills the process with SIGTERM, and the last line it wrote
// holds exactly the responses it sent, by route, status and outcome.
test('on SIGTERM the service writes one shutdown snapshot of exactly what it answered, and still dies of the signal', async (t) => {
  const db = await database(t);
  const running = await service(t, roleEnv('evidence_app', db.name));
  const body = JSON.stringify(evidence({ change_id: 'PR-shutdown' }));
  const sent = [
    await call(running.port, { path: '/health', auth: false }),
    await call(running.port, { path: '/health', auth: false }),
    await call(running.port, { path: '/ready', auth: false }),
    await call(running.port, { method: 'POST', path: '/v1/evidence', body }),
    await call(running.port, { method: 'POST', path: '/v1/evidence', body }),
    await call(running.port, { path: '/v1/indicators', auth: 'Bearer not-a-token' }),
    await call(running.port, { path: '/v1/nope', auth: false }),
  ];
  assert.deepEqual(
    sent.map(({ status }) => status),
    [200, 200, 200, 202, 202, 401, 404],
  );
  running.child.kill('SIGTERM');
  assert.deepEqual(await running.exited, { code: null, signal: 'SIGTERM' });
  const events = eventLines(running.output);
  const last = events.at(-1);
  assert.equal(last.event, 'telemetry');
  assert.equal(last.kind, 'shutdown');
  assert.deepEqual(last.counts, [
    { route: 'GET /health', status: 200, outcome: 'live', n: 2 },
    { route: 'GET /ready', status: 200, outcome: 'ready', n: 1 },
    { route: 'GET /v1/indicators', status: 401, outcome: 'credential-malformed', n: 1 },
    { route: 'POST /v1/evidence', status: 202, outcome: 'appended', n: 1 },
    { route: 'POST /v1/evidence', status: 202, outcome: 'duplicate', n: 1 },
    { route: 'unmatched', status: 404, outcome: 'unmatched-route', n: 1 },
  ]);
  assert.equal(last.ready, true);
  assert.equal(events.filter((event) => event.kind === 'shutdown').length, 1);
  assert.deepEqual(
    events.filter((event) => event.event === 'accepted').map((event) => event.outcome),
    ['appended', 'duplicate'],
  );
});

// AC-5 across the process boundary: the raw bytes the child wrote. Header values must be Latin-1
// on the wire, so the bidi characters ride in the body and the token's claims.
const CANARY = 'zq7canary\u202E\u2066\u200B';
const DANGEROUS =
  /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/;

test('a canary in every field a caller writes reaches none of the bytes the service writes', async (t) => {
  const db = await database(t);
  const running = await service(t, roleEnv('evidence_app', db.name));
  const noisy = {
    'user-agent': 'zq7canary-agent',
    'x-forwarded-for': 'zq7canary-xff',
    cookie: 'zq7canary=1',
  };
  const canaryToken = token({
    ref: `refs/heads/${CANARY}`,
    workflow_ref: `owner/payments/.github/workflows/${CANARY}.yml@refs/heads/main`,
    actor: CANARY,
    sub: `repo:owner/payments:ref:refs/heads/${CANARY}`,
  });
  const record = (overrides = {}) =>
    JSON.stringify(
      evidence({
        change_id: `PR-${CANARY}`,
        computed_at: CANARY,
        affected_set: [`packages/${CANARY}`],
        ai_assisted: true,
        ai_tool: CANARY,
        ...overrides,
      }),
    );
  const statuses = [];
  for (const attempt of [
    { method: 'POST', path: '/v1/evidence', body: record(), auth: `Bearer ${canaryToken}` },
    { method: 'POST', path: '/v1/evidence', body: record() },
    { method: 'POST', path: '/v1/evidence', body: record({ result: { pass: false } }) },
    {
      method: 'POST',
      path: '/v1/evidence',
      body: record({ change_id: `PR2-${CANARY}`, verification: { verified: [CANARY] } }),
    },
    {
      method: 'POST',
      path: '/v1/evidence',
      auth: `Bearer ${token({ event_name: 'workflow_dispatch', actor: CANARY, ref: CANARY })}`,
      body: record(),
    },
    { path: `/v1/${encodeURIComponent(CANARY)}?access_token=zq7canary`, auth: false },
    { path: '/v1/workspaces', auth: 'Bearer zq7canary.not.a.token' },
  ]) {
    const answer = await call(running.port, { ...attempt, headers: noisy });
    statuses.push(answer.status);
  }
  assert.deepEqual(statuses, [202, 202, 409, 422, 403, 404, 401]);
  running.child.kill('SIGTERM');
  await running.exited;
  const written = `${running.output.stdout}${running.output.stderr}`;
  assert.ok(written.includes('"kind":"shutdown"'), 'the shutdown snapshot was written');
  assert.equal(written.includes('zq7canary'), false);
  assert.doesNotMatch(written, DANGEROUS);
});
