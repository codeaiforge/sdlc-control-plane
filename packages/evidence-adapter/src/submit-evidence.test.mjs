import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test, { after } from 'node:test';
import * as adapter from './submit-evidence.mjs';

const {
  AUDIENCE,
  EXIT,
  MAX_EVIDENCE_BYTES,
  allowedTarget,
  createTransport,
  display,
  main,
  mintToken,
  submitEvidence,
} = adapter;

// The adapter against loopback stub servers - a stand-in for the runner's ID-token endpoint and a
// stand-in for the control plane, both real node:http sockets on 127.0.0.1 that count requests
// and keep what they were sent - and, where a socket cannot show it, against an injected
// transport or request function. Time is injected: no test here sleeps for a backoff.

const SCRIPT = new URL('./submit-evidence.mjs', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'submit-evidence-'));
after(() => rmSync(dir, { recursive: true, force: true }));

// Every credential in this file carries a canary, and every output any test produces is collected
// here so the last test can show none of them ever left a request (AC-5).
const REQUEST_TOKEN = `REQUEST-TOKEN-CANARY-${randomBytes(12).toString('hex')}`;
const minted = [];
const outputs = [];
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
function newToken() {
  const signature = `SIGCANARY${randomBytes(30).toString('base64url')}`;
  const token = `${b64({ alg: 'RS256', kid: 'k1' })}.${b64({ n: minted.length })}.${signature}`;
  minted.push(token);
  return token;
}

let records = 0;
function recordFile(value = { schema_version: 'evidence/0', change_id: 'PR-7@abc/1.1' }) {
  const path = join(dir, `evidence-${(records += 1)}.json`);
  writeFileSync(
    path,
    typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value),
  );
  return path;
}

// A loopback server that answers every request with `answer(request, body, index)`; the answer
// writes the response itself. Requests are kept with their headers and exact bytes.
async function stub(t, answer) {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      requests.push({ method: request.method, url: request.url, headers: request.headers, body });
      answer(request, response, body, requests.length - 1);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, requests, server };
}

const json = (response, status, body, headers = {}) => {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
};

// The runner's ID-token endpoint: {"value": <a fresh canary token>} for every request.
const tokenEndpoint = (
  t,
  answer = (request, response) => json(response, 200, { value: newToken() }),
) => stub(t, answer);

const DECISION = {
  accepted: true,
  disposition: 'accepted',
  policy_id: 'test-policy@1',
  reasons: [],
  evidence_attestation: 'self-attested',
};

// A control plane that answers the n-th POST with statuses[n] (the last one repeats). A status of
// 'drop' destroys the socket before any answer.
const controlPlane = (t, statuses, { headers = {}, body } = {}) =>
  stub(t, (request, response, received, index) => {
    const status = statuses[Math.min(index, statuses.length - 1)];
    if (status === 'drop') return request.socket.destroy();
    const answer =
      body?.(request, index) ??
      (status === 202 || status === 422
        ? {
            decision:
              status === 202
                ? DECISION
                : {
                    ...DECISION,
                    accepted: false,
                    disposition: 'needs-remediation',
                    reasons: ['tier T3 is blocked by policy'],
                  },
          }
        : status === 409
          ? { error: 'conflict', idempotency_key: '["fixture","PR-7"]' }
          : { error: 'refused' });
    json(response, status, answer, typeof headers === 'function' ? headers(index) : headers);
  });

// main() with everything a test can see: stdout, the summary file, the exit code, and the waits
// it asked for. random is pinned to 0 unless the test says otherwise.
async function run({ endpoint, mintUrl, path = recordFile(), env = {}, ...deps }) {
  let stdout = '';
  const summary = join(dir, `summary-${(records += 1)}.md`);
  const waits = [];
  const code = await main({
    argv: [path],
    env: {
      ACTIONS_ID_TOKEN_REQUEST_URL: mintUrl,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: REQUEST_TOKEN,
      GITHUB_STEP_SUMMARY: summary,
      ...env,
    },
    endpoint,
    stdout: { write: (text) => (stdout += text) },
    sleep: async (ms) => waits.push(ms),
    random: () => 0,
    ...deps,
  });
  let summaryText = '';
  try {
    summaryText = readFileSync(summary, 'utf8');
  } catch {
    // main wrote no summary.
  }
  outputs.push(stdout, summaryText);
  return { code, stdout, summary: summaryText, waits };
}

async function scene(t, statuses, options = {}) {
  const mint = await tokenEndpoint(t);
  const plane = await controlPlane(t, statuses, options);
  const result = await run({
    endpoint: `${plane.base}/v1/evidence`,
    mintUrl: `${mint.base}/token?api-version=2.0`,
    ...options.run,
  });
  return { ...result, mint, plane };
}

// ------------------------------------------------------------------------------- literals

