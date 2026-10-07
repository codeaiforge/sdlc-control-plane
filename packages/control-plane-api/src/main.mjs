import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { evaluateGuardrails } from '../../guardrail-policy/src/evaluate.mjs';
import { EVIDENCE_ATTESTATION, summarizeEvidence } from '../../indicators/src/summarize.mjs';
import { createAuthenticator, submittedBy } from '../../workload-identity/src/authenticate.mjs';
import { ISSUER, isRefusedActor } from '../../workload-identity/src/constants.mjs';
import { createKeySet } from '../../workload-identity/src/key-set.mjs';
import {
  ACCEPTED_ISSUERS,
  admits,
  bindingKey,
  createRegistry,
} from '../../workspace-registry/src/registry.mjs';
import {
  HEADERS_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  createSubmissionQuota,
  readBodyCapped,
} from './admission.mjs';
import { createInMemoryEvidenceStore, project } from './evidence-store.mjs';
import { refusalEvent, stderrLog } from './refusal-log.mjs';

// createRegistry validates every registration at load and throws, and refuses a document whose
// registry_version is not workspace-registry/1. The policy was the one configuration loaded
// unchecked. openapi.json requires policy_id on an accepted decision
// because an acceptance that names no approved policy is not traceable (FR-3.1, NFR-6.1), and
// evaluateGuardrails passes policy.policy_id straight through - so an unvalidated policy file
// makes the seam emit a 202 its own published schema rejects. Fail at startup instead.
export function assertUsablePolicy(candidate) {
  const errors = [];
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate))
    return ['policy must be an object'];
  if (candidate.policy_version !== 'guardrails/0')
    errors.push('policy_version must be guardrails/0');
  if (typeof candidate.policy_id !== 'string' || candidate.policy_id.length === 0)
    errors.push('policy_id must be a non-empty string');
  return errors;
}

// The issuer is written twice - workload-identity's ISSUER, which step 4 compares `iss` against,
// and contracts' ACCEPTED_ISSUERS, which a registration is checked against - because
// workload-identity imports nothing and this package must not import contracts (its fan-in would
// reach 3). Prose cannot keep two copies equal; this check refuses to start when they differ, so
// a registration can never bind to an issuer whose tokens the verifier would refuse, or the
// reverse.
export function assertIssuerAgreement(accepted = ACCEPTED_ISSUERS, issuer = ISSUER) {
  if (!Array.isArray(accepted) || accepted.length !== 1 || accepted[0] !== issuer)
    return ['ACCEPTED_ISSUERS must be exactly [ISSUER]'];
  return [];
}

const issuerErrors = assertIssuerAgreement();
if (issuerErrors.length > 0)
  throw new Error(`issuer constants disagree: ${issuerErrors.join('; ')}`);

const policy = JSON.parse(
  readFileSync(new URL('../../../config/control-plane/guardrails.json', import.meta.url)),
);
const policyErrors = assertUsablePolicy(policy);
if (policyErrors.length > 0)
  throw new Error(`unusable guardrail policy: ${policyErrors.join('; ')}`);

const registry = createRegistry(
  JSON.parse(
    readFileSync(new URL('../../../config/control-plane/workspaces.json', import.meta.url)),
  ),
);
// One store, one key set, one quota per process, created at module scope exactly as the store
// was before them, so the running service keeps one of each. createApp() takes injection seams
// instead of reaching for these bindings, so a test can hold its own without sharing these.
// Building them does no I/O: the key set's first fetch happens on the first authenticated
// request, so importing this module (the threat-model check does) fetches nothing.
const defaultEvidenceStore = createInMemoryEvidenceStore();
const defaultAuthenticate = createAuthenticator({ keySet: createKeySet() });
const defaultQuota = createSubmissionQuota();

// Every response goes through here, and every call site passes its status as a literal, so
// openapi.contract.test.mjs can read the complete set of statuses this seam sends out of this
// file's source. `closeAfter` is respond-then-destroy: the response is written and flushed with
// `connection: close`, and only then is the request destroyed, so the caller reads the status
// and the unread body is never drained (threat model › Ingress body limit, Disposition).
function send(response, status, body, { headers = {}, closeAfter } = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    ...headers,
    ...(closeAfter ? { connection: 'close' } : {}),
  });
  if (closeAfter) response.end(payload, () => closeAfter.destroy());
  else response.end(payload);
}

