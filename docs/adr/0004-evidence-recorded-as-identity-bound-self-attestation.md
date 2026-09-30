# ADR-0004: Record submitted evidence as the workload's own claim, bound to its verified run identity, and label every disposition self-attested

- **Status**: Proposed
- **Date**: 2026-09-29
- **Deciders**: Proposed by the Architect role, with the Security Engineer role co-designing. Approval is pending: the founder approves or rejects it at task 1.4's close in a founder-authored commit, and — because this decision traces NFR-6.1 — the approval must name the Architect and Security roles. No human has approved it yet; this record states a proposal, not an approval.
- **Trace**: NFR-2.1, NFR-6.1

## Context

Requirement 13 of the threat model's "Requirements handed to task 1.4"
(`docs/architecture/threat-model.md`) asks whether the evidence a workload submits is signed and
bound to its identity, recomputed, or recorded as the workload's own claim — and accepts declining
to attest, provided the decision is recorded "because then every disposition can say so".

- **ABU-11, measured by the threat model.** Every rule `evaluateGuardrails` applies reads a field
  the submitter wrote. A record whose `result.pass` is `false` is answered `202 accepted`, and so is
  one whose `verification.verified` merely contains the string `CAF-SDLC-002:tier`. Under
  `require_verified_controls` a `202 accepted` therefore reads as "control verified" and means "the
  submitter said so".
- **RR-11** records the same thing as a residual: "authentication will establish who, not whether it
  is true". Its stated reason for acceptance is that "Attestation needs a signing identity, and none
  exists until 1.4 names an issuer". ADR-0003 names one.
- **NFR-6.1**: the system "shall not represent automated technical checks as human approval or
  regulatory certification". A disposition that implies the controls were verified, when only a
  claim was received, is that misrepresentation.
- **The engine cannot sign.** `git-native-sdlc-controls` at `e23ca97` contains no signing,
  attestation, Sigstore or OIDC code, and its `evidence/0` schema describes provenance as "a
  declaration, not a detection" (both from task 1.4's Phase ① measurement of that repository).
