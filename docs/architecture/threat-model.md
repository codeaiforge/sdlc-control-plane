# Threat model: evidence ingress and policy administration

- **Status**: Accepted
- **Date**: 2026-09-23
- **Scope**: api+auth
- **Trace**: NFR-2.1, NFR-6.1
- **Classification**: INTERNAL — payload and identifiers (founder, 2026-09-23)

## Scope and method

This models the ingress path published in task 1.1 and the policy administration path ADR-0002
named but did not design: what crosses each boundary, who is on the untrusted side of it, and
which of those crossings is an abuse case somebody has to answer.

**Reachability is measured, not asserted.** Every abuse case below marked _reachable today;
measured_ was established by running the seam — `createApp()` bound to an ephemeral port, driven
over a real socket — and the observed status, the observed store contents and the observed
process RSS are quoted. Three are reachable today without being measured on the socket, and are
labelled so: ABU-6 rests on repository evidence (`git log --format='%G?'`, the absence of
`CODEOWNERS`), ABU-7 on the roadmap's own Definition of Done, and ABU-14 on the absence, before
task 2.1, of any log call in `packages/*/src/` beyond the startup message. None of them is a request whose answer
proves the case, so there was no socket to measure. A claim that something is unreachable is a
claim about code that exists,
and it names the line that makes it so. Nothing here is inferred from reading a handler and
imagining its behaviour, because the one thing this document must not do is describe a system
that is not the one running.

**What this model does not claim.** It is not a penetration test: every reachability claim was
established through the published interface or the repository, and nothing was attempted against
a dependency, the runtime or the host. It models a service with no deploy target — the stack
profile's `Target` row reads `Not selected` — so the network in front of the seam, TLS
termination and any proxy limit are outside it, and TB-1's untrusted side is simply whoever can
open a socket. Requirement 12 below is what the model asks of that network. And the PostgreSQL
store ADR-0002 proposes is modelled **conditional on Gate 2**, never as decided: TB-5 carries that condition in its `Status` cell, and the conformance check
fails the day ADR-0002 leaves `Proposed` while the row still says so.

**Four ID spaces**, all dense from 1 and all referenced rather than repeated: `TB-n` trust
boundaries, `ABU-n` abuse cases, `MIT-n` mitigations, `RR-n` residual risks. Abuse cases are
`ABU-n` and not `AC-n` on purpose: `AC-n` is an acceptance criterion in this task's own Phase ①
brief, and two ID spaces one letter apart in the same sprint is a collision waiting to be
mis-cited in a review.

**STRIDE is applied per boundary, not per asset.** Each trust boundary carries an index across
all six letters, and a letter with nothing behind it reads `n/a` rather than being omitted — an
omitted letter is indistinguishable from a letter nobody considered. The index is the reason
`TB-7` exists: a STRIDE pass over HTTP surfaces will never surface the control plane
misrepresenting its own assurances, because that crossing has no socket. It is in scope because
NFR-6.1's second clause puts it in scope, and it is written down deliberately rather than
discovered.

