import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  NOT_CONFIGURED,
  READINESS_CACHE_MS,
  READINESS_REASONS,
  READINESS_TIMEOUT_MS,
  createReadiness,
} from './readiness.mjs';

// MIT-22 / ABU-18. The unauthenticated readiness probe cannot be used to load the database: at
// most one check at a time, a result reused for READINESS_CACHE_MS, no probe waiting longer than
// READINESS_TIMEOUT_MS, and every answer from a closed vocabulary. The route and its wire
// behaviour are main.test.mjs's; the real database is durable-service.integration.mjs's.

const clock = (ms = 0) => {
  const state = { ms };
  return { state, monotonic: () => state.ms };
};

// A check whose settlement the test controls, counting every call.
function gatedCheck() {
  const gate = { calls: 0, release: () => {} };
  gate.check = () => {
    gate.calls += 1;
    return new Promise((resolve) => {
      gate.release = (value = { ready: true, reason: 'ready' }) => resolve(value);
    });
  };
  return gate;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('200 concurrent probes run one check and all get the same answer', async () => {
  const gate = gatedCheck();
  const readiness = createReadiness({ check: gate.check, ...clock() });
  const probes = Array.from({ length: 200 }, () => readiness.probe());
  await flush();
  assert.equal(gate.calls, 1);
  gate.release();
  const answers = await Promise.all(probes);
  assert.equal(gate.calls, 1);
  for (const answer of answers) assert.equal(answer, answers[0]);
  assert.deepEqual(answers[0], { ready: true, reason: 'ready' });
  assert.equal(Object.isFrozen(answers[0]), true);
});

test('a settled answer is reused for 2000 ms from when it settled, then checked again', async () => {
  const { state, monotonic } = clock(1000);
  let calls = 0;
  const readiness = createReadiness({
    check: async () => {
      calls += 1;
      return { ready: true, reason: 'ready' };
    },
    monotonic,
  });
  await readiness.probe();
  assert.equal(calls, 1);
  state.ms = 1000 + READINESS_CACHE_MS - 1;
  for (let index = 0; index < 50; index += 1) await readiness.probe();
  assert.equal(calls, 1, 'reused inside the window');
  state.ms = 1000 + READINESS_CACHE_MS;
  await readiness.probe();
  assert.equal(calls, 2, 'checked again at the window');
});

test('a check that never settles is answered check-timeout at 2000 ms, and the next probe starts a fresh one later', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { state, monotonic } = clock();
  let calls = 0;
  const readiness = createReadiness({
    check: () => {
      calls += 1;
      return new Promise(() => {});
    },
    monotonic,
  });
  let settled = null;
  readiness.probe().then((value) => (settled = value));
  await flush();
  t.mock.timers.tick(READINESS_TIMEOUT_MS - 1);
  await flush();
  assert.equal(settled, null, 'not before the bound');
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(settled, { ready: false, reason: 'check-timeout' });
  // While the abandoned check is still out, the cached answer is served and none is added.
  // Not awaited: under a defect that skips the cache this probe would hang the file.
  state.ms = READINESS_CACHE_MS - 1;
  readiness.probe();
  await flush();
  assert.equal(calls, 1);
  state.ms = READINESS_CACHE_MS;
  readiness.probe();
  await flush();
  assert.equal(calls, 2, 'one new check after the window, beside the abandoned one');
});

test('a check that throws, rejects, or answers outside the vocabulary is check-fault, and nothing else it returns survives', async () => {
  const cases = [
    () => {
      throw new Error('CANARY sync throw');
    },
    async () => {
      throw new Error('CANARY rejection');
    },
    async () => null,
    async () => undefined,
    async () => ({ ready: 'yes', reason: 'ready' }),
    async () => ({ ready: true, reason: 'database-unreachable' }),
    async () => ({ ready: false, reason: 'ready' }),
    async () => ({ ready: false, reason: 'CANARY driver message' }),
  ];
  for (const check of cases) {
    const answer = await createReadiness({ check, ...clock() }).probe();
    assert.deepEqual(answer, { ready: false, reason: 'check-fault' }, String(check));
  }
  const extra = await createReadiness({
    check: async () => ({ ready: false, reason: 'role-refused', message: 'CANARY' }),
    ...clock(),
  }).probe();
  assert.deepEqual(extra, { ready: false, reason: 'role-refused' });
  assert.deepEqual(Object.keys(extra), ['ready', 'reason']);
});

test('onChange fires on the first answer and on each change only, and a throwing one changes nothing', async () => {
  const { state, monotonic } = clock();
  const answers = [
    { ready: true, reason: 'ready' },
    { ready: true, reason: 'ready' },
    { ready: false, reason: 'database-unreachable' },
    { ready: false, reason: 'database-unreachable' },
    { ready: false, reason: 'role-refused' },
    { ready: true, reason: 'ready' },
  ];
  const changes = [];
  const readiness = createReadiness({
    check: async () => answers.shift(),
    monotonic,
    onChange: (answer) => changes.push(answer.reason),
  });
  for (let index = 0; index < 6; index += 1) {
    await readiness.probe();
    state.ms += READINESS_CACHE_MS;
  }
  assert.deepEqual(changes, ['ready', 'database-unreachable', 'role-refused', 'ready']);

  const throwing = createReadiness({
    check: async () => ({ ready: true, reason: 'ready' }),
    ...clock(),
    onChange: () => {
      throw new Error('disk full');
    },
  });
  assert.deepEqual(await throwing.probe(), { ready: true, reason: 'ready' });
});

test('a readiness built without a check fails closed as not-configured', async () => {
  assert.deepEqual(await createReadiness().probe(), { ready: false, reason: 'not-configured' });
  assert.deepEqual(await NOT_CONFIGURED(), { ready: false, reason: 'not-configured' });
  assert.throws(() => createReadiness({ check: 'not a function' }), TypeError);
});

test('last() is null before the first answer and runs no check', async () => {
  const gate = gatedCheck();
  const readiness = createReadiness({ check: gate.check, ...clock() });
  assert.equal(readiness.last(), null);
  assert.equal(gate.calls, 0);
  const pending = readiness.probe();
  await flush();
  assert.equal(readiness.last(), null, 'not while the check runs');
  gate.release({ ready: false, reason: 'schema-mismatch' });
  await pending;
  assert.deepEqual(readiness.last(), { ready: false, reason: 'schema-mismatch' });
  assert.equal(gate.calls, 1);
});

test('the bounds and the vocabulary are reviewed literals, and nothing reads the environment', () => {
  assert.equal(READINESS_CACHE_MS, 2000);
  assert.equal(READINESS_TIMEOUT_MS, 2000);
  assert.deepEqual(READINESS_REASONS, [
    'ready',
    'database-unreachable',
    'role-refused',
    'schema-mismatch',
    'check-timeout',
    'check-fault',
    'not-configured',
  ]);
  assert.equal(Object.isFrozen(READINESS_REASONS), true);
  const source = readFileSync(new URL('./readiness.mjs', import.meta.url), 'utf8');
  const code = source
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
  for (const spelling of [/\bprocess\b/, /['"]node:process['"]/, /import\.meta\.env/, /\bimport\b/])
    assert.doesNotMatch(code, spelling);
});
