import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { constants, generateKeyPairSync, sign as rsaSign } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { EXIT, main, submitEvidence } from '../../evidence-adapter/src/submit-evidence.mjs';
import { closeHarness, createTestDatabase, roleEnv } from '../../evidence-store/src/pg-harness.mjs';

// Task 3.1, end to end (AC-1/2/3/4/6/9): a fixture workspace's own gate - the real sdlc-controls
// binary at the version the gate pins - produces an evidence/0 record, and the adapter mints a
// token and submits that record, byte for byte, to the real seam over the real PostgreSQL 16
// store (durable-service.fixture.mjs, spawned exactly as durable-service.integration.mjs does).
//
// What this is NOT: a measurement of GitHub. The ID-token endpoint below is a stand-in that speaks
// the runner's protocol and signs with a test key - a PROTOCOL test; a simulator measures itself
// (task 2.1). What GitHub actually puts in the claims of the reusable workflow's token on a
// pull-request run is task 3.3's measurement. The claims here are the ones a registration pinning
// that workflow would require.
//
// Needs PostgreSQL (PG*, the harness's rule) AND the pinned gate binary and its schema:
// SDLC_CONTROLS_BIN, SDLC_CONTROLS_SCHEMA (README › Tests; installed by ci.yml). Fails without
// them, never skips, and refuses any binary whose records are not 0.2.0: a different producer is
// a different proof.

after(() => closeHarness());

const BIN = process.env.SDLC_CONTROLS_BIN;
const SCHEMA_PATH = process.env.SDLC_CONTROLS_SCHEMA;
const PINNED_VERSION = '0.2.0';
const MISSING_GATE =
  'evidence-adapter.integration.mjs needs the pinned gate: set SDLC_CONTROLS_BIN to sdlc-controls ' +
  `v${PINNED_VERSION} and SDLC_CONTROLS_SCHEMA to its schemas/evidence/0/evidence.schema.json`;

const FIXTURE = new URL('./durable-service.fixture.mjs', import.meta.url).pathname;
const ISSUER = 'https://token.actions.githubusercontent.com';
const AUDIENCE = 'urn:codeaiforge:sdlc-control-plane:production';
const PINNED_REF =
  'codeaiforge/sdlc-control-plane/.github/workflows/submit-evidence.yml@refs/tags/evidence-adapter/v0.1.0';
const PINNED_SHA = '3a1f0c9e5b7d2a4c6e8f0b1d3a5c7e9f1b3d5a7c';
const CALLER_REF =
  'fixture-owner/fixture-workspace/.github/workflows/sdlc-controls.yml@refs/pull/7/merge';
const WORKSPACE = 'fixture-workspace';
const REQUEST_TOKEN = 'fixture-runner-request-token';

const work = mkdtempSync(join(tmpdir(), 'evidence-adapter-e2e-'));
after(() => rmSync(work, { recursive: true, force: true }));
let made = 0;
const fresh = (name) => {
  const path = join(work, `${name}-${(made += 1)}`);
  mkdirSync(path);
  return path;
};

// --------------------------------------------------------------------------- the seam's inputs