**Data classification — the question ADR-0002 handed here.** ADR-0002 recorded that "evidence
data classification is undetermined" and fed the question to this task and to Gate 2. It is
answered: **INTERNAL, covering both payload and identifiers**, decided by the founder on
2026-09-23. Covering identifiers is the consequential half. An `evidence/0` payload describes a
workspace's internal structure and delivery activity; the identity pair `(workspace_id,
change_id)` says which workspace was active on which change and when, which is the same class of
fact with the body removed. Classifying only the payload would have left the tombstone ADR-0002
designs outside the classification, and the tombstone is precisely what survives expiry. That
consequence is carried to Gate 2 as a finding rather than resolved here, because resolving it
means editing ADR-0002, which is not this task's to edit.

**Residual-risk acceptances are written back into this document.** A row whose `Accepted by` cell
reads `pending Gate 2` is a risk nobody has accepted yet; an accepted row reads
`<name>, YYYY-MM-DD`. This is the same post-approval edit
`tools/sdlc-controls/adr-conformance.test.mjs` enforces on an ADR's `Deciders` line: it refuses a
record that says `Accepted` while its own approval line still says the approval is outstanding, on
the principle that a record contradicting itself resolves in favour of the sentence saying nobody
signed. `RR-7` was accepted by the founder on 2026-09-23; Gate 2 sat on 2026-10-01 and the founder
accepted every other row.

**What is checked, and what is not.** `tools/sdlc-controls/threat-model-conformance.test.mjs`
holds this document's structure: its header, its sections, the totality of the route coverage,
the totality of the STRIDE index, referential integrity in both directions, that every
mitigation has an owner, and every residual risk either an acceptance or an explicit record that
nobody has made one yet. It cannot judge whether an abuse
case is well chosen, whether a mitigation mitigates, whether the set is complete, or whether a
boundary's `Control` cell is true — an `executable check` citation is held to a path that exists,
not to a file that fails when that control breaks. Those are
Phase ④'s to review, and the check says so in its own header rather than letting a green run
read as a review.

**Task 1.3 ships no production code.** The ingress body limit below is a specification for task
2.1, stated to the byte, with its reasons, so that 2.1 implements a decision rather than making
one. Nothing under `packages/` changes in this task.

**No retained field is personal data today.** Classification answers how sensitive the record is,
not whether erasure is an obligation, and RR-4 and RR-7 both turn on the second question. An
`evidence/0` record carries no name, address or account identifier; the field that would change
that is `owners` on a workspace registration, a non-empty array (checked by
`validateWorkspaceRegistration` in `packages/contracts/src/schema.mjs`) that holds a team name today and is constrained to
nothing — the validator checks only that it is an array with at least one element, not even that
the elements are strings. If a personal name is ever written there, retention stops being an operational choice and
RR-4 and RR-7 need re-deciding rather than re-accepting. Since task 2.1 the envelope also carries
`submitted_by` (ADR-0004), whose `ref`, `workflow_ref` and `job_workflow_ref` are branch, tag and
file names a person chooses and can carry a person's name; ADR-0004 nulls those three, with
`event_name`, on redaction. Since task 2.2 the redaction trigger does it itself, so no redacting
statement can keep them (`packages/evidence-store/migrations/0001-evidence-envelope.sql`).

## System under analysis

The control plane is one deployable — `control-plane-api` — composing five libraries behind an
HTTP seam in `packages/control-plane-api/src/main.mjs`; the fifth, `workload-identity`, verifies a
workload's OIDC token and was added by task 2.1. The seam exports its routes as data:

| Route                | What it answers                                               | Identity required                   |
| -------------------- | ------------------------------------------------------------- | ----------------------------------- |
| `GET /health`        | process liveness, no dependency checked                       | none                                |
| `GET /v1/workspaces` | the caller's own registration, and no other                   | workload principal authorized for W |
| `GET /v1/indicators` | a descriptive aggregate over the caller's workspace's records | workload principal authorized for W |
| `POST /v1/evidence`  | a technical disposition, and an append on an accepted record  | workload principal authorized for W |

"Authorized for W" is ADR-0003's one predicate: a verified GitHub Actions OIDC token whose
`(issuer, repository_owner_id, repository_id)` binds to registration W, W `active`, its event
admitted, any workflow pin matched, and its actor not refused. The seam answers 404 before it reads
any credential, and decides 401, 403 and 503 from the headers before it reads a body byte.

**Measured before task 2.1, at `4f2724f`: there was no identity anywhere in the request path.**
The seam matched a request on `request.method` and `request.url` and nothing else; a
repository-wide search for a header read across every non-test module under `packages/*/src/`
returned nothing. `createRegistry` exported a `get(workspaceId)` lookup
(`packages/workspace-registry/src/registry.mjs:8` at that commit) — the natural consumer of an
authenticated principal — and no caller anywhere in the workspace invoked it. Task 2.1's
predicate is now its caller.

Two things load once, at module scope, and never reload: the workspace registry and the
guardrail policy, both read from `config/control-plane/` near the top of `main.mjs`. A policy
change therefore takes effect on restart and not before. The evidence store is not built at module
scope: since task 2.2 it is ADR-0002's PostgreSQL envelope log, opened by `main.mjs`'s entry block
through `openDurableEvidenceStore()`, and the process refuses to start without it - on an
unusable configuration, an unreachable server, unverified TLS to a non-loopback host, a database
role the startup check refuses (an elevated attribute, membership of any other role, ownership of
the database or of anything in the `evidence` schema, or a grant that could change or remove a
row of the envelope log or its redaction table, or set a row's `received_at` or `redacted_at`; the stack profile's `Access control` row
lists each), or a schema that is not the bundled one.

Measured behaviour of the running seam at `4f2724f`, before task 2.1, quoted because the abuse
cases below were established from it. The first three are closed at the seam since 2.1 (see
ABU-1, ABU-5), and the body-size cases by the ingress cap (ABU-2); none of the four has been
re-measured on a socket since:

- A `POST /v1/evidence` carrying a valid `evidence/0` record and **no credential of any kind** is
  answered `202 Accepted` with `policy_id: baseline-engineering-controls@1`.
- The same request with `Authorization: Bearer not-a-real-token` is answered identically, because
  nothing reads the header.
- Submitting the same record twice yields two `202`s and `total_records: 2` on
  `GET /v1/indicators`.
- A 96 MiB body that is not JSON is answered `400`, having taken the server process from a
  56.1 MiB RSS baseline to a 260.7 MiB peak (4.6x) and `/health` from a 0.392 ms median to
  3.700 ms (9x). RSS settles at 242.4 MiB after the refusal.
- A 96 MiB body that **is** a valid `evidence/0` record is answered `202 Accepted`, taking RSS to
  816.0 MiB (14.5x baseline) — and leaving it there, because the record is now in an append-only
  store that never releases it.
- A body nested deeper than `JSON.stringify`'s recursion limit parses, fails to project, and is
  answered `400 {"error":"request body must be valid JSON"}` — the control plane blaming the
  caller's body for its own fault.

## Trust boundaries

| ID   | Boundary                            | Untrusted side                                                                                               | Trusted side                                                                               | Surfaces                                                                                                                                                                 | Assets crossing                                                                | STRIDE coverage                                         | Control                                                                       | Status  |
| ---- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------- | ----------------------------------------------------------------------------- | ------- |
| TB-1 | Network peer to HTTP seam           | any peer that can open a socket; every route but `GET /health` requires a verified GitHub Actions OIDC token | the request handler in `main.mjs`                                                          | `GET /health`, `GET /v1/workspaces`, `GET /v1/indicators`, `POST /v1/evidence`                                                                                           | evidence records, technical dispositions, registrations, indicator aggregates  | S:ABU-1 T:ABU-3 R:ABU-5,ABU-14 I:ABU-4 D:ABU-2 E:n/a    | executable check `packages/control-plane-api/src/admission.test.mjs`          | current |
| TB-2 | HTTP seam to contract validator     | a parsed but unvalidated request body                                                                        | the `evidence/0` subset `validateEvidence` enforces                                        | `POST /v1/evidence`, `process:packages/contracts/src/schema.mjs`                                                                                                         | the candidate record, its tier, its affected set, its verification list        | S:n/a T:ABU-3,ABU-9 R:n/a I:n/a D:ABU-2 E:n/a           | executable check `packages/contracts/src/schema.test.mjs`                     | current |
| TB-3 | HTTP seam to guardrail evaluator    | the caller's record, and a policy file changed out of band                                                   | `evaluateGuardrails` and the `policy_id` it stamps on                                      | `POST /v1/evidence`, `process:packages/guardrail-policy/src/evaluate.mjs`                                                                                                | policy rules, the approving decision reference, the disposition returned       | S:n/a T:ABU-6,ABU-11 R:ABU-7,ABU-10 I:n/a D:n/a E:ABU-6 | executable check `packages/control-plane-api/src/main.test.mjs`               | current |
| TB-4 | HTTP seam to workspace registry     | a verified principal's claim to a workspace, bound only by the reviewed triple                               | registrations validated at load by `createRegistry`                                        | `GET /v1/workspaces`, `process:packages/workspace-registry/src/registry.mjs`                                                                                             | `repository_url`, `evidence_endpoint`, `owners`, `workspace_id`                | S:ABU-1 T:n/a R:n/a I:ABU-4 D:n/a E:n/a                 | executable check `packages/workspace-registry/src/registry.test.mjs`          | current |
| TB-5 | HTTP seam to evidence store         | an accepted but unattributed record                                                                          | ADR-0002's PostgreSQL envelope log in `packages/evidence-store`, reached as `evidence_app` | `POST /v1/evidence`, `GET /v1/indicators`, `store:packages/evidence-store/src/postgres-store.mjs`, `store:packages/evidence-store/migrations/0001-evidence-envelope.sql` | payload, `(workspace_id, change_id)`, `policy_id`, `received_at`               | S:n/a T:ABU-12 R:ABU-5 I:ABU-13 D:ABU-2,ABU-8 E:ABU-12  | executable check `packages/evidence-store/src/database-roles.integration.mjs` | current |
| TB-6 | Repository to policy administration | any author who can land a commit on the policy path                                                          | the policy and registry loaded at process start                                            | `git:config/control-plane/**`, `forge:pull-request-review`, `process:main.mjs`                                                                                           | guardrail rules, `policy_id`, the approval reference, workspace registrations  | S:ABU-6 T:ABU-6 R:ABU-7 I:n/a D:n/a E:ABU-6             | convention                                                                    | current |
| TB-7 | Control plane to human reader       | the control plane's own published claims about itself                                                        | a human's understanding of what was actually verified                                      | `GET /v1/indicators`, `POST /v1/evidence`, `git:docs/specs/implementation-roadmap.md`                                                                                    | the meaning of a disposition, the indicator disclaimer, every Done-when claim  | S:n/a T:ABU-3 R:ABU-7 I:n/a D:n/a E:n/a                 | convention                                                                    | current |
| TB-8 | HTTP seam to issuer key set         | the network path to and the content at the pinned `jwks_uri`, including any CA the host trusts               | the RSA keys `key-set.mjs` accepts signatures under, for at most the clamped lifetime      | `process:packages/workload-identity/src/key-set.mjs`, `process:packages/workload-identity/src/https-transport.mjs`                                                       | issuer public keys, their `kid`s, and the cache lifetime that bounds their use | S:ABU-15 T:ABU-15 R:n/a I:n/a D:ABU-15 E:n/a            | executable check `packages/workload-identity/src/key-set.test.mjs`            | current |

TB-4 is the boundary NFR-2.1 names. Until task 2.1 the system did not have it: the registry was
loaded, validated and indexed, its only surface was the route that read _out_ of it, and nothing
read _into_ it to authorize a submission. Since 2.1 a verified principal's triple is looked up in
the binding index `createRegistry` builds at load, the registration is read back through
`registry.get`, and a token that binds to nothing authorizes nothing. What the boundary still
cannot see is whether the gate behind a valid token ran unmodified (ADR-0003's limit of
authentication; ABU-11).

TB-5 was `conditional on ADR-0002` until Gate 2 accepted that ADR on 2026-10-01, and the check
below failed on exactly that transition until the row was promoted. Since task 2.2 its trusted side
is the PostgreSQL envelope log ADR-0002 decides, and what crosses it survives a restart. Its control
is the database's, not the seam's - ownership, column grants, the `BEFORE UPDATE` trigger and the
unique index - and only a real server can show it: the check named is an integration test that
logs in as each role, run by `pnpm test:integration` against PostgreSQL 16 in CI.

TB-8 is the one outbound crossing, added by task 2.1 with the fetch it guards (Gate 2 finding 9).
Its untrusted side includes host configuration this code cannot refuse — `NODE_EXTRA_CA_CERTS`,
and on newer Node `NODE_USE_ENV_PROXY` — so a host that trusts a hostile CA or proxies the fetch
can still serve a key set the verifier believes; `NODE_TLS_REJECT_UNAUTHORIZED=0` is overridden,
because the fetch passes `rejectUnauthorized: true` explicitly. The executable check holds the
cache and key rules; the transport rules are held by
`packages/workload-identity/src/https-transport.test.mjs`, through an injected request function
rather than a socket.

TB-7 has no socket, which is the point. Nothing crosses it over a network, so no amount of
transport hardening touches it, and a STRIDE pass driven by the route table would never generate
it. It is the boundary NFR-6.1's second clause describes — "shall not represent automated
technical checks as human approval or regulatory certification" — and the untrusted party on it
is this repository.

`Control` is the boundary's present state, not its planned one: `none`, `convention` (a practice
nothing executes), or `executable check` naming a file that fails when the control breaks. Where
that file catches only part of the control, the rest is named here, because a cell cannot say it.
TB-2's `schema.test.mjs` fails when the version gate breaks. That `verification` and `result` are
present is caught only by `openapi.contract.test.mjs`, which drops each required field and expects
a refusal; that `verification.verified` is an array and `result.pass` a boolean is caught by
nothing. TB-3's
`main.test.mjs` fails when the `policy_id` stamp, the required-control rule or the disposition
breaks; the provenance rule (`evaluate.mjs:22-24`) and the `blocked_tiers` rule (`:20-21`) can each
be deleted with every test green, and task 2.4 adds those tests. No boundary reads `none` since
task 2.1: TB-1 and TB-4, the two NFR-2.1 is about, read `none` until it shipped. TB-1's check
holds admission order, scoping, the respond-then-destroy refusals and the byte cap at the seam,
mostly against a fake socket (only the connection close and `Expect: 100-continue` are held on a
real one, on 127.0.0.1); TB-4's holds the binding index and the registration rules, not the seam
that calls them. TB-6 reads `convention` although
the PR gate runs on every change to it: the gate computes the T3 tier, but the workflow passes it
no approver set, so the review that tier calls for is recorded and never verified. TB-7 reads
`convention` for the same kind of reason. The indicator disclaimer MIT-9 cites is emitted in
full, but every test that reads it (`main.test.mjs`'s "rejected evidence never reaches the
indicator summary" among them) matches only "not a portfolio
decision"; the "compliance conclusion" half — the half NFR-6.1's second clause is about — can be
deleted with the suite green. The disposition's _value_ is pinned — `main.test.mjs`'s "accepts
evidence that satisfies the approved policy" and the
`openapi.json` enum stop `accepted` being relabelled `approved` — and since task 2.1 every
disposition and the indicator carry `evidence_attestation: "self-attested"` (ADR-0004), pinned by
the contract test; but nothing checks how a `202`
or a Done-when tick is _interpreted_, and interpretation is what this boundary is about.

## Abuse cases

`Boundary` names **one** crossing where the case applies — most cases cross more than one, and the
row names a representative. `STRIDE` is the **union** of the letters every boundary files it under,
not the letters for the boundary the row names. The conformance check holds both: the named
boundary must be one that indexes the case, and the letters must match the union.

| ID     | Boundary | STRIDE  | Abuse case                                                                                                                                                                                    | Answered by    |
| ------ | -------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| ABU-1  | TB-1     | S       | Anyone who can reach the port submits evidence as any workspace, and the control plane records it as accepted.                                                                                | MIT-1, MIT-2   |
| ABU-2  | TB-1     | D       | A single unauthenticated socket exhausts process memory by streaming a body the seam buffers whole.                                                                                           | MIT-4          |
| ABU-3  | TB-1     | T       | Forged or bulk submissions move the published indicator, which is read as a statement about real delivery.                                                                                    | MIT-2          |
| ABU-4  | TB-4     | I       | An unauthenticated reader harvests every workspace's repository, endpoint and owner, and the whole indicator.                                                                                 | MIT-3          |
| ABU-5  | TB-5     | R       | With `workspace_id` null nothing claims uniqueness, so a replay is indistinguishable from a distinct submission.                                                                              | MIT-5          |
| ABU-6  | TB-6     | S, T, E | A commit rewrites the guardrail rules or forges its own author, and the next restart enforces the new policy.                                                                                 | MIT-6, MIT-7   |
| ABU-7  | TB-7     | R       | The control plane states an assurance it does not deliver, and a human reads a green check as an approval.                                                                                    | MIT-9, MIT-10  |
| ABU-8  | TB-5     | D       | A refused body becomes an unbounded, unclassified, attacker-supplied write primitive aimed at the durable store.                                                                              | MIT-8          |
| ABU-9  | TB-2     | T       | A submitter omits `ai_assisted` or sets it false, so the provenance rule never applies and the record is counted clean.                                                                       | MIT-11         |
| ABU-10 | TB-3     | R       | A guardrail policy with its `approval` block deleted starts the process and stamps its `policy_id` on every acceptance.                                                                       | MIT-12         |
| ABU-11 | TB-3     | T       | A submitter declares its own tier, verified controls and result, and the guardrail evaluates the claims as facts.                                                                             | MIT-13         |
| ABU-12 | TB-5     | T, E    | The application role or the retention job rewrites or deletes evidence that was already accepted.                                                                                             | MIT-14, MIT-15 |
| ABU-13 | TB-5     | I       | INTERNAL evidence at rest — the durable store and its backups — is read by a role or a copy with no need for it.                                                                              | MIT-16         |
| ABU-14 | TB-1     | R       | Refused, unauthenticated and abusive requests leave no log line, so ABU-1, ABU-2 and ABU-3 go undetected.                                                                                     | MIT-17, MIT-18 |
| ABU-15 | TB-8     | S, T, D | A redirected, spoofed or oversized key-set response, or a stream of forged `kid`s during an outage, makes the verifier trust a key it should not or turns every authenticated route into 503. | MIT-19         |

**ABU-1 — unauthenticated submission and evidence forgery. Reachable before task 2.1 (measured 2026-09-23, at `4f2724f`); closed at the seam by
MIT-2 — see `packages/workload-identity/src/authenticate.test.mjs` and
`packages/control-plane-api/src/admission.test.mjs`; not re-measured on a socket.** At that commit a
`POST /v1/evidence` with no credential was answered `202 Accepted` with a real `policy_id`; the
same request carrying a deliberately invalid bearer token was answered identically, because no
module under `packages/*/src/` read a request header. The rest of this paragraph is the case as
measured then. There is no identity to forge, which is
worse than a forgeable one: forgery implies something was claimed. The record entered the store
attributed to nobody, and `GET /v1/indicators` then counted it. This is the case NFR-2.1 exists to
close — "authenticate the calling workload and authorize it for the registered workspace" — and
TB-1 and TB-4, the two boundaries whose `Control` reads `none`, are its two halves.

**ABU-2 — ingress resource exhaustion. Reachable before task 2.1 (measured 2026-09-23, at `4f2724f`); closed at the seam by MIT-4 — see
`packages/control-plane-api/src/admission.test.mjs`; not re-measured on a socket.** At that commit
the POST handler (`main.mjs:81-83`) accumulated
every chunk into an array and concatenated once, so peak memory was a multiple of the body the
caller chose to send, and the caller chose without limit. Since 2.1 only an authorized workload
reaches the read at all, the read stops at 1 MiB, and RR-10 records what the cap does not bound. A 96 MiB unparseable body took the
server from 56.1 MiB RSS to 260.7 MiB and `/health` to 9x its median before being answered `400`.
The refusal is the _cheap_ case. A 96 MiB body that is a **valid** `evidence/0` record is answered
`202 Accepted`, drives RSS to 816.0 MiB, and leaves it there permanently, because an append-only
store does not release what it accepted. Refusal costs transient memory; acceptance costs
resident memory for the life of the process.

**ABU-3 — indicator poisoning. Reachable by an anonymous client before task 2.1 (measured
2026-09-23, at `4f2724f`); since 2.1 only an authorized workload can move an indicator, and only
its own workspace's — not re-measured on a socket.** At that commit `summarizeEvidence` counted every
record in the store with no notion of who submitted it, and three submissions from one anonymous
client moved `total_records` from 0 to 3 and `by_tier.T1` with it. The indicator's own disclaimer
field says it is descriptive rather than a compliance conclusion, which is true and is not a
defence against the number being wrong. Authentication (MIT-2) removes the anonymous submitter,
not the false claim: ABU-11 is what an authenticated workload can still do.

**ABU-4 — cross-workspace disclosure. Reachable before task 2.1 (measured 2026-09-23, at `4f2724f`); closed at the seam by MIT-3 — see
`packages/control-plane-api/src/admission.test.mjs`; not re-measured on a socket.** Since 2.1 each
read route answers only the caller's own workspace. At that commit `GET /v1/workspaces` returned,
unauthenticated, every registration in full: `repository_url`, `evidence_endpoint`, `owners`,
`value_stream` and `solution` for every governed workspace. That is a map of an organisation's
internal delivery topology and the addresses that accept its evidence. `GET /v1/indicators`
aggregates across every workspace at once with no scoping parameter to leave out. Under the
INTERNAL classification settled above, both routes publish classified data to anyone who can
reach the port.

**ABU-5 — replay and idempotency defeat. Reachable before task 2.1 (measured 2026-09-23, at `4f2724f`); narrowed at the seam by task 2.1;
closed by task 2.2 (MIT-5).** A submission carries the principal's `workspace_id`, and the
idempotency index is the database's unique constraint on `(workspace_id, change_id)`: a replay
after a `SIGKILL` and restart, or racing from a second process, is a `duplicate` and leaves one
row, measured over real processes on PostgreSQL 16
(`packages/control-plane-api/src/durable-service.integration.mjs`). RR-2 records what remains: a
replay's decision is computed for the replay. At that commit submitting a byte-identical
record twice produced two `202`s and `total_records: 2`. ADR-0002's collision rule has a row for
this — `workspace_id === null` appends with `idempotency_key: null` and claims no uniqueness —
and it is the correct answer for a pre-identity scaffold. It is the wrong answer for anything
holding real evidence, because every replay counts again and nothing can distinguish a retry from
a distinct change. The fix is not in the store; it is `workspace_id`, which 2.1 now supplies,
together with the durable index 2.2 built.

**ABU-6 — policy tampering through the git path. Reachable today.** `config/control-plane/**` is
read at module scope and never re-read, so a change lands on the next restart with no runtime
signal. The reviewed-commit trail that stands in for policy administration has two measured
holes: there is **no `CODEOWNERS` file anywhere in the repository**, so no path requires a
particular reviewer; and **every commit is unsigned** — `git log --format='%G?'` returns `N` for
all of them, with `commit.gpgsign` and `user.signingkey` both unset — so the author field is free
text that `git commit --author` plus a force-push rewrites. What does hold is tiering: the path is
`criticality: critical` in `generate-component-map.mjs`, so any change to it tiers T3, and T3
calls for two independent approvers. The gate records that requirement and does not verify it:
`.github/workflows/sdlc-controls.yml` passes the engine neither `--author` nor `--approvers`, and
without them its approver controls are "recorded but not verified". Tampering is therefore
visible in the evidence record, stopped only by whatever branch protection the forge enforces,
and easy to misattribute once landed.

**ABU-7 — governance misrepresentation. Reachable today.** This is the abuse case with no
attacker. Sprint 2's Definition of Done said "Audit events for policy changes are queryable" (Gate 2
reworded it to git history, RR-5) and no scheduled task builds a queryable surface — 2.1 is identity, 2.2 is evidence intake, 2.3 is
operator telemetry, 2.4 is policy and provenance hardening, and 1.3 is this document. `docs/contracts.md` already carries the correction
for its own earlier version of the same overstatement. The harm is not technical: a human reading
a ticked box concludes an audit capability exists, which is exactly the representation NFR-6.1
forbids the system to make.

**ABU-9 — self-declared AI provenance. Reachable today; measured.** `evaluateGuardrails`
(`packages/guardrail-policy/src/evaluate.mjs:22`) applies the provenance rule only when the
record says `ai_assisted` is true, and `ai_assisted` is a field the submitter writes. Measured
against the running seam: `ai_assisted: true` with no `ai_tool` is refused `422
needs-remediation`, as FR-3.1 intends — but **omitting the field entirely returns `202`**, and so
does `ai_assisted: false`. Where the rule does apply it tests only that `ai_tool` is truthy, so
`ai_tool: {}` is answered `202` as well. The submitter therefore decides whether the rule applies to it, and
the record is then counted clean in `GET /v1/indicators`. This is a control that reports a pass
it did not establish, which is the same shape as ABU-7 and bears on NFR-6.1's second clause.
A workload principal carries no claim about AI use, so the founder's gate decision on task 2.1
(Q-3, 2026-10-07) closes the bypass by making `ai_assisted` a required boolean, with a non-empty
`ai_tool` when it is true; task 2.4 implements it (MIT-11). Until then RR-8 records that the rule
is opt-in.

**ABU-10 — an approving reference that resolves to nothing. Reachable today; measured.**
NFR-6.1's first clause is "retain the approving decision reference", and the envelope does retain
`policy_id`. What nothing checks is that the policy the id names carries an approval at all.
`assertUsablePolicy` in `main.mjs` validates exactly two fields, and measured: a
`guardrails.json` with its entire `approval` block deleted returns `[]` — no errors — the process
starts, and every acceptance is stamped `policy_id: baseline-engineering-controls@1`. Nothing
under `packages/` reads `policy.approval`; the only mention in the tree is the description of
`AcceptedDecision.policy_id` in `openapi.json`,
which describes `policy_id` as "traceable to the human approval recorded with that policy" — a
claim the seam does not enforce. And the approval that _is_ present is an example: the shipped
`config/control-plane/guardrails.json` records `decision_id: "LPM-EXAMPLE-001"`, so every
`policy_id` stamped today traces to a placeholder rather than to a decision anyone made. A check
that the block is present would pass it. MIT-12 gives both halves to task 2.4 as a startup
refusal (re-owned from 2.1 at 2.1's Phase ① gate, 2026-10-07).

**ABU-8 — the refused body as a write primitive. Unreachable, by decision.** This is the abuse
case ADR-0002 hands to 1.3 by name. A 400 body is by definition unparseable: retaining it means
retaining an arbitrary byte sequence from an unauthenticated caller, of unbounded length and
undetermined classification, written into the durable evidence log. **Refusals never enter the
evidence store**, and that is structural rather than conventional — the `POST /v1/evidence`
handler in `main.mjs` answers every refusal (401, 403, 413, 429, 400, 422) by writing a response
and returning, and `evidenceStore.append` is reached only by the handler's one `append`, after an
acceptance. A 422 body is parseable and would genuinely help a producer
debug, and is still not retained: pre-2.1 it is unattributed, and mixing refused content into the
log dilutes the single property the log exists to have. If a refusal stream is ever justified, it
is a separate stream with its own classification, retention and access decisions — it does not
arrive by relaxing this. What 2.3 needs is a count with a reason, not a body.

**ABU-11 — self-attested evidence. Reachable today; measured.** Every rule `evaluateGuardrails`
applies reads a field the submitter wrote. Measured against the running seam, each of these is
answered `202 accepted`: a record whose `result.pass` is `false`, because no rule reads it; and a
record whose `verification.verified` contains `CAF-SDLC-002:tier`, which satisfies
`require_verified_controls` by containing the string, whatever ran. The tier is the same by
design rather than by measurement: `blocked_tiers` (`evaluate.mjs:20-21`) is checked against the
tier the record states, and the shipped policy blocks no tier, so there is nothing yet to evade. Under `require_verified_controls` a `202
accepted` reads as "control verified" and means "the submitter said so" — the representation
NFR-6.1's second clause forbids. Authentication does not change this: 2.1 establishes _who_
submitted, not whether the claims are true. Whether claims are attested — signed by the engine
and bound to the workload identity, or recomputed — or recorded as the submitter's word is a
decision, and MIT-13 gives it to 1.4. RR-11 records the gap until then.

**ABU-12 — accepted evidence rewritten or deleted. Unreachable at the port; refused by the database
since task 2.2 (MIT-15).** The store port exposes `append`, `list` and `listRecords` and no
method that removes or rewrites a record, and the conformance suite's "the port exposes no method
that could remove or rewrite a record" test in `store-conformance.mjs` asserts that those three
are the store's only keys (MIT-14). The durable store changes the question: a role that owns a table holds `UPDATE`
and `DELETE` implicitly, and ADR-0002's retention job performs one in-place write by design.
ADR-0002 answers both, and task 2.2 built it stricter in four places, each measured as each role
on PostgreSQL 16 (`packages/evidence-store/src/database-roles.integration.mjs`): the trigger is
`SECURITY DEFINER`, so the retention role holds no `INSERT` on `evidence_redaction` and cannot forge
a redaction row; it stamps `redacted_at` and nulls the four `submitted_by` names itself and refuses
any update to a tombstone; the retention and audit roles cannot read a payload; and the application
role's `INSERT` omits `redacted_at`, because the pairing `CHECK` alone admits a row that arrives
already redacted, and `received_at`, so the database's clock, not the application, sets each row's
retention clock. What remains is the trust root: `evidence_owner` and any cluster superuser can
still disable the trigger or re-grant themselves `DELETE` - a credential-custody requirement on the
deploy target, stated in the stack profile's `Access control` row. So is a member of the built-in
`pg_write_all_data` role once it is also granted `CONNECT`: it can forge or delete
`evidence_redaction` rows, back-date a row's `received_at` and rewrite `schema_migrations`
(measured). A stolen `evidence_app` credential rewrites nothing, but it can append records for any
workspace, attributed to anyone, and so claim another workspace's `(workspace_id, change_id)` first:
that workspace's real submission is then answered 409 for good. Only the token check in front of
the seam binds a record to its workspace. And the trigger checks the form
of a redaction, not the age of the row: whoever holds the `evidence_retention` credential can
redact every live payload at once, irreversibly, each leaving an `evidence_redaction` row. Holding
redaction to the 90-day window is task 2.5's job, and this residual is an input to it.

**ABU-13 — classified evidence at rest. Answered by task 2.2 for the roles it creates (MIT-16).**
The durable store and every backup of it hold payloads and identifiers classified INTERNAL. Two
roles can read a payload - `evidence_app`, which serves the indicators, and `evidence_owner`, which
owns the table - and the retention and audit roles cannot; the stack profile's `Access control`
row records who and why, and a grants snapshot compares the server's real ACLs with that list. A
cluster superuser, a member of a built-in read role such as `pg_read_all_data` once it is also
granted `CONNECT` (two administrator acts the grants snapshot does not see), backups, replicas and
operator copies are outside anything this code controls,
and are stated there as requirements on whoever selects the deploy target, not as properties.

**ABU-14 — abuse leaves no trace. Reachable before task 2.1 (at `4f2724f`, from the absence of
any log call); closed at the seam by MIT-17 — see
`packages/control-plane-api/src/refusal-log.test.mjs`.** At that commit the seam's only log line
was the startup message (`main.mjs:119` there). A refused body, a replay, a 96 MiB submission and a
failed authentication left no log line, so ABU-1, ABU-2 and ABU-3 could not be detected while
they happened or investigated afterwards. Since 2.1 every refusal writes one JSON line to stderr;
a replay that is accepted as a `duplicate` is not a refusal and still writes none. 1.2's security assessment handed this forward as "no
ingress security logging". MIT-17 gave 2.1 the events it creates; MIT-18 gives 2.3 the count.
2.3 is a _Should_ and the roadmap's named deferral candidate, which is what RR-12 records.

**ABU-15 — the key set as an attack surface. Added by task 2.1 with the fetch; not measured
against GitHub.** The verifier trusts whatever keys it fetched from the pinned `jwks_uri`, so the
fetch is a crossing of its own (TB-8). A redirect followed to another host, a response that is not
GitHub's, or one large enough to exhaust memory would each make the verifier trust the wrong key or
fail; and because every authenticated route needs an unexpired key set, a stream of forged `kid`s
that each forced a refetch during an outage would turn every route into 503. MIT-19 answers it in
`packages/workload-identity/src/https-transport.mjs` and `key-set.mjs`; RR-13 records what a GitHub
outage still costs.

## Mitigations

| ID     | Mitigation                                                                                                                                                                               | Addresses    | Owning task | Evidence                                                         |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ----------- | ---------------------------------------------------------------- |
| MIT-1  | Name an OIDC issuer and an authorization model binding a principal to a registered workspace.                                                                                            | ABU-1        | 1.4         | —                                                                |
| MIT-2  | Authenticate the calling workload and authorize it for the workspace before any append.                                                                                                  | ABU-1, ABU-3 | in place    | `packages/workload-identity/src/authenticate.test.mjs`           |
| MIT-3  | Scope every read route to the authorized principal instead of returning the whole registry or store.                                                                                     | ABU-4        | in place    | `packages/control-plane-api/src/admission.test.mjs`              |
| MIT-4  | Enforce the admission limits specified below — byte cap, read timeouts, quota; MIT-2 authenticates first.                                                                                | ABU-2        | in place    | `packages/control-plane-api/src/admission.test.mjs`              |
| MIT-5  | Persist accepted evidence keyed by `(workspace_id, change_id)` so a replay is answered as one.                                                                                           | ABU-5        | in place    | `packages/control-plane-api/src/durable-service.integration.mjs` |
| MIT-6  | Refuse to start on an unusable guardrail policy rather than serving under one.                                                                                                           | ABU-6        | in place    | `packages/control-plane-api/src/main.mjs`                        |
| MIT-7  | Tier every change under the policy path T3, so the gate's evidence records its two-approver requirement.                                                                                 | ABU-6        | in place    | `tools/sdlc-controls/generate-component-map.mjs`                 |
| MIT-8  | Keep refused submissions out of the evidence store, as a decision rather than an omission.                                                                                               | ABU-8        | in place    | `packages/control-plane-api/src/main.mjs`                        |
| MIT-9  | Carry the not-a-compliance-conclusion disclaimer in every indicator response body.                                                                                                       | ABU-7        | in place    | `packages/indicators/src/summarize.mjs`                          |
| MIT-10 | State the policy-administration gap in the published contract document instead of a coming surface.                                                                                      | ABU-7        | in place    | `docs/contracts.md`                                              |
| MIT-11 | Derive AI provenance from the submitting principal rather than a caller-supplied boolean.                                                                                                | ABU-9        | 2.4         | —                                                                |
| MIT-12 | Require a complete approval block before the process will start, and ship a policy whose approval is real.                                                                               | ABU-10       | 2.4         | —                                                                |
| MIT-13 | Decide whether evidence claims are attested and bound to the workload identity, or recorded as self-attested.                                                                            | ABU-11       | 1.4         | —                                                                |
| MIT-14 | Expose no store method that can remove or rewrite an accepted record.                                                                                                                    | ABU-12       | in place    | `packages/evidence-store/src/store-conformance.mjs`              |
| MIT-15 | Build ADR-0002's role separation, grants and `BEFORE UPDATE` trigger with the durable store.                                                                                             | ABU-12       | in place    | `packages/evidence-store/src/database-roles.integration.mjs`     |
| MIT-16 | Record which roles, operators and backup copies may read classified evidence at rest, and grant nothing else.                                                                            | ABU-13       | in place    | `packages/evidence-store/src/database-roles.integration.mjs`     |
| MIT-17 | Log every authentication failure and every refusal with principal, route, status and reason, never the body.                                                                             | ABU-14       | in place    | `packages/control-plane-api/src/refusal-log.test.mjs`            |
| MIT-18 | Count refusals by reason as operator telemetry, so a spike is visible without reading logs.                                                                                              | ABU-14       | 2.3         | —                                                                |
| MIT-19 | Fetch keys only from the pinned HTTPS `jwks_uri` with no redirect, 5 s and 64 KiB; cache for `max-age` clamped to [60, 3600] s; one fetch per 60 s shared by every trigger; fail closed. | ABU-15       | in place    | `packages/workload-identity/src/key-set.test.mjs`                |

MIT-8's evidence is the seam, not ADR-0002: the `POST /v1/evidence` handler's one `append` is the
only one and it runs after an acceptance; the database's grants decide what can be written, not
whether a refused record is offered. MIT-14's evidence is the conformance suite rather than the
store, because the suite is what fails if a mutating method is added. MIT-5, MIT-15 and MIT-16 are
in place since task 2.2, and each Evidence path is an integration test against a real PostgreSQL
16 server, run by `pnpm test:integration` in CI, never by `pnpm test`.

`Owning task` is `in place` only where a path in this repository already enforces the mitigation,
and the check below resolves that path and fails if it does not exist. Everything else names a
roadmap task, and the check fails if the roadmap has no such task — a mitigation owned by a task
number nobody scheduled is a mitigation nobody is going to write.

MIT-11 and MIT-12 were re-owned from 2.1 to task 2.4 by the founder's gate decision Q-1 on
task 2.1 (2026-10-07), which split policy and provenance hardening out of 2.1. MIT-11's shape is
the gate's decision Q-3: `ai_assisted` becomes a required boolean, because a workload principal
carries no claim about AI use to derive it from; the row's wording is kept as the threat this
model handed forward. MIT-2, MIT-3, MIT-4 and MIT-17 are in place since task 2.1; each Evidence
path is the test that fails when its control breaks, and each runs in-process, not over a socket.

MIT-1 and MIT-2 are deliberately two rows. Selecting an issuer is 1.4 and enforcing a token is
2.1; collapsing them would let the gate's identity signal be satisfied by the task the gate
guards, which is the sequencing error that caused 1.4 to be added to the roadmap in the first
place.

## Residual risks

| ID    | Residual risk                                                                                                                                                                                                        | From   | Why accepted                                                                                                                                                                                                                                                                                                                                                                                                  | Accepted by                     | Review point |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ------------ |
| RR-1  | The policy audit trail is attributable but not verifiable: unsigned commits and no `CODEOWNERS`.                                                                                                                     | ABU-6  | Gate 2 (2026-10-01) requires signed commits on this repository from that day; not yet configured at the approval commit `1a0d5f8`, which is unsigned. `CODEOWNERS` and branch protection stay absent while the founder works solo, because no second person can review.                                                                                                                                       | dsofianos (founder), 2026-10-01 | Gate 3       |
| RR-2  | A replay is answered with the decision computed for the replay: after a restart under a changed policy it can name another `policy_id` than the stored record, or be a 422 for a record the store holds as accepted. | ABU-5  | Gate decision Q-14 on task 2.2 kept evaluate-then-append: no read before every evaluation and no decision built from storage, which the contract does not describe. The stored envelope stays the first acceptance, `openapi.json` divergence 6 says so, and the durable unique index keeps the replay itself a `duplicate` across restarts and processes; the service's store refuses a null `workspace_id`. | dsofianos (founder), 2026-10-20 | Gate 3       |
| RR-3  | `guardrails/0` has no contract test, so the policy file and its documented field list can drift apart.                                                                                                               | ABU-6  | Policy is consumed configuration rather than a served contract, so it has no place in `openapi.json` yet.                                                                                                                                                                                                                                                                                                     | dsofianos (founder), 2026-10-01 | Task 2.4     |
| RR-4  | The tombstone retains `(workspace_id, change_id)` past expiry, which is now classified metadata.                                                                                                                     | ABU-4  | Gate 2 approved ADR-0002 as written: the tombstone holds numeric identifiers and a change ID, with names nulled by ADR-0004, and it is what keeps a late replay a `duplicate`. Task 2.2 implements it as decided: the trigger refuses any update to a tombstone, so tombstones are kept indefinitely, and no tombstone expiry is built.                                                                       | dsofianos (founder), 2026-10-20 | Gate 3       |
| RR-5  | No queryable policy-change audit surface exists, and Sprint 2's Definition of Done says one will.                                                                                                                    | ABU-7  | Gate 2 rewrote Sprint 2's Definition of Done: policy changes are queryable from the git history of `config/control-plane/**`, the audit trail ADR-0002 decides. No API surface is built.                                                                                                                                                                                                                      | dsofianos (founder), 2026-10-01 | Gate 3       |
| RR-6  | The quota and read timeouts are per process: N processes admit 60·N submissions per principal a minute, and a restart resets the window.                                                                             | ABU-2  | Gate decision Q-5 on task 2.1 (2026-10-07) chose a per-process code constant; gate decision Q-15 on task 2.2 re-accepted it rather than build a shared counter, which would be a write on every request and is outside 2.2's Done-when. One process is the only deployment shape that exists today; choosing a deploy target that runs more than one brings this back before Gate 3 does.                     | dsofianos (founder), 2026-10-20 | Gate 3       |
| RR-7  | The 90-day retention window has an operational basis only, now applied to data classified INTERNAL.                                                                                                                  | ABU-4  | The shorter window is the conservative choice under a classification that was undetermined until today.                                                                                                                                                                                                                                                                                                       | dsofianos (founder), 2026-09-23 | Gate 3       |
| RR-8  | `ai_assisted` stays submitter-declared until 2.4 makes it a required boolean, so the provenance rule is opt-in.                                                                                                      | ABU-9  | A workload principal carries no claim about AI use to derive it from (gate decision Q-3); inferring it from the record is the same untrusted input under another name.                                                                                                                                                                                                                                        | dsofianos (founder), 2026-10-01 | Task 2.4     |
| RR-9  | A policy with no approval block starts, and the shipped policy's approval is a placeholder, `LPM-EXAMPLE-001`.                                                                                                       | ABU-10 | NFR-6.1's first clause is met by retaining the reference; whether the reference resolves to a real approval is 2.4's to enforce at startup, in the same change as MIT-12.                                                                                                                                                                                                                                     | dsofianos (founder), 2026-10-01 | Task 2.4     |
| RR-10 | `GET /v1/indicators` reads every envelope of the caller's workspace into memory on each request, and nothing bounds how many a workspace keeps until task 2.5 expires payloads.                                      | ABU-2  | Task 2.2 moved the store off the heap - envelopes are PostgreSQL rows - and scoped the read to the caller's workspace (`list({ workspace_id })`), so growth is per workspace and on disk, and 2.1's per-principal quota bounds its rate. The per-request read is bounded by what one workspace submits inside the retention window, which task 2.5 enforces.                                                  | dsofianos (founder), 2026-10-20 | Task 2.5     |
| RR-11 | Tier, verified controls and result are the submitter's word; authentication will establish who, not whether it is true.                                                                                              | ABU-11 | ADR-0004 (Accepted) records every disposition as the workload's own claim, bound to its verified run and labelled `self-attested`; signing evidence is a future decision.                                                                                                                                                                                                                                     | dsofianos (founder), 2026-10-01 | Gate 3       |
| RR-12 | If 2.3 defers to Sprint 3, refusals are logged by 2.1 but not counted until then, so a spike is visible only in logs.                                                                                                | ABU-14 | The roadmap defers 2.3 rather than compress it, deciding at Sprint 2's mid-point; 2.1's log line alone keeps an investigation trail.                                                                                                                                                                                                                                                                          | dsofianos (founder), 2026-10-01 | Task 2.3     |
| RR-13 | Availability depends on GitHub's key set: an outage longer than the cached set's remaining life (≤ 3600 s) answers 503 on every authenticated route, for up to 60 s after recovery.                                  | ABU-15 | ADR-0003's "Residuals for Gate 2" lists it and Gate 2 accepted that list (Findings handed to Gate 2 › 9); serving an expired key would trade a visible outage for verifying against a key GitHub may have withdrawn.                                                                                                                                                                                          | dsofianos (founder), 2026-10-07 | Gate 3       |

The founder's gate decision Q-1 on task 2.1 (2026-10-07) re-pointed RR-3, RR-8 and RR-9 from
task 2.1 to task 2.4, which took over the policy and provenance work; their acceptances of
2026-10-01 stand, and RR-8's reason was restated for gate decision Q-3. RR-2 and RR-6 were
rewritten to the risks that remain once task 2.1 shipped what they described as missing, and the
founder accepted the successors, with the new RR-13, at 2.1's Phase ② gate (2026-10-07). RR-2,
RR-4, RR-6 and RR-10 were reviewed at their task-2.2 review point: RR-2 and RR-10 were rewritten to
the risks that remain once the durable store shipped, RR-4 was confirmed as implemented, and RR-6
was re-accepted with a new review point; the founder accepted all four at 2.2's Phase ② gate
(2026-10-20).

## Ingress body limit — specification for task 2.1

- **Byte cap**: 1048576

  One mebibyte, chosen from measurement rather than convention. At a 60-character path — the
  shape a real monorepo produces — a serialised `affected_set` entry costs 63 bytes, so 1 MiB
  admits about 16,600 paths. A repo-wide reformat of a large monorepo, call it 6,500 files, sits
  at roughly 2.6x headroom inside that; 20,000 paths would need 1.20 MiB and is refused. For
  scale at the other end, this entire repository submitted as one `affected_set` — all 144
  files `main` tracked when this was measured — serialises to 4.9 KiB, under half a percent of the cap. The cap is generous
  against every legitimate submission anyone has described and still two orders of magnitude
  below the 96 MiB a single socket demonstrably lands today.

- **Counted**: received bytes

  The running total of bytes actually read off the socket, accumulated inside the existing
  `for await (const chunk of request)` loop, compared after each chunk. `content-length` is a
  fast path and nothing more: a chunked request declares no length at all — verified by sending
  one, which the seam answered `202` with no `Content-Length` header present — and a header that
  lies is a header, not a measurement. Rejecting early on an honest oversized `content-length`
  saves the transfer; the running counter is what makes the limit true. Implement both, and let
  the counter be authoritative.

- **Wire status**: 413

  Not 400. A 4 MB body can be perfectly well-formed JSON and a perfectly valid `evidence/0`
  record — the 96 MiB body measured above was accepted with a `202` precisely because it was
  valid — so answering an oversized body with "request body must be valid JSON" states something
  false about it. FR-2.2 requires rejection with actionable validation reasons, and "your body is
  malformed" is not actionable for a producer whose body is fine and merely large. The producer
  needs to be told to split the submission, which is a different instruction.

- **Disposition**: respond then destroy

  Write the 413 first, then destroy the socket. Order is the whole content of this bullet.
  Draining the remainder keeps reading a stream already refused, which hands the attacker the
  transfer they were denied. Destroying first means the client sees `ECONNRESET` and never reads
  the 413 — so the control plane refuses correctly and the producer learns nothing about why, and
  retries.

- **Contract consequence**: openapi.json gains 413 on POST /v1/evidence; info.version 0.1.0 -> 0.2.0

  `packages/control-plane-api/openapi.json` is held to the seam in both directions by
  `packages/control-plane-api/src/openapi.contract.test.mjs`: a status the seam can answer with
  and the document does not declare fails there. So 2.1 cannot ship the limit without declaring
  the status, and cannot declare the status without bumping `info.version`. Both edits belong in
  the same change as the limit. This document does not read `openapi.json` and its check does not
  either — that file has one reader, and a second one would be a second source of truth.

- **Owning task**: 2.1

  The limit ships with authentication because both are ingress admission control and both change
  what the seam does before it reads a body. It is **not** an environment variable. A tunable
  limit is a second policy surface with no review path, no approval record and no tier — the
  exact shape of ungoverned policy this control plane exists to object to. It is a constant, in
  the code, changed by a reviewed commit.

**The limit must not be signalled by throwing.** At `4f2724f`, `main.mjs:93-95` was a blanket
`catch` that answered any throw inside the handler with `400 {"error": "request body must be valid
JSON"}`, unconditionally, and the handler still has one. Verified: a body nested past `JSON.stringify`'s recursion limit parses fine,
throws inside `project()`, and is answered `400` — the control plane blaming the caller for its
own projection fault. A thrown 413 would be silently converted into the wrong status by the same
path, and no contract test would catch it because the seam really would be answering a declared
status. Enforce the limit inline: respond and return from inside the read loop, **before**
`JSON.parse` and **before** `project()`. Enforcing after either one has already paid the cost the
limit exists to avoid.

**The cap bounds one body, not the connections carrying them.** Node's defaults are a 300-second
`requestTimeout`, a 60-second `headersTimeout` and no `maxConnections` limit, so a thousand slow
sockets each sending just under the cap hold a thousand buffers for five minutes. Three further
admission rules belong in the same change. **Authenticate on the headers before reading a single
body byte**: an unauthenticated request is answered `401` and destroyed without its body being
read, which makes every other cost here an authenticated one. **Set the read timeouts** to what a
1 MiB upload needs, not what Node assumes. **Apply a per-principal quota** on submissions, because
a cap per request multiplied by an unlimited request rate is not a cap, and RR-10 records what an
unbounded rate costs the store. That each exists was decided here; task 2.1 set the numbers, as
code constants in `packages/control-plane-api/src/admission.mjs`:

- `headersTimeout` 10000 ms and `requestTimeout` 30000 ms. 1 MiB in 30 s needs about 35 KiB/s
  sustained, with room for a 5 s key-set fetch. **Derived by arithmetic from the cap, not
  measured** on a real link, which the threat model asked for; Node's defaults are 60 s and 300 s.
  Node checks both on one timer, every `connectionsCheckingInterval`, 30 s by default, which let
  a slow request outlive its timeout by up to 30 s. The seam sets 1000 ms, so headers are cut by
  11 s and the whole request by 31 s at the latest.
- 60 submissions per principal per fixed 60 s window, the figure of the founder's gate decision
  Q-5, answered 429 with `Retry-After` before the body is read. **Per process**: N processes admit
  60·N, a restart resets the window, and at the cap that is up to 60 MiB a minute per principal
  into the evidence store. RR-6 and RR-10 record what remains: task 2.2 moved the store into
  PostgreSQL and kept the quota per process (its gate decision Q-15).
- The cap is counted inside the read loop as specified, but the loop drives the body iterator by
  hand rather than with `for await`: leaving a `for await` early destroys the request, and with it
  the socket, before the 413 can be written, which is the destroy-first failure the Disposition
  bullet above rules out.

## Policy administration

Policy administration today is a reviewed commit to `config/control-plane/`, read once at process
start. It is a real control and a limited one, and both halves have to be said.

What holds. The path is `criticality: critical` in `tools/sdlc-controls/generate-component-map.mjs`,
so every change to it tiers T3, and the gate emits an evidence artifact, tied to the commit,
recording that T3 calls for two independent approvers. It records the requirement without
verifying it — the workflow passes the engine no approver set — so whether two people approved
is decided by branch protection, which is forge configuration this repository cannot show. The policy is validated at startup by `assertUsablePolicy`
in `main.mjs` and the process refuses to start on a policy that would make the seam emit a
202 its own published schema rejects. Registrations are validated on load by `createRegistry` and
a bad one throws, as does a registry document that is not `workspace-registry/1`.

What does not hold. There is no `CODEOWNERS` file, so no reviewer is required by path — the two
approvers the tier demands are any two. Commits are unsigned, so the attribution the trail
depends on is free text. A policy change is invisible until a restart, so an operator cannot tell
from the running process which policy is in force. And none of it is queryable: the trail is
answerable only by someone holding the repository and running `git log`. No route exposes it, and
under the current roadmap none will.

That last point is the collision recorded as `RR-5` and carried to Gate 2: Sprint 2's Definition
of Done commits to queryable policy-change audit events, and no scheduled task builds them.
ADR-0002 recorded the gap and handed the choice forward; this document does the same rather than
deciding it, because either resolution — rewriting the commitment or adding a task — changes the
scope of the sprint the roadmap already calls its pressure point.

## Requirements handed to task 1.4

Task 1.4 selects the OIDC issuer and the authorization model. These are the constraints this
threat model puts on that choice, each traceable to a row above. They are kept as handed over:
the line citations and every "today" and "currently" below describe the code at `4f2724f`,
before task 2.1 implemented ADR-0003 and ADR-0004.

1. **The principal must bind to a registered `workspace_id`**, not merely authenticate. TB-4's
   trusted side is the registry, and `registry.get(workspaceId)` at
   `packages/workspace-registry/src/registry.mjs:8` is the lookup that has been waiting for a
   caller. An authenticated principal that cannot be resolved to a registration authorizes
   nothing. The workspace comes from the credential, never from the body: today a submission
   carrying a `workspace_id` of its own choosing is answered `202`, not refused.
2. **The binding must be usable as ADR-0002's `workspace_id`.** The idempotency key is
   `JSON.stringify([workspace_id, change_id])` and its uniqueness scope is the whole store for
   all time, so the identifier must be stable across token rotations and issuer re-registrations.
   A per-token or per-session identifier would silently re-open `ABU-5` while appearing to close
   it.
3. **It is a workload credential, not a user credential.** The submitter is a CI job in a
   governed workspace. The model has to answer what happens when that workload runs on a fork, a
   pull request from outside the organisation, or a re-run of an old pipeline. An acceptable
   answer refuses a fork or an external pull request unless the registration explicitly admits
   it; an answer that admits them by default lets anyone who can open a pull request submit.
4. **Read routes need the same decision as the write route.** `ABU-4` is a disclosure on
   `GET /v1/workspaces` and `GET /v1/indicators`, and an authorization model that covers only
   `POST /v1/evidence` leaves it open. 1.4 must state what an authenticated principal may read,
   not only what it may write.
5. **Unauthenticated `GET /health` must stay unauthenticated**, and 1.4 should say so explicitly.
   It is a liveness probe with no dependency check and no data; requiring a credential on it
   breaks deployment tooling for no gain.
6. **Failure must be distinguishable.** Unauthenticated, authenticated-but-unauthorized, and
   refused-by-policy are three different answers, and `openapi.json` currently declares none of
   the first two. 1.4 names the statuses; 2.1 declares them and bumps `info.version`.
7. **The token's audience must be this control plane.** A token minted for another relying party
   and replayed here must be refused, so `aud` is checked against a value specific to it.
8. **Name the claims that bind a token to a registration** — repository, ref, workflow — and make
   the registry hold them in a form that can be compared. Today `repository_url` is checked only for
   being a non-empty string (`packages/contracts/src/schema.mjs:38-46`), never as a URL, so nothing
   could match a claim against it.
9. **Bound the token's lifetime and say what replay means.** `exp` and `nbf` are enforced; 1.4
   states whether `jti` is tracked, and if it is not, why a replay within the lifetime is
   acceptable.
10. **Say how issuer keys rotate.** Keys come from the issuer's published key set, are cached for
    a bounded time, and an unavailable key set fails closed — it never admits unverified tokens.
11. **The credential travels in the `Authorization` header only**, never a cookie or a query
    string. The seam accepts a `text/plain` POST today, which is harmless while nothing is
    authenticated and a cross-site request forgery vector the moment a credential is ambient.
12. **A bearer credential needs TLS on every hop that carries it.** This model scopes the network
    out because there is no deploy target; this requirement is what it asks of whichever target
    is chosen.
13. **Decide evidence attestation** (MIT-13): whether the evidence a workload submits is signed and
    bound to its identity, recomputed, or recorded as the workload's own claim. Declining to attest
    is an acceptable answer if it is recorded, because then every disposition can say so.

## Findings handed to Gate 2

Each of these is outside this task's scope to fix and inside Gate 2's to decide.

1. **ADR-0002's expiry design is incomplete under a classification that covers identifiers.**
   ADR-0002 expires a payload by tombstoning: the body is nulled and
   `(workspace_id, change_id, idempotency_key, received_at, envelope_version)` survive, with a
   `redacted_at` added. That design was written while classification was undetermined, and
   ADR-0002 itself flags the second-order question. The classification settled today — INTERNAL,
   **covering identifiers** — resolves it in the direction the ADR feared: the tombstone retains
   classified metadata indefinitely, so expiry removes the payload and not the classification.
   Gate 2 has to decide whether the tombstone gets its own retention window, and task 2.2 has to
   implement whatever it decides. (Gate 2 decided: kept indefinitely, RR-4. Task 2.2's trigger
   refuses any update to a tombstone.) **This is recorded here and ADR-0002 is not edited** — amending
   an ADR under review to absorb a finding from a document the same gate is reviewing would hide
   the disagreement the gate exists to see.
2. **There is no `CODEOWNERS` file, and every commit is unsigned.** T3 tiering records that a policy
   change needs two approvers, and nothing verifies it: the gate runs without `--approvers`. Were
   it verified, nothing would make them the _right_ two, and nothing makes the recorded author
   true. ADR-0002 already names signed commits and branch protection on
   `config/control-plane/**` as a Gate 2 condition. This document measures the current state and
   agrees.
3. **`guardrails/0` has no contract test.** `docs/contracts.md` documents its field list;
   `config/control-plane/guardrails.json` implements it; nothing compares them. The two can drift
   silently, and a drift in the policy schema is a drift in what the control plane will accept.
4. **`docs/architecture/overview.html` has no in-repo generator.** `.prettierignore` exempts it
   as "Rendered output — regenerated from `overview.md`, not hand-edited", but no script,
   workflow or target in this repository regenerates it. A rendered artifact that nothing can
   rebuild is a hand-edited file with a comment claiming otherwise, and it can diverge from
   `overview.md` with nothing to notice.
5. **`tools/sdlc-controls/README.md`'s file table is stale.** It lists three files, one of which
   (`acceptance.sh`) does not exist, and omits the three checks that do:
   `adr-conformance.test.mjs`, `graph-fidelity.test.mjs` and `stack-profile.test.mjs` — soon four
   with `threat-model-conformance.test.mjs`. The file is vendored from upstream and exempt from
   this repository's formatter, so correcting it is a vendor-sync decision rather than an edit.
6. **Three controls this document relies on have no test.** The provenance rule
   (`evaluate.mjs:22-24`) and the `blocked_tiers` rule (`:20-21`) can each be deleted with every
   test in the workspace green, and so can the `criticality: 'critical'` that puts
   `config/control-plane/**` at T3 (`tools/sdlc-controls/generate-component-map.mjs`, MIT-7). All
   three are true today and removable in silence. The two guardrail tests belong with MIT-11 in
   2.1 (re-owned to 2.4 on 2026-10-07); the criticality test belongs with the PR gate.
7. **`repository_url` and `evidence_endpoint` are checked only as non-empty strings**, never as URLs, and nothing dereferences
   today. Any component that later fetches either one — a portfolio integration, an evidence
   pull — is a server-side request forgery sink the day it ships, and has to treat both as
   attacker-supplied.
8. **The PR gate TB-6 relies on runs mutable references.** `.github/workflows/sdlc-controls.yml`
   installs `sdlc-controls@v0.2.0` by tag and pins its actions by tag, not by commit, so what
   computes the tier can change without a change to this repository.
9. **Gate 2 outcome (founder, 2026-10-01).** Every residual risk then reading `pending Gate 2`
   was accepted, and ADR-0002 (read with ADR-0004's amendment) and this threat model were set to
   Accepted in `1a0d5f8`. ADR-0003's "Residuals for Gate 2" were accepted as listed there. The
   findings above were disposed of as follows:
   - **1** accepted: the tombstone keeps its identifiers indefinitely (RR-4), reviewed at Gate 3.
   - **2** signed commits are required from Gate 2 on; `CODEOWNERS` and branch protection are
     accepted as residual while the founder works solo (RR-1).
   - **3** and **6**'s two guardrail tests go to task 2.1 with MIT-11 (re-owned to 2.4 on
     2026-10-07); **6**'s criticality test
     goes with **4**, **5** and **8** to a proposed hardening task (`docs/specs/sprint-1-progress.md`).
   - **7** binds whichever task first dereferences `repository_url` or `evidence_endpoint`.
   - ADR-0003's outbound key-set fetch had no trust boundary here; added as TB-8 by task 2.1,
     with the fetch.
