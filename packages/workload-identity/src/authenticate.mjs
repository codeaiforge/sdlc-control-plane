import {
  AUDIENCE,
  CLOCK_SKEW_S,
  ISSUER,
  MAX_KID_LENGTH,
  MAX_LIFETIME_S,
  MAX_TOKEN_BYTES,
} from './constants.mjs';
import { decodeJsonSegment, splitCompact, verifyRs256 } from './jws.mjs';

// Steps 1-5 of ADR-0003's validation order, in exactly that order, each returning on its first
// failure so the status a malformed or forged token gets is the same every time:
//
//   1. header syntax                                         401
//   2. key set available                                     503
//   3. alg, kid, signature                                   401
//   4. iss, aud, exp / nbf / iat, lifetime                   401
//   5. claim types and formats -> a frozen principal         401
//
// Step 6 (binding, status, event, pins, refused actor -> 403) needs the registry and lives in
// the seam. One consequence of the order is deliberate and tested: an HS256 token with no key set
// available is 503, not 401, because step 2 runs before step 3 looks at `alg`.
//
// Nothing here returns or logs an error message. Every refusal is a reason code from the seam's
// closed vocabulary (refusal-log.mjs), because a caught decoding error can quote token bytes.

const own = (object, key) => Object.hasOwn(object, key);
const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;
const isTime = (value) => typeof value === 'number' && Number.isFinite(value);

// Canonical decimal: no sign, no leading zero, at most 20 digits, compared as a string and never
// parsed - a number loses precision above 2^53 and reads "074" as 74 (ADR-0003 › Registration).
const CANONICAL_ID = /^[1-9][0-9]{0,19}$/;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const SHA1_HEX = /^[0-9a-f]{40}$/;
// RFC 6750's `Bearer 1*SP b64token`, scheme case-insensitive.
const BEARER = /^bearer +(\S+)$/i;

const refuse = (reason, status = 401) => ({ ok: false, status, reason });

// Counted in rawHeaders, never read from request.headers: Node keeps only the first of a
// repeated Authorization there, silently, so a repeat is visible in rawHeaders alone.
export function readCredential(rawHeaders) {
  let count = 0;
  let value;
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    if (String(rawHeaders[index]).toLowerCase() === 'authorization') {
      count += 1;
      value = rawHeaders[index + 1];
    }
  }
  if (count === 0) return refuse('credential-missing');
  if (count > 1) return refuse('credential-repeated');
  const match = typeof value === 'string' ? BEARER.exec(value) : null;
  if (!match) return refuse('credential-malformed');
  const token = match[1];
  // Before any decode: an oversized token costs a length check and nothing else.
  if (Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) return refuse('token-too-large');
  return { ok: true, token };
}

export function checkRegisteredClaims(payload, nowS) {
  if (!own(payload, 'iss') || payload.iss !== ISSUER) return refuse('iss-mismatch');
  const aud = own(payload, 'aud') ? payload.aud : undefined;
  const audienceOk =
    aud === AUDIENCE || (Array.isArray(aud) && aud.length === 1 && aud[0] === AUDIENCE);
  if (!audienceOk) return refuse('aud-mismatch');
  for (const claim of ['exp', 'nbf', 'iat']) {
    if (!own(payload, claim) || !isTime(payload[claim])) return refuse('claim-invalid');
  }
  if (!(payload.exp > nowS - CLOCK_SKEW_S)) return refuse('token-expired');
  if (payload.nbf > nowS + CLOCK_SKEW_S) return refuse('token-not-yet-valid');
  if (payload.iat > nowS + CLOCK_SKEW_S) return refuse('iat-in-future');
  if (payload.exp - payload.iat > MAX_LIFETIME_S) return refuse('lifetime-exceeded');
  return { ok: true };
}

const REQUIRED_STRING_CLAIMS = ['event_name', 'ref', 'workflow_ref'];