const signing = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWKS = {
  keys: [{ ...signing.publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' }],
};
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
function signToken(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' })}.${b64({
    iss: ISSUER,
    aud: AUDIENCE,
    iat: now,
    nbf: now - 5,
    exp: now + 300,
    sub: 'repo:fixture-owner/fixture-workspace:pull_request',
    repository: 'fixture-owner/fixture-workspace',
    repository_owner_id: '9001',
    repository_id: '9002',
    actor: 'alice',
    actor_id: '3251178',
    run_id: '1001',
    run_attempt: '1',
    sha: 'c'.repeat(40),
    ref: 'refs/pull/7/merge',
    event_name: 'pull_request',
    workflow_ref: CALLER_REF,
    job_workflow_ref: PINNED_REF,
    job_workflow_sha: PINNED_SHA,
    ...overrides,
  })}`;
  const signature = rsaSign('sha256', Buffer.from(input), {
    key: signing.privateKey,
    padding: constants.RSA_PKCS1_PADDING,
  });
  return `${input}.${signature.toString('base64url')}`;
}

// Fictional ids; the pin names the reusable workflow at the tag a workspace would call it by.
const REGISTRY = {
  registry_version: 'workspace-registry/1',
  workspaces: [
    {
      workspace_id: WORKSPACE,
      display_name: 'Fixture workspace',
      value_stream: 'fixtures',
      repository_url: 'https://example.invalid/fixture-workspace',
      evidence_endpoint: 'https://example.invalid/never-called',
      owners: ['platform'],
      status: 'active',
      workload_identity: {
        issuer: ISSUER,
        repository_owner_id: '9001',
        repository_id: '9002',
        admitted_events: ['pull_request'],
        required_job_workflow_ref: PINNED_REF,
        required_job_workflow_sha: PINNED_SHA,
      },
    },
  ],
};
// Blocks no tier, so a blocked change's record is stored with the gate's own result in it: the
// control plane keeps the workspace's claim, including "controls not met" (ADR-0004).
const POLICY = {
  policy_version: 'guardrails/0',
  policy_id: 'fixture-policy@1',
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

// ------------------------------------------------------------------- the fixture workspace

// Every child process gets exactly this environment: no inherited git configuration, no
// NX_WORKSPACE_ROOT_PATH pointing at this repository (task 2.2's lesson), nothing else.
const childEnv = (home) => ({
  PATH: process.env.PATH,
  HOME: home,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  LC_ALL: 'C',
});

function git(repo, home, ...args) {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=alice', '-c', 'user.email=alice@example.invalid', ...args],
    { cwd: repo, env: childEnv(home), encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

const write = (root, path, text) => {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), text);
};

// A git repository with an Nx-shaped layout and a branch `change` that edits `edit`. Built in a
// temp directory from these literals and never in this repository, where a project.json would
// become a project of this workspace.
function fixtureWorkspace(edit) {
  const home = fresh('home');
  const repo = fresh('repo');
  git(repo, home, 'init', '-q', '-b', 'main');
  write(repo, 'package.json', '{ "name": "fixture-workspace", "private": true }\n');
  write(repo, 'nx.json', '{}\n');
  write(
    repo,
    'packages/alpha/project.json',
    '{ "name": "alpha", "tags": ["criticality:critical"] }\n',
  );
  write(repo, 'packages/alpha/src/index.mjs', 'export const alpha = 1;\n');
  write(repo, 'docs/readme.md', '# Fixture\n');
  git(repo, home, 'add', '-A');
  git(repo, home, 'commit', '-q', '-m', 'chore: fixture');
  git(repo, home, 'checkout', '-q', '-b', 'change');
  write(repo, edit, `${readFileSync(join(repo, edit), 'utf8')}// changed\n`);
  git(repo, home, 'commit', '-q', '-a', '-m', 'feat: the change');
  // As the gate writes it, under $RUNNER_TEMP: outside the repository.
  const config = join(home, 'components.yaml');
  writeFileSync(
    config,
    [
      'version: 1',
      'defaults:',
      '  unmatched_path_tier: high',
      '  breadth_threshold: 4',
      'components:',
      '  - id: "docs"',
      '    match: ["docs/**"]',
      '    criticality: low',
      '    shared: false',
      '  - id: "alpha"',
      '    match: ["packages/alpha/**"]',
      '    criticality: critical',
      '    shared: false',
      '',
    ].join('\n'),
  );
  return { repo, home, config, head: git(repo, home, 'rev-parse', 'change') };
}

