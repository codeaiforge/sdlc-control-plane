import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import {
  evaluateGuardrails,
  validateGuardrailPolicy,
} from '../../guardrail-policy/src/evaluate.mjs';
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
import { StartupRefused, openDurableService } from '../../evidence-store/src/database-config.mjs';
import { project } from '../../evidence-store/src/evidence-store.mjs';
import { createReadiness } from './readiness.mjs';
import { stderrLog } from './refusal-log.mjs';
import { createTelemetry } from './telemetry.mjs';

// createRegistry validates every registration at load and throws; the policy is held to
// validateGuardrailPolicy (guardrails/0, closed at every level) the same way. It checks form: a
// complete approval that is not placeholder-shaped and not dated after the policy takes effect,
// every rule present and well-typed, and the provenance rule on (MIT-12). Whether the approval
// names a decision record is a repository fact, checked by
// tools/sdlc-controls/policy-conformance.test.mjs, not here: a deployed host need not ship the
// record. Anything this refuses stops the service before it listens, and createRequestHandler
// refuses it too, so no seam runs under a policy the validator has not accepted.
export function assertUsablePolicy(candidate) {
  return validateGuardrailPolicy(candidate).errors;
}

// What a seam holds: a deep-frozen copy, and the copy is what the validator checks, so the policy
// the validator accepted is the one every request is evaluated under, whatever a caller does with
// its own object afterwards. A value structuredClone cannot copy throws here. Each object is
// frozen before its children are visited, and a frozen one is not revisited, so a policy that
// refers to itself reaches the validator instead of exhausting the stack.
function heldPolicy(candidate) {
  const freeze = (value) => {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const child of Object.values(value)) freeze(child);
    }
    return value;
  };
  return freeze(structuredClone(candidate));
}

const SHIPPED_POLICY = new URL('../../../config/control-plane/guardrails.json', import.meta.url);

