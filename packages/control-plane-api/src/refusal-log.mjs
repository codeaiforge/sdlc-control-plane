// MIT-17: every refusal is logged with its route, status and reason, and with the principal only
// once step 5 has produced one. One JSON object per line on stderr.
//
// The shape is closed and nothing outside it can reach a line:
//
//   { event: 'refusal', at, route, status, reason, principal? }
//
// - `route` is the matched route table entry, never request.url, which can carry an
//   access_token query string; an unmatched request is logged as 'unmatched', without its URL.
// - `reason` is a member of REFUSAL_REASONS. A 422 logs its disposition, never the reasons list,
//   which quotes the submitted record.
// - `principal` holds four numeric identifiers and the bound workspace_id, nothing else. `ref`,
//   `workflow_ref`, `actor` and `sub` are names a person chooses and are never logged. Before
//   step 5 there is no principal at all: an unverified token's repository_id would blame a
//   repository that sent nothing (ADR-0003 › Credential transport).
// - No error message is ever logged. In current V8 a JSON.parse error quotes part of its input,
//   so an error caught while decoding a token can carry token bytes. Callers map a catch to a
//   reason code and drop the error.
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
  'body-not-json',
  'rejected',
  'needs-remediation',
  'unmatched-route',
]);

const PRINCIPAL_IDS = ['repository_owner_id', 'repository_id', 'run_id', 'run_attempt'];

// Builds the event from parts the seam controls. An unknown reason throws: it is a defect in the
// seam, never something a caller can send, and the seam's log wrapper keeps the throw away from
// the response.
export function refusalEvent({ at, route, status, reason, principal, workspaceId }) {
  if (!REFUSAL_REASONS.includes(reason)) throw new TypeError('refusal reason is not in the list');
  const event = {
    event: 'refusal',
    at,
    route: route ? `${route.method} ${route.path}` : 'unmatched',
    status,
    reason,
  };
  if (principal) {
    event.principal = Object.fromEntries(PRINCIPAL_IDS.map((key) => [key, principal[key]]));
    if (workspaceId !== undefined) event.principal.workspace_id = workspaceId;
  }
  return event;
}

// The default sink. A failed write must never take the process down or change the response, so
// it is swallowed: the refusal has already been answered.
export function stderrLog(event) {
  try {
    process.stderr.write(`${JSON.stringify(event)}\n`);
  } catch {
    // Nothing to do: logging is best-effort, the refusal stands.
  }
}
