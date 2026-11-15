# ADR-0005: Serve readiness as a second unauthenticated probe route, GET /ready, beside GET /health

- **Status**: Accepted
- **Date**: 2026-11-15
- **Deciders**: Approved by dsofianos (founder) for the Architect and Security Engineer roles, 2026-11-15.
- **Trace**: NFR-3.1, Infra

## Context

Task 2.3 makes failed ingestion, delayed processing and retention violations detectable by an
operator (`docs/specs/implementation-roadmap.md`, Sprint 2). One thing an operator's tooling
cannot tell today is whether the running service can reach its database. `GET /health` is
liveness only: it does no I/O and its published meaning is "a liveness signal, not a readiness
one" (`packages/control-plane-api/openapi.json`). While PostgreSQL is gone the process answers
`/health` 200 and every store route 503, and only an authorized caller can see the 503s, because
an unauthenticated request is answered 401 before any store route touches the database.

A readiness signal is what a process supervisor or a load balancer consumes, and neither holds a
workload token: a token is a workspace's credential, not an operator's, and the system owns no
operator credential (ADR-0002 rejected creating one for a digest). There is no deploy target, so
there is no private network or second listener to put an operator route behind
(`docs/specs/stack.md`, Deploy).

ADR-0003 (Accepted) decides route authorization as a table of every route, and its _Authorized
for W_ predicate is "applied identically on every route except `GET /health`" (_Decision › Route
authorization_). A second route without a credential makes that sentence false, and an accepted
ADR's text is not edited (`.ai/standards/adr.md`). Most of ADR-0003 is unaffected, so it is not
superseded either; this record adds the one class of route it did not foresee.

The founder decided the shape at task 2.3's Phase ① gate (Q-3 A, 2026-11-15) and asked for this
record at the Phase ② gate (Q-11 A, 2026-11-15).

## Decision

We will define a **probe route** as a route that:

1. reads no credential, even when one is sent;
2. answers a status-only body, built by the seam, that carries no caller data and no reason;
3. reads nothing from the request but its method and path, and no header but the framing ones
   (`content-length`, `transfer-encoding`), which decide whether the connection is closed;
4. does bounded I/O or none: any check it runs is single-flight, its result cached, and no probe
   waits longer than a fixed literal bound;
5. is never a data route and never an administration route.

There are exactly two probe routes. `GET /health` is one, unchanged: liveness, no I/O. `GET
/ready` is the other: readiness, answered `200 {"status":"ready"}` or `503
{"status":"not-ready"}` from one query on the service's own pool, as its own role, that the
applied schema is exactly the one the build bundles; at most one check runs at a time, a result
is reused for 2 s, and no probe waits longer than 2 s (`READINESS_CACHE_MS`,
`READINESS_TIMEOUT_MS` in `packages/control-plane-api/src/readiness.mjs`). The reason goes to the
service's own log only.

ADR-0003's _Authorized for W_ predicate applies, unchanged, to every route outside the probe
class. A new probe route needs a new decision record; a new route of any other kind gets the
predicate.

## Options Considered

- **Option A — a second unauthenticated probe route, `GET /ready`, on the public port (chosen,
  Q-3 A).** A supervisor or load balancer can use it without a credential, and it is the shape
  they expect. It tells any peer one bit — whether the database answers the service — that before
  it only an authorized caller could infer; the single-flight check, the 2 s cache and the 2 s
  bound keep it from being a way to load the database (threat model ABU-18, MIT-22).
- **Option B — no new route; readiness only through a command an operator runs.** Nothing new is
  disclosed and ADR-0003 stays exactly true. A supervisor or load balancer cannot use it, so the
  gap the task exists to close stays open for every automated consumer.
- **Option C — make `GET /health` check the database.** One unauthenticated route, as today. It
  changes a published meaning, and a supervisor that restarts on a failed liveness probe would
  restart a healthy process every time the database blips — the failure mode the liveness /
  readiness split exists to prevent.
- **Option D — an operator-only listener bound to loopback, serving readiness and counts.** No
  disclosure on the public port. It is a second listener with its own trust boundary and contract,
  and whether loopback is private depends on a deploy target nobody has chosen (Q-2 B, declined).

## Consequences

- Positive: an operator's tooling can tell "the process is up" (`/health`) from "the process can
  serve evidence" (`/ready`), and sees recovery without a restart. The reason a probe failed is in
  the log line the readiness change writes, never in the answer.
- Negative: any peer learns whether the database answers the service, without a credential, and,
  from how long the answer takes, whether a not-ready database hangs or refuses. That is recorded
  as a residual risk (threat model RR-16), not implied away.
- Negative: each check is a query on the service's pool. However many peers probe, it adds at most
  one query every 2 s and at most two readiness checks pending at once (one abandoned at the
  bound, one current). The store gives up on the abandoned one at 5 s and asks the server to
  cancel it; in a partition the cancel may not arrive, and the abandoned query keeps its
  connection until the socket dies.
- Constraint: the probe class is closed at two routes. A third route without a credential is a
  new decision, and the threat model's TB-1 names every route either way (its route-totality
  check fails otherwise).
- Constraint: readiness does not re-check the role's grants. That stays a startup check
  (`assertServiceRole`, D-16 of task 2.2): a grant made while the service runs is seen at the next
  start, and `/ready` does not flip on grant drift.
- When a deploy target is chosen, whether `/ready` stays on the public port or moves behind an
  operator listener is that decision's to make; RR-16 is reviewed then.