// Presence is Object.hasOwn, so a claim reachable only through the prototype chain is absent.
export function checkClaimFormats(payload) {
  for (const claim of ['repository_owner_id', 'repository_id', 'actor_id']) {
    if (!own(payload, claim) || typeof payload[claim] !== 'string') return refuse('claim-invalid');
    if (!CANONICAL_ID.test(payload[claim])) return refuse('claim-invalid');
  }
  for (const claim of ['run_id', 'run_attempt']) {
    if (!own(payload, claim) || typeof payload[claim] !== 'string') return refuse('claim-invalid');
    if (!POSITIVE_INTEGER.test(payload[claim])) return refuse('claim-invalid');
  }
  if (!own(payload, 'sha') || typeof payload.sha !== 'string' || !SHA1_HEX.test(payload.sha))
    return refuse('claim-invalid');
  for (const claim of REQUIRED_STRING_CLAIMS) {
    if (!own(payload, claim) || !isNonEmptyString(payload[claim])) return refuse('claim-invalid');
  }
  if (own(payload, 'job_workflow_ref') && !isNonEmptyString(payload.job_workflow_ref))
    return refuse('claim-invalid');
  if (
    own(payload, 'job_workflow_sha') &&
    !(typeof payload.job_workflow_sha === 'string' && SHA1_HEX.test(payload.job_workflow_sha))
  )
    return refuse('claim-invalid');
  return {
    ok: true,
    principal: Object.freeze({
      issuer: payload.iss,
      repository_owner_id: payload.repository_owner_id,
      repository_id: payload.repository_id,
      actor_id: payload.actor_id,
      run_id: payload.run_id,
      run_attempt: payload.run_attempt,
      sha: payload.sha,
      ref: payload.ref,
      event_name: payload.event_name,
      workflow_ref: payload.workflow_ref,
      job_workflow_ref: own(payload, 'job_workflow_ref') ? payload.job_workflow_ref : null,
      job_workflow_sha: own(payload, 'job_workflow_sha') ? payload.job_workflow_sha : null,
    }),
  };
}

export function createAuthenticator({ keySet, now = Date.now }) {
  async function verifySteps(request) {
    // Step 1.
    const credential = readCredential(request.rawHeaders ?? []);
    if (!credential.ok) return credential;
    const compact = splitCompact(credential.token);
    if (!compact.ok) return refuse('credential-malformed');
    const { header } = compact;
    if (typeof header.alg !== 'string') return refuse('header-invalid');
    if (
      typeof header.kid !== 'string' ||
      header.kid.length === 0 ||
      header.kid.length > MAX_KID_LENGTH
    )
      return refuse('header-invalid');
    if (own(header, 'crit')) return refuse('header-invalid');

    // Step 2.
    const keys = await keySet.current();
    if (keys === null) return refuse('key-set-unavailable', 503);

    // Step 3. jku, jwk, x5u, x5c and x5t are never read: a key comes only from the pinned set.
    if (header.alg !== 'RS256') return refuse('alg-unsupported');
    let key = keys.get(header.kid);
    if (key === undefined) key = (await keySet.refreshForUnknownKid())?.get(header.kid);
    if (key === undefined) return refuse('kid-unknown');
    if (!verifyRs256(compact.signingInput, compact.signature, key))
      return refuse('signature-invalid');

    // Step 4. The payload is decoded only now, after the signature verifies.
    const payload = decodeJsonSegment(compact.payloadSegment);
    if (!payload.ok) return refuse('claim-invalid');
    const registered = checkRegisteredClaims(payload.value, now() / 1000);
    if (!registered.ok) return registered;

    // Step 5.
    return checkClaimFormats(payload.value);
  }

  // Never throws. A throw here is the control plane's fault, not the caller's credential, so it
  // is answered 503 rather than 401 (design deviation D-c), and the error itself is dropped.
  return async function authenticate(request) {
    try {
      return await verifySteps(request);
    } catch {
      return refuse('verifier-fault', 503);
    }
  };
}

// ADR-0004's eleven fields, in its order, from verified claims only. sub, repository, actor and
// actor_id never reach it: names are not identity here (FR-1.2), and actor_id is only consulted
// for the refused-actor rule.
export function submittedBy(principal) {
  return {
    issuer: principal.issuer,
    repository_owner_id: principal.repository_owner_id,
    repository_id: principal.repository_id,
    run_id: principal.run_id,
    run_attempt: principal.run_attempt,
    sha: principal.sha,
    ref: principal.ref,
    event_name: principal.event_name,
    workflow_ref: principal.workflow_ref,
    job_workflow_ref: principal.job_workflow_ref,
    job_workflow_sha: principal.job_workflow_sha,
  };
}
