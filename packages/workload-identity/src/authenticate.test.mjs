import assert from 'node:assert/strict';
import { constants, generateKeyPairSync, sign as rsaSign } from 'node:crypto';
import test from 'node:test';
import {
  checkClaimFormats,
  checkRegisteredClaims,
  createAuthenticator,
  submittedBy,
} from './authenticate.mjs';
import { createKeySet } from './key-set.mjs';

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

// Steps 1-5 of ADR-0003's validation order, one test per refusal. Every key is generated here;
// every token is signed here; the key set is fed by an injected fetch and the clock is injected,
// so nothing reaches the network or depends on the wall clock.

const ISSUER = 'https://token.actions.githubusercontent.com';
const AUDIENCE = 'urn:codeaiforge:sdlc-control-plane:production';
const START_MS = Date.UTC(2026, 9, 7, 12, 0, 0);

const signing = generateKeyPairSync('rsa', { modulusLength: 2048 });
const rotated = generateKeyPairSync('rsa', { modulusLength: 2048 });
const attacker = generateKeyPairSync('rsa', { modulusLength: 2048 });

const jwkOf = (pair, kid) => ({
  ...pair.publicKey.export({ format: 'jwk' }),
  kid,
  use: 'sig',
  alg: 'RS256',
});

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

// The ~15-line inline signer the design calls for. `padding` is a parameter so the PSS test can
// sign the same input another way.
function sign(
  header,
  claims,
  privateKey = signing.privateKey,
  padding = constants.RSA_PKCS1_PADDING,
) {
  const input = `${b64(header)}.${b64(claims)}`;
  const signature = rsaSign('sha256', Buffer.from(input), { key: privateKey, padding });
  return `${input}.${signature.toString('base64url')}`;
}

const ABSENT = Symbol('absent');

// A token's claims at a given clock, shaped by MEASURED. An override of ABSENT deletes a claim.
function claimsAt(nowMs, overrides = {}) {
  const iat = Math.floor(nowMs / 1000);
  const base = {
    jti: 'jti-1',
    sub: 'repo:CANARY-SUB-owner/CANARY-SUB-repo:ref:refs/heads/main',
    aud: AUDIENCE,
    ref: 'refs/heads/main',
    sha: MEASURED.sha,
    repository: 'CANARY-REPOSITORY-owner/CANARY-REPOSITORY-repo',
    repository_owner: 'CANARY-OWNER',
    repository_owner_id: '65',
    repository_id: '74',
    run_id: MEASURED.run_id,
    run_number: '7',
    run_attempt: MEASURED.run_attempt,
    actor: 'CANARY-ACTOR',
    actor_id: MEASURED.actor_id,
    workflow: 'gate',
    workflow_ref: 'owner/repo/.github/workflows/gate.yml@refs/heads/main',
    event_name: 'push',
    ref_type: 'branch',
    iss: ISSUER,
    nbf: iat - MEASURED.nbf_before_iat_s,
    exp: iat + MEASURED.lifetime_s,
    iat,
  };
  if (MEASURED.job_workflow_claims_outside_reusable) {
    base.job_workflow_ref = base.workflow_ref;
    base.job_workflow_sha = MEASURED.job_workflow_sha;
  }
  const claims = { ...base, ...overrides };
  for (const [key, value] of Object.entries(claims)) if (value === ABSENT) delete claims[key];
  return claims;
}

function setup({ keys = [jwkOf(signing, 'k1')], fetchKeySet } = {}) {
  const clock = { ms: START_MS };
  const fetches = [];
  let served = keys;
  const keySet = createKeySet({
    now: () => clock.ms,
    fetchKeySet:
      fetchKeySet ??
      (async (...args) => {
        fetches.push(args);
        return {
          body: Buffer.from(JSON.stringify({ keys: served })),
          cacheControl: 'max-age=3600',
        };
      }),
  });
  const authenticate = createAuthenticator({ keySet, now: () => clock.ms });
  return {
    clock,
    fetches,
    authenticate,
    rotate: (next) => {
      served = next;
    },
    token: (overrides, header = { alg: 'RS256', kid: 'k1', typ: 'JWT' }, key, padding) =>
      sign(header, claimsAt(clock.ms, overrides), key, padding),
  };
}

