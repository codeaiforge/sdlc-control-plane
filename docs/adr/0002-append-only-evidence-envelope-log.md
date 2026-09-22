# ADR-0002: Persist accepted evidence as an append-only PostgreSQL envelope log keyed by (workspace_id, change_id)

- **Status**: Proposed
- **Date**: 2026-09-22
- **Deciders**: Proposed by the Database Engineer role. Approval is pending Architect-role review, and — because this decision traces NFR-6.1 — pending Security-role sign-off at Gate 2 (Production ingress). No human has approved it yet; this record states a proposal, not an approval.
- **Trace**: NFR-3.1, NFR-6.1

## Context

NFR-3.1 requires that, **before production use**, accepted evidence is stored durably and that
retrying the same submission is idempotent. Neither property exists today. Accepted records live
in a process-local array created at module scope in `packages/control-plane-api/src/main.mjs`;
they do not survive a restart, and a replayed submission appends a second copy that the
indicator summary counts twice.

The decision cannot wait, for two reasons the roadmap already records.

1. **Gate 2 (Production ingress) will not pass without it.** Its "Store selection" signal reads
   no-go while "ADR absent or does not name all three" — store, idempotency key and retention.
   Gate 2 is explicitly human and blocks the whole of Sprint 2.
2. **Task 2.2 must not write persistence code first.** The risk register entry "Evidence
   contract reopens once a real store is chosen" carries exactly this mitigation: 1.2 produces
   the store ADR before 2.2 writes any persistence code, so a contract change discovered here
   stops Sprint 2 cheaply rather than after an adapter exists.

The complicating force is identity. **No workspace identity exists anywhere in the evidence path
today.** The composition seam matches a request on `request.method` and `request.url` alone and
never reads a header; `POST /v1/evidence` has no path parameter; and the workspace registry is
consulted only by `GET /v1/workspaces`. An accepted record therefore cannot currently be
attributed to the workspace that sent it — which is also why nothing today can tell a replay
from a distinct submission that happens to share a `change_id`.

That gap is scheduled, not overlooked: task 2.2 depends on both 1.2 and 2.1, so "identity before
durable attribution" is already encoded in the roadmap's dependency column and in Sprint 2's
execution waves. What 1.2 has to settle is the shape the store commits to **now**, so that when
2.1 produces an authenticated principal there is a defined slot for it rather than a schema
change.

A fourth force is scope. `evidence/0` is an upstream contract, published in task 0.2 and frozen
into `packages/contracts/src/schema.mjs` and `packages/control-plane-api/openapi.json`. Anything
this decision needs that `evidence/0` does not carry has to be carried somewhere else, or the
contract reopens and Sprint 1's risk checkpoint fails.

## Decision

We will persist each accepted evidence record as one row in a single append-only PostgreSQL
table, wrapped in a control-plane-owned envelope, keyed for idempotency by the pair
`(workspace_id, change_id)`, retained for 90 days from the control plane's own receipt time, and
expired by tombstoning rather than deletion. Task 1.2 ships the port and its conformance suite
with an in-process adapter; task 2.2 writes the PostgreSQL adapter against that suite.

### The store: PostgreSQL 16+, one append-only table

Evidence is stored as `jsonb` in one table, with the envelope's identity fields as ordinary
columns and a `UNIQUE (workspace_id, change_id)` constraint carrying the idempotency claim. The
shape is indicative — 2.2 owns the migration — but the constraints are the decision:

```sql
CREATE TABLE evidence_envelope (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  envelope_version text        NOT NULL,
  workspace_id     text,                   -- nullable on purpose: see the fourth collision row.
                                           -- Postgres treats NULLs as distinct under UNIQUE, so a
                                           -- null workspace claims no uniqueness with no app code.
  change_id        text        NOT NULL,
  received_at      timestamptz NOT NULL,   -- the control plane's clock, never the submitter's
  evidence         jsonb,                  -- NULL once redacted; see Expiry behaviour
  redacted_at      timestamptz,
  UNIQUE (workspace_id, change_id)
);
```

**Append-only is structural, not a convention.** The application role is granted `INSERT` and
`SELECT` on this table and nothing else. A rule enforced only by the code that writes the rows
is a rule any later code path can forget; a missing `UPDATE` grant is enforced by the server for
every path at once. This is the database-layer equivalent of the workspace's own principle that
a rule nothing checks is a convention rather than a control.