test('the reviewed constants are the design literals', () => {
  assert.equal(adapter.AUDIENCE, 'urn:codeaiforge:sdlc-control-plane:production');
  assert.equal(adapter.CONTROL_PLANE_ENDPOINT, null);
  assert.equal(adapter.MAX_EVIDENCE_BYTES, 1048576);
  assert.equal(adapter.MAX_TOKEN_BYTES, 8192);
  assert.equal(adapter.MAX_RESPONSE_BYTES, 65536);
  assert.equal(adapter.MAX_ATTEMPTS, 4);
  assert.equal(adapter.BACKOFF_BASE_MS, 2000);
  assert.equal(adapter.MAX_RETRY_AFTER_S, 60);
  assert.equal(adapter.MINT_TIMEOUT_MS, 10000);
  assert.equal(adapter.SUBMIT_TIMEOUT_MS, 40000);
  assert.equal(adapter.TOTAL_BUDGET_MS, 150000);
  assert.deepEqual(
    { ...EXIT },
    { ACCEPTED: 0, NOT_ACCEPTED: 1, LOCAL: 2, NO_RECORD: 3, REFUSED: 4, UNAVAILABLE: 5 },
  );
  assert.equal(Object.isFrozen(EXIT), true);
});

// ------------------------------------------------------------------------- U1 status table