- **Recomputation is ruled out** by ADR-0001 ("A workspace remains responsible for its own Nx graph
  and CI gate") and by the roadmap principle "Federate, do not centralise": the control plane "never
  runs the workspace's pipeline".
- **ADR-0002** (Proposed) pins `evidence/0` as un-extendable by the control plane: identity and
  routing data live in the envelope, never in the record.
- **ADR-0003** (Proposed) proves which repository and which run submitted a record, and states its
  own limit: anyone who can push to a registered repository can mint a valid token from an edited
  workflow. Authentication identifies the submitter; it does not vouch for the gate.

## Decision

We will record every accepted evidence record as **the workload's own claim, bound to the verified
run identity that submitted it**, and we will say so on every disposition and on the indicator.
We will not sign, verify a signature over, or recompute evidence in the MVP.

### The run identity in the envelope

The evidence envelope gains a `submitted_by` object, built **only from verified token claims**
(ADR-0003) and never from the request body:

| Field                 | Source claim          | Notes                                                       |
| --------------------- | --------------------- | ----------------------------------------------------------- |
| `issuer`              | `iss`                 | the accepted issuer                                         |
| `repository_owner_id` | `repository_owner_id` | string, as the claim is                                     |
| `repository_id`       | `repository_id`       | string, as the claim is                                     |
| `run_id`              | `run_id`              | the run a human can open on the forge to re-check the claim |
| `run_attempt`         | `run_attempt`         | tells a re-run from the original                            |
| `sha`                 | `sha`                 | the commit the run built                                    |
| `ref`                 | `ref`                 | for a `pull_request` run, the merge ref                     |
| `event_name`          | `event_name`          | the admitted event                                          |
| `workflow_ref`        | `workflow_ref`        | the workflow file and ref that ran                          |
| `job_workflow_ref`    | `job_workflow_ref`    | `null` when the token carries none; see below               |

- Every source claim is in the GitHub issuer's `claims_supported`
  (<https://token.actions.githubusercontent.com/.well-known/openid-configuration>, fetched
  2026-09-29).
- `submitted_by` lives in the **envelope**, beside `workspace_id` and `policy_id`, never in the
  `evidence/0` record, as ADR-0002 requires.
- On `duplicate` or `conflict` the first envelope's `submitted_by` stands, as the first record does.
  A replay is not a second submitter.
- **`job_workflow_ref` may be absent.** GitHub documents the claim only "For jobs using a reusable
  workflow" (<https://docs.github.com/en/actions/reference/security/oidc>, fetched 2026-09-30).
  That it is absent for other jobs is _unverified_; `null` is the fail-safe representation either
  way. If it is present for jobs outside a reusable workflow it presumably equals `workflow_ref`,
  which a direct push to the pinned ref also satisfies (_unverified_; task 2.1 records a measured
  token). ADR-0003's "Registration contract" states what that means for a pin.
- **Retention.** `submitted_by` is identity, not payload: it is built from the token and never from
  the record. Under ADR-0002's rule for an expired envelope — "payload removed, identity retained"
  — it is therefore kept with `workspace_id` and `change_id` when the payload is redacted, and it
  is not on ADR-0002's list of what a redacted envelope keeps only because that list predates it.
  It holds repository IDs, `ref`, `sha` and `run_id`, identifiers the threat model classifies
  INTERNAL, so it falls under the threat model's Gate 2 finding 1: whether the tombstone gets its
  own retention window is Gate 2's to decide, for `submitted_by` with the rest of the tombstone,
  and task 2.2 implements what Gate 2 decides.
- **Envelope version.** Adding `submitted_by` does not bump `evidence-envelope/0`
  (`packages/control-plane-api/src/evidence-store.mjs:6`). Every envelope accepted once task 2.1
  ships carries it, and no envelope is durable until task 2.2, which depends on 2.1 in the roadmap,
  so no stored `/0` envelope ever lacks it.

### What a disposition and the indicator may claim

- **`accepted`** means: "the claims submitted by a run whose identity was verified as registered
  workspace W satisfied policy P". It never means "the controls were verified", and no surface this control plane owns
  may word it that way.
- **`needs-remediation`** means the same claims, so evaluated, did not satisfy P.
- **The indicator** is a count of claims made by the caller's own workspace (ADR-0003, "Route
  authorization"), not a count of verified outcomes.

### Making it visible to a reader

- `AcceptedDecision`, `UnacceptedDecision` and `IndicatorSummary` in
  `packages/control-plane-api/openapi.json` each gain a **required** property
  `evidence_attestation`, whose only permitted value is `"self-attested"`.
- All three schemas are `additionalProperties: false`, so this is a contract change, not an additive
  one. It is folded into task 2.1's `info.version` bump, alongside the 401, 403, 413 and 503
  declarations, so the published contract changes once.
- A required field, not prose, because prose can be dropped by a client and a field whose value is
  fixed cannot be quoted without it. The indicator's existing `note` disclaimer is kept; it says the
  number is not a compliance conclusion, not that the inputs are unverified.
- Declaring it as an enumeration of one leaves room for a future `"signed"` value as a new decision,
  without renaming the field.

### Implementers

- **Task 2.1**: `submitted_by` on the in-memory envelope, `evidence_attestation` at the seam and in
  `indicators`, and the three `openapi.json` schemas.
- **Task 2.2**: the `submitted_by` column in the PostgreSQL envelope table.

## Options Considered

- **(i) Recorded as the workload's own claim, bound to the verified run identity — chosen.** It
  needs nothing the MVP does not already build: ADR-0003's verified claims supply the identity, and
  the envelope already exists. It is honest under NFR-6.1, because every disposition carries its
  own label. A human who doubts a record can open `run_id` on the forge and compare. Against it: a
  disposition is still only as true as the submitter, and a same-repository writer who edits the
  gate submits a claim that is recorded exactly like an honest one.
- **(ii) Signed — rejected for the MVP.** Two routes exist, and neither is available:
  - the engine signs its own evidence: it has no such capability, so this is upstream work in
    `git-native-sdlc-controls`, not a control-plane decision;
  - GitHub artifact attestations: GitHub scopes them to "Software you are releasing" and advises
    against "Frequent builds that are just for automated testing"
    (<https://docs.github.com/en/actions/concepts/security/artifact-attestations>). Per-PR gate
    evidence is the second kind.

  Even a signature made inside the run would sign what an edited workflow produced; signing moves
  the trust to the signer, and the signer is the same workload ADR-0003 already identifies.

- **(iii) Recomputed — rejected.** The control plane would have to run the workspace's pipeline,
  which ADR-0001 and the roadmap's "Federate, do not centralise" principle rule out.

## Consequences

- **Upgrade path.** (ii) can be added later without changing the binding: a signature would be
  verified against the same run identity, and `evidence_attestation` would gain a second value by a
  new decision and a contract bump.
- **What becomes harder.** Every consumer of a disposition or the indicator must handle a new
  required field, once, in task 2.1's contract bump. Task 2.1's already large specification grows
  by one envelope field and three schema properties.
- **Threat model.** MIT-13 ("Decide whether evidence claims are attested… or recorded as
  self-attested", owner 1.4) is **decided** once this ADR is Accepted. RR-11 reaches its review
  point and is carried to Gate 2 as "attestation declined, and made visible on every disposition";
  its reason changes from "no signing identity exists" to "declined". The threat model itself is not
  edited by task 1.4; ADR-0003's "Residuals for Gate 2" and "Threat-model status" carry this there.
- **ABU-11 stays reachable.** This decision does not stop a submitter lying; it stops the control
  plane repeating the lie as a verification.
