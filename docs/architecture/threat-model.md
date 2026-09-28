# Threat model: evidence ingress and policy administration

- **Status**: Proposed
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
process RSS are quoted. Two are reachable today without being measured on the socket, and are
labelled so: ABU-6 rests on repository evidence (`git log --format='%G?'`, the absence of
`CODEOWNERS`) and ABU-7 on the roadmap's own Definition of Done. Neither is a request an attacker
sends, so there was no socket to measure. A claim that something is unreachable is a claim about code that exists,
and it names the line that makes it so. Nothing here is inferred from reading a handler and
imagining its behaviour, because the one thing this document must not do is describe a system
that is not the one running.

**What this model does not claim.** It is not a penetration test: every reachability claim was
established through the published interface or the repository, and nothing was attempted against
a dependency, the runtime or the host. It models a service with no deploy target — the stack
profile's `Target` row reads `Not selected` — so the network in front of the seam, TLS
termination and any proxy limit are outside it, and TB-1's untrusted side is simply whoever can
open a socket. And the PostgreSQL store ADR-0002 proposes is modelled **conditional on Gate 2**,
never as decided: TB-5 carries that condition in its `Status` cell, and the conformance check
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

**Residual-risk acceptances are written back into this document after Gate 2.** A row whose
`Accepted by` cell reads `pending Gate 2` is a risk nobody has accepted yet. When Gate 2 sits,
the cell is edited to `<name>, YYYY-MM-DD`. This is the same post-approval edit
`tools/sdlc-controls/adr-conformance.test.mjs` already enforces on an ADR's `Deciders` line: it
refuses a record that says `Accepted` while its own approval line still says the approval is
outstanding, on the principle that a record contradicting itself resolves in favour of the
sentence saying nobody signed. `RR-7` is already written in the accepted form, because its
acceptance was made today by the founder rather than deferred to the gate — so both branches of
the grammar are live in this document, not just the one it will grow into.

**What is checked, and what is not.** `tools/sdlc-controls/threat-model-conformance.test.mjs`
holds this document's structure: its header, its sections, the totality of the route coverage,
the totality of the STRIDE index, referential integrity in both directions, that every
mitigation has an owner, and every residual risk either an acceptance or an explicit record that
nobody has made one yet. It cannot judge whether an abuse
case is well chosen, whether a mitigation mitigates, or whether the set is complete. Those are
Phase ④'s to review, and the check says so in its own header rather than letting a green run
read as a review.

**Task 1.3 ships no production code.** The ingress body limit below is a specification for task
2.1, stated to the byte, with its reasons, so that 2.1 implements a decision rather than making
one. Nothing under `packages/` changes in this task.

**No retained field is personal data today.** Classification answers how sensitive the record is,
not whether erasure is an obligation, and RR-4 and RR-7 both turn on the second question. An
`evidence/0` record carries no name, address or account identifier; the field that would change
that is `owners` on a workspace registration, a non-empty array
(`packages/contracts/src/schema.mjs:48-49`) that holds a team name today and is constrained to
nothing — the validator checks only that it is an array with at least one element, not even that
the elements are strings. If a personal name is ever written there, retention stops being an operational choice and
RR-4 and RR-7 need re-deciding rather than re-accepting.

## System under analysis

The control plane is one deployable — `control-plane-api` — composing four libraries behind an
HTTP seam in `packages/control-plane-api/src/main.mjs`. The seam exports its routes as data:

| Route                | What it answers                                              | Identity required |
| -------------------- | ------------------------------------------------------------ | ----------------- |
| `GET /health`        | process liveness, no dependency checked                      | none              |
| `GET /v1/workspaces` | every registration loaded at startup, in full                | none              |
| `GET /v1/indicators` | a descriptive aggregate over every record in the store       | none              |
| `POST /v1/evidence`  | a technical disposition, and an append on an accepted record | none              |

The "Identity required" column is the whole of NFR-2.1's current status. **There is no identity
anywhere in the request path.** The seam matches a request on `request.method` and `request.url`
and nothing else; a repository-wide search for a header read across every non-test module under
`packages/*/src/` returns nothing. `createRegistry` exports a `get(workspaceId)` lookup at
`packages/workspace-registry/src/registry.mjs:8` — the natural consumer of an authenticated
principal — and **no caller anywhere in the workspace invokes it**. The authorization boundary
NFR-2.1 requires is present in the code as an unused function.