// The gate's tier step (the sibling sdlc-controls.yml), with the per-run change id of Q-4 B.
function runGate(fixture, { changeId, approvers, base = 'main' }) {
  const out = join(fresh('gate'), 'evidence.json');
  const result = spawnSync(
    BIN,
    [
      'tier',
      '--repo',
      fixture.repo,
      '--base',
      base,
      '--head',
      'change',
      '--config',
      fixture.config,
      '--change-id',
      changeId,
      '--author',
      'alice',
      '--approvers',
      approvers,
      '--approvers-known',
      '--evidence-out',
      out,
    ],
    { cwd: fixture.repo, env: childEnv(fixture.home), encoding: 'utf8' },
  );
  if (!existsSync(out)) return { status: result.status, path: out, record: null };
  const bytes = readFileSync(out);
  const record = JSON.parse(bytes.toString('utf8'));
  assert.equal(record.tool?.version, PINNED_VERSION, 'the record is not from the pinned gate');
  assert.deepEqual(checkSchema(record), [], 'the record fails the pinned evidence/0 schema');
  return { status: result.status, path: out, bytes, record };
}

// ----------------------------------------------------------------- the pinned schema, checked

// The keywords evidence/0 at v0.2.0 uses, and nothing else: any other keyword throws, so a schema
// this reader does not understand fails loudly rather than passing unchecked. `format` is an
// annotation here, as the gate's own ajv step does not assert it.
const KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  '$ref',
  'enum',
  'const',
  'minimum',
]);
const ANNOTATIONS = new Set([
  '$schema',
  '$id',
  '$defs',
  'title',
  'description',
  'examples',
  'format',
]);
const TYPES = {
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: Array.isArray,
  string: (v) => typeof v === 'string',
  boolean: (v) => typeof v === 'boolean',
  integer: Number.isInteger,
  number: (v) => typeof v === 'number',
};

let SCHEMA;
function checkSchema(value, schema = SCHEMA, path = '$', errors = []) {
  for (const key of Object.keys(schema))
    if (!KEYWORDS.has(key) && !ANNOTATIONS.has(key) && !key.startsWith('x-'))
      throw new Error(`schema keyword ${key} at ${path} is not understood by this check`);
  if (schema.$ref !== undefined) {
    const name = /^#\/\$defs\/([A-Za-z]+)$/.exec(schema.$ref)?.[1];
    if (!name || !SCHEMA.$defs?.[name]) throw new Error(`unresolvable $ref ${schema.$ref}`);
    checkSchema(value, SCHEMA.$defs[name], path, errors);
  }
  if (schema.type !== undefined) {
    if (!TYPES[schema.type]) throw new Error(`type ${schema.type} is not understood`);
    if (!TYPES[schema.type](value)) return errors.concat(`${path} is not ${schema.type}`);
  }
  if (Object.hasOwn(schema, 'const') && value !== schema.const) errors.push(`${path} != const`);
  if (schema.enum !== undefined && !schema.enum.includes(value)) errors.push(`${path} not in enum`);
  if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path} < minimum`);
  if (TYPES.object(value)) {
    for (const key of schema.required ?? [])
      if (!Object.hasOwn(value, key)) errors.push(`${path}.${key} is required`);
    if (
      schema.additionalProperties !== undefined &&
      typeof schema.additionalProperties !== 'boolean'
    )
      throw new Error('a schema-valued additionalProperties is not understood');
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key])
        checkSchema(item, schema.properties[key], `${path}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}.${key} is not allowed`);
    }
  }
  if (Array.isArray(value) && schema.items)
    value.forEach((item, index) => checkSchema(item, schema.items, `${path}[${index}]`, errors));
  return errors;
}

// ------------------------------------------------------ the runner stand-in, the relay, the seam

async function listen(t, server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}

// The runner's ID-token endpoint, as a protocol stand-in: it answers only the bearer request
// token, records the audience it was asked for, and mints with the test key. `claims` overrides
// what it mints, for the refusal cases.
async function tokenStandIn(t, claims = {}) {
  const requests = [];
  const port = await listen(
    t,
    createServer((request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      requests.push({
        authorization: request.headers.authorization,
        audiences: url.searchParams.getAll('audience'),
      });
      if (request.headers.authorization !== `bearer ${REQUEST_TOKEN}`) {
        response.writeHead(401).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ value: signToken(claims) }));
    }),
  );
  return { url: `http://127.0.0.1:${port}/token?api-version=2.0`, requests };
}