`UNIQUE (workspace_id, change_id)` is the idempotency claim itself, not an optimisation of it.
A uniqueness rule implemented by "select, then insert if absent" is a race between two
concurrent submissions of the same record; a unique index is decided by the server.

The cost has to be stated plainly, because it is the largest consequence of this ADR. **The
workspace has no runtime dependencies at all today** — five packages, Node built-ins only,
`node:test` as the harness. `pg` would be the first. It arrives at **task 2.2** and brings with
it a lockfile change, a CI service container in both workflows, a migration story, connection
and credential configuration, and an integration test that needs a live server. All of that sits
inside an 8-SP task, in a sprint already planned at 21 SP against ~20 SP of solo capacity, whose
own risk checkpoint names it the pressure point of the whole roadmap. **None of it lands in
1.2.** Task 1.2 adds no dependency, no lockfile change and no CI change; it ships the port, the
conformance suite and an in-process adapter that satisfies it.

### The idempotency key: `JSON.stringify([workspace_id, change_id])`

The key is the JSON encoding of the pair, exported as `idempotencyKey` from
`packages/control-plane-api/src/evidence-store.mjs`.

It is not a delimiter join, and the reason is a silent data-loss bug rather than a preference:
`['a|b','c'].join('|')` and `['a','b|c'].join('|')` are the **same string**, so a joined key
aliases two genuinely distinct changes, answers the second as a replay of the first, and drops a
real evidence record on the floor with a success status. `JSON.stringify(['a|b','c'])` and
`JSON.stringify(['a','b|c'])` differ, because the encoding escapes and delimits rather than
concatenating. Workspace and change identifiers are externally supplied strings with no
character class this project controls, so this is a live case, not a contrived one.

**Uniqueness scope is the whole store for all time** — not per process, not per connection, and
not within a sliding window. A replay of a submission from three months ago is still a replay.
This is what makes the in-memory adapter a stand-in rather than an implementation: its scope is
one process's lifetime, which is exactly what NFR-3.1 says is insufficient.

`change_id` comes from the `evidence/0` record, where it is already a required, non-empty
string. `workspace_id` comes from 2.1's authenticated principal and **is `null` today**, because
nothing in the request path produces one.

The four-row collision rule the port implements:

| Key state                              | Outcome     | What the store does                                       |
| -------------------------------------- | ----------- | --------------------------------------------------------- |
| Key absent                             | `appended`  | Append the envelope; return it.                           |
| Key present, identical JSON projection | `duplicate` | Append nothing; return the existing envelope.             |
| Key present, differing JSON projection | `conflict`  | Append nothing; return the existing envelope.             |
| `workspace_id === null`                | `appended`  | Append with `idempotency_key: null`; claim no uniqueness. |

**`conflict` is not `duplicate`, and collapsing the two would be a real loss.** A duplicate is a
producer doing the correct thing — retrying after an ambiguous response. A conflict is two
different bodies claiming the same `(workspace, change)` pair: a producer fault, a `change_id`
collision, or tampering. In every one of those cases the first record stands, because appending
the second would break the uniqueness claim and replacing the first would let a later caller
rewrite accepted evidence. But quietly answering `duplicate` would mean the stored evidence
disagrees with what the workspace believes it submitted, with nothing anywhere recording that
the disagreement happened. The store distinguishes them so that a caller — and 2.3's telemetry —
can tell a healthy retry from a fault.

Both outcomes are **unreachable over HTTP until 2.1**, because `workspace_id` is `null` and the
null row of the table above applies to every submission the seam can currently receive. They are
kept alive by the conformance suite rather than by the request path. **Task 2.2 must choose the
wire status for a `conflict`** — most likely 409, which today's `openapi.json` does not declare
— and must do so in the same change that bumps `info.version`.

### Retention: 90 days from `received_at`

Accepted evidence is retained for 90 days, measured from the envelope's `received_at`, which is
the control plane's own clock.

The basis is **one SAFe Program Increment (five iterations, ~10 weeks) plus margin**, so that a
PI retrospective can still reach every record from the increment it is reviewing. This is an
**operational basis, not a compliance one**: no regulation, contract or retention schedule has
been cited for this data, and this ADR does not claim one.

That is itself the open question this decision hands forward: **evidence data classification is
undetermined.** An `evidence/0` record carries a change identifier, a repository binding
expression, an affected-path set and tool metadata — which is, in aggregate, a description of a
workspace's internal structure and delivery activity. Whether that is public, internal or
confidential has not been decided by anyone. The question feeds **task 1.3's threat model** and
**Gate 2**, and it should be answered before the store holds production data rather than after.