// MIT-17. The event is built from the matched route entry and the reason code, never from the
// request; a throwing sink or a defective event never reaches the response.
function logRefusal({ log, now }, route, status, reason, caller) {
  try {
    log(
      refusalEvent({
        at: new Date(now()).toISOString(),
        route,
        status,
        reason,
        principal: caller?.principal,
        workspaceId: caller?.workspaceId,
      }),
    );
  } catch {
    // Logging is best-effort; the refusal has been decided and is answered regardless.
  }
}

const INVALID_TOKEN = { error: 'invalid token' };
const WWW_AUTHENTICATE = { 'www-authenticate': 'Bearer error="invalid_token"' };
const FORBIDDEN = { error: 'forbidden' };
const KEY_SET_UNAVAILABLE = { error: 'key set unavailable' };

// Step 6, the one "authorized for W" predicate every route but GET /health applies (ADR-0003 ›
// Route authorization): the verified triple binds to W, read back through registry.get; W is
// active, admits the token's event and its pins match; and the actor is not refused. Every
// failure is the same 403 on the wire; only the log tells them apart.
function authorizeFor({ registry }, principal) {
  const workspaceId = registry.bindingFor(principal);
  if (workspaceId === undefined) return { ok: false, reason: 'no-binding' };
  const registration = registry.get(workspaceId);
  if (registration === undefined) return { ok: false, reason: 'no-binding' };
  const refusal = admits(registration, principal);
  if (refusal !== null) return { ok: false, reason: refusal, workspaceId };
  if (isRefusedActor(principal.actor_id))
    return { ok: false, reason: 'refused-actor', workspaceId };
  return { ok: true, workspaceId };
}

// Steps 1-6, from the request line and headers alone: no body byte is read before a caller is
// authorized, and every refusal here is respond-then-destroy. Returns the caller, or null once it
// has answered.
async function authorizeRequest(context, route, request, response) {
  const result = await context.authenticate(request);
  if (!result.ok) {
    logRefusal(context, route, result.status, result.reason);
    if (result.status === 503) send(response, 503, KEY_SET_UNAVAILABLE, { closeAfter: request });
    else send(response, 401, INVALID_TOKEN, { headers: WWW_AUTHENTICATE, closeAfter: request });
    return null;
  }
  const decision = authorizeFor(context, result.principal);
  if (!decision.ok) {
    logRefusal(context, route, 403, decision.reason, {
      principal: result.principal,
      workspaceId: decision.workspaceId,
    });
    send(response, 403, FORBIDDEN, { closeAfter: request });
    return null;
  }
  const { issuer, repository_owner_id, repository_id } = result.principal;
  return {
    route,
    principal: result.principal,
    workspaceId: decision.workspaceId,
    bindingKey: bindingKey(issuer, repository_owner_id, repository_id),
  };
}