Three things load once, at module scope, and never reload: the workspace registry and the
guardrail policy (the registry at `main.mjs:8-10` and `:34`, the policy at `main.mjs:27-32`), and
the in-process evidence store (`main.mjs:38`). A policy
change therefore takes effect on restart and not before, and the store is a process-local array
that a restart destroys — ADR-0002 is the decision that replaces it, and is still `Proposed`.

Measured behaviour of the running seam, quoted because the rest of this document depends on it:

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

| ID   | Boundary                            | Untrusted side                                             | Trusted side                                          | Surfaces                                                                              | Assets crossing                                                               | STRIDE coverage                                  | Control                                                                   | Status                  |
| ---- | ----------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------- | ----------------------- |
| TB-1 | Network peer to HTTP seam           | any peer that can open a socket, authenticated by nothing  | the request handler in `main.mjs`                     | `GET /health`, `GET /v1/workspaces`, `GET /v1/indicators`, `POST /v1/evidence`        | evidence records, technical dispositions, registrations, indicator aggregates | S:ABU-1 T:ABU-3 R:ABU-5 I:ABU-4 D:ABU-2 E:n/a    | none                                                                      | current                 |
| TB-2 | HTTP seam to contract validator     | a parsed but unvalidated request body                      | the `evidence/0` subset `validateEvidence` enforces   | `POST /v1/evidence`, `process:packages/contracts/src/schema.mjs`                      | the candidate record, its tier, its affected set, its verification list       | S:n/a T:ABU-3,ABU-9 R:n/a I:n/a D:ABU-2 E:n/a    | executable check `packages/contracts/src/schema.test.mjs`                 | current                 |
| TB-3 | HTTP seam to guardrail evaluator    | the caller's record, and a policy file changed out of band | `evaluateGuardrails` and the `policy_id` it stamps on | `POST /v1/evidence`, `process:packages/guardrail-policy/src/evaluate.mjs`             | policy rules, the approving decision reference, the disposition returned      | S:n/a T:ABU-6 R:ABU-7,ABU-10 I:n/a D:n/a E:ABU-6 | executable check `packages/guardrail-policy/src/evaluate.test.mjs`        | current                 |
| TB-4 | HTTP seam to workspace registry     | a submission's implicit and unverified workspace claim     | registrations validated at load by `createRegistry`   | `GET /v1/workspaces`, `process:packages/workspace-registry/src/registry.mjs`          | `repository_url`, `evidence_endpoint`, `owners`, `workspace_id`               | S:ABU-1 T:n/a R:n/a I:ABU-4 D:n/a E:n/a          | none                                                                      | current                 |
| TB-5 | HTTP seam to evidence store         | an accepted but unattributed record                        | the append-only envelope log ADR-0002 specifies       | `POST /v1/evidence`, `store:packages/control-plane-api/src/evidence-store.mjs`        | payload, `(workspace_id, change_id)`, `policy_id`, `received_at`              | S:n/a T:n/a R:ABU-5 I:n/a D:ABU-2,ABU-8 E:n/a    | executable check `packages/control-plane-api/src/evidence-store.test.mjs` | conditional on ADR-0002 |
| TB-6 | Repository to policy administration | any author who can land a commit on the policy path        | the policy and registry loaded at process start       | `git:config/control-plane/**`, `forge:pull-request-review`, `process:main.mjs`        | guardrail rules, `policy_id`, the approval reference, workspace registrations | S:ABU-6 T:ABU-6 R:ABU-7 I:n/a D:n/a E:ABU-6      | convention                                                                | current                 |
| TB-7 | Control plane to human reader       | the control plane's own published claims about itself      | a human's understanding of what was actually verified | `GET /v1/indicators`, `POST /v1/evidence`, `git:docs/specs/implementation-roadmap.md` | the meaning of a disposition, the indicator disclaimer, every Done-when claim | S:n/a T:ABU-3 R:ABU-7 I:n/a D:n/a E:n/a          | executable check `packages/indicators/src/summarize.test.mjs`             | current                 |

TB-4 is the boundary NFR-2.1 names and the system does not have. Its trusted side exists — the
registry is loaded, validated and indexed — and its only current surface is the route that reads
_out_ of it. Nothing reads _into_ it to authorize a submission, which is why `registry.get()` has
no caller.

TB-5 is `conditional on ADR-0002` rather than `current` because the boundary it describes is the
durable store, and the durable store is a proposal. Today the trusted side is a process-local
array. When ADR-0002 leaves `Proposed`, the row is wrong: the check below fails on exactly that
transition and names the rows to promote, so the conditionality retires itself instead of
outliving the condition.

