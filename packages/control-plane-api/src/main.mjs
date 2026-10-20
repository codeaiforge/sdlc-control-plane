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
  CONNECTIONS_CHECKING_INTERVAL_MS,
  HEADERS_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  createSubmissionQuota,
  readBodyCapped,
} from './admission.mjs';
import {
  StartupRefused,
  openDurableEvidenceStore,
} from '../../evidence-store/src/database-config.mjs';
import { project } from '../../evidence-store/src/evidence-store.mjs';
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
// One key set and one quota per process, created at module scope, so the running service keeps
// one of each. createApp() takes injection seams instead of reaching for these bindings, so a test
// can hold its own without sharing these. Building them does no I/O: the key set's first fetch
// happens on the first authenticated request, so importing this module (the threat-model check
// does) fetches nothing. There is no store here: the durable one is opened by the entry block
// below, which needs the database, and a test injects its own - so importing this module reads no
// database configuration and builds no client.
const defaultAuthenticate = createAuthenticator({ keySet: createKeySet() });
const defaultQuota = createSubmissionQuota();

// The statuses that refuse a request without reading its body: 404, 401, 503, 403 and 429 are
// decided on the request line and headers, 413 on content-length or part-way through the read.
// Each one closes the connection whatever the body's state (ADR-0003 › Wire statuses). 503 is
// also the answer to a store or handler fault, after the body has been read; closing then costs
// the caller a reconnect and nothing else.
const REFUSED_UNREAD = new Set([404, 401, 503, 403, 429, 413]);

// True while the request declares a body the parser has not yet seen the end of. `complete`
// alone will not do: it turns true only after the handler has run, even for a request with no
// body, so it would close every keep-alive connection. A request with neither header has no body.
function bodyUnread(request) {
  if (request.complete === true) return false;
  const headers = request.headers ?? {};
  return headers['transfer-encoding'] !== undefined || Number(headers['content-length']) > 0;
}