const bearer = (token) => ({ rawHeaders: ['Authorization', `Bearer ${token}`] });

const refusedWith = async (authenticate, request, status, reason) => {
  const result = await authenticate(request);
  assert.deepEqual(result, { ok: false, status, reason });
};

test('a well-formed token is accepted and yields a frozen principal of verified claims', async () => {
  const { authenticate, token } = setup();
  const result = await authenticate(bearer(token()));
  assert.equal(result.ok, true);
  assert.equal(Object.isFrozen(result.principal), true);
  assert.deepEqual(result.principal, {
    issuer: ISSUER,
    repository_owner_id: '65',
    repository_id: '74',
    actor_id: MEASURED.actor_id,
    run_id: MEASURED.run_id,
    run_attempt: MEASURED.run_attempt,
    sha: MEASURED.sha,
    ref: 'refs/heads/main',
    event_name: 'push',
    workflow_ref: 'owner/repo/.github/workflows/gate.yml@refs/heads/main',
    job_workflow_ref: MEASURED.job_workflow_claims_outside_reusable
      ? 'owner/repo/.github/workflows/gate.yml@refs/heads/main'
      : null,
    job_workflow_sha: MEASURED.job_workflow_claims_outside_reusable
      ? MEASURED.job_workflow_sha
      : null,
  });
});

// ------------------------------------------------------------------------------------- step 1

test('step 1: no Authorization header is 401 invalid_token', async () => {
  const { authenticate, fetches } = setup();
  await refusedWith(authenticate, { rawHeaders: [] }, 401, 'credential-missing');
  await refusedWith(authenticate, { rawHeaders: ['Cookie', 'token=x'] }, 401, 'credential-missing');
  await refusedWith(authenticate, {}, 401, 'credential-missing');
  assert.equal(fetches.length, 0, 'step 1 refusals must not reach the key set');
});

test('step 1: a repeated Authorization, visible only in rawHeaders, is 401', async () => {
  const { authenticate, token } = setup();
  const good = token();
  // request.headers keeps only the first; rawHeaders keeps both, and that is what is counted.
  const request = {
    headers: { authorization: `Bearer ${good}` },
    rawHeaders: ['authorization', `Bearer ${good}`, 'AUTHORIZATION', `Bearer ${good}`],
  };
  await refusedWith(authenticate, request, 401, 'credential-repeated');
});

test('step 1: bearer is read in any case and another scheme is 401', async () => {
  const { authenticate, token } = setup();
  const good = token();
  for (const scheme of ['Bearer', 'bearer', 'BEARER', 'bEaReR']) {
    const result = await authenticate({ rawHeaders: ['Authorization', `${scheme} ${good}`] });
    assert.equal(result.ok, true, scheme);
  }
  for (const value of [
    `Basic ${good}`,
    `Token ${good}`,
    `Bearer`,
    `Bearer `,
    `${good}`,
    `Bearer ${good} extra`,
    `Bearer\t${good}`,
    `Bearer:${good}`,
  ]) {
    await refusedWith(
      authenticate,
      { rawHeaders: ['Authorization', value] },
      401,
      'credential-malformed',
    );
  }
});