While classification is unknown, the **shorter window is the conservative choice**: a retention
window can be extended later by a reviewed decision, but data already retained under an unknown
classification cannot be un-kept.

**Task 1.2 implements no expiry at all.** A retention window on a process-local store is
theatre — the process restart destroys everything long before day 90, so an expiry job would be
enforcing a policy against a store that cannot honour any policy. Retention is implemented in
**2.2**, alongside the durable store it applies to, and verified in **2.3**, whose Done-when
already requires an operator to be able to detect retention-policy violations.

### Expiry behaviour: tombstoning, derived from what the alternatives break

Expiry removes the payload and keeps the identity. The reasoning is derived from the failure
modes of the other two options, not asserted as a preference.

**A plain delete breaks idempotency.** Delete the row and the key goes with it. A producer that
replays an expired submission — which is exactly what a long-lived CI job or a backfill does —
finds no key, and the store admits the content it has just spent a scheduled job expiring. Worse,
it is now a _new_ record with a _new_ `received_at`, so its retention clock restarts and it can
be kept indefinitely by a caller that retries on a 90-day cycle. Retention and idempotency would
be fighting each other, and idempotency would lose.

**Anonymisation breaks the key from the other end.** Anonymising the identity would destroy
`change_id`, which is precisely the component the idempotency key needs to keep, while leaving
the payload — which is the part carrying the undetermined classification, and the part expiry
exists to remove. It removes exactly the wrong half.

So: **payload removed, identity retained.** A redacted envelope keeps `workspace_id`,
`change_id`, `idempotency_key`, `received_at` and `envelope_version`, and gains `redacted_at`. A
replay of an expired submission still resolves to its key and is still answered as a duplicate,
against a row that no longer carries the evidence body.

The honest cost: **a redaction is an in-place write, and it is the single deliberate exception
to append-only.** Two mitigations, both structural rather than procedural:

- The retention job runs under **its own database role**, holding `UPDATE` on the `evidence` and
  `redacted_at` columns of this one table and nothing else. The application role still holds no
  `UPDATE` at all, so the exception is available to one scheduled job and to no request path.
- Every redaction **appends a row to a separate `evidence_redaction` table**, so the _fact_ of a
  redaction is itself recorded append-only even though its target was modified in place. A
  redaction that leaves no trace is indistinguishable from tampering; one that appends its own
  record is not.

The second-order open question, recorded here rather than resolved: `(workspace_id, change_id)`
**survives expiry**, and that pair is itself metadata — it says which workspace was active on
which change, and when. If the classification answer from 1.3 covers identifiers as well as
payloads, this design retains something it may not be entitled to retain, and the tombstone
itself needs a retention decision.

### The audit-event boundary: two events, and git for policy

The control plane emits audit events only for state changes **it owns**. There are exactly two:

1. **An envelope was appended** — a new accepted evidence record entered the store.
2. **A payload was redacted** — a retention expiry removed an evidence body.

Everything else that looks like an audit concern is either not a state change or not ours.

**The append log is its own audit trail.** A row already answers who (`workspace_id`), what
(`change_id` and the payload) and when (`received_at`). The critical constraint is that
`received_at` is **the control plane's clock, never a value taken from the submitter's record**.
A submitter that sets its own receipt time sets its own retention clock with it, can backdate
itself out of the window, and can reorder itself in any timeline an operator reads. The port
enforces this: a `received_at` field inside a submitted record is preserved as payload and is
never read as the receipt time.

**Policy and registration changes are reviewed commits under `config/control-plane/`, read at
startup. Git is the MVP audit trail** for them, and it is a real one rather than a placeholder:
that path tiers `critical` in the component map, so a change to it goes through the
`sdlc-controls` gate, and the gate emits an evidence artifact tied to an attributable commit.
"Who changed the policy, when, and with what approval" is answerable from the commit history,
without the control plane storing anything.

Two limits must be said plainly rather than left for a reader to discover.

**It is not signature-grade.** Commits in this repository are unsigned today - `git log
--format='%G?'` returns `N` for every commit, and `commit.gpgsign` and `user.signingkey` are
unset - and no control verifies an authorship claim. Git's object graph gives integrity, not
attribution: in an unsigned repository the author field is free text, so `git commit --author`
plus a force-push rewrites who changed a policy and nothing notices. Making this trail
attribution-grade needs signed commits and branch protection on `config/control-plane/**`, and
that is a **Gate 2 condition rather than something this ADR delivers**.

