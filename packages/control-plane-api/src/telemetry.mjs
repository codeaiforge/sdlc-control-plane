// Operator telemetry (task 2.3, MIT-18): every response the seam sends is counted by route,
// status and outcome, and every response but a probe's writes one line; every 60 s, and once at
// SIGTERM or SIGINT, one `telemetry` line holds every count since the process started.
//
// The seam's send() is the only caller of record(), and every response goes through send(), so
// one response is one record by construction; telemetry.test.mjs proves it from main.mjs's source
// and by driving every (status, outcome) pair. A line or a count is built here from values the
// seam owns - the matched route entry, a literal status, an outcome from OUTCOMES, a duration it
// measured, a verified principal's four numeric ids and the bound workspace_id - and from nothing
// the caller wrote: no request field, URL, header, token, body or error message. The count map's
// keys are those same values, so its size is bounded by the vocabulary and no caller can grow it.
//
// Six event names, each a closed shape:
//
//   refusal   { event, at, route, status, reason, duration_ms, principal? }       (refusal-log.mjs)
//   accepted  { event, at, route, status, outcome, duration_ms, principal }        202 appended | duplicate
//   served    { event, at, route, status, duration_ms, principal }                 200 on a workload route
//   readiness { event, at, ready, reason }                                         first answer, each change
//   startup   { event, at, policy_id, decision_id, schema_version, workspaces }    once, before listening
//   telemetry { event, at, kind, started_at, uptime_s, counts, slow_threshold_ms, slow,
//               late_faults, connections_without_request, ready }
//
// The counts are this process's since it started: a restart resets them, two processes do not add
// up, and a SIGKILL or an out-of-memory kill loses up to TELEMETRY_INTERVAL_MS of them - the
// per-response lines keep the same facts (threat model RR-12). No I/O here but through `log`.

import { REFUSAL_REASONS, principalFields, refusalEvent, routeName } from './refusal-log.mjs';

// Reviewed literals, never configuration. One line a minute is what a supervisor already keeps.
// A healthy append takes milliseconds and the store's cutoff is 5000 ms, so 1000 ms shows a
// database drifting toward the cutoff long before it becomes 503s.
export const TELEMETRY_INTERVAL_MS = 60000;
export const SLOW_RESPONSE_MS = 1000;

// Closed: every response's outcome is one of these. An outcome outside it is a seam defect, never
// caller input; record() throws and send() still answers, and the count does not move.
export const OUTCOMES = Object.freeze([
  ...REFUSAL_REASONS,
  'appended', // 202, the store's own outcome (gate decision Q-7 on task 2.3)
  'duplicate', // 202, a replay: nothing appended, and nothing left in the store to show it
  'served', // 200 on GET /v1/workspaces and GET /v1/indicators
  'live', // 200 on GET /health
  'ready', // 200 on GET /ready
  'not-ready', // 503 on GET /ready
]);

const ACCEPTED = new Set(['appended', 'duplicate']);
// Probe answers are counted and never lined (gate decision Q-12 on task 2.3): a supervisor
// probing every 10 s would otherwise bury the refusal lines. /ready writes a readiness line on
// each change instead. A probe route's handler-fault is a refusal and is lined.
const PROBE = new Set(['live', 'ready', 'not-ready']);

const SNAPSHOT_KINDS = new Set(['interval', 'shutdown']);

const wholeMs = (value) => {
  if (!Number.isInteger(value) || value < 0)
    throw new TypeError('duration_ms must be a whole number of milliseconds');
  return value;
};

export function acceptedEvent({ at, route, status, outcome, durationMs, principal, workspaceId }) {
  if (!ACCEPTED.has(outcome)) throw new TypeError('accepted outcome is not in the list');
  return {
    event: 'accepted',
    at,
    route: routeName(route),
    status,
    outcome,
    duration_ms: wholeMs(durationMs),
    principal: principalFields(principal, workspaceId),
  };
}

export function servedEvent({ at, route, status, durationMs, principal, workspaceId }) {
  return {
    event: 'served',
    at,
    route: routeName(route),
    status,
    duration_ms: wholeMs(durationMs),
    principal: principalFields(principal, workspaceId),
  };
}

export function readinessEvent({ at, ready, reason }) {
  if (typeof ready !== 'boolean' || typeof reason !== 'string')
    throw new TypeError('readiness event needs a boolean and a reason');
  return { event: 'readiness', at, ready, reason };
}

// The loaded, validator-accepted policy's id and approving decision, the schema version the
// startup check found, and the number of registrations whatever their status (AC-6). Nothing else.
export function startupEvent({ at, policyId, decisionId, schemaVersion, workspaces }) {
  if (typeof policyId !== 'string' || typeof decisionId !== 'string')
    throw new TypeError('startup event needs the policy and decision ids');
  if (!Number.isInteger(schemaVersion) || !Number.isInteger(workspaces))
    throw new TypeError('startup event needs whole numbers');
  return {
    event: 'startup',
    at,
    policy_id: policyId,
    decision_id: decisionId,
    schema_version: schemaVersion,
    workspaces,
  };
}