// Read, parse and check, or throw. A parse failure is reported without the file's text, as every
// other reason is reported without a value.
export function loadGuardrailPolicy(url = SHIPPED_POLICY) {
  let candidate;
  try {
    candidate = JSON.parse(readFileSync(url, 'utf8'));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error('unusable guardrail policy: not JSON');
  }
  const held = heldPolicy(candidate);
  const errors = assertUsablePolicy(held);
  if (errors.length > 0) throw new Error(`unusable guardrail policy: ${errors.join('; ')}`);
  return held;
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

const policy = loadGuardrailPolicy();

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

// One exchange per request, registered as the handler's first statement, before routing: the
// telemetry it records to, the matched route once the table is searched, and when it started.
// Module-private, and send() is its only reader, so no route handler can forget it or change it.
const exchanges = new WeakMap();

// Every response goes through here, and every call site passes its status as a literal, so
// openapi.contract.test.mjs can read the complete set of statuses this seam sends out of this
// file's source. Every call site also names its outcome - a literal, or one of four expressions
// whose values telemetry.test.mjs pins - so the complete set of (status, outcome) pairs can be read
// out of it too, and the response is recorded here, before it is written: one send() is one event
// (task 2.3, MIT-18), and a write that throws on a destroyed socket still has its event. A second
// send() for the same request - a fault after the first write attempt - is counted as a late fault,
// never as a second event. Telemetry is decided before the write and cannot change it.
//
// It is also the one place a connection is closed: a refusal, or any response sent
// while the body is still unread, is respond-then-destroy - written and flushed with
// `connection: close`, and only then is the request destroyed - so the caller reads the status and
// the unread body is never drained, which would hand the peer the transfer it was refused (threat
// model › Ingress body limit, Disposition). For any other response the seam closes nothing; whether
// the connection then stays open is Node's decision (Connection: close, HTTP/1.0, an unanswered
// Expect: 100-continue all close it), so no keep-alive is promised.
function send(response, status, body, request, { headers = {}, outcome, caller } = {}) {
  try {
    const exchange = exchanges.get(request);
    if (exchange.recorded) exchange.telemetry.recordLateFault();
    else {
      exchange.recorded = true;
      exchange.telemetry.record({
        route: exchange.route,
        status,
        outcome,
        durationMs: exchange.telemetry.elapsed(exchange.started),
        principal: caller?.principal,
        workspaceId: caller?.workspaceId,
      });
    }
  } catch {
    // Telemetry is best-effort; the response goes out regardless, and the fault is a number in
    // the snapshot (telemetry_faults), never silence.
    try {
      exchanges.get(request)?.telemetry.recordTelemetryFault();
    } catch {
      // Nothing left to count it with.
    }
  }
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

const INVALID_TOKEN = { error: 'invalid token' };
const WWW_AUTHENTICATE = { 'www-authenticate': 'Bearer error="invalid_token"' };
const FORBIDDEN = { error: 'forbidden' };
const KEY_SET_UNAVAILABLE = { error: 'key set unavailable' };
// A store failure is the control plane's fault, never the caller's body (ADR-0002 Consequences):
// it is answered 503, retry-safe because intake is idempotent - a commit whose answer was lost
// replays as a duplicate. No driver message ever reaches a body or a log line.
const STORE_UNAVAILABLE = { error: 'evidence store unavailable' };
const SERVICE_UNAVAILABLE = { error: 'service unavailable' };
const BODY_NOT_JSON = { error: 'request body must be valid JSON' };
// The probes' bodies: a status and nothing else. The reason a probe is not ready is logged, never
// answered (ADR-0005).
const LIVE = { status: 'ok' };
const READY = { status: 'ready' };
const NOT_READY = { status: 'not-ready' };

// Step 6, the one "authorized for W" predicate every route but the two probes applies (ADR-0003 ›
// Route authorization; ADR-0005 for the probe routes): the verified triple binds to W, read back
// through registry.get; W is active, admits the token's event and its pins match; and the actor is
// not refused. Every failure is the same 403 on the wire; only the log tells them apart.
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
// has answered. Before step 5 there is no principal to name; a 403 names the verified one.
async function authorizeRequest(context, route, request, response) {
  const result = await context.authenticate(request);
  if (!result.ok) {
    if (result.status === 503)
      send(response, 503, KEY_SET_UNAVAILABLE, request, { outcome: result.reason });
    else
      send(response, 401, INVALID_TOKEN, request, {
        headers: WWW_AUTHENTICATE,
        outcome: result.reason,
      });
    return null;
  }
  const decision = authorizeFor(context, result.principal);
  if (!decision.ok) {
    send(response, 403, FORBIDDEN, request, {
      outcome: decision.reason,
      caller: { principal: result.principal, workspaceId: decision.workspaceId },
    });
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
// fails closed. `probe: true` marks the two probe routes (ADR-0005): no credential, a status-only
// body, and counted rather than logged line by line.
export const routes = [
  {
    method: 'GET',
    path: '/health',
    auth: 'none',
    probe: true,
    // Liveness: no I/O, no dependency checked.
    handle: (context, request, response) => send(response, 200, LIVE, request, { outcome: 'live' }),
  },
  {
    method: 'GET',
    path: '/ready',
    auth: 'none',
    probe: true,
    // Readiness: one bounded, single-flight, cached database check (readiness.mjs, MIT-22). The
    // 503 closes the connection, as every 503 does. `fault` is the body the catch-all answers a
    // fault on this route with: the contract's 503 here is the closed not-ready body, so a fault
    // is answered with it too (outcome handler-fault, lined), never with an error envelope.
    fault: NOT_READY,
    handle: async ({ readiness }, request, response) => {
      const answer = await readiness.probe();
      if (answer.ready) return send(response, 200, READY, request, { outcome: 'ready' });
      return send(response, 503, NOT_READY, request, { outcome: 'not-ready' });
    },
  },
  {
    method: 'GET',
    path: '/v1/workspaces',
    auth: 'workload',
    // Exactly the caller's own registration; no other is disclosed (MIT-3).
    handle: ({ registry }, request, response, caller) =>
      send(response, 200, { data: [registry.get(caller.workspaceId)] }, request, {
        outcome: 'served',
        caller,
      }),
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
        return send(response, 503, STORE_UNAVAILABLE, request, {
          outcome: 'store-unavailable',
          caller,
        });
      }
      const records = envelopes
        .filter((envelope) => envelope.workspace_id === caller.workspaceId)
        .filter((envelope) => envelope.evidence !== null)
        .map((envelope) => envelope.evidence);
      return send(response, 200, { data: summarizeEvidence(records) }, request, {
        outcome: 'served',
        caller,
      });
    },
  },
  {
    method: 'POST',
    path: '/v1/evidence',
    auth: 'workload',
    handle: async (context, request, response, caller) => {
      const { policy, evidenceStore, quota } = context;
      // Counted before the body is read, so a 413, 400 or 422 still costs a submission: each of
      // them has already cost a read. Per process - see admission.mjs.
      const allowance = quota.take(caller.bindingKey);
      if (!allowance.ok) {
        return send(response, 429, { error: 'submission quota exceeded' }, request, {
          headers: { 'retry-after': String(allowance.retryAfterS) },
          outcome: 'quota-exceeded',
          caller,
        });
      }
      // The try spans the body read, the parse, the evaluation and the append. A throw inside it
      // is answered with the documented 400 envelope - a body the caller got wrong - except a
      // store failure, which the append's own catch answers 503 first. The body read is inside
      // for a reason beyond tidiness: a client that opens a POST and drops the socket makes the
      // read throw, and so does Node's own requestTimeout, which answers 408 itself and destroys
      // the socket mid-body (measured, task 2.3). That throw has its own catch and its own reason,
      // body-read-failed: before 2.3 it was logged body-not-json, which blamed a body nobody had
      // finished sending. The 400 written to the destroyed socket is unchanged. Anything that
      // still escapes is the request handler's catch-all's (503).
      try {
        // The cap is a returned value, never a throw: this catch would answer a thrown 413 as
        // 400. Enforced before JSON.parse and before project(), from inside the read loop.
        // `Expect: 100-continue` is answered here and nowhere else: after authentication,
        // authorization, the quota and the content-length fast path, so a request refused by any
        // of them is never invited to send its body (createSeamServer stops Node's automatic 100).
        let read;
        try {
          read = await readBodyCapped(request, {
            beforeRead: caller.awaitsContinue ? () => response.writeContinue() : undefined,
          });
        } catch {
          return send(response, 400, BODY_NOT_JSON, request, {
            outcome: 'body-read-failed',
            caller,
          });
        }
        if (!read.ok) {
          return send(response, 413, { error: 'request body too large' }, request, {
            outcome: 'body-too-large',
            caller,
          });
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
          return send(response, 422, { decision }, request, {
            outcome: decision.disposition,
            caller,
          });
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
          return send(response, 503, STORE_UNAVAILABLE, request, {
            outcome: 'store-unavailable',
            caller,
          });
        }
        // A different body under a key already held (ADR-0002): nothing was appended and the
        // first record stands. The answer names the key - the caller's own workspace and change -
        // and never carries the stored payload, which the caller may not have sent.
        if (appended.outcome === 'conflict') {
          return send(
            response,
            409,
            { error: 'conflict', idempotency_key: appended.key },
            request,
            {
              outcome: 'conflict',
              caller,
            },
          );
        }
        // `appended` or `duplicate`: a replay is answered with the decision computed for the
        // replay (openapi.json divergence 6), and logged as which it was - a duplicate leaves no
        // trace in the store, so this line is the only one (gate decision Q-7 on task 2.3).
        return send(response, 202, { decision }, request, { outcome: appended.outcome, caller });
      } catch {
        return send(response, 400, BODY_NOT_JSON, request, { outcome: 'body-not-json', caller });
      }
    },
  },
];

// `telemetry` defaults to one of the handler's own around `log`, so a caller that only captures
// `log` sees every line. `readiness` defaults to one that fails closed - a handler that was never
// given a database check answers GET /ready 503, never 200.
export function createRequestHandler({
  registry,
  policy,
  evidenceStore,
  authenticate,
  quota,
  readiness,
  telemetry,
  log = stderrLog,
  now = Date.now,
}) {
  // No default authenticator here: a handler built without one must not exist, rather than
  // exist and fail on its first request.
  if (typeof authenticate !== 'function')
    throw new TypeError('createRequestHandler needs an authenticate function');
  // The same check as startup, so a test or fixture cannot build a seam around a policy the
  // service would refuse to start with.
  const held = heldPolicy(policy);
  const policyErrors = assertUsablePolicy(held);
  if (policyErrors.length > 0)
    throw new TypeError(
      `createRequestHandler needs a usable guardrail policy: ${policyErrors.join('; ')}`,
    );
  const recorder = telemetry ?? createTelemetry({ log, now });
  const context = {
    registry,
    policy: held,
    evidenceStore,
    authenticate,
    quota: quota ?? createSubmissionQuota({ now }),
    readiness:
      readiness ?? createReadiness({ onChange: (answer) => recorder.readinessChanged(answer) }),
  };
  // `awaitsContinue` is set only by createSeamServer's 'checkContinue' route: the client sent
  // `Expect: 100-continue` and Node has not answered it.
  return async (request, response, { awaitsContinue = false } = {}) => {
    const exchange = { telemetry: recorder, route: null, started: recorder.mark() };
    exchanges.set(request, exchange);
    // .find() over the table performs the same two === comparisons, in the same order, as the
    // if-chain it replaced. Routing comes first: a request that matches no entry is answered
    // 404 before any credential is read, and a query string - access_token included - makes a
    // request unmatched, because request.url is compared whole.
    const route = routes.find(
      (candidate) => candidate.method === request.method && candidate.path === request.url,
    );
    if (!route)
      return send(response, 404, { error: 'not found' }, request, { outcome: 'unmatched-route' });
    exchange.route = route;
    // The catch-all (2.1 SEC-6): a rejection anywhere in a route - a probe's included, since task
    // 2.3 gave GET /ready I/O - is answered 503 handler-fault, and the promise this returns never
    // rejects: an unhandled rejection terminates the process under Node's default, which `nx serve`
    // runs with. If a response is already on the wire, all that is left to do is close it; that
    // response has its event already, so the fault is counted as late, not as a second response.
    //
    // The backstop: a path that returns without answering - an early `return;` a handler gains
    // later - would otherwise hold the request to requestTimeout and leave no count and no line.
    // It is answered 503 handler-fault here instead, so every exchange ends in a send().
    let caller = null;
    try {
      // The probes read no credential, even when one is sent. GET /health does no I/O.
      if (route.auth === 'none') await route.handle(context, request, response);
      else {
        caller = await authorizeRequest(context, route, request, response);
        if (caller !== null)
          await route.handle(context, request, response, { ...caller, awaitsContinue });
      }
      if (!exchange.recorded && !response.headersSent)
        send(response, 503, route.fault ?? SERVICE_UNAVAILABLE, request, {
          outcome: 'handler-fault',
          caller: caller ?? undefined,
        });
    } catch {
      try {
        if (response.headersSent) {
          recorder.recordLateFault();
          request.destroy?.();
        } else
          send(response, 503, route.fault ?? SERVICE_UNAVAILABLE, request, {
            outcome: 'handler-fault',
            caller: caller ?? undefined,
          });
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
//
// Given `telemetry` (gate decision Q-13 on task 2.3), it also counts each connection that closes
// without ever producing a request: one Node answered itself - a malformed request (400), headers
// that stalled past headersTimeout (408) or grew past maxHeaderSize (431) - or one that sent
// nothing, a port scan or a TCP health check among them. It reads only the 'connection' event and
// the requests the handler is given, and changes nothing Node writes. The count has no reason.
export function createSeamServer(handler, { telemetry } = {}) {
  const served = new WeakSet();
  const handle = (request, response, options) => {
    served.add(request.socket);
    return handler(request, response, options);
  };
  const server = createServer(
    {
      headersTimeout: HEADERS_TIMEOUT_MS,
      requestTimeout: REQUEST_TIMEOUT_MS,
      connectionsCheckingInterval: CONNECTIONS_CHECKING_INTERVAL_MS,
    },
    (request, response) => handle(request, response),
  );
  server.on('checkContinue', (request, response) =>
    handle(request, response, { awaitsContinue: true }),
  );
  server.on('checkExpectation', (request, response) => handle(request, response));
  if (telemetry)
    server.on('connection', (socket) =>
      socket.once('close', () => {
        if (!served.has(socket)) telemetry.connectionWithoutRequest();
      }),
    );
  return server;
}

// No default store, exactly as createRequestHandler has no default authenticator: a service built
// without one must not exist, rather than exist and quietly keep evidence in memory. Without
// `checkReadiness` GET /ready fails closed (not-configured). One telemetry serves the handler, the
// readiness changes and the server's connection count.
export function createApp({
  evidenceStore,
  authenticate = defaultAuthenticate,
  checkReadiness,
  telemetry,
  log = stderrLog,
} = {}) {
  if (evidenceStore === undefined || evidenceStore === null)
    throw new TypeError('createApp needs an evidence store');
  const recorder = telemetry ?? createTelemetry({ log });
  const readiness = createReadiness({
    ...(checkReadiness === undefined ? {} : { check: checkReadiness }),
    onChange: (answer) => recorder.readinessChanged(answer),
  });
  return createSeamServer(
    createRequestHandler({
      registry,
      policy,
      evidenceStore,
      authenticate,
      quota: defaultQuota,
      readiness,
      telemetry: recorder,
      log,
    }),
    { telemetry: recorder },
  );
}

// AC-6: the one startup line, naming the policy the seam holds - loaded, accepted by the validator
// and deep-frozen - its approving decision, the schema version the startup check found, and the
// number of registrations whatever their status. Written once, after the store opened and before
// the service listens. Nothing else is in it.
export function announceStartup({
  telemetry,
  policy: loaded,
  registry: registrations,
  schemaVersion,
}) {
  telemetry.startup({
    policyId: loaded.policy_id,
    decisionId: loaded.approval.decision_id,
    schemaVersion,
    workspaces: registrations.list().length,
  });
}

// One last telemetry line when the supervisor stops the process. The handler writes the snapshot
// synchronously, removes itself and its twin, and re-raises the signal, so the process still dies
// of it and the exit status a supervisor sees is unchanged. stderr writes to a file or a pipe are
// synchronous on Linux (Node, "A note on process I/O"); elsewhere the line can be lost. SIGKILL and
// an out-of-memory kill write nothing (RR-12).
export const SHUTDOWN_SIGNALS = Object.freeze(['SIGTERM', 'SIGINT']);
export function installShutdownSnapshot({ telemetry, target = process }) {
  const handlers = new Map();
  for (const signal of SHUTDOWN_SIGNALS) {
    const handler = () => {
      for (const [name, installed] of handlers) target.off(name, installed);
      telemetry.stop();
      telemetry.snapshot('shutdown');
      target.kill(target.pid, signal);
    };
    handlers.set(signal, handler);
    target.once(signal, handler);
  }
}

// The service: the durable store or nothing. openDurableService() reads the PG* variables
// (database-config.mjs, not here) and refuses - an unusable configuration, an unreachable server,
// unverified TLS to a non-loopback host, a role its startup role check refuses, a schema that is
// not the bundled one - and the process exits 1 with one fixed line, never a driver message. Then,
// in order: the startup line, the interval snapshot, the shutdown snapshot, and the listener.
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const port = Number(process.env.PORT ?? 3000);
  openDurableService().then(
    ({ evidenceStore, checkReadiness, schemaVersion }) => {
      const telemetry = createTelemetry({ log: stderrLog });
      announceStartup({ telemetry, policy, registry, schemaVersion });
      telemetry.startInterval();
      installShutdownSnapshot({ telemetry });
      createApp({ evidenceStore, checkReadiness, telemetry }).listen(port, () =>
        console.log(`control plane listening on :${port}`),
      );
    },
    (error) => {
      const line =
        error instanceof StartupRefused ? error.message : 'control plane refused to start: failed';
      process.stderr.write(`${line}\n`);
      process.exit(1);
    },
  );
}