// Between the adapter and the seam: keeps every request body, and with `dropFirst` lets the first
// submission reach the seam - which commits it - and then destroys the adapter's socket before
// the answer, so the adapter sees a lost 202.
async function relay(t, seamPort, { dropFirst = false } = {}) {
  const bodies = [];
  const port = await listen(
    t,
    createServer((incoming, outgoing) => {
      const chunks = [];
      incoming.on('data', (chunk) => chunks.push(chunk));
      incoming.on('end', () => {
        const body = Buffer.concat(chunks);
        bodies.push(body);
        const index = bodies.length - 1;
        const forward = httpRequest(
          {
            host: '127.0.0.1',
            port: seamPort,
            method: incoming.method,
            path: incoming.url,
            agent: false,
            headers: {
              authorization: incoming.headers.authorization,
              'content-type': incoming.headers['content-type'],
              'content-length': body.length,
            },
          },
          (answer) => {
            const parts = [];
            answer.on('data', (chunk) => parts.push(chunk));
            answer.on('end', () => {
              if (dropFirst && index === 0) return incoming.socket.destroy();
              outgoing.writeHead(answer.statusCode, answer.headers);
              outgoing.end(Buffer.concat(parts));
            });
          },
        );
        forward.on('error', () => incoming.socket.destroy());
        forward.end(body);
      });
    }),
  );
  return { url: `http://127.0.0.1:${port}/v1/evidence`, bodies };
}

// durable-service.fixture.mjs, started and awaited as durable-service.integration.mjs does it.
async function seam(t, env) {
  const child = spawn(process.execPath, [FIXTURE], {
    env: { PATH: process.env.PATH, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  child.stdin.end(JSON.stringify({ jwks: JWKS, registry: REGISTRY, policy: POLICY }));
  const exited = once(child, 'exit');
  return new Promise((resolve, reject) => {
    child.stdout.on('data', () => {
      const line = stdout.split('\n')[0];
      if (line.startsWith('{')) resolve(JSON.parse(line).port);
    });
    exited.then(([code]) => reject(new Error(`seam exited ${code}: ${stderr.trim()}`)));
  });
}

function indicators(port) {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/v1/indicators',
        agent: false,
        headers: { authorization: `Bearer ${signToken()}` },
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (text += chunk));
        response.on('end', () => resolve(JSON.parse(text).data));
      },
    );
    outgoing.on('error', reject);
    outgoing.end();
  });
}

// One test's world: a database, the seam on it, the stand-in, the relay, and a submit function
// that runs the adapter's CLI entry (main) against them and keeps what it printed.
async function world(t, { claims, dropFirst } = {}) {
  assert.ok(BIN && SCHEMA_PATH, MISSING_GATE);
  SCHEMA ??= JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  const db = await createTestDatabase();
  t.after(() => db.dispose());
  const seamPort = await seam(t, roleEnv('evidence_app', db.name));
  const mint = await tokenStandIn(t, claims);
  const wire = await relay(t, seamPort, { dropFirst });
  const submit = async (path) => {
    let stdout = '';
    const code = await main({
      argv: [path],
      env: {
        ACTIONS_ID_TOKEN_REQUEST_URL: mint.url,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: REQUEST_TOKEN,
      },
      endpoint: wire.url,
      stdout: { write: (text) => (stdout += text) },
      random: () => 0,
    });
    return { code, stdout };
  };
  // As evidence_app: the one role that reads the payload, where the gate's result lives.
  const reader = db.connectAs('evidence_app', { max: 1 });
  const rows = async () =>
    (
      await reader`
        SELECT change_id, policy_id, evidence -> 'result' ->> 'pass' AS pass,
               submitted_by ->> 'job_workflow_ref' AS job_workflow_ref,
               submitted_by ->> 'run_id' AS run_id
          FROM evidence.evidence_envelope WHERE workspace_id = ${WORKSPACE} ORDER BY id`
    ).map((row) => ({ ...row }));
  return { db, seamPort, mint, wire, submit, rows };
}