test('U1 every status maps to its outcome after exactly one mint and one POST', async (t) => {
  const elsewhere = await stub(t, (request, response) => json(response, 200, {}));
  const cases = [
    [202, EXIT.ACCEPTED, /202, disposition "accepted" under policy "test-policy@1"/],
    [422, EXIT.NOT_ACCEPTED, /422, disposition "needs-remediation".*not stored\. Reasons: tier T3/],
    [400, EXIT.REFUSED, /refused 400 /],
    [401, EXIT.REFUSED, /refused 401 \(the control plane refused the token\)/],
    [403, EXIT.REFUSED, /refused 403 \(no registration admits this run/],
    [409, EXIT.REFUSED, /refused 409 .*idempotency key "\["fixture","PR-7"\]"/],
    [413, EXIT.REFUSED, /refused 413 /],
    [301, EXIT.REFUSED, /refused 301 \(a redirect, never followed\)/],
    [418, EXIT.REFUSED, /refused 418 \(an answer this adapter does not handle\)/],
  ];
  for (const [status, exit, line] of cases) {
    const result = await scene(t, [status], {
      headers: { location: `${elsewhere.base}/v1/evidence` },
    });
    assert.equal(result.code, exit, String(status));
    assert.match(result.stdout, line, String(status));
    assert.equal(result.mint.requests.length, 1, `${status}: one mint`);
    assert.equal(result.plane.requests.length, 1, `${status}: one POST, never retried`);
    assert.equal(result.waits.length, 0);
  }
  assert.equal(elsewhere.requests.length, 0, 'a Location target is never requested');
});

test('U1 a 202 without a decision holding a string disposition is an answer it does not handle', async (t) => {
  for (const body of [
    '',
    '<html>',
    'null',
    '{}',
    '{"decision":null}',
    '{"decision":[]}',
    '{"decision":"accepted"}',
    '{"decision":{"policy_id":"p@1"}}',
    '{"decision":{"disposition":7}}',
  ]) {
    const mint = await tokenEndpoint(t);
    const plane = await stub(t, (request, response) => {
      response.writeHead(202, { 'content-type': 'application/json' });
      response.end(body);
    });
    const result = await run({ endpoint: `${plane.base}/v1/evidence`, mintUrl: `${mint.base}/t` });
    assert.equal(result.code, EXIT.REFUSED, body);
    assert.match(
      result.stdout,
      /refused 202 \(an answer this adapter does not handle\); it cannot tell whether anything was stored\./,
      body,
    );
    assert.doesNotMatch(result.stdout, /self-attested|disposition/, body);
    assert.equal(plane.requests.length, 1, `${body}: one POST, never retried`);
  }
});

test('U1 the POST carries exactly one bearer token and the record bytes, nothing added', async (t) => {
  const path = recordFile('{"change_id":"PR-7", "b": [1,2] }\n');
  const result = await scene(t, [202], { run: { path } });
  const [request] = result.plane.requests;
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/v1/evidence');
  assert.equal(request.headers.authorization, `Bearer ${minted.at(-1)}`);
  assert.equal(request.headers['content-type'], 'application/json');
  assert.equal(request.headers['content-length'], String(readFileSync(path).length));
  assert.equal(request.headers['user-agent'], 'sdlc-control-plane-evidence-adapter');
  assert.ok(request.body.equals(readFileSync(path)), 'the bytes are the file, unchanged');
});

// --------------------------------------------------------------------------------- U2 retry

test('U2 503, 503, 202: three attempts, three tokens, identical bytes, jittered backoff', async (t) => {
  for (const failure of [503, 502, 504, 'drop']) {
    let call = 0;
    const path = recordFile({ change_id: `PR-${failure}` });
    const result = await scene(t, [failure, failure, 202], {
      run: { path, random: () => [0, 1][call++] },
    });
    assert.equal(result.code, EXIT.ACCEPTED, String(failure));
    assert.equal(result.plane.requests.length, 3);
    assert.equal(result.mint.requests.length, 3, 're-minted for every attempt');
    const tokens = result.plane.requests.map((request) => request.headers.authorization);
    assert.equal(new Set(tokens).size, 3, 'three distinct tokens');
    for (const request of result.plane.requests)
      assert.ok(request.body.equals(readFileSync(path)), 'identical bytes every attempt');
    // Attempt 2 waits d=2000 * (0.5 + 0.5*0) = 1000; attempt 3 waits d=4000 * (0.5 + 0.5*1).
    assert.deepEqual(result.waits, [1000, 4000]);
    assert.match(result.stdout, /attempt 1 of 4: \S+; next attempt in 1\.0 s with a new token/);
    assert.match(result.stdout, /attempt 2 of 4: \S+; next attempt in 4\.0 s with a new token/);
  }
});

test('U2 a timeout is retried like a lost answer', async (t) => {
  const mint = await tokenEndpoint(t);
  const plane = await controlPlane(t, [202]);
  const real = createTransport();
  let posts = 0;
  const transport = (target, options) =>
    options.method === 'POST' && (posts += 1) === 1
      ? Promise.resolve({ error: 'timeout' })
      : real(target, options);
  const result = await run({
    endpoint: `${plane.base}/v1/evidence`,
    mintUrl: `${mint.base}/token`,
    transport,
  });
  assert.equal(result.code, EXIT.ACCEPTED);
  assert.match(result.stdout, /attempt 1 of 4: timeout;/);
  assert.equal(mint.requests.length, 2);
});

test('U2 four retry-safe failures end unavailable, with no claim about what was stored', async (t) => {
  const result = await scene(t, [503]);
  assert.equal(result.code, EXIT.UNAVAILABLE);
  assert.equal(result.plane.requests.length, 4);
  assert.match(
    result.stdout,
    /no answer after 4 attempt\(s\) in \d+ s \(503\); the record may or may not be stored/,
  );
});

test('U2 attempts that all fail at the mint end unavailable and say nothing was sent', async (t) => {
  const mint = await stub(t, (request, response) => json(response, 503, {}));
  const plane = await controlPlane(t, [202]);
  const result = await run({ endpoint: `${plane.base}/v1/evidence`, mintUrl: `${mint.base}/t` });
  assert.equal(result.code, EXIT.UNAVAILABLE);
  assert.equal(mint.requests.length, 4);
  assert.equal(plane.requests.length, 0);
  assert.match(
    result.stdout,
    /after 4 attempt\(s\) in \d+ s \(mint-unavailable\); no attempt got as far as a POST, so nothing was sent/,
  );
  assert.doesNotMatch(result.stdout, /may or may not be stored/);

  // One POST lost, then the mint down: something may have been stored.
  let calls = 0;
  const real = createTransport();
  const transport = (target, options) =>
    (calls += 1) === 2 ? Promise.resolve({ error: 'network' }) : real(target, options);
  const halfway = await stub(t, (request, response, body, index) =>
    index === 0 ? json(response, 200, { value: newToken() }) : json(response, 503, {}),
  );
  const mixed = await run({
    endpoint: `${plane.base}/v1/evidence`,
    mintUrl: `${halfway.base}/t`,
    transport,
  });
  assert.equal(mixed.code, EXIT.UNAVAILABLE);
  assert.match(mixed.stdout, /\(mint-unavailable\); the record may or may not be stored/);
});

// ----------------------------------------------------------------------------------- U3 429

test('U3 429 honours retry-after inside the quota window and stops beyond it', async (t) => {
  const honoured = await scene(t, [429, 202], { headers: { 'retry-after': '7' } });
  assert.equal(honoured.code, EXIT.ACCEPTED);
  assert.deepEqual(honoured.waits, [7000]);

  const absent = await scene(t, [429, 202]);
  assert.equal(absent.code, EXIT.ACCEPTED);
  assert.deepEqual(absent.waits, [1000], 'no retry-after: the backoff');

  const unparseable = await scene(t, [429, 202], { headers: { 'retry-after': 'soon' } });
  assert.deepEqual(unparseable.waits, [1000]);

  const beyond = await scene(t, [429, 202], { headers: { 'retry-after': '3600' } });
  assert.equal(beyond.code, EXIT.UNAVAILABLE);
  assert.equal(beyond.plane.requests.length, 1, 'stopped rather than outlast the window');
  assert.deepEqual(beyond.waits, []);

  // 90 s would still fit the 150 s budget, so only the 60 s rule stops this one.
  const outside = await scene(t, [429, 202], { headers: { 'retry-after': '90' } });
  assert.equal(outside.code, EXIT.UNAVAILABLE);
  assert.equal(outside.plane.requests.length, 1, 'a retry-after past the quota window stops');
  assert.deepEqual(outside.waits, []);
});

// -------------------------------------------------------------------------------- U4 budget

test('U4 the budget, not the attempt count, ends attempts that each time out', async () => {
  let clock = 1_000_000;
  const calls = [];
  // Every mint takes its full 10 s and every POST its full 40 s, then times out.
  const transport = async (target, options) => {
    calls.push(options.method);
    if (options.method === 'GET') {
      clock += 10000;
      return { status: 200, body: Buffer.from(JSON.stringify({ value: newToken() })) };
    }
    clock += 40000;
    return { error: 'timeout' };
  };
  const result = await submitEvidence({
    body: Buffer.from('{}'),
    endpoint: 'https://control-plane.invalid/v1/evidence',
    env: {
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://runner.invalid/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: REQUEST_TOKEN,
    },
    transport,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    random: () => 1,
  });
  // 0-50 s, wait 2 s, 52-102 s; a third attempt after a 4 s wait would end at 156 s > 150 s.
  assert.deepEqual(result, {
    kind: 'unavailable',
    last: 'timeout',
    attempts: 2,
    posted: true,
    elapsedMs: 102000,
  });
  assert.deepEqual(calls, ['GET', 'POST', 'GET', 'POST']);
});

// ---------------------------------------------------------------------------------- U5 mint

test('U5 the mint sends the request token as bearer and sets the audience exactly once', async (t) => {
  const result = await scene(t, [202], {});
  const [request] = result.mint.requests;
  assert.equal(request.method, 'GET');
  assert.equal(request.headers.authorization, `bearer ${REQUEST_TOKEN}`);
  const url = new URL(request.url, 'http://127.0.0.1');
  assert.deepEqual(url.searchParams.getAll('audience'), [AUDIENCE]);
  assert.equal(url.searchParams.get('api-version'), '2.0');

  const mint = await tokenEndpoint(t);
  const plane = await controlPlane(t, [202]);
  await run({
    endpoint: `${plane.base}/v1/evidence`,
    mintUrl: `${mint.base}/token?audience=https%3A%2F%2Fgithub.com%2Fowner&api-version=2.0`,
  });
  const replaced = new URL(mint.requests[0].url, 'http://127.0.0.1');
  assert.deepEqual(replaced.searchParams.getAll('audience'), [AUDIENCE], 'replaced, not added');
});

test('U5 a mint the runner refuses or answers malformed stops before any POST', async (t) => {
  const answers = {
    refused: (request, response) => json(response, 401, { message: 'no' }),
    'two segments': (request, response) => json(response, 200, { value: 'aaaa.bbbb' }),
    'too long': (request, response) =>
      json(response, 200, { value: `a.b.${'c'.repeat(8193 - 4)}` }),
    'not json': (request, response) => response.end('<html>'),
    'no value': (request, response) => json(response, 200, { token: 'a.b.c' }),
  };
  for (const [name, answer] of Object.entries(answers)) {
    const mint = await stub(t, answer);
    const plane = await controlPlane(t, [202]);
    const result = await run({ endpoint: `${plane.base}/v1/evidence`, mintUrl: `${mint.base}/t` });
    assert.equal(result.code, EXIT.LOCAL, name);
    assert.match(
      result.stdout,
      /the runner did not issue a token; does the calling job grant id-token: write\?/,
    );
    assert.equal(plane.requests.length, 0, `${name}: nothing submitted`);
    assert.equal(mint.requests.length, 1, `${name}: not retried`);
  }
});

test('U5 a mint that is unavailable is retried as an attempt', async (t) => {
  const mint = await stub(t, (request, response, body, index) =>
    index === 0 ? json(response, 503, {}) : json(response, 200, { value: newToken() }),
  );
  const plane = await controlPlane(t, [202]);
  const result = await run({ endpoint: `${plane.base}/v1/evidence`, mintUrl: `${mint.base}/t` });
  assert.equal(result.code, EXIT.ACCEPTED);
  assert.match(result.stdout, /attempt 1 of 4: mint-unavailable;/);
  assert.equal(plane.requests.length, 1);
});

test('U5 a request Node refuses to build is a local failure, not retried, and nothing is sent', async (t) => {
  // A request token Node will not put in a header: http.request throws before any byte leaves.
  const mint = await tokenEndpoint(t);
  const plane = await controlPlane(t, [202]);
  const result = await run({
    endpoint: `${plane.base}/v1/evidence`,
    mintUrl: `${mint.base}/t`,
    env: { ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'x\r\ny: 1' },
  });
  assert.equal(result.code, EXIT.LOCAL);
  assert.match(
    result.stdout,
    /not submitted: Node refused to build a request \(a header it will not send\); nothing was sent\./,
  );
  assert.equal(mint.requests.length + plane.requests.length, 0);
  assert.deepEqual(result.waits, [], 'not retried');

  // The transport maps the throw to its own code, whichever request function threw.
  for (const options of [{ httpsRequest: throwing }, { httpRequest: throwing }]) {
    const target = options.httpsRequest ? 'https://example.com/' : 'http://127.0.0.1:1/';
    assert.deepEqual(
      await createTransport(options)(target, { method: 'GET', headers: {}, timeoutMs: 1000 }),
      { error: 'request-invalid' },
    );
  }

  // The same refusal on the POST: local, after one mint and no retry.
  let posts = 0;
  const real = createTransport();
  const viaPost = await run({
    endpoint: `${plane.base}/v1/evidence`,
    mintUrl: `${mint.base}/t`,
    transport: (target, options) => {
      if (options.method !== 'POST') return real(target, options);
      posts += 1;
      return Promise.resolve({ error: 'request-invalid' });
    },
  });
  assert.equal(viaPost.code, EXIT.LOCAL);
  assert.match(viaPost.stdout, /nothing was sent\./);
  assert.equal(posts, 1);
  assert.equal(mint.requests.length, 1);
});

function throwing() {
  throw new TypeError('Invalid character in header content');
}

test('U5 a mint URL that is not https is refused with no request at all', async () => {
  for (const mintUrl of ['http://example.com/token', 'http://localhost:1/token', 'not a url']) {
    let calls = 0;
    const transport = async () => {
      calls += 1;
      return { error: 'network' };
    };
    const result = await run({
      endpoint: 'https://control-plane.invalid/v1/evidence',
      mintUrl,
      transport,
    });
    assert.equal(result.code, EXIT.LOCAL, mintUrl);
    assert.match(result.stdout, /the ID-token request URL is not https/);
    assert.equal(calls, 0, mintUrl);
  }
  assert.deepEqual(
    await mintToken({
      requestUrl: 'http://example.com/t',
      requestToken: 'x',
      transport: () => assert.fail(),
    }),
    { ok: false, retryable: false, reason: 'mint-endpoint-not-https' },
  );
});

test('U5 the ID-token variables are required', async () => {
  for (const env of [
    { ACTIONS_ID_TOKEN_REQUEST_URL: undefined },
    { ACTIONS_ID_TOKEN_REQUEST_TOKEN: '' },
  ]) {
    let calls = 0;
    const result = await run({
      endpoint: 'https://control-plane.invalid/v1/evidence',
      mintUrl: 'https://runner.invalid/t',
      env,
      transport: async () => {
        calls += 1;
        return { error: 'network' };
      },
    });
    assert.equal(result.code, EXIT.LOCAL);
    assert.match(result.stdout, /the ID-token request variables are not set/);
    assert.equal(calls, 0);
  }
});

// -------------------------------------------------------------------------------- U7 guards

test('U7 only https, or http to the literal loopback addresses, is an endpoint', async () => {
  for (const endpoint of [
    'http://example.com/v1/evidence',
    'http://localhost:1/v1/evidence',
    'ftp://example.com/v1/evidence',
    'https://user:secret@example.com/v1/evidence',
    'not a url',
  ]) {
    let calls = 0;
    const result = await run({
      endpoint,
      mintUrl: 'https://runner.invalid/t',
      transport: async () => {
        calls += 1;
        return { error: 'network' };
      },
    });
    assert.equal(result.code, EXIT.LOCAL, endpoint);
    assert.match(result.stdout, /not submitted: the control plane endpoint is not https\./);
    assert.equal(calls, 0, `${endpoint}: no request, not even a mint`);
  }
  assert.ok(allowedTarget('https://example.com/v1/evidence'));
  assert.ok(allowedTarget('http://127.0.0.1:8080/v1/evidence'));
  assert.ok(allowedTarget('http://[::1]:8080/v1/evidence'));
  assert.equal(allowedTarget('http://127.0.0.2/v1/evidence'), null);
  // The WHATWG parser normalises this spelling to 127.0.0.1, which is loopback.
  assert.ok(allowedTarget('http://0x7f000001/v1/evidence'));
});

test('U7 the transport refuses a non-loopback http target itself', async () => {
  const answer = await createTransport({ httpRequest: () => assert.fail('no request') })(
    'http://example.com/',
    { method: 'GET', headers: {}, timeoutMs: 1000 },
  );
  assert.deepEqual(answer, { error: 'endpoint-not-https' });
});

test('U7 a record over 1 MiB is refused before minting; exactly 1 MiB is sent', async (t) => {
  const over = await scene(t, [202], {
    run: { path: recordFile(Buffer.alloc(MAX_EVIDENCE_BYTES + 1, 0x20)) },
  });
  assert.equal(over.code, EXIT.LOCAL);
  assert.match(over.stdout, /larger than 1048576 bytes/);
  assert.equal(over.mint.requests.length, 0);
  assert.equal(over.plane.requests.length, 0);

  const exact = await scene(t, [202], {
    run: { path: recordFile(Buffer.alloc(MAX_EVIDENCE_BYTES, 0x20)) },
  });
  assert.equal(exact.code, EXIT.ACCEPTED);
  assert.equal(exact.plane.requests[0].body.length, MAX_EVIDENCE_BYTES);
  assert.match(exact.stdout, /change_id "\(unreadable\)"/);

  // Refused on its size alone, before it is read: a sparse 3 GiB file costs nothing on disk and
  // is more than readFileSync will read, so only the stat check gives this answer.
  const huge = recordFile('');
  truncateSync(huge, 3 * 1024 ** 3);
  const unread = await scene(t, [202], { run: { path: huge } });
  assert.equal(unread.code, EXIT.LOCAL);
  assert.match(unread.stdout, /larger than 1048576 bytes/);
  assert.equal(unread.mint.requests.length, 0);
  rmSync(huge);

  assert.deepEqual(
    await submitEvidence({
      body: Buffer.alloc(MAX_EVIDENCE_BYTES + 1),
      endpoint: 'https://control-plane.invalid/',
      env: {},
      transport: () => assert.fail(),
    }),
    { kind: 'local', reason: 'record-too-large' },
  );
});

test('U7 a symlink or a directory is refused; a missing record is NO_RECORD with no request', async (t) => {
  const target = recordFile();
  const link = join(dir, 'link.json');
  symlinkSync(target, link);
  const directory = join(dir, 'a-directory');
  mkdirSync(directory);
  for (const path of [link, directory]) {
    const result = await scene(t, [202], { run: { path } });
    assert.equal(result.code, EXIT.LOCAL, path);
    assert.match(result.stdout, /not submitted: the evidence record is not a regular file\./);
    assert.equal(result.mint.requests.length + result.plane.requests.length, 0);
  }
  const missing = await scene(t, [202], { run: { path: join(dir, 'nothing-here.json') } });
  assert.equal(missing.code, EXIT.NO_RECORD);
  assert.match(
    missing.stdout,
    /no evidence record at .*nothing-here\.json: the gate did not reach a decision; nothing was submitted\./,
  );
  assert.equal(missing.mint.requests.length + missing.plane.requests.length, 0);
});

// A fake https.request, as https-transport.test.mjs drives fetchJwks: records the options and
// answers with an in-memory response, or never.
function fakeRequest(respond) {
  const calls = [];
  const request = (url, options, onResponse) => {
    const outgoing = new EventEmitter();
    const record = { url: String(url), options, destroyed: false, body: undefined };
    calls.push(record);
    outgoing.destroy = () => {
      record.destroyed = true;
    };
    outgoing.end = (body) => {
      record.body = body;
      respond((response) => onResponse(response), record);
    };
    return outgoing;
  };
  return { request, calls };
}

function fakeResponse({ status = 200, headers = {}, chunks = [] }) {
  const readable = Readable.from(chunks.map((chunk) => Buffer.from(chunk)));
  readable.statusCode = status;
  readable.headers = headers;
  return readable;
}

test('U7 https requests pass rejectUnauthorized: true and read no Location', async () => {
  let locationRead = false;
  const headers = { 'content-length': '2' };
  Object.defineProperty(headers, 'location', {
    enumerable: false,
    get() {
      locationRead = true;
      return 'https://attacker.invalid/';
    },
  });
  const { request, calls } = fakeRequest((deliver) =>
    deliver(fakeResponse({ status: 302, headers, chunks: ['{}'] })),
  );
  const answer = await createTransport({ httpsRequest: request })(
    'https://example.com/v1/evidence',
    {
      method: 'POST',
      headers: {},
      body: Buffer.from('{}'),
      timeoutMs: 1000,
    },
  );
  assert.equal(answer.status, 302);
  // strictEqual true, not truthy: the explicit option is what overrides
  // NODE_TLS_REJECT_UNAUTHORIZED=0 in the environment.
  assert.equal(calls[0].options.rejectUnauthorized, true);
  assert.equal(locationRead, false);
});

test('U7 an answer over 64 KiB is cut off, declared or not', async () => {
  for (const response of [
    { headers: { 'content-length': '65537' }, chunks: [] },
    { headers: {}, chunks: ['x'.repeat(40000), 'x'.repeat(40000)] },
  ]) {
    const { request, calls } = fakeRequest((deliver) =>
      deliver(fakeResponse({ status: 202, ...response })),
    );
    const answer = await createTransport({ httpsRequest: request })('https://example.com/', {
      method: 'GET',
      headers: {},
      timeoutMs: 1000,
    });
    assert.deepEqual(answer, { status: 202, error: 'response-too-large' });
    assert.equal(calls[0].destroyed, true);
  }
});

test('U7 one deadline per request destroys it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { request, calls } = fakeRequest(() => {});
  const pending = createTransport({ httpsRequest: request })('https://example.com/', {
    method: 'GET',
    headers: {},
    timeoutMs: 40000,
  });
  t.mock.timers.tick(39999);
  assert.equal(calls[0].destroyed, false);
  t.mock.timers.tick(1);
  assert.deepEqual(await pending, { error: 'timeout' });
  assert.equal(calls[0].destroyed, true);
});

