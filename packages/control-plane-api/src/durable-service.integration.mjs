import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { constants, generateKeyPairSync, sign as rsaSign } from 'node:crypto';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import test, { after } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { closeHarness, createTestDatabase, roleEnv } from '../../evidence-store/src/pg-harness.mjs';

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
function token() {
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
  rules: {
    minimum_evidence_schema: 'evidence/0',
    require_verified_controls: ['CAF-SDLC-002:tier'],
    require_ai_provenance_when_assisted: true,
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

function call(port, { method = 'GET', path, body, auth = true }) {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        agent: false,
        headers: {
          ...(auth ? { authorization: `Bearer ${token()}` } : {}),
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
