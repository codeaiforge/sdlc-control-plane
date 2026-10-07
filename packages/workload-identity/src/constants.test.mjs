import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import * as constants from './constants.mjs';

// AC-3. Literals spelled out, never derived from the module under test: a change to any of them
// is exactly what these assertions exist to notice. The accepted-issuer set lives in
// packages/contracts and is not compared here, because importing it would add an edge onto that
// project; main.test.mjs pins the agreement of the two copies at the seam, where the startup
// check that enforces it lives.
test('issuer, jwks_uri, audience and refused actors are exact frozen literals', () => {
  assert.equal(constants.ISSUER, 'https://token.actions.githubusercontent.com');
  assert.equal(constants.JWKS_URI, 'https://token.actions.githubusercontent.com/.well-known/jwks');
  assert.equal(constants.AUDIENCE, 'urn:codeaiforge:sdlc-control-plane:production');
  assert.deepEqual(constants.REFUSED_ACTOR_IDS, ['49699333']);
  assert.equal(Object.isFrozen(constants.REFUSED_ACTOR_IDS), true);
  assert.throws(() => constants.REFUSED_ACTOR_IDS.push('1'), TypeError);
});

test('every limit is the reviewed literal', () => {
  assert.equal(constants.CLOCK_SKEW_S, 60);
  assert.equal(constants.MAX_LIFETIME_S, 900);
  assert.equal(constants.MAX_TOKEN_BYTES, 8192);
  assert.equal(constants.MAX_KID_LENGTH, 256);
  assert.equal(constants.JWKS_TIMEOUT_MS, 5000);
  assert.equal(constants.JWKS_MAX_BYTES, 65536);
  assert.equal(constants.JWKS_MIN_TTL_S, 60);
  assert.equal(constants.JWKS_MAX_TTL_S, 3600);
  assert.equal(constants.JWKS_MIN_FETCH_INTERVAL_MS, 60000);
});

test('the refused-actor rule compares canonical strings, never numbers', () => {
  assert.equal(constants.isRefusedActor('49699333'), true);
  // A number never equals the string claim; a refusal that accepted one would fail open on the
  // day a caller started comparing numbers.
  assert.equal(constants.isRefusedActor(49699333), false);
  assert.equal(constants.isRefusedActor('049699333'), false);
  assert.equal(constants.isRefusedActor('1'), false);
});

// The environment is reached by more than one spelling. Each probe below is a way a later edit
// could read a variable without writing `process.env`; any mention of `process` in code at all
// is refused, because no module in this package has a reason to touch it. Comments are stripped
// first so that prose ("for the whole process") is not mistaken for a read: a block comment, and
// a line comment that starts the line or follows whitespace - never the `//` inside a URL.
const ENV_SPELLINGS = [
  /\bprocess\b/,
  /['"]node:process['"]/,
  /\bgetenv\b/i,
  /\benv\s*\}\s*=/,
  /import\.meta\.env/,
];
const codeOf = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');

test('no non-test module in workload-identity reads process.env', () => {
  const sources = readdirSync(new URL('.', import.meta.url)).filter(
    (file) => file.endsWith('.mjs') && !file.endsWith('.test.mjs'),
  );
  assert.deepEqual(sources.sort(), [
    'authenticate.mjs',
    'constants.mjs',
    'https-transport.mjs',
    'jws.mjs',
    'key-set.mjs',
  ]);
  for (const file of sources) {
    const code = codeOf(readFileSync(new URL(file, import.meta.url), 'utf8'));
    for (const spelling of ENV_SPELLINGS)
      assert.doesNotMatch(code, spelling, `${file} reaches the environment via ${spelling}`);
  }
});

test('the environment probes catch each spelling they name, and comments hide none of them', () => {
  // Guards on the guard: a probe list that matched nothing would leave the test above green, and
  // a comment stripper that ate code would hide a read behind it.
  const bypasses = [
    'const x = process.env.ISSUER;',
    "const x = process['env'].ISSUER;",
    "const x = Reflect.get(process, 'env');",
    "import { env } from 'node:process';",
    'const { env } = globalThis.process;',
    'const x = import.meta.env.ISSUER;',
    "const url = 'https://example.invalid'; const x = process.env.X;",
  ];
  for (const bypass of bypasses)
    assert.ok(
      ENV_SPELLINGS.some((spelling) => spelling.test(codeOf(bypass))),
      `no probe catches: ${bypass}`,
    );
  assert.equal(
    ENV_SPELLINGS.some((spelling) => spelling.test(codeOf('// for the whole process.\n'))),
    false,
  );
});