const changeId = (head, attempt = 1) => `PR-7@${head}/1001.${attempt}`;

// ------------------------------------------------------------------------------------ tests

// AC-1, AC-2, AC-4, AC-6 (re-run), AC-9 (re-run of the submit job alone).
test('I-pass: a passing gate record is submitted unchanged and answered 202 accepted, once', async (t) => {
  const w = await world(t);
  const fixture = fixtureWorkspace('docs/readme.md');
  const gate = runGate(fixture, { changeId: changeId(fixture.head), approvers: 'bob' });
  assert.equal(gate.status, 0, 'controls met');
  assert.equal(gate.record.result.pass, true);

  const first = await w.submit(gate.path);
  assert.equal(first.code, EXIT.ACCEPTED, first.stdout);
  assert.match(
    first.stdout,
    /202, disposition "accepted" under policy "fixture-policy@1"\. .*self-attested/,
  );
  assert.equal(w.wire.bodies.length, 1);
  assert.ok(w.wire.bodies[0].equals(gate.bytes), 'the bytes the seam received are the file');
  assert.deepEqual(w.mint.requests, [
    { authorization: `bearer ${REQUEST_TOKEN}`, audiences: [AUDIENCE] },
  ]);

  // A re-run of the submit job alone re-sends the same file: answered 202 as a duplicate, with
  // the decision computed for the replay.
  const rerun = await submitEvidence({
    body: readFileSync(gate.path),
    endpoint: w.wire.url,
    env: {
      ACTIONS_ID_TOKEN_REQUEST_URL: w.mint.url,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: REQUEST_TOKEN,
    },
  });
  assert.deepEqual(rerun, {
    kind: 'accepted',
    status: 202,
    decision: {
      accepted: true,
      disposition: 'accepted',
      policy_id: 'fixture-policy@1',
      reasons: [],
      evidence_attestation: 'self-attested',
    },
    attempts: 1,
  });
  assert.ok(w.wire.bodies[1].equals(gate.bytes));
  assert.deepEqual(await w.rows(), [
    {
      change_id: changeId(fixture.head),
      policy_id: 'fixture-policy@1',
      pass: 'true',
      job_workflow_ref: PINNED_REF,
      run_id: '1001',
    },
  ]);
});

// AC-3: a change the gate blocks still publishes its record.
test('I-block: a gate exit 1 record is submitted and stored with its failing result', async (t) => {
  const w = await world(t);
  const fixture = fixtureWorkspace('packages/alpha/src/index.mjs');
  const gate = runGate(fixture, { changeId: changeId(fixture.head), approvers: '' });
  assert.equal(gate.status, 1, 'controls not met');
  assert.equal(gate.record.tier, 'T3');
  assert.equal(gate.record.result.pass, false);

  const answer = await w.submit(gate.path);
  assert.equal(answer.code, EXIT.ACCEPTED, answer.stdout);
  assert.ok(w.wire.bodies[0].equals(gate.bytes));
  const [row] = await w.rows();
  assert.equal(row.pass, 'false', 'stored as the gate said: controls not met');
  const summary = await indicators(w.seamPort);
  assert.deepEqual([summary.total_records, summary.passing_records], [1, 0]);
});

// AC-3: no record, nothing submitted.
test('I-exit2: a gate that errors writes no record, and the adapter submits nothing', async (t) => {
  const w = await world(t);
  const fixture = fixtureWorkspace('docs/readme.md');
  const gate = runGate(fixture, {
    changeId: changeId(fixture.head),
    approvers: 'bob',
    base: 'no-such-ref',
  });
  assert.equal(gate.status, 2);
  assert.equal(gate.record, null);
  const answer = await w.submit(gate.path);
  assert.equal(answer.code, EXIT.NO_RECORD);
  assert.match(
    answer.stdout,
    /no evidence record at .*: the gate did not reach a decision; nothing was submitted\./,
  );
  assert.equal(w.mint.requests.length, 0);
  assert.equal(w.wire.bodies.length, 0);
});

