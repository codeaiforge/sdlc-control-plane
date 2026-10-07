import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { createKeySet, maxAgeSeconds, parseKeySet } from './key-set.mjs';

// AC-4's cache and key rules. Keys are generated here, per file, never shared; the key set is
// fed by an injected fetch, so no test here reaches the network. The clock is injected too, so
// "60 s later" is an assignment rather than a wait.

const rsa2048 = generateKeyPairSync('rsa', { modulusLength: 2048 });
const rsa2048b = generateKeyPairSync('rsa', { modulusLength: 2048 });
const rsa1024 = generateKeyPairSync('rsa', { modulusLength: 1024 });
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });

const jwkOf = (pair, extra = {}) => ({
  ...pair.publicKey.export({ format: 'jwk' }),
  use: 'sig',
  alg: 'RS256',
  ...extra,
});

const body = (keys) => Buffer.from(JSON.stringify({ keys }));

// A controllable clock and fetch. `answers` is consumed in order; each entry is a response, an
// Error to reject with, or a deferred the test resolves itself.
function harness(answers) {
  const clock = { ms: Date.UTC(2026, 9, 7, 12, 0, 0) };
  const fetches = [];
  const keySet = createKeySet({
    now: () => clock.ms,
    fetchKeySet: async () => {
      fetches.push(clock.ms);
      const next = answers.shift();
      if (next === undefined) throw new Error('unexpected fetch');
      if (next instanceof Error) throw next;
      if (typeof next.then === 'function') return next;
      return next;
    },
  });
  return { clock, fetches, keySet };
}

const ok = (keys, cacheControl = 'public, max-age=3600, must-revalidate') => ({
  body: body(keys),
  cacheControl,
});

test('max-age 5 is clamped to 60, 99999 to 3600, and a missing one is 60', () => {
  assert.equal(maxAgeSeconds('max-age=5'), 60);
  assert.equal(maxAgeSeconds('public, max-age=99999'), 3600);
  assert.equal(maxAgeSeconds('public, max-age=3600, must-revalidate'), 3600);
  assert.equal(maxAgeSeconds('max-age=600'), 600);
  assert.equal(maxAgeSeconds(undefined), 60);
  assert.equal(maxAgeSeconds('no-cache'), 60);
  assert.equal(maxAgeSeconds('max-age=-5'), 60);
  assert.equal(maxAgeSeconds('s-maxage=3000'), 60, 's-maxage is not max-age');
  assert.equal(maxAgeSeconds('max-age="1200"'), 1200);
});

test('the fetched set is cached for its clamped max-age and used within it', async () => {
  const { clock, fetches, keySet } = harness([ok([jwkOf(rsa2048, { kid: 'k1' })], 'max-age=120')]);
  const first = await keySet.current();
  assert.equal(first.has('k1'), true);
  clock.ms += 119_000;
  assert.equal((await keySet.current()).has('k1'), true);
  assert.equal(fetches.length, 1, 'a cached set was refetched inside its lifetime');
});

test('no key is used past expiry', async () => {
  // Expiry while the refetch fails: the expired set must not be served stale.
  const { clock, keySet } = harness([
    ok([jwkOf(rsa2048, { kid: 'k1' })], 'max-age=60'),
    new Error('outage'),
  ]);
  assert.ok(await keySet.current());
  clock.ms += 59_999;
  assert.ok(await keySet.current(), 'the set expired early');
  clock.ms += 1;
  assert.equal(await keySet.current(), null);
});

test('an expiry inside a spent budget is null, starts no fetch, and recovers when it allows', async () => {
  // RR-13's case: an unknown-kid refetch that fails shortly before expiry spends the budget, so
  // the expiry refetch waits for it - up to 60 s of 503 after GitHub recovers.
  const { clock, fetches, keySet } = harness([
    ok([jwkOf(rsa2048, { kid: 'k1' })], 'max-age=120'),
    new Error('outage'),
    ok([jwkOf(rsa2048, { kid: 'k1' })], 'max-age=120'),
  ]);
  const t0 = clock.ms;
  await keySet.current();
  clock.ms = t0 + 100_000;
  assert.ok(await keySet.refreshForUnknownKid(), 'the failed refetch dropped the cache');
  clock.ms = t0 + 120_000;
  assert.equal(await keySet.current(), null);
  assert.equal(fetches.length, 2, 'a barred caller started a fetch');
  clock.ms = t0 + 160_000;
  assert.equal((await keySet.current()).has('k1'), true);
  assert.equal(fetches.length, 3);
});

test('an expired cache is refetched once the budget allows', async () => {
  const { clock, fetches, keySet } = harness([
    ok([jwkOf(rsa2048, { kid: 'k1' })], 'max-age=60'),
    ok([jwkOf(rsa2048b, { kid: 'k2' })], 'max-age=60'),
  ]);
  await keySet.current();
  clock.ms += 60_000;
  const refreshed = await keySet.current();
  assert.deepEqual([...refreshed.keys()], ['k2']);
  assert.equal(fetches.length, 2);
});

test('concurrent callers share one in-flight fetch', async () => {
  let release;
  const deferred = new Promise((resolve) => {
    release = resolve;
  });
  const { fetches, keySet } = harness([deferred]);
  const callers = [keySet.current(), keySet.current(), keySet.refreshForUnknownKid()];
  await Promise.resolve();
  release(ok([jwkOf(rsa2048, { kid: 'k1' })]));
  const results = await Promise.all(callers);
  assert.equal(fetches.length, 1);
  for (const keys of results) assert.equal(keys.has('k1'), true);
});