TB-7 has no socket, which is the point. Nothing crosses it over a network, so no amount of
transport hardening touches it, and a STRIDE pass driven by the route table would never generate
it. It is the boundary NFR-6.1's second clause describes — "shall not represent automated
technical checks as human approval or regulatory certification" — and the untrusted party on it
is this repository.

`Control` is the boundary's present state, not its planned one: `none`, `convention` (a practice
nothing executes), or `executable check` naming the file that fails when the control breaks. Two
boundaries read `none`, and they are the two NFR-2.1 is about. TB-6 reads `convention` although
the PR gate runs on every change to it: the gate computes the T3 tier, but the workflow passes it
no approver set, so the review that tier calls for is recorded and never verified. TB-7's check
covers one of its three surfaces: a test asserts the indicator disclaimer MIT-9 cites on the
`GET /v1/indicators` body, but nothing checks what a `202` disposition or a Done-when tick is read
as meaning — those halves are convention.

## Abuse cases

`Boundary` names **one** crossing where the case applies — most cases cross more than one, and the
row names a representative. `STRIDE` is the **union** of the letters every boundary files it under,
not the letters for the boundary the row names. The conformance check holds both: the named
boundary must be one that indexes the case, and the letters must match the union.

| ID     | Boundary | STRIDE  | Abuse case                                                                                                              | Answered by   |
| ------ | -------- | ------- | ----------------------------------------------------------------------------------------------------------------------- | ------------- |
| ABU-1  | TB-1     | S       | Anyone who can reach the port submits evidence as any workspace, and the control plane records it as accepted.          | MIT-1, MIT-2  |
| ABU-2  | TB-1     | D       | A single unauthenticated socket exhausts process memory by streaming a body the seam buffers whole.                     | MIT-4         |
| ABU-3  | TB-1     | T       | Forged or bulk submissions move the published indicator, which is read as a statement about real delivery.              | MIT-2         |
| ABU-4  | TB-4     | I       | An unauthenticated reader harvests every workspace's repository, endpoint and owner, and the whole indicator.           | MIT-3         |
| ABU-5  | TB-5     | R       | With `workspace_id` null nothing claims uniqueness, so a replay is indistinguishable from a distinct submission.        | MIT-5         |
| ABU-6  | TB-6     | S, T, E | A commit rewrites the guardrail rules or forges its own author, and the next restart enforces the new policy.           | MIT-6, MIT-7  |
| ABU-7  | TB-7     | R       | The control plane states an assurance it does not deliver, and a human reads a green check as an approval.              | MIT-9, MIT-10 |
| ABU-8  | TB-5     | D       | A refused body becomes an unbounded, unclassified, attacker-supplied write primitive aimed at the durable store.        | MIT-8         |
| ABU-9  | TB-2     | T       | A submitter omits `ai_assisted` or sets it false, so the provenance rule never applies and the record is counted clean. | MIT-11        |
| ABU-10 | TB-3     | R       | A guardrail policy with its `approval` block deleted starts the process and stamps its `policy_id` on every acceptance. | MIT-12        |

**ABU-1 — unauthenticated submission and evidence forgery. Reachable today; measured.** A
`POST /v1/evidence` with no credential is answered `202 Accepted` with a real `policy_id`; the
same request carrying a deliberately invalid bearer token is answered identically, because no
module under `packages/*/src/` reads a request header. There is no identity to forge, which is
worse than a forgeable one: forgery implies something was claimed. The record entered the store
attributed to nobody, and `GET /v1/indicators` then counted it. This is the case NFR-2.1 exists to
close — "authenticate the calling workload and authorize it for the registered workspace" — and
TB-1 and TB-4, the two boundaries whose `Control` reads `none`, are its two halves.

**ABU-2 — ingress resource exhaustion. Reachable today; measured.** `main.mjs:81-83` accumulates
every chunk into an array and concatenates once, so peak memory is a multiple of the body the
caller chooses to send, and the caller chooses without limit. A 96 MiB unparseable body took the
server from 56.1 MiB RSS to 260.7 MiB and `/health` to 9x its median before being answered `400`.
The refusal is the _cheap_ case. A 96 MiB body that is a **valid** `evidence/0` record is answered
`202 Accepted`, drives RSS to 816.0 MiB, and leaves it there permanently, because an append-only
store does not release what it accepted. Refusal costs transient memory; acceptance costs
resident memory for the life of the process.