test('step 1: a token of 8193 bytes is 401 before any decode, 8192 is read', async () => {
  const { authenticate, token, fetches } = setup();
  // Pad a claim until the compact token is exactly 8192 bytes. An unpadded base64url segment is
  // never 1 mod 4 characters long, so one padded segment cannot reach every total: the header
  // gets a padding member too, and some pair of lengths lands on the boundary exactly.
  let exact;
  for (let headerPad = 0; headerPad < 4 && exact === undefined; headerPad += 1) {
    const header = { alg: 'RS256', kid: 'k1', typ: 'JWT', x: 'h'.repeat(headerPad) };
    // Token length only grows with the padding, so the walk stops once it passes 8192.
    for (let pad = 3000; exact === undefined; pad += 1) {
      const candidate = token({ padding: 'p'.repeat(pad) }, header);
      if (candidate.length === 8192) exact = candidate;
      if (candidate.length > 8192) break;
    }
  }
  assert.ok(exact, 'no padding produced a token of exactly 8192 bytes');
  assert.equal((await authenticate(bearer(exact))).ok, true);
  const before = fetches.length;
  await refusedWith(authenticate, bearer(`${exact}A`), 401, 'token-too-large');
  await refusedWith(authenticate, bearer('x'.repeat(8193)), 401, 'token-too-large');
  // Multi-byte characters count as bytes, not as UTF-16 code units.
  await refusedWith(authenticate, bearer('é'.repeat(4097)), 401, 'token-too-large');
  assert.equal(fetches.length, before);
});

test('step 1: two or four segments, or a non-base64url byte, is 401', async () => {
  const { authenticate, token } = setup();
  const [h, p, s] = token().split('.');
  for (const malformed of [
    `${h}.${p}`,
    `${h}.${p}.${s}.${s}`,
    `${h}.${p}.${s}!`,
    `${h}.${p}.${s}=`,
    `${h}.%.${s}`,
  ]) {
    await refusedWith(authenticate, bearer(malformed), 401, 'credential-malformed');
  }
});

test('step 1: non-canonical base64url is 401', async () => {
  const { authenticate, token } = setup();
  const [h, p, s] = token().split('.');
  // Pad each segment to a length that leaves unused low bits in its final character, then flip
  // one of them: the lenient decoder reads the same bytes, the round-trip refuses it.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const tweak = (segment) => {
    const last = alphabet.indexOf(segment.at(-1));
    return segment.slice(0, -1) + alphabet[last ^ 1];
  };
  for (const [name, segment] of [
    ['payload', p],
    ['signature', s],
  ]) {
    if (segment.length % 4 === 0) continue; // no unused bits to flip
    const bad = tweak(segment);
    assert.deepEqual(Buffer.from(bad, 'base64url'), Buffer.from(segment, 'base64url'), name);
    const token = name === 'payload' ? `${h}.${bad}.${s}` : `${h}.${p}.${bad}`;
    await refusedWith(authenticate, bearer(token), 401, 'credential-malformed');
  }
});

test('step 1: a header with no alg, no kid, an empty or 257-char kid, or crit is 401', async () => {
  const { authenticate, token } = setup();
  for (const header of [
    { kid: 'k1' },
    { alg: 'RS256' },
    { alg: 'RS256', kid: '' },
    { alg: 'RS256', kid: 'k'.repeat(257) },
    { alg: 'RS256', kid: 7 },
    { alg: 7, kid: 'k1' },
    { alg: 'RS256', kid: 'k1', crit: ['exp'] },
    { alg: 'RS256', kid: 'k1', crit: [] },
  ]) {
    await refusedWith(authenticate, bearer(token({}, header)), 401, 'header-invalid');
  }
  // 256 characters is the limit, not past it.
  const result = await authenticate(bearer(token({}, { alg: 'RS256', kid: 'k'.repeat(256) })));
  assert.deepEqual(result, { ok: false, status: 401, reason: 'kid-unknown' });
});

test('step 1: a header that is an array or not JSON is 401', async () => {
  const { authenticate, token } = setup();
  const [, p, s] = token().split('.');
  for (const header of [
    Buffer.from('[1,2]').toString('base64url'),
    Buffer.from('{not json').toString('base64url'),
    Buffer.from('"RS256"').toString('base64url'),
    Buffer.from('null').toString('base64url'),
  ]) {
    await refusedWith(authenticate, bearer(`${header}.${p}.${s}`), 401, 'credential-malformed');
  }
});