test('at most one attempt per 60 s across expiry and unknown-kid triggers', async () => {
  const { clock, fetches, keySet } = harness([
    ok([jwkOf(rsa2048, { kid: 'k1' })], 'max-age=60'),
    ok([jwkOf(rsa2048, { kid: 'k1' })], 'max-age=60'),
  ]);
  await keySet.current(); // attempt 1 at t0
  clock.ms += 30_000;
  await keySet.refreshForUnknownKid(); // barred
  await keySet.refreshForUnknownKid(); // barred
  clock.ms += 30_000; // t0 + 60 s: expiry and budget coincide
  await keySet.current(); // attempt 2
  await keySet.refreshForUnknownKid(); // barred again
  assert.equal(fetches.length, 2);
});

test('a failed unknown-kid refetch keeps the unexpired cache', async () => {
  const { clock, keySet } = harness([
    ok([jwkOf(rsa2048, { kid: 'k1' })], 'max-age=3600'),
    new Error('outage'),
  ]);
  await keySet.current();
  clock.ms += 60_000;
  const afterFailure = await keySet.refreshForUnknownKid();
  assert.equal(afterFailure.has('k1'), true, 'a failed refetch dropped a working cache');
  assert.equal((await keySet.current()).has('k1'), true);
});

test('a barred caller with no unexpired cache gets null and starts no fetch', async () => {
  const { clock, fetches, keySet } = harness([new Error('outage')]);
  assert.equal(await keySet.current(), null);
  clock.ms += 59_999;
  assert.equal(await keySet.current(), null);
  assert.equal(await keySet.refreshForUnknownKid(), null);
  assert.equal(fetches.length, 1);
});

test('a fetch that throws synchronously does not wedge the budget', async () => {
  const clock = { ms: 0 };
  let calls = 0;
  const keySet = createKeySet({
    now: () => clock.ms,
    fetchKeySet: () => {
      calls += 1;
      if (calls === 1) throw new Error('sync failure');
      return Promise.resolve(ok([jwkOf(rsa2048, { kid: 'k1' })]));
    },
  });
  assert.equal(await keySet.current(), null);
  clock.ms += 60_000;
  assert.equal((await keySet.current()).has('k1'), true);
});

test('kty other than RSA, a modulus under 2048, use other than sig, alg other than RS256 are dropped', () => {
  const keys = parseKeySet(
    body([
      jwkOf(rsa2048, { kid: 'good' }),
      { ...ec.publicKey.export({ format: 'jwk' }), kid: 'ec' },
      jwkOf(rsa1024, { kid: 'short' }),
      jwkOf(rsa2048, { kid: 'enc', use: 'enc' }),
      jwkOf(rsa2048, { kid: 'ps', alg: 'PS256' }),
      jwkOf(rsa2048, { kid: 'hs', alg: 'HS256' }),
      { kty: 'RSA', kid: 'broken', n: 'AQAB', e: 'AQAB' },
      { kty: 'oct', kid: 'sym', k: 'c2VjcmV0' },
      jwkOf(rsa2048, { kid: '' }),
      jwkOf(rsa2048, { kid: 'x'.repeat(257) }),
      'not an object',
      null,
    ]),
  );
  assert.deepEqual([...keys.keys()], ['good']);
});

test('use and alg may be absent, and the key is still usable', () => {
  const { use, alg, ...bare } = jwkOf(rsa2048, { kid: 'bare' });
  assert.equal(use, 'sig');
  assert.equal(alg, 'RS256');
  assert.deepEqual([...parseKeySet(body([bare])).keys()], ['bare']);
});

test('a duplicate kid drops both keys', () => {
  const keys = parseKeySet(
    body([
      jwkOf(rsa2048, { kid: 'dup' }),
      jwkOf(rsa2048b, { kid: 'dup' }),
      jwkOf(rsa2048b, { kid: 'dup' }),
      jwkOf(rsa2048, { kid: 'other' }),
    ]),
  );
  assert.deepEqual([...keys.keys()], ['other']);
});

test('private key members are never imported', () => {
  const privateJwk = { ...rsa2048.privateKey.export({ format: 'jwk' }), kid: 'priv' };
  const keys = parseKeySet(body([privateJwk]));
  assert.equal(keys.get('priv').type, 'public');
});

test('a kid of __proto__ is an ordinary entry in a Map, never a prototype lookup', () => {
  const keys = parseKeySet(body([jwkOf(rsa2048, { kid: 'k1' })]));
  assert.equal(keys.get('__proto__'), undefined);
  assert.equal(keys.get('constructor'), undefined);
});

test('an empty usable set, a non-JSON body or a missing keys array is a failed fetch', async () => {
  for (const bad of [
    Buffer.from(JSON.stringify({ keys: [] })),
    Buffer.from(JSON.stringify({ keys: [jwkOf(rsa1024, { kid: 'short' })] })),
    Buffer.from('<html>not json</html>'),
    Buffer.from(JSON.stringify({ notkeys: [] })),
    Buffer.from(JSON.stringify([])),
    Buffer.from('null'),
  ]) {
    assert.equal(parseKeySet(bad), null);
    const { keySet } = harness([{ body: bad, cacheControl: 'max-age=3600' }]);
    assert.equal(await keySet.current(), null);
  }
});

test('constructing a key set fetches nothing', async () => {
  let fetched = false;
  createKeySet({
    fetchKeySet: async () => {
      fetched = true;
      return ok([]);
    },
  });
  await Promise.resolve();
  assert.equal(fetched, false);
});