**ABU-3 — indicator poisoning. Reachable today; measured.** `summarizeEvidence` counts every
record in the store with no notion of who submitted it. Three submissions from one anonymous
client moved `total_records` from 0 to 3 and `by_tier.T1` with it. The indicator's own disclaimer
field says it is descriptive rather than a compliance conclusion, which is true and is not a
defence against the number being wrong.

**ABU-4 — cross-workspace disclosure. Reachable today; measured.** `GET /v1/workspaces` returns,
unauthenticated, every registration in full: `repository_url`, `evidence_endpoint`, `owners`,
`value_stream` and `solution` for every governed workspace. That is a map of an organisation's
internal delivery topology and the addresses that accept its evidence. `GET /v1/indicators`
aggregates across every workspace at once with no scoping parameter to leave out. Under the
INTERNAL classification settled above, both routes publish classified data to anyone who can
reach the port.

**ABU-5 — replay and idempotency defeat. Reachable today; measured.** Submitting a byte-identical
record twice produced two `202`s and `total_records: 2`. ADR-0002's collision rule has a row for
this — `workspace_id === null` appends with `idempotency_key: null` and claims no uniqueness —
and it is the correct answer for a pre-identity scaffold. It is the wrong answer for anything
holding real evidence, because every replay counts again and nothing can distinguish a retry from
a distinct change. The fix is not in the store; it is `workspace_id`, and `workspace_id` is 2.1.

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
attacker. Sprint 2's Definition of Done says "Audit events for policy changes are queryable" and
no scheduled task builds a queryable surface — 2.1 is identity, 2.2 is evidence intake, 2.3 is
operator telemetry, and 1.3 is this document. `docs/contracts.md` already carries the correction
for its own earlier version of the same overstatement. The harm is not technical: a human reading
a ticked box concludes an audit capability exists, which is exactly the representation NFR-6.1
forbids the system to make.

**ABU-9 — self-declared AI provenance. Reachable today; measured.** `evaluateGuardrails`
(`packages/guardrail-policy/src/evaluate.mjs:22`) applies the provenance rule only when the
record says `ai_assisted` is true, and `ai_assisted` is a field the submitter writes. Measured
against the running seam: `ai_assisted: true` with no `ai_tool` is refused `422
needs-remediation`, as FR-3.1 intends — but **omitting the field entirely returns `202`**, and so
does `ai_assisted: false`. The submitter therefore decides whether the rule applies to it, and
the record is then counted clean in `GET /v1/indicators`. This is a control that reports a pass
it did not establish, which is the same shape as ABU-7 and bears on NFR-6.1's second clause.
Deriving provenance from an authenticated principal is 2.1's (MIT-11); until then RR-8 records
that the rule is opt-in.

**ABU-10 — an approving reference that resolves to nothing. Reachable today; measured.**
NFR-6.1's first clause is "retain the approving decision reference", and the envelope does retain
`policy_id`. What nothing checks is that the policy the id names carries an approval at all.
`assertUsablePolicy` (`main.mjs:16-25`) validates exactly two fields, and measured: a
`guardrails.json` with its entire `approval` block deleted returns `[]` — no errors — the process
starts, and every acceptance is stamped `policy_id: baseline-engineering-controls@1`. Nothing
under `packages/` reads `policy.approval`; the only mention in the tree is `openapi.json:325`,
which describes `policy_id` as "traceable to the human approval recorded with that policy" — a
claim the seam does not enforce. MIT-12 gives it to 2.1 as a startup refusal.

**ABU-8 — the refused body as a write primitive. Unreachable, by decision.** This is the abuse
case ADR-0002 hands to 1.3 by name. A 400 body is by definition unparseable: retaining it means
retaining an arbitrary byte sequence from an unauthenticated caller, of unbounded length and
undetermined classification, written into the durable evidence log. **Refusals never enter the
evidence store**, and that is structural rather than conventional — `main.mjs:93-95` answers a
refusal by writing a response and returning, and `evidenceStore.append` is only reached on
`main.mjs:91`, after an acceptance. A 422 body is parseable and would genuinely help a producer
debug, and is still not retained: pre-2.1 it is unattributed, and mixing refused content into the
log dilutes the single property the log exists to have. If a refusal stream is ever justified, it
is a separate stream with its own classification, retention and access decisions — it does not
arrive by relaxing this. What 2.3 needs is a count with a reason, not a body.