export function snapshotEvent({
  at,
  kind,
  startedAt,
  uptimeS,
  counts,
  slow,
  lateFaults,
  connectionsWithoutRequest,
  ready,
}) {
  if (!SNAPSHOT_KINDS.has(kind)) throw new TypeError('telemetry kind is not in the list');
  return {
    event: 'telemetry',
    at,
    kind,
    started_at: startedAt,
    uptime_s: uptimeS,
    counts,
    slow_threshold_ms: SLOW_RESPONSE_MS,
    slow,
    late_faults: lateFaults,
    connections_without_request: connectionsWithoutRequest,
    ready,
  };
}

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function createTelemetry({ log, now = Date.now, monotonic = () => performance.now() } = {}) {
  if (typeof log !== 'function') throw new TypeError('createTelemetry needs a log function');
  const startedAt = new Date(now()).toISOString();
  const startedMono = monotonic();
  // `${route}\n${status}\n${outcome}` -> n, and route -> n. Keys are seam-owned values only.
  const counts = new Map();
  const slow = new Map();
  let lateFaults = 0;
  let connectionsWithoutRequest = 0;
  let ready = null;
  let timer = null;

  const at = () => new Date(now()).toISOString();
  // Best-effort: a sink that throws never reaches a caller, and so never a response.
  const write = (event) => {
    try {
      log(event);
    } catch {
      // The count has moved; the line is lost, the response is not.
    }
  };

  function snapshot(kind = 'interval') {
    const entries = [...counts]
      .map(([key, n]) => {
        const [route, status, outcome] = key.split('\n');
        return { route, status: Number(status), outcome, n };
      })
      .sort(
        (a, b) => compare(a.route, b.route) || a.status - b.status || compare(a.outcome, b.outcome),
      );
    const event = snapshotEvent({
      at: at(),
      kind,
      startedAt,
      uptimeS: Math.max(0, Math.floor((monotonic() - startedMono) / 1000)),
      counts: entries,
      slow: [...slow].map(([route, n]) => ({ route, n })).sort((a, b) => compare(a.route, b.route)),
      lateFaults,
      connectionsWithoutRequest,
      ready,
    });
    write(event);
    return event;
  }

  return {
    // The start of an exchange, on the same clock elapsed() reads.
    mark: () => monotonic(),
    // Whole milliseconds since `started`; a clock that steps backwards cannot make it negative.
    elapsed: (started) => Math.max(0, Math.round(monotonic() - started)),

    // One response. Throws on an outcome outside OUTCOMES, before anything moves.
    record({ route, status, outcome, durationMs, principal, workspaceId }) {
      if (!OUTCOMES.includes(outcome)) throw new TypeError('outcome is not in the list');
      if (!Number.isInteger(status)) throw new TypeError('status must be a literal number');
      wholeMs(durationMs);
      const name = routeName(route);
      const key = `${name}\n${status}\n${outcome}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (durationMs >= SLOW_RESPONSE_MS) slow.set(name, (slow.get(name) ?? 0) + 1);
      if (PROBE.has(outcome)) return;
      const parts = { at: at(), route, status, durationMs, principal, workspaceId };
      try {
        if (ACCEPTED.has(outcome)) write(acceptedEvent({ ...parts, outcome }));
        else if (outcome === 'served') write(servedEvent(parts));
        else write(refusalEvent({ ...parts, reason: outcome }));
      } catch {
        // A defective event is never written in part; the count above stands.
      }
    },

    // A second write attempt for a response that already has its event: counted, never lined.
    recordLateFault() {
      lateFaults += 1;
    },
    // A connection that closed without producing a request Node handed to the seam (gate decision
    // Q-13 on task 2.3): Node's own 400, 408 and 431, a port scan, a TCP health check. No reason.
    connectionWithoutRequest() {
      connectionsWithoutRequest += 1;
    },
    // Readiness's onChange: one line per change, with the reason.
    readinessChanged(answer) {
      ready = answer?.ready === true;
      try {
        write(readinessEvent({ at: at(), ready, reason: answer?.reason }));
      } catch {
        // A defective event is never written in part.
      }
    },
    startup({ policyId, decisionId, schemaVersion, workspaces }) {
      try {
        write(startupEvent({ at: at(), policyId, decisionId, schemaVersion, workspaces }));
      } catch {
        // Never stops a service whose every startup check passed; telemetry.test.mjs pins the line.
      }
    },
    snapshot,
    // Unref'd: a pending snapshot never keeps the process alive.
    startInterval() {
      if (timer !== null) return;
      timer = setInterval(() => snapshot('interval'), TELEMETRY_INTERVAL_MS);
      timer.unref();
    },
    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}
