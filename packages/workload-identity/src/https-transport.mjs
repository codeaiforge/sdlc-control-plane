import https from 'node:https';
import { JWKS_MAX_BYTES, JWKS_TIMEOUT_MS, JWKS_URI } from './constants.mjs';

// The production fetch behind the key set (ADR-0003 › Keys and rotation; threat model TB-8).
// Every rule here fails the fetch, and a failed fetch is all the key set ever learns: the
// rejection carries a fixed message and never the response, so nothing the network sent can
// reach a log through it.
//
// - HTTPS only, checked before any request is made.
// - `rejectUnauthorized: true` is passed explicitly, so NODE_TLS_REJECT_UNAUTHORIZED=0 in the
//   environment cannot switch certificate verification off for this request. The extra-CA and
//   proxy variables are host configuration this code cannot refuse; TB-8 names them.
// - No redirect is followed. https.request never follows one, and any status but 200 - a 301 or
//   302 included - is a failure whose Location header is never read.
// - 64 KiB: an honest content-length over the cap fails before a byte is read, and the received
//   bytes are counted regardless, because a header that lies is not a measurement.
// - One 5000 ms deadline over the whole exchange, which destroys the request.
//
// `request` is injectable so the tests drive every rule without a socket; production passes
// nothing and gets https.request.
export function fetchJwks(url = JWKS_URI, { request = https.request } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      reject(new Error('key-set url is not a url'));
      return;
    }
    if (target.protocol !== 'https:') {
      reject(new Error('key-set url is not https'));
      return;
    }

    let settled = false;
    let outgoing;
    const fail = (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      outgoing?.destroy();
      reject(new Error(message));
    };
    const deadline = setTimeout(() => fail('key-set fetch timed out'), JWKS_TIMEOUT_MS);

    const onResponse = (response) => {
      if (response.statusCode !== 200)
        return fail('key-set fetch answered a status other than 200');
      const declared = response.headers['content-length'];
      if (declared !== undefined && Number(declared) > JWKS_MAX_BYTES)
        return fail('key-set response declares more than the byte cap');
      const chunks = [];
      let received = 0;
      response.on('data', (chunk) => {
        if (settled) return;
        received += chunk.length;
        if (received > JWKS_MAX_BYTES) return fail('key-set response passed the byte cap');
        chunks.push(chunk);
      });
      response.on('error', () => fail('key-set response failed'));
      response.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        resolve({ body: Buffer.concat(chunks), cacheControl: response.headers['cache-control'] });
      });
    };

    try {
      outgoing = request(
        target,
        { method: 'GET', rejectUnauthorized: true, headers: { accept: 'application/json' } },
        onResponse,
      );
    } catch {
      fail('key-set request could not be made');
      return;
    }
    outgoing.on('error', () => fail('key-set request failed'));
    outgoing.end();
  });
}