## Mitigations

| ID     | Mitigation                                                                                               | Addresses    | Owning task | Evidence                                             |
| ------ | -------------------------------------------------------------------------------------------------------- | ------------ | ----------- | ---------------------------------------------------- |
| MIT-1  | Name an OIDC issuer and an authorization model binding a principal to a registered workspace.            | ABU-1        | 1.4         | —                                                    |
| MIT-2  | Authenticate the calling workload and authorize it for the workspace before any append.                  | ABU-1, ABU-3 | 2.1         | —                                                    |
| MIT-3  | Scope every read route to the authorized principal instead of returning the whole registry or store.     | ABU-4        | 2.1         | —                                                    |
| MIT-4  | Enforce the ingress body limit specified below, before parse and before projection.                      | ABU-2        | 2.1         | —                                                    |
| MIT-5  | Persist accepted evidence keyed by `(workspace_id, change_id)` so a replay is answered as one.           | ABU-5        | 2.2         | —                                                    |
| MIT-6  | Refuse to start on an unusable guardrail policy rather than serving under one.                           | ABU-6        | in place    | `packages/control-plane-api/src/main.mjs`            |
| MIT-7  | Tier every change under the policy path T3, so the gate's evidence records its two-approver requirement. | ABU-6        | in place    | `tools/sdlc-controls/generate-component-map.mjs`     |
| MIT-8  | Keep refused submissions out of the evidence store, as a decision rather than an omission.               | ABU-8        | in place    | `docs/adr/0002-append-only-evidence-envelope-log.md` |
| MIT-9  | Carry the not-a-compliance-conclusion disclaimer in every indicator response body.                       | ABU-7        | in place    | `packages/indicators/src/summarize.mjs`              |
| MIT-10 | State the policy-administration gap in the published contract document instead of a coming surface.      | ABU-7        | in place    | `docs/contracts.md`                                  |
| MIT-11 | Derive AI provenance from the submitting principal rather than a caller-supplied boolean.                | ABU-9        | 2.1         | —                                                    |
| MIT-12 | Require an approval block, not just a policy id, before the process will start.                          | ABU-10       | 2.1         | —                                                    |

`Owning task` is `in place` only where a path in this repository already enforces the mitigation,
and the check below resolves that path and fails if it does not exist. Everything else names a
roadmap task, and the check fails if the roadmap has no such task — a mitigation owned by a task
number nobody scheduled is a mitigation nobody is going to write.

MIT-1 and MIT-2 are deliberately two rows. Selecting an issuer is 1.4 and enforcing a token is
2.1; collapsing them would let the gate's identity signal be satisfied by the task the gate
guards, which is the sequencing error that caused 1.4 to be added to the roadmap in the first
place.

## Residual risks

| ID    | Residual risk                                                                                                    | From   | Why accepted                                                                                                                                                                                                                                      | Accepted by                     | Review point        |
| ----- | ---------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------- |
| RR-1  | The policy audit trail is attributable but not verifiable: unsigned commits and no `CODEOWNERS`.                 | ABU-6  | Signed commits and branch protection are a Gate 2 condition in ADR-0002, not deliverable inside this task.                                                                                                                                        | pending Gate 2                  | Gate 2              |
| RR-2  | `workspace_id` is null until 2.1, so every submission claims no uniqueness and every replay appends.             | ABU-5  | ADR-0002 makes the null branch explicit and requires 2.2 to refuse it in production configuration.                                                                                                                                                | pending Gate 2                  | Gate 2 and task 2.2 |
| RR-3  | `guardrails/0` has no contract test, so the policy file and its documented field list can drift apart.           | ABU-6  | Policy is consumed configuration rather than a served contract, so it has no place in `openapi.json` yet.                                                                                                                                         | pending Gate 2                  | Gate 2              |
| RR-4  | The tombstone retains `(workspace_id, change_id)` past expiry, which is now classified metadata.                 | ABU-4  | Fixing it means reopening ADR-0002's expiry design, which is Gate 2's decision and task 2.2's work.                                                                                                                                               | pending Gate 2                  | Gate 2 and task 2.2 |
| RR-5  | No queryable policy-change audit surface exists, and Sprint 2's Definition of Done says one will.                | ABU-7  | Resolving it either rewrites a DoD bullet or adds a task to the sprint already over capacity.                                                                                                                                                     | pending Gate 2                  | Gate 2              |
| RR-6  | The ingress body limit is specified and not shipped, so until 2.1 the seam buffers whatever is sent.             | ABU-2  | 1.3 writes no production code; shipping the limit here would put an unreviewed control on the live path.                                                                                                                                          | pending Gate 2                  | Task 2.1            |
| RR-7  | The 90-day retention window has an operational basis only, now applied to data classified INTERNAL.              | ABU-4  | The shorter window is the conservative choice under a classification that was undetermined until today.                                                                                                                                           | dsofianos (founder), 2026-09-23 | Gate 2              |
| RR-8  | `ai_assisted` stays submitter-declared until 2.1 authenticates the principal, so the provenance rule is opt-in.  | ABU-9  | The seam has no principal to derive it from; inferring it from the record is the same untrusted input under another name.                                                                                                                         | pending Gate 2                  | Task 2.1            |
| RR-9  | `assertUsablePolicy` validates `policy_version` and `policy_id` only, so a policy with no approval block starts. | ABU-10 | NFR-6.1's first clause is met by retaining the reference; whether the reference resolves to a real approval is 2.1's to enforce at startup, in the same change as MIT-12.                                                                         | pending Gate 2                  | Task 2.1            |
| RR-10 | A per-request cap bounds one submission, not the store: N compliant submissions still exhaust memory.            | ABU-2  | The in-process store is a stand-in with no eviction; only 2.2's durable store, bounded by the retention window, changes that. Measured: 300 accepted records strictly under the 1 MiB cap grew resident memory by 521 MiB and did not release it. | pending Gate 2                  | Task 2.2            |

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