// Every response goes through here, and every call site passes its status as a literal, so
// openapi.contract.test.mjs can read the complete set of statuses this seam sends out of this
// file's source. It is also the one place a connection is closed: a refusal, or any response sent
// while the body is still unread, is respond-then-destroy - written and flushed with
// `connection: close`, and only then is the request destroyed - so the caller reads the status and
// the unread body is never drained, which would hand the peer the transfer it was refused (threat
// model › Ingress body limit, Disposition). For any other response the seam closes nothing; whether
// the connection then stays open is Node's decision (Connection: close, HTTP/1.0, an unanswered
// Expect: 100-continue all close it), so no keep-alive is promised.
function send(response, status, body, request, { headers = {} } = {}) {
  const payload = JSON.stringify(body);
  const close = REFUSED_UNREAD.has(status) || bodyUnread(request);
  response.writeHead(status, {
    'content-type': 'application/json',
    ...headers,
    ...(close ? { connection: 'close' } : {}),
  });
  if (close) response.end(payload, () => request.destroy());
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
// A store failure is the control plane's fault, never the caller's body (ADR-0002 Consequences):
// it is answered 503, retry-safe because intake is idempotent - a commit whose answer was lost
// replays as a duplicate. No driver message ever reaches a body or a log line.
const STORE_UNAVAILABLE = { error: 'evidence store unavailable' };
const SERVICE_UNAVAILABLE = { error: 'service unavailable' };

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
    if (result.status === 503) send(response, 503, KEY_SET_UNAVAILABLE, request);
    else send(response, 401, INVALID_TOKEN, request, { headers: WWW_AUTHENTICATE });
    return null;
  }
  const decision = authorizeFor(context, result.principal);
  if (!decision.ok) {
    logRefusal(context, route, 403, decision.reason, {
      principal: result.principal,
      workspaceId: decision.workspaceId,
    });
    send(response, 403, FORBIDDEN, request);
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
    handle: (context, request, response) => send(response, 200, { status: 'ok' }, request),
  },
  {
    method: 'GET',
    path: '/v1/workspaces',
    auth: 'workload',
    // Exactly the caller's own registration; no other is disclosed (MIT-3).
    handle: ({ registry }, request, response, caller) =>
      send(response, 200, { data: [registry.get(caller.workspaceId)] }, request),
  },
  {
    method: 'GET',
    path: '/v1/indicators',
    auth: 'workload',
    // Only W's envelopes, and only those that still carry a payload - the filter listRecords()
    // applies - taken through list() so the port does not change (ADR-0003 › Route authorization).
    // The store reads W's rows only (RR-10); the two filters below stay as defence in depth.
    handle: async (context, request, response, caller) => {
      let envelopes;
      try {
        envelopes = await context.evidenceStore.list({ workspace_id: caller.workspaceId });
      } catch {
        logRefusal(context, caller.route, 503, 'store-unavailable', caller);
        return send(response, 503, STORE_UNAVAILABLE, request);
      }
      const records = envelopes
        .filter((envelope) => envelope.workspace_id === caller.workspaceId)
        .filter((envelope) => envelope.evidence !== null)
        .map((envelope) => envelope.evidence);
      return send(response, 200, { data: summarizeEvidence(records) }, request);
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
        return send(response, 429, { error: 'submission quota exceeded' }, request, {
          headers: { 'retry-after': String(allowance.retryAfterS) },
        });
      }
      // The try spans the body read, the parse, the evaluation and the append. A throw inside it
      // is answered with the documented 400 envelope - a body the caller got wrong - except a
      // store failure, which the append's own catch answers 503 first. The body read is inside
      // for a reason beyond tidiness: a client that opens a POST and drops the socket makes the
      // read throw. Anything that still escapes is the request handler's catch-all's (503).
      try {
        // The cap is a returned value, never a throw: this catch would answer a thrown 413 as
        // 400. Enforced before JSON.parse and before project(), from inside the read loop.
        // `Expect: 100-continue` is answered here and nowhere else: after authentication,
        // authorization, the quota and the content-length fast path, so a request refused by any
        // of them is never invited to send its body (createSeamServer stops Node's automatic 100).
        const read = await readBodyCapped(request, {
          beforeRead: caller.awaitsContinue ? () => response.writeContinue() : undefined,
        });
        if (!read.ok) {
          logRefusal(context, route, 413, 'body-too-large', caller);
          return send(response, 413, { error: 'request body too large' }, request);
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
          return send(response, 422, { decision }, request);
        }
        // workspace_id and submitted_by come from the verified principal, never from the body.
        // The write completes before the 202 is written: nothing is queued (ADR-0002 "The 202").
        let appended;
        try {
          appended = await evidenceStore.append(record, {
            workspace_id: caller.workspaceId,
            policy_id: decision.policy_id ?? null,
            submitted_by: submittedBy(caller.principal),
          });
        } catch (error) {
          // By class, not by message: a TypeError is a record the store cannot keep (the depth
          // band in divergence 5), the caller's fault, answered 400 by the catch below. Anything
          // else - unreachable, refused, timed out, an envelope option the seam built wrongly -
          // is the control plane's.
          if (error instanceof TypeError) throw error;
          logRefusal(context, route, 503, 'store-unavailable', caller);
          return send(response, 503, STORE_UNAVAILABLE, request);
        }
        // A different body under a key already held (ADR-0002): nothing was appended and the
        // first record stands. The answer names the key - the caller's own workspace and change -
        // and never carries the stored payload, which the caller may not have sent.
        if (appended.outcome === 'conflict') {
          logRefusal(context, route, 409, 'conflict', caller);
          return send(response, 409, { error: 'conflict', idempotency_key: appended.key }, request);
        }
        // `appended` or `duplicate`: a replay is answered with the decision computed for the
        // replay (openapi.json divergence 6).
        return send(response, 202, { decision }, request);
      } catch {
        logRefusal(context, route, 400, 'body-not-json', caller);
        return send(response, 400, { error: 'request body must be valid JSON' }, request);
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
  // `awaitsContinue` is set only by createSeamServer's 'checkContinue' route: the client sent
  // `Expect: 100-continue` and Node has not answered it.
  return async (request, response, { awaitsContinue = false } = {}) => {
    // .find() over the table performs the same two === comparisons, in the same order, as the
    // if-chain it replaced. Routing comes first: a request that matches no entry is answered
    // 404 before any credential is read, and a query string - access_token included - makes a
    // request unmatched, because request.url is compared whole.
    const route = routes.find(
      (candidate) => candidate.method === request.method && candidate.path === request.url,
    );
    if (!route) {
      logRefusal(context, null, 404, 'unmatched-route');
      return send(response, 404, { error: 'not found' }, request);
    }
    // GET /health reads no credential, even when one is sent. It does no I/O and cannot reject.
    if (route.auth === 'none') return route.handle(context, request, response);
    // The catch-all (2.1 SEC-6): a rejection anywhere in an authenticated route is answered 503
    // and logged, and the promise this returns never rejects - an unhandled rejection terminates
    // the process under Node's default, which `nx serve` runs with. If a response is already on
    // the wire, all that is left to do is close it.
    let caller = null;
    try {
      caller = await authorizeRequest(context, route, request, response);
      if (caller === null) return;
      return await route.handle(context, request, response, { ...caller, awaitsContinue });
    } catch {
      logRefusal(context, route, 503, 'handler-fault', caller ?? undefined);
      try {
        if (response.headersSent) request.destroy?.();
        else send(response, 503, SERVICE_UNAVAILABLE, request);
      } catch {
        request.destroy?.();
      }
    }
  };
}

// The one place a server is built around a handler, so a test's server is wired exactly as the
// service's: the admission timing constants, and a 'checkContinue' listener. With that listener
// Node sends no automatic `100 Continue`; the handler is told the client is waiting, and only the
// POST handler, once the request is admitted, sends it. A 'checkExpectation' listener does the
// same for any other Expect value: without it Node answers 417 itself, bypassing send(), and then
// reads and discards the body until requestTimeout. The handler ignores the expectation, as
// RFC 9110 permits, so the request is refused or admitted exactly like one without the header.
export function createSeamServer(handler) {
  const server = createServer(
    {
      headersTimeout: HEADERS_TIMEOUT_MS,
      requestTimeout: REQUEST_TIMEOUT_MS,
      connectionsCheckingInterval: CONNECTIONS_CHECKING_INTERVAL_MS,
    },
    handler,
  );
  server.on('checkContinue', (request, response) =>
    handler(request, response, { awaitsContinue: true }),
  );
  server.on('checkExpectation', (request, response) => handler(request, response));
  return server;
}

// No default store, exactly as createRequestHandler has no default authenticator: a service built
// without one must not exist, rather than exist and quietly keep evidence in memory.
export function createApp({
  evidenceStore,
  authenticate = defaultAuthenticate,
  log = stderrLog,
} = {}) {
  if (evidenceStore === undefined || evidenceStore === null)
    throw new TypeError('createApp needs an evidence store');
  return createSeamServer(
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

// The service: the durable store or nothing. openDurableEvidenceStore() reads the PG* variables
// (database-config.mjs, not here) and refuses - an unusable configuration, an unreachable server,
// unverified TLS to a non-loopback host, a role that could rewrite evidence, a schema that is not
// the bundled one - and the process exits 1 with one fixed line, never a driver message.
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const port = Number(process.env.PORT ?? 3000);
  openDurableEvidenceStore().then(
    (evidenceStore) =>
      createApp({ evidenceStore }).listen(port, () =>
        console.log(`control plane listening on :${port}`),
      ),
    (error) => {
      const line =
        error instanceof StartupRefused ? error.message : 'control plane refused to start: failed';
      process.stderr.write(`${line}\n`);
      process.exit(1);
    },
  );
}
