import assert from 'node:assert/strict';
import { constants, generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { decodeBase64url, decodeJsonSegment, splitCompact, verifyRs256 } from './jws.mjs';

// Decoding and signature edge cases. Keys are generated in this file and nowhere else.

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const signRs256 = (input, privateKey = pair.privateKey) =>
  sign('sha256', Buffer.from(input), { key: privateKey, padding: constants.RSA_PKCS1_PADDING });

test('canonical base64url decodes and round-trips', () => {
  assert.deepEqual(decodeBase64url('aGk'), Buffer.from('hi'));
  assert.deepEqual(decodeBase64url('-_8'), Buffer.from([0xfb, 0xff]));
});

test('padding, the standard alphabet, whitespace and empty segments are refused', () => {
  for (const segment of ['aGk=', 'aGk==', '+/8', 'aG k', 'aGk\n', '', 'a', 'aGk.']) {
    assert.equal(decodeBase64url(segment), null, JSON.stringify(segment));
  }
});

test('a non-canonical final character is refused, though the lenient decoder accepts it', () => {
  // 'aGk' and 'aGl' differ only in the final character's unused low bits, and both decode to
  // "hi". A verifier that accepted both would accept two spellings of one token.
  assert.deepEqual(Buffer.from('aGl', 'base64url'), Buffer.from('hi'));
  assert.equal(decodeBase64url('aGl'), null);
  assert.deepEqual(decodeBase64url('aGk'), Buffer.from('hi'));
});

test('a JSON segment must be a JSON object in strict UTF-8', () => {
  assert.deepEqual(decodeJsonSegment(b64({ alg: 'RS256' })), { ok: true, value: { alg: 'RS256' } });
  for (const value of [[1, 2], 'text', 42, null, true]) {
    assert.deepEqual(decodeJsonSegment(b64(value)), { ok: false }, JSON.stringify(value));
  }
  assert.deepEqual(decodeJsonSegment(Buffer.from('{not json').toString('base64url')), {
    ok: false,
  });
  const invalidUtf8 = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]);
  assert.deepEqual(decodeJsonSegment(invalidUtf8.toString('base64url')), { ok: false });
});

test('a failed decode returns no error text that could carry token bytes', () => {
  const result = decodeJsonSegment(Buffer.from('{"CANARY-BYTES').toString('base64url'));
  assert.deepEqual(Object.keys(result), ['ok']);
});

test('exactly three segments are required', () => {
  const header = b64({ alg: 'RS256', kid: 'k' });
  const payload = b64({ sub: 'x' });
  const signature = signRs256(`${header}.${payload}`).toString('base64url');
  assert.equal(splitCompact(`${header}.${payload}.${signature}`).ok, true);
  for (const token of [
    `${header}.${payload}`,
    `${header}.${payload}.${signature}.${signature}`,
    `${header}..${signature}`,
    `${header}.${payload}.`,
    `.${payload}.${signature}`,
    '',
    42,
    undefined,
  ]) {
    assert.equal(splitCompact(token).ok, false, String(token));
  }
});

test('splitCompact returns the signing input, the payload segment and the raw signature', () => {
  const header = b64({ alg: 'RS256', kid: 'k' });
  const payload = b64({ sub: 'x' });
  const signature = signRs256(`${header}.${payload}`);
  const result = splitCompact(`${header}.${payload}.${signature.toString('base64url')}`);
  assert.equal(result.signingInput, `${header}.${payload}`);
  assert.equal(result.payloadSegment, payload);
  assert.deepEqual(result.signature, signature);
  assert.deepEqual(result.header, { alg: 'RS256', kid: 'k' });
});

test('a non-canonical payload or signature segment is refused at split', () => {
  const header = b64({ alg: 'RS256', kid: 'k' });
  assert.equal(splitCompact(`${header}.aGl.aGk`).ok, false);
  assert.equal(splitCompact(`${header}.aGk.aGl`).ok, false);
  assert.equal(splitCompact(`${header}.aGk=.aGk`).ok, false);
});

test('RS256 verifies under the signing key and fails under any other', () => {
  const input = 'header.payload';
  const signature = signRs256(input);
  assert.equal(verifyRs256(input, signature, pair.publicKey), true);
  assert.equal(verifyRs256(input, signature, other.publicKey), false);
  assert.equal(verifyRs256('header.payloaD', signature, pair.publicKey), false);
});

test('a flipped bit in the signature fails', () => {
  const input = 'header.payload';
  const signature = Buffer.from(signRs256(input));
  signature[signature.length - 1] ^= 0x01;
  assert.equal(verifyRs256(input, signature, pair.publicKey), false);
});

test('a PSS-padded signature over the same input is refused', () => {
  const input = 'header.payload';
  const pss = sign('sha256', Buffer.from(input), {
    key: pair.privateKey,
    padding: constants.RSA_PKCS1_PSS_PADDING,
  });
  assert.equal(verifyRs256(input, pss, pair.publicKey), false);
});

test('a malformed signature or key returns false, never throws', () => {
  assert.equal(verifyRs256('a.b', Buffer.alloc(0), pair.publicKey), false);
  assert.equal(verifyRs256('a.b', Buffer.alloc(256), 'not a key'), false);
});