**The limit must not be signalled by throwing.** `main.mjs:93-95` is a blanket `catch` that
answers any throw inside the handler with `400 {"error": "request body must be valid JSON"}`,
unconditionally. Verified: a body nested past `JSON.stringify`'s recursion limit parses fine,
throws inside `project()`, and is answered `400` — the control plane blaming the caller for its
own projection fault. A thrown 413 would be silently converted into the wrong status by the same
path, and no contract test would catch it because the seam really would be answering a declared
status. Enforce the limit inline: respond and return from inside the read loop, **before**
`JSON.parse` and **before** `project()`. Enforcing after either one has already paid the cost the
limit exists to avoid.

## Policy administration

Policy administration today is a reviewed commit to `config/control-plane/`, read once at process
start. It is a real control and a limited one, and both halves have to be said.

What holds. The path is `criticality: critical` in `tools/sdlc-controls/generate-component-map.mjs`,
so every change to it tiers T3, and the gate emits an evidence artifact, tied to the commit,
recording that T3 calls for two independent approvers. It records the requirement without
verifying it — the workflow passes the engine no approver set — so whether two people approved
is decided by branch protection, which is forge configuration this repository cannot show. The policy is validated at startup by `assertUsablePolicy`
(`main.mjs:16-32`) and the process refuses to start on a policy that would make the seam emit a
202 its own published schema rejects. Registrations are validated on load by `createRegistry` and
a bad one throws.

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
threat model puts on that choice, each traceable to a row above.

1. **The principal must bind to a registered `workspace_id`**, not merely authenticate. TB-4's
   trusted side is the registry, and `registry.get(workspaceId)` at
   `packages/workspace-registry/src/registry.mjs:8` is the lookup that has been waiting for a
   caller. An authenticated principal that cannot be resolved to a registration authorizes
   nothing.
2. **The binding must be usable as ADR-0002's `workspace_id`.** The idempotency key is
   `JSON.stringify([workspace_id, change_id])` and its uniqueness scope is the whole store for
   all time, so the identifier must be stable across token rotations and issuer re-registrations.
   A per-token or per-session identifier would silently re-open `ABU-5` while appearing to close
   it.
3. **It is a workload credential, not a user credential.** The submitter is a CI job in a
   governed workspace. The model has to answer what happens when that workload runs on a fork, a
   pull request from outside the organisation, or a re-run of an old pipeline.
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
   implement whatever it decides. **This is recorded here and ADR-0002 is not edited** — amending
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
6. **Every residual risk above whose `Accepted by` reads `pending Gate 2` is unaccepted**, and is
   waiting on this gate; the table is the count, and stating a number here rotted the first time the
   table grew. Gate 2's
   own no-go condition is "Residual risks unlisted or unreviewed"; they are now listed, and the
   review is the gate's. Acceptances are written back into this document as
   `<name>, YYYY-MM-DD` when they are made.