// ------------------------------------------------------------------------------------- step 2

test('step 2: no cached key set and a failed fetch is 503', async () => {
  const { authenticate, token } = setup({
    fetchKeySet: async () => {
      throw new Error('outage');
    },
  });
  await refusedWith(authenticate, bearer(token()), 503, 'key-set-unavailable');
});

test('step 2: step order — an HS256 token with no key set is 503, not 401', async () => {
  const { authenticate, token } = setup({
    fetchKeySet: async () => {
      throw new Error('outage');
    },
  });
  await refusedWith(
    authenticate,
    bearer(token({}, { alg: 'HS256', kid: 'k1' })),
    503,
    'key-set-unavailable',
  );
});

// ------------------------------------------------------------------------------------- step 3

test('step 3: none, HS256, ES256 and PS256 are 401', async () => {
  const { authenticate, token } = setup();
  for (const alg of ['none', 'HS256', 'ES256', 'PS256', 'RS384', 'rs256', 'RS256 ']) {
    await refusedWith(authenticate, bearer(token({}, { alg, kid: 'k1' })), 401, 'alg-unsupported');
  }
});

test('step 3: an unknown kid refetches once and is then 401', async () => {
  const { authenticate, token, fetches, clock } = setup();
  await authenticate(bearer(token())); // first fetch
  clock.ms += 60_000; // the budget allows one more attempt
  const before = fetches.length;
  await refusedWith(
    authenticate,
    bearer(token({}, { alg: 'RS256', kid: 'k9' })),
    401,
    'kid-unknown',
  );
  assert.equal(fetches.length, before + 1, 'an unknown kid did not refetch exactly once');
  await refusedWith(
    authenticate,
    bearer(token({}, { alg: 'RS256', kid: 'k9' })),
    401,
    'kid-unknown',
  );
  assert.equal(fetches.length, before + 1, 'a second unknown kid refetched inside the budget');
});

test('step 3: a key rotated in is found by the unknown-kid refetch', async () => {
  const { authenticate, token, clock, rotate } = setup();
  await authenticate(bearer(token()));
  rotate([jwkOf(signing, 'k1'), jwkOf(rotated, 'k2')]);
  clock.ms += 60_000;
  const result = await authenticate(
    bearer(token({}, { alg: 'RS256', kid: 'k2' }, rotated.privateKey)),
  );
  assert.equal(result.ok, true);
});

test('step 3: kid __proto__ and constructor find no key and are 401', async () => {
  const { authenticate, token } = setup();
  for (const kid of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    await refusedWith(authenticate, bearer(token({}, { alg: 'RS256', kid })), 401, 'kid-unknown');
  }
});

test('step 3: a signature from another key, or a flipped bit, is 401', async () => {
  const { authenticate, token } = setup();
  await refusedWith(
    authenticate,
    bearer(token({}, undefined, attacker.privateKey)),
    401,
    'signature-invalid',
  );
  const [h, p, s] = token().split('.');
  const bytes = Buffer.from(s, 'base64url');
  bytes[0] ^= 0x80;
  await refusedWith(
    authenticate,
    bearer(`${h}.${p}.${bytes.toString('base64url')}`),
    401,
    'signature-invalid',
  );
  // A payload edited after signing: the signature no longer covers it.
  const forged = b64({ ...claimsAt(START_MS), repository_id: '75' });
  await refusedWith(authenticate, bearer(`${h}.${forged}.${s}`), 401, 'signature-invalid');
});