// The routes are data so that something other than a reader can enumerate them. openapi.json
// claims a set of routes, statuses and security requirements, and openapi.contract.test.mjs
// compares that claim against this table rather than against a description of it. `auth` is
// 'none' or 'workload'; anything but 'none' is authenticated, so a route that forgets the field
// fails closed.
export const routes = [
  {
    method: 'GET',
    path: '/health',
    auth: 'none',
    handle: (context, request, response) => send(response, 200, { status: 'ok' }),
  },
  {
    method: 'GET',
    path: '/v1/workspaces',
    auth: 'workload',
    // Exactly the caller's own registration; no other is disclosed (MIT-3).
    handle: ({ registry }, request, response, caller) =>
      send(response, 200, { data: [registry.get(caller.workspaceId)] }),
  },
  {
    method: 'GET',
    path: '/v1/indicators',
    auth: 'workload',
    // Only W's envelopes, and only those that still carry a payload - the filter listRecords()
    // applies - taken through list() so the port does not change (ADR-0003 › Route authorization).
    handle: async ({ evidenceStore }, request, response, caller) => {
      const envelopes = await evidenceStore.list();
      const records = envelopes
        .filter((envelope) => envelope.workspace_id === caller.workspaceId)
        .filter((envelope) => envelope.evidence !== null)
        .map((envelope) => envelope.evidence);
      return send(response, 200, { data: summarizeEvidence(records) });
    },
  },
  {
    method: 'POST',
    path: '/v1/evidence',
    auth: 'workload',
    handle: async (context, request, response, caller) => {
      const { policy, evidenceStore, quota } = context;
      const { route } = caller;
      // Counted before the body is read, so a 413, 400 or 422 still costs a submission: each of
      // them has already cost a read. Per process - see admission.mjs.
      const allowance = quota.take(caller.bindingKey);
      if (!allowance.ok) {
        logRefusal(context, route, 429, 'quota-exceeded', caller);
        return send(
          response,
          429,
          { error: 'submission quota exceeded' },
          { headers: { 'retry-after': String(allowance.retryAfterS) }, closeAfter: request },
        );
      }
      // The try spans the body read, the parse and the evaluation. Narrowing it would change
      // what a fault puts on the wire: a throw inside this span is answered with the
      // documented 400 envelope, whereas outside it the throw escapes the handler, rejects
      // the returned promise and leaves the caller with no response at all. The body read is
      // inside for that reason and not only for tidiness — a client that opens a POST and
      // drops the socket makes the read throw, and an unhandled rejection there terminates
      // the process under Node's default behaviour, which `nx serve` runs with.
      try {
        // The cap is a returned value, never a throw: this catch would answer a thrown 413 as
        // 400. Enforced before JSON.parse and before project(), from inside the read loop.
        const read = await readBodyCapped(request);
        if (!read.ok) {
          logRefusal(context, route, 413, 'body-too-large', caller);
          return send(response, 413, { error: 'request body too large' }, { closeAfter: request });
        }
        // Decoded once, after the concat: a multi-byte character straddling a chunk boundary
        // would otherwise become U+FFFD - silent corruption of the change_id that ties evidence
        // to a change, which no contract check can catch.
        const record = JSON.parse(read.body.toString('utf8'));
        // Projected before the policy is evaluated, not after. JSON.stringify is recursive where
        // JSON.parse is not, so a body the seam parses can still be unprojectable; running policy
        // first would let the control plane compute "accepted" for a record it then loses, and
        // answer the caller with a body-fault 400 for JSON that was valid. Refuse it first.
        project(record);
        const evaluated = evaluateGuardrails(record, policy);
        // Every disposition says what it rests on: the workload's own claims (ADR-0004).
        const decision = { ...evaluated, evidence_attestation: EVIDENCE_ATTESTATION };
        if (!decision.accepted) {
          logRefusal(context, route, 422, decision.disposition, caller);
          return send(response, 422, { decision });
        }
        // workspace_id and submitted_by come from the verified principal, never from the body.
        await evidenceStore.append(record, {
          workspace_id: caller.workspaceId,
          policy_id: decision.policy_id ?? null,
          submitted_by: submittedBy(caller.principal),
        });
        return send(response, 202, { decision });
      } catch {
        logRefusal(context, route, 400, 'body-not-json', caller);
        return send(response, 400, { error: 'request body must be valid JSON' });
      }
    },
  },
];

export function createRequestHandler({
  registry,
  policy,
  evidenceStore,
  authenticate,
  quota,
  log = stderrLog,
  now = Date.now,
}) {
  // No default authenticator here: a handler built without one must not exist, rather than
  // exist and fail on its first request.
  if (typeof authenticate !== 'function')
    throw new TypeError('createRequestHandler needs an authenticate function');
  const context = {
    registry,
    policy,
    evidenceStore,
    authenticate,
    quota: quota ?? createSubmissionQuota({ now }),
    log,
    now,
  };
  return async (request, response) => {
    // .find() over the table performs the same two === comparisons, in the same order, as the
    // if-chain it replaced. Routing comes first: a request that matches no entry is answered
    // 404 before any credential is read, and a query string - access_token included - makes a
    // request unmatched, because request.url is compared whole.
    const route = routes.find(
      (candidate) => candidate.method === request.method && candidate.path === request.url,
    );
    if (!route) {
      logRefusal(context, null, 404, 'unmatched-route');
      return send(response, 404, { error: 'not found' });
    }
    // GET /health reads no credential, even when one is sent.
    if (route.auth === 'none') return route.handle(context, request, response);
    const caller = await authorizeRequest(context, route, request, response);
    if (caller === null) return;
    return route.handle(context, request, response, caller);
  };
}

export function createApp({
  evidenceStore = defaultEvidenceStore,
  authenticate = defaultAuthenticate,
  log = stderrLog,
} = {}) {
  return createServer(
    { headersTimeout: HEADERS_TIMEOUT_MS, requestTimeout: REQUEST_TIMEOUT_MS },
    createRequestHandler({
      registry,
      policy,
      evidenceStore,
      authenticate,
      quota: defaultQuota,
      log,
    }),
  );
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const port = Number(process.env.PORT ?? 3000);
  createApp().listen(port, () => console.log(`control plane scaffold listening on :${port}`));
}
