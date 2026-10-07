import { constants, verify } from 'node:crypto';

// Strict compact-JWS handling (RFC 7515 compact serialisation, RS256 only).
//
// Base64url is checked by round-trip, not by the decoder's leniency. Buffer.from(_, 'base64url')
// ignores characters outside the alphabet, accepts padding, and maps several encodings onto the
// same bytes (a final character's unused bits are discarded), so a decoder used without the
// round-trip accepts more than one spelling of one token. Here a segment is accepted only if it
// is exactly the canonical unpadded encoding of the bytes it decodes to.

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const utf8 = new TextDecoder('utf-8', { fatal: true });

export function decodeBase64url(segment) {
  if (typeof segment !== 'string' || !BASE64URL.test(segment)) return null;
  const bytes = Buffer.from(segment, 'base64url');
  return bytes.toString('base64url') === segment ? bytes : null;
}

// A JSON object, decoded from canonical base64url and strict UTF-8. Never throws, and never
// returns an error: a JSON.parse message quotes part of its input, and the input here is token
// bytes, which must not reach a log through an error (D-7).
export function decodeJsonSegment(segment) {
  const bytes = decodeBase64url(segment);
  if (bytes === null) return { ok: false };
  let value;
  try {
    value = JSON.parse(utf8.decode(bytes));
  } catch {
    return { ok: false };
  }
  return isObject(value) ? { ok: true, value } : { ok: false };
}

// Exactly three canonical segments. The header is decoded here (step 1 needs alg and kid); the
// payload is only checked for canonical encoding, and is decoded by the caller after the
// signature verifies (step 4).
export function splitCompact(token) {
  if (typeof token !== 'string') return { ok: false };
  const segments = token.split('.');
  if (segments.length !== 3) return { ok: false };
  const [headerSegment, payloadSegment, signatureSegment] = segments;
  const header = decodeJsonSegment(headerSegment);
  if (!header.ok) return { ok: false };
  if (decodeBase64url(payloadSegment) === null) return { ok: false };
  const signature = decodeBase64url(signatureSegment);
  if (signature === null) return { ok: false };
  return {
    ok: true,
    header: header.value,
    signingInput: `${headerSegment}.${payloadSegment}`,
    payloadSegment,
    signature,
  };
}

// RSASSA-PKCS1-v1_5 with SHA-256, the padding named explicitly: a KeyObject used without it
// takes the key type's default, and the verifier must never accept PSS for an RS256 header.
export function verifyRs256(signingInput, signature, key) {
  try {
    return verify(
      'sha256',
      Buffer.from(signingInput, 'ascii'),
      { key, padding: constants.RSA_PKCS1_PADDING },
      signature,
    );
  } catch {
    return false;
  }
}