test('step 3: jku, jwk, x5u, x5c and x5t are ignored, never fetched', async () => {
  const { authenticate, token, fetches } = setup();
  const embedded = {
    alg: 'RS256',
    kid: 'k1',
    jku: 'https://attacker.invalid/jwks',
    x5u: 'https://attacker.invalid/cert',
    jwk: jwkOf(attacker, 'k1'),
    x5c: ['MIIB'],
    x5t: 'thumbprint',
  };
  // Signed by the attacker's key it names inline: refused, because the key comes from the pinned
  // set only.
  await refusedWith(
    authenticate,
    bearer(token({}, embedded, attacker.privateKey)),
    401,
    'signature-invalid',
  );
  // Signed by the real key with the same header members: accepted, since GitHub's own header
  // carries x5t and they must not be refused.
  assert.equal((await authenticate(bearer(token({}, embedded)))).ok, true);
  for (const args of fetches) assert.deepEqual(args, [], 'the fetch was handed a header URL');
});

test('step 3: a PSS-padded signature over the same input is 401', async () => {
  const { authenticate, token } = setup();
  const pss = token({}, undefined, signing.privateKey, constants.RSA_PKCS1_PSS_PADDING);
  await refusedWith(authenticate, bearer(pss), 401, 'signature-invalid');
});

// ------------------------------------------------------------------------------------- step 4

test('step 4: iss with a trailing slash is 401', async () => {
  const { authenticate, token } = setup();
  for (const iss of [
    `${ISSUER}/`,
    'https://token.actions.githubusercontent.com:443',
    'HTTPS://token.actions.githubusercontent.com',
    'https://gitlab.com',
    ABSENT,
  ]) {
    await refusedWith(authenticate, bearer(token({ iss })), 401, 'iss-mismatch');
  }
});

test('step 4: the default owner-URL audience is 401', async () => {
  const { authenticate, token } = setup();
  for (const aud of ['https://github.com/owner', `${AUDIENCE}:staging`, '', ABSENT, [], 42]) {
    await refusedWith(authenticate, bearer(token({ aud })), 401, 'aud-mismatch');
  }
});

test('step 4: a two-element aud is 401 and a one-element array is accepted', async () => {
  const { authenticate, token } = setup();
  await refusedWith(
    authenticate,
    bearer(token({ aud: [AUDIENCE, 'https://other.invalid'] })),
    401,
    'aud-mismatch',
  );
  await refusedWith(
    authenticate,
    bearer(token({ aud: [AUDIENCE, AUDIENCE] })),
    401,
    'aud-mismatch',
  );
  assert.equal((await authenticate(bearer(token({ aud: [AUDIENCE] })))).ok, true);
});

test('step 4: exp at now−60 is 401 and now−59 is accepted', async () => {
  const nowS = START_MS / 1000;
  const base = claimsAt(START_MS);
  const at = (exp) => checkRegisteredClaims({ ...base, exp, iat: exp - 300 }, nowS);
  assert.deepEqual(at(nowS - 60), { ok: false, status: 401, reason: 'token-expired' });
  assert.deepEqual(at(nowS - 59), { ok: true });
  // Through the authenticator as well, so the clock wiring is what is tested.
  const { authenticate, token } = setup();
  const iat = nowS - 300;
  await refusedWith(
    authenticate,
    bearer(token({ iat, nbf: iat, exp: nowS - 60 })),
    401,
    'token-expired',
  );
  assert.equal((await authenticate(bearer(token({ iat, nbf: iat, exp: nowS - 59 })))).ok, true);
});

test('step 4: nbf and iat beyond now+60 are 401', async () => {
  const nowS = START_MS / 1000;
  const base = { ...claimsAt(START_MS), exp: nowS + 300 };
  assert.deepEqual(checkRegisteredClaims({ ...base, nbf: nowS + 61 }, nowS), {
    ok: false,
    status: 401,
    reason: 'token-not-yet-valid',
  });
  assert.deepEqual(checkRegisteredClaims({ ...base, nbf: nowS + 60 }, nowS), { ok: true });
  assert.deepEqual(checkRegisteredClaims({ ...base, iat: nowS + 61 }, nowS), {
    ok: false,
    status: 401,
    reason: 'iat-in-future',
  });
  assert.deepEqual(checkRegisteredClaims({ ...base, iat: nowS + 60 }, nowS), { ok: true });
});