// AC-4: the unchanged authenticator refuses another audience, and the pin refuses another workflow.
test('I-aud and I-pin: a token for another audience is 401, another workflow is 403', async (t) => {
  for (const [claims, status] of [
    [{ aud: 'https://github.com/fixture-owner' }, 401],
    [{ job_workflow_ref: CALLER_REF }, 403],
  ]) {
    const w = await world(t, { claims });
    const fixture = fixtureWorkspace('docs/readme.md');
    const gate = runGate(fixture, { changeId: changeId(fixture.head), approvers: 'bob' });
    const answer = await w.submit(gate.path);
    assert.equal(answer.code, EXIT.REFUSED, answer.stdout);
    assert.match(answer.stdout, new RegExp(`refused ${status} `));
    assert.equal(w.wire.bodies.length, 1, 'never retried');
    assert.deepEqual(await w.rows(), []);
  }
});

// AC-6: a 202 lost on the way back is retried with a new token and lands as a duplicate.
test('I-lost: a lost 202 is retried with a fresh token and leaves one row', async (t) => {
  const w = await world(t, { dropFirst: true });
  const fixture = fixtureWorkspace('docs/readme.md');
  const gate = runGate(fixture, { changeId: changeId(fixture.head), approvers: 'bob' });
  const answer = await w.submit(gate.path);
  assert.equal(answer.code, EXIT.ACCEPTED, answer.stdout);
  assert.match(answer.stdout, /attempt 1 of 4: network; next attempt in 1\.0 s with a new token/);
  assert.equal(w.mint.requests.length, 2, 're-minted');
  assert.equal(w.wire.bodies.length, 2);
  for (const body of w.wire.bodies) assert.ok(body.equals(gate.bytes));
  assert.equal((await w.rows()).length, 1);
});

// AC-9 (Q-4 B): per-run change ids make every gate run its own record - indicators count gate
// runs, not changes - and a bare PR-<n> collides.
test('I-runs and I-collide: two runs are two records; two records under one bare id are a 409', async (t) => {
  const w = await world(t);
  const fixture = fixtureWorkspace('docs/readme.md');
  const unapproved = runGate(fixture, { changeId: changeId(fixture.head, 1), approvers: '' });
  const approved = runGate(fixture, { changeId: changeId(fixture.head, 2), approvers: 'bob' });
  assert.deepEqual([unapproved.status, approved.status], [1, 0]);
  assert.equal((await w.submit(unapproved.path)).code, EXIT.ACCEPTED);
  assert.equal((await w.submit(approved.path)).code, EXIT.ACCEPTED);
  const summary = await indicators(w.seamPort);
  assert.deepEqual([summary.total_records, summary.passing_records], [2, 1]);

  const first = runGate(fixture, { changeId: 'PR-7', approvers: '' });
  const second = runGate(fixture, { changeId: 'PR-7', approvers: 'bob' });
  assert.equal((await w.submit(first.path)).code, EXIT.ACCEPTED);
  const collided = await w.submit(second.path);
  assert.equal(collided.code, EXIT.REFUSED, collided.stdout);
  assert.match(
    collided.stdout,
    /refused 409 \(.*--change-id is not unique per run; idempotency key "\["fixture-workspace","PR-7"\]"\)/,
  );
  assert.deepEqual(
    (await w.rows()).map((row) => [row.change_id, row.pass]),
    [
      [changeId(fixture.head, 1), 'false'],
      [changeId(fixture.head, 2), 'true'],
      ['PR-7', 'false'],
    ],
    'the first record under PR-7 stands',
  );
});
