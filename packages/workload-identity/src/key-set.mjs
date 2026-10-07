import { createPublicKey } from 'node:crypto';
import {
  JWKS_MAX_TTL_S,
  JWKS_MIN_FETCH_INTERVAL_MS,
  JWKS_MIN_TTL_S,
  MAX_KID_LENGTH,
} from './constants.mjs';
import { fetchJwks } from './https-transport.mjs';

// The issuer's key set, cached under ADR-0003 › Keys and rotation:
//
// - cached for the response's Cache-Control max-age, clamped to [60, 3600] s; a missing or
//   unreadable max-age is the floor, 60 s;
// - no stale use: once the cache expires no key from it verifies anything, whatever the network
//   is doing (there is no stale-while-error);
// - every fetch - the first, the refetch on expiry, the refetch on an unknown kid - shares one
//   in-flight request and one budget of one attempt per 60 s for the whole process. A caller that
//   arrives while the budget is spent is answered from the cache, or with null if there is no
//   unexpired cache; it never starts a fetch of its own;
// - a failed fetch keeps whatever unexpired cache there is, so a stream of forged kids during a
//   GitHub outage cannot turn a working cache into a global 503 (ADR-0003; RR-13 records what
//   remains).
//
// Constructing a key set does no I/O. The first fetch happens on the first call, which is the
// first authenticated request; importing main.mjs therefore fetches nothing.

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function maxAgeSeconds(cacheControl) {
  const match =
    typeof cacheControl === 'string'
      ? /(?:^|,)\s*max-age\s*=\s*"?(\d{1,10})"?\s*(?:,|$)/i.exec(cacheControl)
      : null;
  const declared = match ? Number(match[1]) : JWKS_MIN_TTL_S;
  return Math.min(JWKS_MAX_TTL_S, Math.max(JWKS_MIN_TTL_S, declared));
}

// A usable key is RSA, at least 2048 bits, `use` sig and `alg` RS256 where either is present,
// and carries a kid this verifier would accept in a token header. Anything else is dropped, not
// fatal: GitHub's set is several keys and one odd entry must not take the others with it. A kid
// that appears twice is dropped entirely, because there is no rule that says which copy is real.
// Only kty, n and e reach createPublicKey: a JWK carrying private members would otherwise be
// imported as a private key and its public half derived, which is not what a key set is for.
export function parseKeySet(body) {
  let document;
  try {
    document = JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : String(body));
  } catch {
    return null;
  }
  if (!isObject(document) || !Array.isArray(document.keys)) return null;
  const keys = new Map();
  const duplicated = new Set();
  for (const jwk of document.keys) {
    if (!isObject(jwk) || jwk.kty !== 'RSA') continue;
    if (typeof jwk.kid !== 'string' || jwk.kid.length === 0 || jwk.kid.length > MAX_KID_LENGTH)
      continue;
    if (Object.hasOwn(jwk, 'use') && jwk.use !== 'sig') continue;
    if (Object.hasOwn(jwk, 'alg') && jwk.alg !== 'RS256') continue;
    if (typeof jwk.n !== 'string' || typeof jwk.e !== 'string') continue;
    let key;
    try {
      key = createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' });
    } catch {
      continue;
    }
    if (!(key.asymmetricKeyDetails?.modulusLength >= 2048)) continue;
    if (keys.has(jwk.kid) || duplicated.has(jwk.kid)) {
      keys.delete(jwk.kid);
      duplicated.add(jwk.kid);
      continue;
    }
    keys.set(jwk.kid, key);
  }
  return keys.size > 0 ? keys : null;
}

export function createKeySet({ fetchKeySet = () => fetchJwks(), now = Date.now } = {}) {
  let cache = null; // { keys: Map<kid, KeyObject>, expiresAt: ms }
  let inFlight = null;
  let lastAttemptAt = -Infinity;

  const unexpired = () => (cache !== null && now() < cache.expiresAt ? cache.keys : null);

  async function fetchOnce() {
    try {
      const { body, cacheControl } = await fetchKeySet();
      const keys = parseKeySet(body);
      if (keys === null) return;
      cache = { keys, expiresAt: now() + maxAgeSeconds(cacheControl) * 1000 };
    } catch {
      // A failed fetch changes nothing: the unexpired cache, if any, stays in use.
    }
  }

  // The one place a fetch can start. Returns the in-flight attempt, or null when the budget is
  // spent. `.finally` runs after the assignment, so a fetch that fails synchronously cannot leave
  // a settled promise parked in inFlight.
  function attempt() {
    if (inFlight !== null) return inFlight;
    const at = now();
    if (at - lastAttemptAt < JWKS_MIN_FETCH_INTERVAL_MS) return null;
    lastAttemptAt = at;
    inFlight = fetchOnce().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return {
    async current() {
      const cached = unexpired();
      if (cached !== null) return cached;
      const pending = attempt();
      if (pending !== null) await pending;
      return unexpired();
    },
    async refreshForUnknownKid() {
      const pending = attempt();
      if (pending !== null) await pending;
      return unexpired();
    },
  };
}