// ------------------------------------------------------------------- U8 wording and escaping

const LS = String.fromCharCode(0x2028);
const HOSTILE = `PR-7\n::add-mask::x|<script>alert(1)</script>\`${LS}${'z'.repeat(500)}`;

test('U8 echoed fields cannot start a line, are entity-escaped in the summary, and are cut at 120', async (t) => {
  const path = recordFile({ change_id: HOSTILE });
  const result = await scene(t, [422], {
    run: { path },
    body: () => ({
      decision: {
        accepted: false,
        disposition: `needs\r\nremediation`,
        policy_id: '<b>p|1</b>',
        reasons: [HOSTILE, 7],
      },
    }),
  });
  assert.equal(result.code, EXIT.NOT_ACCEPTED);
  const lines = result.stdout.split('\n').filter(Boolean);
  for (const line of lines) assert.match(line, /^submit-evidence: /);
  assert.equal(result.stdout.includes(LS), false);
  assert.match(result.stdout, /PR-7\\u000a::add-mask::x\|<script>/);
  assert.match(result.stdout, /needs\\u000d\\u000aremediation/);
  assert.match(result.stdout, /\(number\)/);
  for (const line of result.summary.split('\n').filter((l) => l.startsWith('- '))) {
    assert.equal(/[<>|`'"]/.test(line), false, line);
  }
  assert.match(result.summary, /&lt;script&gt;/);
  assert.match(result.summary, /&#124;/);

  assert.equal(display('a'.repeat(500)), `${'a'.repeat(120)}…`);
  assert.equal(display('a'.repeat(120)), 'a'.repeat(120));
  assert.equal(display('\u0085\u009b\u007f\u0000'), '\\u0085\\u009b\\u007f\\u0000');
  assert.equal(display(LS + String.fromCharCode(0x2029)), '\\u2028\\u2029');
  assert.equal(display('PR#7 ##[x]'), 'PR\\u00237 \\u0023\\u0023[x]');
  assert.equal(display(null), '(null)');
  assert.equal(display({}), '(object)');
});

test('U8 a legacy ##[command] in any echoed field reaches the log escaped', async (t) => {
  const warning = '##[warning title=x]Evidence accepted by control plane';
  const mask = '##[add-mask]accepted';
  const notAccepted = await scene(t, [422], {
    run: { path: recordFile({ change_id: warning }) },
    body: () => ({
      decision: {
        accepted: false,
        disposition: mask,
        policy_id: warning,
        reasons: [mask, warning],
      },
    }),
  });
  const conflict = await scene(t, [409], {
    run: { path: recordFile({ change_id: mask }) },
    body: () => ({ error: 'conflict', idempotency_key: warning }),
  });
  const accepted = await scene(t, [202], {
    body: () => ({ decision: { ...DECISION, disposition: mask, policy_id: warning } }),
  });
  const missing = await scene(t, [202], { run: { path: join(dir, `${warning}.json`) } });
  for (const result of [notAccepted, conflict, accepted, missing]) {
    assert.equal(result.stdout.includes('##['), false, result.stdout);
    assert.equal(result.summary.includes('##['), false, result.summary);
    assert.match(result.stdout, /\\u0023\\u0023\[(warning title=x|add-mask)\]/);
  }
  assert.match(notAccepted.stdout, /change_id "\\u0023\\u0023\[warning title=x\]Evidence/);
  assert.match(notAccepted.stdout, /Reasons: \\u0023\\u0023\[add-mask\]accepted; \\u0023/);
  assert.match(conflict.stdout, /idempotency key "\\u0023\\u0023\[warning title=x\]/);
  assert.match(accepted.stdout, /disposition "\\u0023\\u0023\[add-mask\]accepted"/);
});

test('U8 no outcome is worded as verified, approved or compliant; accepted says self-attested', async (t) => {
  const rendered = [];
  for (const status of [202, 422, 400, 401, 403, 409, 413, 301, 418, 503]) {
    const result = await scene(t, [status]);
    rendered.push(result.stdout, result.summary);
    if (status === 202) assert.match(result.stdout, /self-attested/);
  }
  const mint = await stub(t, (request, response) => json(response, 401, {}));
  rendered.push((await run({ endpoint: 'https://cp.invalid/', mintUrl: `${mint.base}/t` })).stdout);
  for (const endpoint of ['http://example.com/', null])
    rendered.push((await run({ endpoint, mintUrl: 'https://runner.invalid/t' })).stdout);
  rendered.push(
    (await run({ endpoint: 'https://cp.invalid/', mintUrl: 'x', path: join(dir, 'none') })).stdout,
  );
  rendered.push((await run({ endpoint: 'https://cp.invalid/', mintUrl: 'x', path: dir })).stdout);
  rendered.push(
    (
      await run({
        endpoint: 'https://cp.invalid/',
        mintUrl: 'x',
        env: { ACTIONS_ID_TOKEN_REQUEST_URL: '' },
      })
    ).stdout,
  );
  for (const text of rendered) assert.doesNotMatch(text, /verif|approv|complian/i);
});

// ------------------------------------------------------------------------- U6 canaries

test('U6 a server that echoes the credentials gets [redacted] back', async (t) => {
  const result = await scene(t, [422], {
    body: (request) => ({
      decision: {
        accepted: false,
        disposition: 'rejected',
        policy_id: request.headers.authorization,
        reasons: [`you sent ${request.headers.authorization}`, `and ${REQUEST_TOKEN}`],
      },
    }),
  });
  assert.equal(result.code, EXIT.NOT_ACCEPTED);
  assert.match(result.stdout, /policy "Bearer \[redacted\]"/);
  assert.match(result.stdout, /you sent Bearer \[redacted\]; and \[redacted\]/);

  const conflict = await scene(t, [409], {
    body: (request) => ({ error: 'conflict', idempotency_key: request.headers.authorization }),
  });
  assert.match(conflict.stdout, /idempotency key "Bearer \[redacted\]"/);
});

test('U9 the CLI refuses while no endpoint is configured, and importing it runs nothing', () => {
  const path = recordFile();
  const cli = spawnSync(process.execPath, [SCRIPT, path], {
    env: { PATH: process.env.PATH },
    encoding: 'utf8',
  });
  assert.equal(cli.status, EXIT.LOCAL);
  assert.equal(
    cli.stdout,
    'submit-evidence: not submitted: no control plane endpoint is configured in this adapter release.\n',
  );
  assert.equal(cli.stderr, '');
  outputs.push(cli.stdout, cli.stderr);

  const imported = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(SCRIPT)});`, path],
    { env: { PATH: process.env.PATH }, encoding: 'utf8' },
  );
  assert.equal(imported.status, 0);
  assert.equal(imported.stdout, '');
});

test('U9 main hands on only the dependencies it names: an extra body or onAttempt does nothing', async (t) => {
  // endpoint and env are main's own parameters, so body is the one value main checks that an
  // unnamed dependency could otherwise replace on its way to submitEvidence.
  const path = recordFile();
  const forged = Buffer.from('{"schema_version":"evidence/0","change_id":"FORGED"}');
  let called = false;
  const result = await scene(t, [503, 202], {
    run: {
      path,
      body: forged,
      onAttempt: () => {
        called = true;
      },
    },
  });
  assert.equal(result.code, EXIT.ACCEPTED);
  assert.equal(result.plane.requests.length, 2);
  for (const request of result.plane.requests)
    assert.ok(request.body.equals(readFileSync(path)), 'the bytes sent are the file main read');
  assert.equal(called, false, "main's own onAttempt prints the attempt line");
  assert.match(result.stdout, /attempt 1 of 4: /);
});

// Last, over everything every test above printed or wrote: no request token, no minted token, and
// no 12-character run of any minted token's signature segment.
test('U6 no output of any test carries a credential or a piece of a signature', () => {
  assert.ok(minted.length > 20, 'the scenarios minted tokens');
  assert.ok(outputs.length > 40, 'the scenarios produced output');
  const all = outputs.join('\n');
  assert.equal(all.includes(REQUEST_TOKEN), false);
  assert.equal(all.includes('CANARY'), false);
  for (const token of minted) {
    assert.equal(all.includes(token), false);
    const signature = token.split('.')[2];
    for (let index = 0; index + 12 <= signature.length; index += 1)
      assert.equal(all.includes(signature.slice(index, index + 12)), false);
  }
});