**It is not queryable.** It answers
those questions only for somebody holding the repository and running `git log`. No route exposes
it, no API returns it, and an auditor without repository access cannot reach it at all.

That limit collides with a commitment already written down. **Sprint 2's Definition of Done
includes "Audit events for policy changes are queryable", and no scheduled task delivers it.**
Task 2.2's Done-when is about evidence intake ("a replay is safe, durable records survive
restart, and audit events are queryable" — in the context of ingestion); task 2.3 is operator
telemetry for ingestion, delay and retention; task 1.3 produces a threat model, which is a
document, not a surface. `docs/contracts.md` carried the same overstatement — that policy
administration is "surfaced in Sprint 2" — and is corrected in this change to say what is
actually scheduled and what git actually delivers. Either that DoD bullet is
rewritten to what git actually delivers, or a task is added to Sprint 2 or 3 to build a queryable
policy-change surface. **This ADR records the gap and hands the choice to Gate 2**; it does not
decide it, because the choice adds scope to the sprint the roadmap already calls its pressure
point.

### Refused submissions are not retained

A submission the control plane refuses does not enter the evidence store. This is now a decision
rather than an omission.

- **A 400 body is by definition unparseable.** Retaining it means retaining an arbitrary byte
  sequence supplied by an unauthenticated caller — an unbounded, unclassified,
  attacker-controlled write primitive pointed at the durable store. It belongs in **1.3's threat
  model as an abuse case**, not in a retention design.
- **A 422 body is parseable and would genuinely be useful** for debugging a producer. It is
  nonetheless not retained: pre-2.1 it is unattributed, so a refused-evidence log would be a pile
  of anonymous records nobody can trace to a submitter; and storing refused content in the same
  log as accepted content dilutes the one property the log exists to have, that everything in it
  was accepted under a named policy.
- **What 2.3 needs to detect failed ingestion is a count with a reason, not a body.** "Twelve
  submissions from this workspace were refused for `required control not verified` in the last
  hour" is the operator signal; the twelve bodies are not.

This ADR fixes only two things here: refusals do not enter the evidence store, and a future
refusal log — if one is justified after 1.3 — is a **separate stream** with its own
classification, retention and access decisions.

### The 202: the terminal disposition stays in the response body

`POST /v1/evidence` answers 202 with a terminal disposition in the body, and that does not
change. `EvidenceAcceptedResponse` is `additionalProperties: false`, so adding a `submission_id`
or a retrieval link is not an additive change: it requires editing `openapi.json` and bumping
`info.version`, which is out of scope for a task that must not reopen the published contract.

Task 1.2 therefore ships a **synchronous, in-process port**, so the document's published caveat —
that the 202 is synchronous and promises nothing about later work — stays literally true, and
the contract test that freezes that divergence keeps passing unchanged.

The recommendation carried to 2.2: **keep the write synchronous.** An `INSERT ... RETURNING` that
completes before the response is written preserves the published semantics exactly and needs no
version bump. Making intake asynchronous is a real option, but it changes what the 202 means to
every existing client, and it deserves its own ADR rather than arriving as a side effect of
choosing a database.

### Risk checkpoint

Sprint 1's risk checkpoint asks whether 1.2's ADR can name a concrete store and idempotency key
without reopening the evidence schema. It can, and this ADR does: `change_id` is already a
required field of `evidence/0`; `workspace_id` rides in a control-plane-owned envelope that wraps
the record rather than in the record itself; no field is added to, removed from or reinterpreted
in `evidence/0`; `packages/contracts/src/schema.mjs` is unchanged; `openapi.json` and its
`info.version` are unchanged. The contract fixed in task 0.2 is therefore not wrong, and
Sprint 2 may start on top of it.

## Options Considered

- **Option A — PostgreSQL 16+ with a `jsonb` evidence column (chosen).** Cross-process
  uniqueness enforced by a unique index rather than by application code; append-only enforceable
  by grant rather than by convention; `jsonb` preserves unrecognised additive fields, which
  NFR-1.1 requires the system to tolerate; a real query surface for 2.3's telemetry and for
  retention verification; ordinary operational practice for backup and restore. Against it: it
  is the workspace's first runtime dependency and its first external service, and every one of
  those costs lands inside 2.2's 8 SP in an over-capacity sprint. Chosen because the alternatives
  each fail a requirement outright rather than merely costing more.

