import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fetchJwks } from './https-transport.mjs';

// AC-4's transport rules, driven through an injected fake of https.request. No test here opens a
// socket: the fake records what it was asked for and answers with an in-memory Readable.

const URL_OK = 'https://token.actions.githubusercontent.com/.well-known/jwks';

// A fake https.request. `respond` decides what happens when the request is ended: it receives a
// function that delivers a response, and may never call it (a stalled server).
function fakeRequest(respond) {
  const calls = [];
  const request = (url, options, onResponse) => {
    const outgoing = new EventEmitter();
    const record = { url: String(url), options, destroyed: false };
    calls.push(record);
    outgoing.destroy = () => {
      record.destroyed = true;
    };
    outgoing.end = () => respond((response) => onResponse(response), record);
    return outgoing;
  };
  return { request, calls };
}

function response({ status = 200, headers = {}, chunks = [] }) {
  const readable = Readable.from(chunks.map((chunk) => Buffer.from(chunk)));
  readable.statusCode = status;
  readable.headers = headers;
  return readable;
}

const jwks = JSON.stringify({ keys: [] });

test('a 200 answer resolves the body and the cache-control header', async () => {
  const { request, calls } = fakeRequest((deliver) =>
    deliver(response({ headers: { 'cache-control': 'max-age=3600' }, chunks: [jwks] })),
  );
  const result = await fetchJwks(URL_OK, { request });
  assert.equal(result.body.toString('utf8'), jwks);
  assert.equal(result.cacheControl, 'max-age=3600');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, URL_OK);
  assert.equal(calls[0].options.method, 'GET');
});

test('a non-https url is refused with no request made', async () => {
  const { request, calls } = fakeRequest(() => assert.fail('no request may be made'));
  for (const url of [
    'http://token.actions.githubusercontent.com/.well-known/jwks',
    'file:///etc/passwd',
    'ftp://token.actions.githubusercontent.com/jwks',
    'not a url',
    '//token.actions.githubusercontent.com/jwks',
  ]) {
    await assert.rejects(fetchJwks(url, { request }), Error, url);
  }
  assert.equal(calls.length, 0);
});

test('rejectUnauthorized is passed as true', async () => {
  const { request, calls } = fakeRequest((deliver) => deliver(response({ chunks: [jwks] })));
  await fetchJwks(URL_OK, { request });
  // strictEqual true, not truthy: the explicit option is what overrides
  // NODE_TLS_REJECT_UNAUTHORIZED=0 in the environment.
  assert.equal(calls[0].options.rejectUnauthorized, true);
});

test('301, 302 and 404 are failures and Location is never requested', async () => {
  for (const status of [301, 302, 307, 308, 404, 500]) {
    let locationRead = false;
    const headers = {};
    Object.defineProperty(headers, 'location', {
      enumerable: true,
      get() {
        locationRead = true;
        return 'https://attacker.invalid/jwks';
      },
    });
    const { request, calls } = fakeRequest((deliver) =>
      deliver(response({ status, headers, chunks: [jwks] })),
    );
    await assert.rejects(fetchJwks(URL_OK, { request }), Error, `status ${status}`);
    assert.equal(calls.length, 1, `status ${status} was followed`);
    assert.equal(calls[0].destroyed, true, `status ${status} left the request open`);
    assert.equal(locationRead, false, `status ${status} read Location`);
  }
});

test('content-length over 65536 fails before a byte is read', async () => {
  let pulled = false;
  const { request, calls } = fakeRequest((deliver) => {
    const readable = new Readable({
      read() {
        pulled = true;
        this.push(null);
      },
    });
    readable.statusCode = 200;
    readable.headers = { 'content-length': '65537' };
    deliver(readable);
  });
  await assert.rejects(fetchJwks(URL_OK, { request }));
  assert.equal(pulled, false, 'the body was read although its declared length is over the cap');
  assert.equal(calls[0].destroyed, true);
});

test('a streamed body past 65536 bytes is destroyed at the cap', async () => {
  // No content-length at all, as a chunked answer would send: the counter is authoritative.
  const { request, calls } = fakeRequest((deliver) =>
    deliver(response({ chunks: ['x'.repeat(40000), 'x'.repeat(40000), 'x'.repeat(10)] })),
  );
  await assert.rejects(fetchJwks(URL_OK, { request }));
  assert.equal(calls[0].destroyed, true);
});

test('a body of exactly 65536 bytes is accepted', async () => {
  const { request } = fakeRequest((deliver) =>
    deliver(response({ chunks: ['x'.repeat(32768), 'x'.repeat(32768)] })),
  );
  const { body } = await fetchJwks(URL_OK, { request });
  assert.equal(body.length, 65536);
});

test('a content-length that lies low does not lift the cap', async () => {
  const { request } = fakeRequest((deliver) =>
    deliver(response({ headers: { 'content-length': '10' }, chunks: ['x'.repeat(70000)] })),
  );
  await assert.rejects(fetchJwks(URL_OK, { request }));
});

test('the 5000 ms deadline aborts a stalled fetch', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { request, calls } = fakeRequest(() => {
    // Never responds.
  });
  const pending = fetchJwks(URL_OK, { request });
  let settled = false;
  pending.then(
    () => (settled = true),
    () => (settled = true),
  );
  t.mock.timers.tick(4999);
  await Promise.resolve();
  assert.equal(settled, false, 'the fetch gave up before its 5000 ms deadline');
  t.mock.timers.tick(1);
  await assert.rejects(pending, /timed out/);
  assert.equal(calls[0].destroyed, true);
});

test('a request error and a throwing request function are failures, not throws', async () => {
  const failing = (url, options) => {
    const outgoing = new EventEmitter();
    outgoing.destroy = () => {};
    outgoing.end = () => outgoing.emit('error', new Error('ECONNREFUSED'));
    return outgoing;
  };
  await assert.rejects(fetchJwks(URL_OK, { request: failing }), /request failed/);
  const throwing = () => {
    throw new Error('boom');
  };
  await assert.rejects(fetchJwks(URL_OK, { request: throwing }), /could not be made/);
});

test('a rejection carries a fixed message, never what the network sent', async () => {
  const canary = 'CANARY-NETWORK-BYTES';
  const { request } = fakeRequest((deliver) =>
    deliver(response({ status: 500, headers: { 'x-canary': canary }, chunks: [canary] })),
  );
  const error = await fetchJwks(URL_OK, { request }).catch((caught) => caught);
  assert.ok(error instanceof Error);
  assert.doesNotMatch(error.message, new RegExp(canary));
  assert.equal(error.cause, undefined);
});
