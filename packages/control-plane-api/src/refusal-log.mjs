// MIT-17: every refusal is logged with its route, status and reason, and with the principal only
// once step 5 has produced one. One JSON object per line on stderr. Since task 2.3 the line is
// written by telemetry.record (telemetry.mjs), which the seam's send() calls for every response,
// so a refusal cannot be answered without being counted and logged.
//
// The shape is closed and nothing outside it can reach a line:
//
//   { event: 'refusal', at, route, status, reason, duration_ms, principal? }
//
// - `route` is the matched route table entry, never request.url, which can carry an
//   access_token query string; an unmatched request is logged as 'unmatched', without its URL.
// - `reason` is a member of REFUSAL_REASONS. A 422 logs its disposition, never the reasons list,
//   which quotes the submitted record.
// - `duration_ms` is the seam's handling time in whole milliseconds, a number the seam measured.
// - `principal` holds four numeric identifiers and the bound workspace_id, nothing else. `ref`,
//   `workflow_ref`, `actor` and `sub` are names a person chooses and are never logged. Before
//   step 5 there is no principal at all: an unverified token's repository_id would blame a
//   repository that sent nothing (ADR-0003 › Credential transport).
// - No error message is ever logged. In current V8 a JSON.parse error quotes part of its input,
//   so an error caught while decoding a token can carry token bytes; a database driver's error
//   can carry the failing row and the bound parameters. Callers map a catch to a reason code and
//   drop the error.
// Never the body, the token or the Authorization value, whatever the status.

export const REFUSAL_REASONS = Object.freeze([
  // 401
  'credential-missing',
  'credential-repeated',
  'credential-malformed',
  'token-too-large',
  'header-invalid',
  'alg-unsupported',
  'kid-unknown',
  'signature-invalid',
  'iss-mismatch',
  'aud-mismatch',
  'token-expired',
  'token-not-yet-valid',
  'iat-in-future',
  'lifetime-exceeded',
  'claim-invalid',
  // 503
  'key-set-unavailable',
  'verifier-fault',
  // 403
  'no-binding',
  'not-active',
  'event-not-admitted',
  'pin-ref',
  'pin-sha',
  'refused-actor',
  // 429, 413, 400, 422, 404
  'quota-exceeded',
  'body-too-large',
  // The body read threw: the client hung up, or Node's own requestTimeout answered 408 and
  // destroyed the socket mid-body (measured, task 2.3). Before 2.3 it was logged body-not-json.
  'body-read-failed',
  'body-not-json',
  'rejected',
  'needs-remediation',
  'unmatched-route',
  // 409: a different body under a key already held (ADR-0002); the first record stands
  'conflict',
  // 503 after authorization: the evidence store failed, or anything else in a route did
  'store-unavailable',
  'handler-fault',
]);

const PRINCIPAL_IDS = ['repository_owner_id', 'repository_id', 'run_id', 'run_attempt'];

// The four numeric identifiers of a verified principal, and the bound workspace_id when there is
// one. Every event that names a caller builds it here, so no event can name one differently.
export function principalFields(principal, workspaceId) {
  const fields = Object.fromEntries(PRINCIPAL_IDS.map((key) => [key, principal[key]]));
  if (workspaceId !== undefined) fields.workspace_id = workspaceId;
  return fields;
}

// The route as a line names it: the matched table entry's method and path, or 'unmatched'.
export const routeName = (route) => (route ? `${route.method} ${route.path}` : 'unmatched');

// Builds the event from parts the seam controls. An unknown reason throws: it is a defect in the
// seam, never something a caller can send, and send() keeps the throw away from the response.
export function refusalEvent({ at, route, status, reason, durationMs, principal, workspaceId }) {
  if (!REFUSAL_REASONS.includes(reason)) throw new TypeError('refusal reason is not in the list');
  if (!Number.isInteger(durationMs) || durationMs < 0)
    throw new TypeError('duration_ms must be a whole number of milliseconds');
  const event = {
    event: 'refusal',
    at,
    route: routeName(route),
    status,
    reason,
    duration_ms: durationMs,
  };
  if (principal) event.principal = principalFields(principal, workspaceId);
  return event;
}

// The default sink, and the only writer of event lines. A failed write must never take the
// process down or change the response, so it is swallowed: the response has already been decided.
export function stderrLog(event) {
  try {
    process.stderr.write(`${JSON.stringify(event)}\n`);
  } catch {
    // Nothing to do: logging is best-effort, the refusal stands.
  }
}
