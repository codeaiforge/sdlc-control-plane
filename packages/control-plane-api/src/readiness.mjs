// GET /ready (task 2.3, ADR-0005, MIT-22): whether this process can serve the evidence routes,
// answered from at most one database check at a time.
//
// The route reads no credential, so any peer can call it, and each check is a database round
// trip on the service's own pool (threat model ABU-18). Three literals bound what that costs, and
// they are reviewed values, never configuration:
//
// - single-flight: probes that arrive while a check runs share it;
// - READINESS_CACHE_MS: a settled result is reused for 2 s, measured from when it settled, so at
//   most one check starts per 2 s however many peers probe;
// - READINESS_TIMEOUT_MS: no probe waits longer than 2 s. A check still running then is answered
//   check-timeout and left to the store, whose run() gives up on it at STORE_QUERY_TIMEOUT_MS and
//   asks the server to cancel it, so at most two readiness checks are ever pending here at once
//   (one abandoned, one current). In a partition the cancel may not arrive, and an abandoned
//   query keeps its connection until the socket dies.
//
// An answer is therefore at most 2 s old, and a database lost now reads not-ready to a probe
// arriving at most 4 s later; recovery reads the same way, with no restart. The reason is for the
// log only (onChange, once per change); the route's body carries the status and nothing else.

export const READINESS_CACHE_MS = 2000;
export const READINESS_TIMEOUT_MS = 2000;

// Closed. Every answer is one of these; a check that returns anything else is check-fault.
export const READINESS_REASONS = Object.freeze([
  'ready',
  'database-unreachable',
  'role-refused',
  'schema-mismatch',
  'check-timeout',
  'check-fault',
  'not-configured',
]);

// The check a handler built without one runs: fails closed, so a seam that was never given a
// database never reads ready.
export const NOT_CONFIGURED = async () => ({ ready: false, reason: 'not-configured' });

const answer = (ready, reason) => Object.freeze({ ready, reason });

// Only a shape from the vocabulary passes, rebuilt from its two fields, so nothing else a check
// returns - a driver message included - can reach the log or the route.
function normalise(result) {
  if (result?.ready === true && result.reason === 'ready') return answer(true, 'ready');
  if (
    result?.ready === false &&
    result.reason !== 'ready' &&
    READINESS_REASONS.includes(result.reason)
  )
    return answer(false, result.reason);
  return answer(false, 'check-fault');
}

export function createReadiness({
  check = NOT_CONFIGURED,
  monotonic = () => performance.now(),
  onChange = () => {},
} = {}) {
  if (typeof check !== 'function') throw new TypeError('createReadiness needs a check function');
  let last = null;
  let settledAt = 0;
  let inflight = null;

  function bounded() {
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(answer(false, 'check-timeout')), READINESS_TIMEOUT_MS);
    });
    // A check that throws, or rejects after the bound, is answered here and never unhandled.
    const checked = Promise.resolve()
      .then(check)
      .then(normalise, () => answer(false, 'check-fault'));
    return Promise.race([checked, timeout]).finally(() => clearTimeout(timer));
  }

  function settle(result) {
    const changed = last === null || last.ready !== result.ready || last.reason !== result.reason;
    last = result;
    settledAt = monotonic();
    inflight = null;
    if (changed) {
      try {
        onChange(result);
      } catch {
        // The log is best-effort; the answer stands.
      }
    }
    return result;
  }

  return {
    // Never rejects.
    probe() {
      if (last !== null && inflight === null && monotonic() - settledAt < READINESS_CACHE_MS)
        return Promise.resolve(last);
      inflight ??= bounded().then(settle);
      return inflight;
    },
    // The last answer, or null before the first check settles. Runs no check.
    last: () => last,
  };
}