test('step 4: exp−iat of 901 is 401 and 900 is accepted', async () => {
  const nowS = START_MS / 1000;
  const base = claimsAt(START_MS);
  assert.deepEqual(checkRegisteredClaims({ ...base, iat: nowS, exp: nowS + 901 }, nowS), {
    ok: false,
    status: 401,
    reason: 'lifetime-exceeded',
  });
  assert.deepEqual(checkRegisteredClaims({ ...base, iat: nowS, exp: nowS + 900 }, nowS), {
    ok: true,
  });
});

test('step 4: exp, nbf or iat missing or a string is 401', async () => {
  const { authenticate, token } = setup();
  for (const claim of ['exp', 'nbf', 'iat']) {
    for (const value of [ABSENT, '1791374400', null, true, [1]]) {
      await refusedWith(authenticate, bearer(token({ [claim]: value })), 401, 'claim-invalid');
    }
  }
});

test('step 4: a payload that is not a JSON object is 401 after the signature verifies', async () => {
  const { authenticate } = setup();
  const header = b64({ alg: 'RS256', kid: 'k1' });
  for (const payload of ['[1]', '"text"', '{broken']) {
    const segment = Buffer.from(payload).toString('base64url');
    const input = `${header}.${segment}`;
    const signature = rsaSign('sha256', Buffer.from(input), {
      key: signing.privateKey,
      padding: constants.RSA_PKCS1_PADDING,
    });
    await refusedWith(
      authenticate,
      bearer(`${input}.${signature.toString('base64url')}`),
      401,
      'claim-invalid',
    );
  }
});

// ------------------------------------------------------------------------------------- step 5

const NINE_REQUIRED = [
  'repository_owner_id',
  'repository_id',
  'actor_id',
  'event_name',
  'run_id',
  'run_attempt',
  'sha',
  'ref',
  'workflow_ref',
];

test('step 5: each of the nine required claims, missing or empty, is 401', async () => {
  const { authenticate, token } = setup();
  for (const claim of NINE_REQUIRED) {
    for (const value of [ABSENT, '', null, 7, {}]) {
      await refusedWith(authenticate, bearer(token({ [claim]: value })), 401, 'claim-invalid');
    }
  }
});

test("step 5: ids '074', '0', 74, '1e3' and 21 digits are 401", async () => {
  const valid = claimsAt(START_MS);
  for (const claim of ['repository_owner_id', 'repository_id', 'actor_id']) {
    for (const value of [
      '074',
      '0',
      74,
      '1e3',
      '1'.repeat(21),
      ' 74',
      '74 ',
      '+74',
      '-74',
      '7.4',
    ]) {
      assert.deepEqual(
        checkClaimFormats({ ...valid, [claim]: value }),
        { ok: false, status: 401, reason: 'claim-invalid' },
        `${claim}: ${JSON.stringify(value)}`,
      );
    }
    assert.equal(checkClaimFormats({ ...valid, [claim]: '1'.repeat(20) }).ok, true);
  }
});

test('step 5: run_id and run_attempt that are not canonical positive integers are 401', () => {
  const valid = claimsAt(START_MS);
  for (const claim of ['run_id', 'run_attempt']) {
    for (const value of ['0', '01', '-1', '1.0', 'example-run-id', 1, ' 1']) {
      assert.equal(checkClaimFormats({ ...valid, [claim]: value }).ok, false, `${claim}: ${value}`);
    }
  }
});

test('step 5: sha uppercase or 39 chars is 401', () => {
  const valid = claimsAt(START_MS);
  for (const sha of [
    'A'.repeat(40),
    'a'.repeat(39),
    'a'.repeat(41),
    'example-sha',
    'g'.repeat(40),
  ]) {
    assert.equal(checkClaimFormats({ ...valid, sha }).ok, false, sha);
  }
});