- **Option B — `node:sqlite`, the built-in single-file database (rejected).** Superficially the
  cheapest: durable, no runtime dependency, no service container. It is unavailable on this
  workspace's floor. `engines.node` is `">=20.0.0"` and both workflows pin `node-version: 20`;
  `node:sqlite` landed in 22.5 and is still marked Experimental. Adopting it means raising
  `engines.node` and the pinned version in `ci.yml` and `sdlc-controls.yml` — three control
  surfaces changed to adopt a storage API Node may still change in a minor release. It is also
  single-writer, so it does not survive the control plane running as more than one process,
  which is the first thing a production deployment does.

- **Option C — `fsync`'d JSONL append log on disk (rejected as primary; retained as fallback).**
  Genuinely append-only by construction, and its durability story is honest. Three failures.
  Uniqueness would be enforced by an in-process index, so two processes reading the same file
  would both accept the same key — the exact property NFR-3.1 asks for is the one it cannot
  provide. There is no query surface, so 2.3 has nothing to build operator telemetry or retention
  verification on. And retention means rewriting the file, which destroys the single attractive
  property the option had. It is **named here as the documented fallback if Sprint 2 overruns**:
  it would deliver durability across restart, which is the most visible half of NFR-3.1, while
  leaving multi-process idempotency, queryability and retention undelivered — and taking that
  fallback means saying so at Gate 2 rather than quietly shipping half of an approved decision.

- **Option D — keep the in-memory array and defer the decision to Sprint 2 (rejected).** NFR-3.1
  says "before production use", and Gate 2's "Store selection" signal reads no-go while the ADR
  does not name store, key and retention. Deferring does not remove the work; it moves it inside
  2.2, where discovering that the store needs something `evidence/0` does not carry would reopen
  a published contract mid-sprint. That is precisely the sequence the risk register's mitigation
  exists to prevent.

## Consequences

**Easier**

- Task 2.2 writes an adapter against a tested contract instead of a description of one. The port
  (`evidence-store.mjs`) and its conformance suite (`store-conformance.mjs`) exist now; adding
  the PostgreSQL adapter is one more `describeEvidenceStore('postgres', …)` line. Every call in
  that suite is awaited except one: `reads are synchronous` deliberately does not await, and
  asserts the result is not a thenable. An async adapter passes the other fifteen unedited and
  deletes that one, in the same change that makes reads async and awaits them at the seam.
- The seam takes the store by injection, so a test holds its own store and no test depends on
  another's appends.
- Unrecognised additive fields survive storage unchanged, which is what NFR-1.1 asks of the
  system end to end rather than only at the validator.

**Harder, and new constraints on future work**

- `duplicate` and `conflict` are **unreachable over HTTP until 2.1** and are kept alive only by
  the conformance suite. Behaviour no request path exercises decays; the suite is the only thing
  standing between this design and a rediscovery in 2.2.
- **Task 2.2 must add a startup assertion refusing a null `workspace_id` in production
  configuration.** "No idempotency claimed" is a correct answer for a pre-identity scaffold and a
  silent failure in production — the service would accept every replay as a fresh record while
  appearing to work. The assertion is what stops the null branch reaching production.
- **Task 2.2 must choose the wire status for a `conflict`** and declare it in `openapi.json`,
  bumping `info.version` in the same change.
- **`evidence/0` is pinned as un-extendable by the control plane.** Because identity lives in the
  envelope, the control plane must never add a field to the evidence record to solve an identity
  or routing problem; that is now permanent, not a Sprint 1 convenience.
- **A store failure inside the POST handler currently produces the wrong answer.** The `try` in
  the evidence route spans the body read, the parse and the evaluation, and answers any throw
  with the documented 400 envelope, `{"error": "request body must be valid JSON"}`. A store that
  throws would therefore blame the caller's body for the control plane's own fault. It is
  unreachable today — the in-memory adapter throws only on preconditions the seam has already
  validated — but 2.2 must close it with a store-failure status, since a database is the first
  thing in this path that can fail for reasons the caller did not cause.
- The in-memory adapter compares the **projection string** to tell `duplicate` from `conflict`,
  while PostgreSQL's `jsonb` comparison normalises key order. Two bodies differing only in key
  order are a conflict in memory and a duplicate in Postgres. The conformance suite does not pin
  that case; 2.2 should decide it and pin it.
- Sprint 2 inherits the audit-surface gap recorded above, and Gate 2 has to resolve it one way
  or the other before "Audit events for policy changes are queryable" can be honestly ticked.