test('step 5: job_workflow_* present but not a string, or a bad sha, is 401', () => {
  const valid = claimsAt(START_MS);
  for (const value of ['', null, 7, {}]) {
    assert.equal(checkClaimFormats({ ...valid, job_workflow_ref: value }).ok, false);
  }
  for (const value of ['', null, 'B'.repeat(40), 'b'.repeat(39), 7]) {
    assert.equal(checkClaimFormats({ ...valid, job_workflow_sha: value }).ok, false);
  }
  const pinned = checkClaimFormats({
    ...valid,
    job_workflow_ref: 'owner/repo/.github/workflows/mint.yml@refs/heads/main',
    job_workflow_sha: MEASURED.job_workflow_sha,
  });
  assert.equal(pinned.principal.job_workflow_sha, MEASURED.job_workflow_sha);
});

test('step 5: absent job_workflow_* become null', () => {
  const { job_workflow_ref: _r, job_workflow_sha: _s, ...without } = claimsAt(START_MS);
  const { principal } = checkClaimFormats(without);
  assert.equal(principal.job_workflow_ref, null);
  assert.equal(principal.job_workflow_sha, null);
});

test('step 5: an inherited claim (prototype) is not present', () => {
  const inherited = Object.create(claimsAt(START_MS));
  assert.equal(inherited.repository_id, '74', 'the fixture must be readable through the chain');
  assert.deepEqual(checkClaimFormats(inherited), {
    ok: false,
    status: 401,
    reason: 'claim-invalid',
  });
  const partial = Object.assign(Object.create({ job_workflow_sha: 'c'.repeat(40) }), {
    ...claimsAt(START_MS),
  });
  delete partial.job_workflow_sha;
  assert.equal(checkClaimFormats(partial).principal.job_workflow_sha, null);
});

// ------------------------------------------------------------------- defensive and AC-11 side

test('a verifier that throws is 503 and logs no error text', async () => {
  const keySet = {
    current: async () => {
      throw new Error('CANARY-ERROR-TEXT');
    },
    refreshForUnknownKid: async () => null,
  };
  const authenticate = createAuthenticator({ keySet, now: () => START_MS });
  const { token } = setup();
  const result = await authenticate(bearer(token()));
  assert.deepEqual(result, { ok: false, status: 503, reason: 'verifier-fault' });
  assert.doesNotMatch(JSON.stringify(result), /CANARY/);
});

test('no refusal carries anything but ok, status and reason', async () => {
  const { authenticate, token } = setup();
  const t = token({ repository_id: 'CANARY' });
  const result = await authenticate(bearer(t));
  assert.deepEqual(Object.keys(result).sort(), ['ok', 'reason', 'status']);
  assert.doesNotMatch(JSON.stringify(result), /CANARY/);
});

test("submittedBy has exactly ADR-0004's eleven keys, in its order, from verified claims", async () => {
  const { authenticate, token } = setup();
  const { principal } = await authenticate(bearer(token()));
  const recorded = submittedBy(principal);
  assert.deepEqual(Object.keys(recorded), [
    'issuer',
    'repository_owner_id',
    'repository_id',
    'run_id',
    'run_attempt',
    'sha',
    'ref',
    'event_name',
    'workflow_ref',
    'job_workflow_ref',
    'job_workflow_sha',
  ]);
  for (const [key, value] of Object.entries(recorded)) assert.equal(value, principal[key], key);
});

test('sub, repository and actor never reach submitted_by', async () => {
  const { authenticate, token } = setup();
  const { principal } = await authenticate(bearer(token()));
  const text = JSON.stringify(submittedBy(principal));
  assert.doesNotMatch(text, /CANARY/);
  assert.equal(Object.hasOwn(submittedBy(principal), 'actor_id'), false);
});
