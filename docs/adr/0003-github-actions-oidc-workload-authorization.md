# ADR-0003: Authenticate GitHub Actions OIDC workload tokens and bind each to one registered workspace by repository ID

- **Status**: Proposed
- **Date**: 2026-09-29
- **Deciders**: Proposed by the Architect role, with the Security Engineer role co-designing. Approval is pending: the founder approves or rejects it at task 1.4's close in a founder-authored commit. No human has approved it yet; this record states a proposal, not an approval.
- **Trace**: NFR-2.1

## Context

NFR-2.1: "Before a production endpoint accepts evidence, the system shall authenticate the calling
workload and authorize it for the registered workspace." Nothing does either today.

- The threat model (`docs/architecture/threat-model.md`, Status Proposed) gives **TB-1** (network
  peer to HTTP seam) and **TB-4** (HTTP seam to workspace registry) the Control `none`. Its ABU-1
  measurement: a `POST /v1/evidence` with no credential is answered `202 Accepted` with a real
  `policy_id`, and one carrying a deliberately invalid bearer token is answered identically,
  because no module under `packages/*/src/` reads a request header.
- `registry.get(workspaceId)` (`packages/workspace-registry/src/registry.mjs:8`) has no caller.
  The seam reaches the registry only through `registry.list()` on `GET /v1/workspaces`.
- ADR-0002 (Proposed) keys idempotency on `JSON.stringify([workspace_id, change_id])`, unique
  across the whole store for all time, and takes `workspace_id` from task 2.1's principal. Today
  it is `null` for every submission.
- The evidence producer is task 3.1's `ai-ready-nx-workspace` adapter. CI for this organisation
  has been observed only on GitHub Actions (task 1.4's Phase ① measurement), and Gitea Actions,
  the other forge in use, cannot mint an ID token (see Options Considered).
- The founder decided at task 1.4's Phase ① gate (2026-09-29) that the MVP authenticates **GitHub
  Actions only**, binds on `repository_id` held in the registration, keeps a second issuer
  additive later, and scopes read routes to the caller's own workspace with no human or
  cross-workspace view.

The threat model's section "Requirements handed to task 1.4" lists thirteen requirements. This ADR
answers requirements 1–12; ADR-0004 answers requirement 13 (evidence attestation). The mapping is
under Consequences, "Requirements trace". The requirements are cited there by number, not
restated.

Issuer facts below carry a source label from "Sources" at the end of this record. A fact without
one is marked _unverified_ or _inferred_. Where a fact could not be verified, the design is built
to fail closed whichever way it turns out.

## Decision

We will accept exactly one credential: a GitHub Actions OIDC ID token, presented as a bearer token,
minted for this control plane's audience, verified against GitHub's published key set, and bound
to exactly one registered workspace by the numeric-ID triple
`(issuer, repository_owner_id, repository_id)` held in the reviewed registry. Task 1.4 specifies;
task 2.1 implements. Nothing under `packages/` or `config/` changes in this ADR's task.

### Issuer

- The accepted `iss` is `https://token.actions.githubusercontent.com`, compared **byte for byte**,
  with no trailing slash. That is the discovery document's `issuer` value [S1]. GCP's workload
  identity guidance writes the same issuer with a trailing slash [S11], which is exactly why the
  comparison is equality and not normalisation.
- Discovery: `https://token.actions.githubusercontent.com/.well-known/openid-configuration` [S1].
  Its `jwks_uri` is `https://token.actions.githubusercontent.com/.well-known/jwks` [S1].
- `iss` and `jwks_uri` are **reviewed code constants**, never environment variables. The threat
  model's reasoning for the body limit applies unchanged: a tunable value is a second policy
  surface with no review path, no approval record and no tier.
- Discovery is not fetched at runtime to learn the issuer or key location; the constants are the
  reviewed copy of it. A change of either is a reviewed commit.
- GitHub Enterprise per-enterprise issuers are **not accepted**. The discovery document lists an
  `issuer_scope` claim [S1], but the URL form of an enterprise issuer is _unverified_, and
  accepting one is a new decision, made by adding a member to the accepted-issuer set.

### Audience

- **Rule:** `aud` must equal `urn:codeaiforge:sdlc-control-plane:<deployment-id>`, where
  `<deployment-id>` is a reviewed code constant naming one deployment.
- **MVP value:** `urn:codeaiforge:sdlc-control-plane:production`.
- `aud` must be a string, or an array of exactly one element, equal to that value. A token with
  more than one audience is refused: it was minted for more than one relying party, and any of
  them could replay it here.
- GitHub's default audience is "the URL of the repository owner" [S3], so every relying party in
  one organisation that accepts the default shares one audience. A URN can never equal an
  `https://github.com/<owner>` URL, and there is no hostname to choose yet because no deploy target
  exists. That default, and every other audience, is refused with **401**.
- A job obtains a custom audience with `core.getIDToken(audience)` [S3], and "Without
  `id-token: write`, the OIDC JWT ID token cannot be requested" [S3]. Task 3.1's adapter therefore
  declares `permissions: id-token: write` and calls
  `core.getIDToken('urn:codeaiforge:sdlc-control-plane:production')`.

### Principal to workspace binding

- **Binding key:** `(iss, repository_owner_id, repository_id)`, read from **verified** claims only.
  Both ID claims are in `claims_supported` [S1], and GitHub's example payload carries them as JSON
  strings (`"repository_id": "74"`, `"repository_owner_id": "65"`) [S4].
- **Lookup:** at load, task 2.1 builds an index keyed by
  `JSON.stringify([issuer, repository_owner_id, repository_id])` — the same encoding, for the same
  reason, as ADR-0002's idempotency key — mapping to a `workspace_id`. It then calls
  `registry.get(workspace_id)`. That is the call TB-4's trusted side has been waiting for.
- The request body is **never** read for identity. A `workspace_id` inside a submitted record is
  payload, as ADR-0002 already treats a submitted `received_at`.
- A verified token that matches no registration, or matches one whose `status` is not `active`,
  **authorizes nothing** (403).
- Registry load refuses two registrations with the same triple, as `register` already refuses a
  duplicate `workspace_id` (`registry.mjs:17-18`).
- **Not compared:** `sub`, `repository`, `repository_owner`, `repository_url`, `repo_property_*`,
  `ref`, `workflow_ref` and `ref_protected`.
  - Names are refused because FR-1.2 says the system "does not infer people, teams, or authority
    from a repository name".
  - `sub` is name-based for older repositories: "Repositories created before July 15, 2026 keep the
    previous format unless you opt in to immutable subject claims", and "Repository renames and
    transfers after July 15, 2026 also move to the immutable subject format" [S3].
    `ai-ready-nx-workspace` predates that date (Phase ① measurement).
  - `ref` and `ref_protected` are not compared because evidence is per change, and a change is
    gated on whatever branch it lives on before it merges: a `push` from **any** branch is admitted
    when the registration admits `push`, and so is a pull request whatever its base. Requiring
    `ref_protected` would admit only runs on protected branches, which is not where a gate runs,
    and it is not required in the MVP. For a pull request `ref` is a merge ref (see "Workload
    contexts"), which names no branch a registration could pin.
  - `workflow_ref` is not compared: it names the caller workflow at the ref that ran, and anyone
    who can push a branch chooses both. **The workflow is bound only through the optional
    `required_job_workflow_ref` and `required_job_workflow_sha`** ("Registration contract"); a
    registration that sets neither admits a token from any workflow in the repository.
  - Custom properties appear in the token "prefixed with `repo_property_`" [S3]. Binding on one
    would make the forge organisation's administrators, rather than TB-4's reviewed registry, the
    authority that decides which workspace a token speaks for.
- `workspace_id` stays **registry-assigned** and is never derived from a claim, so ADR-0002's
  all-time key does not move when anything in the token does (requirement 2).

What happens to the resolved `workspace_id` when the world changes:

| Event                                                   | Outcome                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token rotation                                          | **Survives.** A token carries no workspace identifier; the registry assigns it.                                                                                                                                                                                                                                                                                           |
| Repository rename                                       | **Survives if `repository_id` is stable across a rename.** That is _unverified_; it is _inferred_ from GitHub's immutable `sub` format, which "includes both the owner ID and repository ID" and which renames after July 15, 2026 move to [S3]. If it is not stable, the token matches nothing and is refused (403) until a reviewed registry commit records the new ID. |
| Transfer to another owner                               | `repository_owner_id` changes, so the triple no longer matches: **403** until a reviewed commit updates the binding. That commit keeps the same `workspace_id` only if a human decides it is still the same workspace. Whether `repository_id` itself survives a transfer is _unverified_.                                                                                |
| Issuer re-registration (a second issuer, or enterprise) | The registration's `issuer` changes by reviewed commit; `workspace_id` is unchanged. ADR-0002's key is unaffected because `workspace_id` is not derived from the issuer.                                                                                                                                                                                                  |
| Repository deleted and its name re-used                 | The new repository has a new ID, so it is refused. GCP's guidance for the same problem: use "the numeric `*_id` fields instead, which are unique and can't be reused" [S11].                                                                                                                                                                                              |

### Registration contract: `workspace-registry/1`

Every registration gains a **required** object `workload_identity`:

| Field                       | Type and normalised form                                                                           | Comparison with the token                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `issuer`                    | string; a member of the control plane's accepted-issuer constant set, which has exactly one member | `iss` equals it exactly                                                                                |
| `repository_owner_id`       | string matching `^[1-9][0-9]{0,19}$` — decimal digits, no sign, no leading zero                    | the claim is a JSON string of the same form, compared by **string equality**; never parsed as a number |
| `repository_id`             | same as `repository_owner_id`                                                                      | same                                                                                                   |
| `admitted_events`           | non-empty array of unique strings, each a member of `{push, pull_request, pull_request_review}`    | `event_name` is a member                                                                               |
| `required_job_workflow_ref` | optional string of the form `<owner>/<repo>/.github/workflows/<file>@refs/(heads\|tags)/<name>`    | when present, the `job_workflow_ref` claim is present and equals it exactly                            |
| `required_job_workflow_sha` | optional string of 40 lowercase hexadecimal digits; allowed only with `required_job_workflow_ref`  | when present, the `job_workflow_sha` claim is present and equals it exactly                            |

- The ID fields are strings because the claims are strings [S4], and because a numeric parse loses
  precision above 2^53 and accepts `"074"` as `74`. Equality on a canonical string form has neither
  failure.
- `job_workflow_ref` is "For jobs using a reusable workflow, the ref path to the reusable workflow",
  and `job_workflow_sha` is "For jobs using a reusable workflow, the commit SHA for the reusable
  workflow file" [S3]; both are in `claims_supported` [S1]. Pinning them is the optional hardening
  the founder chose for the same-repository risk under "Workload contexts" (Q-6).
- **What a pin does.** A token minted by a job outside the pinned reusable workflow does not carry
  the pinned value, so an edited caller workflow that mints its own token is refused (but see
  "Unverified issuer behaviour" below for a workflow pushed to the pinned ref itself).
- **What a pin does not do.** A job with `id-token: write` can request a token through
  "environment variables on the runner", `ACTIONS_ID_TOKEN_REQUEST_URL` and
  `ACTIONS_ID_TOKEN_REQUEST_TOKEN` [S3], so every step of that job can mint one (_inferred_: the
  page does not say which steps see them). A gate job runs code the pull request controls —
  install scripts, `project.json` targets, tests. If the job that holds the token executes that
  code, the code can call `getIDToken` itself and mint a token carrying the pinned
  `job_workflow_ref`, which passes. **A pin narrows the same-repository risk only when minting and
  submitting happen in a separate job of the pinned workflow that checks out and runs no
  pull-request-controlled code**, consuming the gate's output as data. Task 3.1 builds its adapter
  in that shape (Consequences). A pin constrains who mints the token, not what the record says;
  the gate's output is produced by pull-request code (ADR-0004).
- **A ref pin is only as strong as the ref.** A branch or tag can be moved by anyone allowed to
  push it. `required_job_workflow_sha` pins the file's commit instead, which cannot move; the cost
  is a reviewed registry commit for every change to the pinned workflow. A registration that pins
  only the ref accepts whatever the ref points at (a Gate 2 residual).
- **Unverified issuer behaviour.** Both pages describe `job_workflow_ref` only for reusable
  workflows [S3], [S12]; whether GitHub omits it for other jobs is _unverified_. If it is present
  for a job that is not in a reusable workflow, it presumably equals `workflow_ref`, and a
  top-level workflow pushed directly to the pinned ref would then satisfy a ref pin (_unverified_).
  Either way the rule is fail-safe in one direction: a token without the claim fails a pin. Task
  2.1 records a measured token from a job outside any reusable workflow.
- `status` becomes enumerated, `active | suspended`, and only `active` authorizes. Today it is only
  checked for being a non-empty string (`packages/contracts/src/schema.mjs:38-46`). Suspension is
  the revocation path: a reviewed commit and a restart.
- `repository_url` stays descriptive and is never matched. Requirement 8 observes that nothing could
  match a claim against it; the answer is to move the binding into dedicated comparable fields,
  not to start parsing a URL.
- **Validation task 2.1 applies at load:** every rule in the table; unknown `issuer` refused;
  duplicate triples refused; `admitted_events` members outside the allowlist refused. Any failure
  throws at startup, as an invalid registration does today.
- **Why a new major version, under NFR-1.1.** NFR-1.1 requires the system to "reject an unknown
  major contract version and tolerate unrecognised additive fields on a supported version". A new
  _required_ block makes every `workspace-registry/0` document invalid, which is not additive. The
  additive alternative — an _optional_ block under `/0` — would let a registration with no binding
  load cleanly and then authorize nothing, forever, with no error anywhere: a fail-closed nobody
  can see.
- **Version enforcement.** `REGISTRY_SCHEMA_VERSION` (`schema.mjs:2`) is exported and read by
  nothing, and `registry_version` in `config/control-plane/workspaces.json` is never checked. Task
  2.1 makes the registry refuse to load unless `registry_version === 'workspace-registry/1'`.
- **Implementer: task 2.1**, for the validator and `REGISTRY_SCHEMA_VERSION` in `schema.mjs`, the
  binding index and version check in `workspace-registry`, the `Workspace` schema in
  `packages/control-plane-api/openapi.json`, and the migration of
  `config/control-plane/workspaces.json` to `/1`.
- **Constraint on task 2.1.** The version check and the binding index live in `workspace-registry`,
  not in `control-plane-api`. `contracts` has a fan-in of 2 today; if `control-plane-api` imported
  it, fan-in would reach 3, which `tools/sdlc-controls/generate-component-map.mjs` turns into
  `shared: true` and a retier of every later change under it.

### Workload contexts

The event allowlist is `{push, pull_request, pull_request_review}`, and no registration can admit
anything outside it in the MVP. That is stricter than requirement 3's "refused unless the
registration explicitly admits them": the contexts that run untrusted code with base-repository
privileges cannot be admitted at all.

- `pull_request_target` "runs in the context of the default branch of the base repository" [S5].
- `workflow_run` "is able to access secrets and write tokens, even if the previous workflow was
  not" [S5].
- For `event_name`, "OIDC tokens requested for Dependabot update jobs use `dynamic` as the value"
  [S3], which is outside the allowlist. A run Dependabot itself triggers on a pull request or push is
  a different case; it has its own row below and is refused by actor.
- **Refused-actor set.** A reviewed code constant, like `iss`, never an environment variable or a
  registration field. A token whose `actor_id` is a member is refused (403) whatever its event and
  whatever the registration admits. Its one member is the Dependabot account's ID, for the reason in
  the Dependabot row below. Members are canonical decimal strings, compared with the claim by string
  equality, like the binding IDs; a number would never equal the string claim, and the refusal
  would fail open.
- `issue_comment` is outside the allowlist.
- `merge_group`, `workflow_dispatch` and `schedule` are outside the allowlist, so a gate that runs
  in a merge queue, by hand or on a schedule cannot submit evidence. That fails closed; admitting
  any of them is a new decision.

| Context                                                                                                               | Outcome                                                            | Claim that distinguishes it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pull request from a fork                                                                                              | **Refused**                                                        | **No claim distinguishes it.** Nothing in `claims_supported` names the head repository [S1]. The refusal therefore rests on GitHub not issuing an ID token to the run, and that is _inferred_; no cited page says it. For it: "You can use the permissions key to add and remove read permissions for forked repositories, but typically you can't grant write access. The exception to this behavior is where an admin user has selected the Send write tokens to workflows from pull requests option" [S6], and the permission's value is literally `write`. Against it: of `id-token: write`, "This setting only enables fetching and setting the OIDC token; it does not grant write access to other resources" [S3], so a fork run's inability to obtain a token is not the documented write restriction. Task 3.1 measures it before any registration admits `pull_request` or `pull_request_review` on a public repository (Consequences), and it is a Gate 2 residual. The exception setting applies "to private repositories only" [S7]. On a private or internal repository with it on, a fork token would be indistinguishable from a same-repository one. Registration therefore carries a **precondition**, confirmed by the registering human in the reviewed commit, that the setting is off. The control plane cannot verify it; it is a Gate 2 residual. Whether a fork token would carry the base repository's `repository_id` is _unverified_, and the refusal does not depend on it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Pull request from outside the organisation, and any trigger that runs untrusted code in the base repository's context | **Refused**                                                        | An outsider cannot push a branch to the base repository (_inferred_ from the permission model), so an external pull request is a fork pull request, above. `event_name` of `pull_request_target`, `workflow_run` or `issue_comment` is refused by the allowlist.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Run Dependabot itself triggers on `push`, `pull_request` or `pull_request_review`                                     | **Refused (403)**                                                  | `actor_id`, "The ID of personal account that initiated the workflow run" [S3], in `claims_supported` [S1], is a member of the refused-actor set. GitHub's Dependabot page tells these runs apart by actor, with "an expression like: if: github.actor != 'dependabot[bot]'" [S13]; that `actor_id` is that actor's ID is _inferred_ from the claim's description. The fork row's refusal does not cover these runs, because the fork treatment is only a default: "By default, GitHub Actions workflow runs that are triggered by Dependabot from push, pull_request, pull_request_review, or pull_request_review_comment events are treated as if they were opened from a repository fork" [S13], and it says "You can use the permissions key in your workflow to increase the access for the token" [S13]. Dependabot branches live in the base repository (_inferred_: Dependabot opens its pull requests from branches it pushes there), and the run executes the dependency update Dependabot pulled in. The page does not mention `id-token`, so that such a run can obtain an ID token is _inferred_; the refusal does not depend on it. GitHub's REST API reports the `dependabot[bot]` account as `"id": 49699333` [S14]; that the `actor_id` claim carries that value is _unverified_, so task 2.1 records the `actor_id` of a measured Dependabot-triggered run and sets the constant from it. A run a human triggers on a Dependabot pull request — pushing to its branch, submitting a review, labelling or reopening it — is not triggered by Dependabot: it carries that human's `actor_id` (_inferred_), gets no fork-like default (_inferred_: [S13] speaks only of runs "triggered by Dependabot"), and is a same-repository run, below, admitted wherever its event is. It still runs the dependency update Dependabot pulled in. That is the routine review path, not an edge case, and it is a Gate 2 residual. Dependabot _update_ jobs are also refused by the event allowlist, since their `event_name` is `dynamic` (above). |
| Re-run of an old pipeline                                                                                             | **Admitted if its event is admitted**                              | `run_attempt` other than `"1"` [S1], [S4]. A re-run is possible "up to 30 days after its initial run", uses "the same `GITHUB_SHA` … and `GITHUB_REF`", and uses "the privileges of the actor who initially triggered the workflow" [S8]. It is evaluated against the **current** registration, so a suspended workspace cannot be re-run into acceptance. Its evidence resolves through ADR-0002: an identical body is `duplicate`, a differing body is `conflict`, and the first record stands.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Pull request from a branch of the same repository                                                                     | **Admitted if `pull_request` / `pull_request_review` is admitted** | **No claim distinguishes it from a fork pull request**; it is admitted by `event_name`, relying on the fork-token precondition in the fork row above. For both events GITHUB_REF is the "PR merge branch `refs/pull/PULL_REQUEST_NUMBER/merge`" [S5], the same for a fork. That the OIDC `ref` claim, "The git ref that triggered the workflow run" [S3], equals GITHUB_REF is _inferred_ for both events, and `ref` is not compared ("Not compared"). The risk this admits is recorded as a residual: anyone with write access can edit the workflow on a branch and mint a valid token.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

**The limit of authentication, stated once.** A verified token proves which repository and which run
submitted the evidence. It does not prove that the gate which produced the evidence ran
unmodified. Anyone who can push to a registered repository can edit a workflow and mint a token
whose binding claims match — on a same-repository pull request, a push, or a feature branch.
A pin (`required_job_workflow_ref`, optionally with `required_job_workflow_sha`) narrows that only
for runs whose token-holding job executes no pull-request-controlled code. A pinned gate job that
runs the pull request's code while holding `id-token: write` lets that code mint an admitted token
directly. ADR-0004 is the answer to what a disposition may therefore claim.

### Route authorization

Routing is unchanged and comes first: a request that matches no entry in `routes` on exact method
and path (`packages/control-plane-api/src/main.mjs:105-109`) is answered 404 before any credential
is read. Every route in `routes` (`main.mjs:48-98`):

| Route                                  | Principal                                                   | May read or write                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                          | **Unauthenticated.** No credential is read, even if sent.   | Liveness only. It carries no data and checks no dependency, and deployment tooling probes it without a credential.                                                                                                                                                                                                                                                                                    |
| `GET /v1/workspaces`                   | A workload principal **authorized for** workspace W (below) | Reads `{ "data": [registration W] }` — a list of exactly one. No other registration is disclosed.                                                                                                                                                                                                                                                                                                     |
| `GET /v1/indicators`                   | A workload principal authorized for W                       | Reads `summarizeEvidence` over the records of envelopes whose `workspace_id` is W. Today the route summarises `evidenceStore.listRecords()` (`main.mjs:63`); the seam instead takes `evidenceStore.list()`, keeps the envelopes whose `workspace_id` is W, and drops redacted envelopes (`evidence` null), as `listRecords()` does today (`evidence-store.mjs:124-127`), so the port does not change. |
| `POST /v1/evidence`                    | A workload principal authorized for W                       | Writes one envelope with `workspace_id` = W, taken from the principal and never from the body.                                                                                                                                                                                                                                                                                                        |
| Policy and registration administration | **No principal this model authenticates**                   | Stays the TB-6 path: a reviewed commit to `config/control-plane/**`, read at process start. No route administers either.                                                                                                                                                                                                                                                                              |

- **Authorized for W** means one predicate, applied identically on every route except
  `GET /health`: the verified token binds to W, W is `active`, W admits the token's `event_name`,
  any `required_job_workflow_ref` / `required_job_workflow_sha` pin matches, and the token's
  `actor_id` is not in the refused-actor set. Reads get the full predicate rather than an active
  binding alone, because a looser read rule would let a context the registration refuses —
  `pull_request_target`, `workflow_dispatch`, `schedule` — read W's registration and indicator, no
  caller needs that, and one predicate is one code path and one set of 403 cases for task 2.1 to
  test.
- This is MIT-3's shape ("Scope every read route to the authorized principal"), which task 2.1
  owns.
- The organisation-wide and human view of the indicator is **lost** in the MVP, by the founder's
  decision. It is a Gate 2 residual. FR-1.1's criterion "Registered workspaces can be listed
  deterministically" still holds for the library's `list()`, which is unchanged; over HTTP the list
  is always the caller's own single entry.

### Wire statuses

| Status | Meaning                       | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------ | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 401    | Unauthenticated               | Missing, malformed or repeated `Authorization` (a repeat is detected from `request.rawHeaders`: Node's `request.headers` silently keeps only the first); a token header with no valid `kid` (a non-empty string of at most 256 characters) or with `crit`; bad signature; wrong `iss`, `aud` or `alg`; unknown `kid` after the permitted refetch; expired or not yet valid; lifetime over the maximum; a claim of the wrong type or format, or a missing or empty `repository_owner_id`, `repository_id`, `actor_id`, `event_name`, `run_id`, `run_attempt`, `sha`, `ref` or `workflow_ref`. Sent with `WWW-Authenticate: Bearer error="invalid_token"`. |
| 403    | Authenticated, not authorized | A valid token matching no `active` registration; an `event_name` the registration does not admit; a `job_workflow_ref` or `job_workflow_sha` pin whose claim is absent or unequal; an `actor_id` in the refused-actor set (Dependabot). **One identical body for every case.**                                                                                                                                                                                                                                                                                                                                                                           |
| 422    | Refused by policy             | Existing and unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 503    | Key set unavailable           | No unexpired key set is cached and a fetch fails or yields an unusable set (an addition beyond requirement 6; see "Keys and rotation"). The fault is the control plane's, not the caller's credential.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

- **403, not 404, for a valid token with no registration.** 404 already means "no such route" here,
  and a status that differed between "registered but not admitted" and "not registered" would let
  any token holder probe which repositories are registered. The reason for a 403 goes only to task
  2.1's MIT-17 log ("principal, route, status and reason, never the body").
- **Decided on the headers, before any body byte is read.** On `POST /v1/evidence`, 401, 403 and
  503 are decided from the request line and headers alone, then the response is sent and the
  socket destroyed, as the threat model specifies for 401. Only an authorized request reaches the
  413 byte cap, then 400, 422 and 202.
- **Task 2.1** declares 401, 403 and 503 on every route except `GET /health` in
  `packages/control-plane-api/openapi.json`, and bumps `info.version` in the same change as the 413
  the threat model already assigns it. Today the document declares only 202, 400 and 422 on the
  POST and 200 on each GET.

### Token lifetime and replay

- `exp`, `iat` and `nbf` are required and must be JSON numbers. All three are in
  `claims_supported` [S1].
- Clock-skew allowance: **60 s**. Accept only if `exp > now − 60`, `nbf ≤ now + 60` and
  `iat ≤ now + 60`.
- **Maximum accepted lifetime: `exp − iat ≤ 900 s`.** GitHub's documentation gives no normative
  token lifetime. Its example payload has `exp − iat` = 300 s and `exp − nbf` = 900 s, with `nbf`
  600 s before `iat` [S4]; the "5 minutes" figure appears otherwise only in a secondary source
  (actions/toolkit issue #2048). This design therefore does not rest on 300 s: 900 s is three times
  the example, and a longer token fails closed (401) and shows up in the log rather than being
  silently accepted. Task 2.1 records a measured `exp − iat` from a real run.
- **`jti` is not tracked** (the founder's decision, Q-7). The reasoning, through ADR-0002's
  `(workspace_id, change_id)` key:
  - A byte-identical replay of a submission is `duplicate`: nothing is appended.
  - A different body with the same `change_id` is `conflict`, and the first record stands.
  - A different body with a new `change_id`, under a stolen token, is appended. Only the token's
    lifetime bounds this, and it is a Gate 2 residual. The bound is 900 s of lifetime plus the 60 s
    skew allowance: `exp ≤ iat + 900` and `exp > now − 60` together accept a token until about
    **960 s after its `iat`**.
  - Tracking `jti` needs state shared across processes, which is task 2.2's store; 2.2 depends on
    2.1, so tracking in 2.1 would invert the roadmap's dependency. A per-process cache would
    protect one process and read as protection for all of them.

### Keys and rotation

- **Source:** the pinned `jwks_uri` [S1], fetched over HTTPS only, following no redirect, with a
  5 s timeout and a 64 KiB response cap.
- **Cache:** for the response's `Cache-Control` `max-age`, clamped to **[60 s, 3600 s]**. The JWKS
  was measured answering `cache-control: public, max-age=3600, must-revalidate` [S2]. No key is used
  past that bound: there is no stale-while-error.
- **Every fetch is single-flight and rate-limited**: the first fetch, a refetch on expiry and a
  refetch on an unknown `kid` share one in-flight request and at most one attempt per 60 s across
  the process. Requests that arrive while a fetch is barred are answered from the cache, or 503 if
  there is no unexpired cache; they never start a fetch of their own.
- **Unknown `kid`:** triggers a refetch under that limit. If the `kid` is still unknown, 401. This
  bounds how hard a stream of forged `kid` values can drive the control plane against GitHub.
- **A failed refetch keeps the unexpired cache.** If an unknown-`kid` refetch fails, the cached key
  set stays in use until its own expiry and that token gets 401. A stream of forged `kid` values
  during a GitHub outage therefore cannot turn a working cache into a global 503.
- **Fail closed:** when no unexpired key set is cached and a fetch fails, cannot be parsed or yields
  an empty set, every authenticated route answers **503**. The control plane never verifies against
  nothing and never admits an unverified token.
- **Token header.** A token with no `kid` is refused (401), never tried against every key. `kid`
  must be a non-empty string of at most 256 characters, looked up in a `Map` rather than a plain
  object, so a `kid` of `__proto__` finds no key and gets 401, not an error status. `jku`,
  `jwk`, `x5u`, `x5c` and `x5t` are ignored: a key comes only from the pinned key set (GitHub's
  example header carries `x5t` [S12], so it must not be refused). A `crit` header is refused (401),
  because this verifier understands no extension.
- **Validation order**, so that the status a malformed or forged token gets is the same in every
  implementation and can be tested:
  1. header syntax — one `Authorization`, `Bearer`, a compact JWS within 8 KiB, a decodable header
     with `alg` and `kid` and no `crit` (401);
  2. key set available (503);
  3. `alg`, `kid` and signature (401);
  4. `iss`, `aud`, `exp`, `nbf`, `iat` and the lifetime cap (401);
  5. claim types — `repository_owner_id`, `repository_id` and `actor_id` present in canonical
     string form (GitHub's example payload carries `"actor_id": "12"` as a string [S4]);
     `event_name`, `run_id`, `run_attempt`, `sha`, `ref` and `workflow_ref` present as non-empty
     strings — every claim ADR-0004's `submitted_by` is built from — with `run_id` and
     `run_attempt` matching `^[1-9][0-9]*$` and `sha` 40 lowercase hexadecimal characters; and
     `job_workflow_ref` / `job_workflow_sha`, where present, non-empty strings, `job_workflow_sha`
     also 40 lowercase hexadecimal characters (401). These formats are _inferred_: GitHub's example
     payload carries placeholders (`"sha": "example-sha"`, `"run_id": "example-run-id"`) [S4], and
     task 2.1 confirms them from a measured token. A format change on GitHub's side therefore
     fails closed rather than recording a `run_id` nobody can reopen. No registration is consulted
     yet, so a pin cannot decide anything here;
  6. binding, `status`, `event_name`, a pinned claim absent or unequal, and an `actor_id` in the
     refused-actor set (403).
- **Algorithms:** the token header's `alg` must be exactly `RS256`, the only value in the discovery
  document's `id_token_signing_alg_values_supported` [S1]. A key must have `kty` `RSA` and a modulus
  of at least 2048 bits, `use` `sig` where present, and `alg` `RS256` where present. The measured key
  set held four RSA keys, each `alg` RS256 and `use` sig [S2]. `none`, `HS*`, `ES*`, `PS*` and every
  other algorithm are refused.
- Whether 2.1 verifies with `node:crypto` directly (keeping the workspace's zero runtime
  dependencies) or adopts `jose` (its first runtime dependency) is task 2.1's choice, reviewed in its
  Phase ⑥.

### Credential transport

- The credential is read from **exactly one** `Authorization` header, scheme `Bearer` compared
  case-insensitively, whose value is a compact JWS of three base64url segments, at most 8 KiB.
- Cookies, the query string (`access_token` or any other name), and form or body parameters are
  **never read** for a credential. Today a query string already makes a request unmatched, because
  routing compares `request.url` whole (`main.mjs:105-106`); task 2.1 keeps that property if routing
  ever tolerates a query.
- **Never logged or echoed.** Neither the token nor the `Authorization` value is written to a log,
  an error body or a MIT-17 record, whatever the status: a logged token can be replayed for about
  960 s (Token lifetime and replay). A refusal at steps 1–5 is logged without a principal and
  without any claim, because an unverified token's `repository_id` would blame a repository that
  sent nothing. Task 2.1 implements it.
- Because the credential is never ambient, a browser cannot attach it to a cross-site request, and
  the `text/plain` POST the seam accepts today does not become a request-forgery vector once
  authentication exists.
- **TLS on every hop that carries the header**, including load balancer to service, is a
  constraint on whichever deploy target is selected (`docs/specs/stack.md`, `Target`). A bearer
  token on a plaintext hop is a credential handed to whoever can read that hop.

## Options Considered

### Issuers

The founder's gate decision fixed GitHub Actions; the comparison is kept so the choice can be
re-examined against the same facts.

| Candidate                                 | Workload token?                                                                                                                            | `aud`                                                                                           | Repository / ref / workflow claims                                                                                                                                                                        | Lifetime and `jti`                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **GitHub Actions (chosen)**               | Yes, with `id-token: write` [S3]                                                                                                           | Default is the owner URL; custom through `core.getIDToken(audience)` [S3]                       | `repository_id`, `repository_owner_id`, `repository`, `ref`, `ref_type`, `ref_protected`, `sha`, `workflow`, `workflow_ref`, `job_workflow_ref`, `event_name`, `run_id`, `run_attempt`, among others [S1] | Not stated normatively; the example is 300 s from `iat` [S4]. `jti` is in `claims_supported` [S1]. |
| GitLab CI                                 | Yes, configured with the `id_tokens` keyword [S9]                                                                                          | "Specified in the ID tokens configuration"; "The domain of the GitLab instance by default" [S9] | `namespace_id`, `project_id`, `project_path`, `ref`, `ref_type`, `ref_protected`, `pipeline_source`, `ci_config_ref_uri` [S9]                                                                             | "set to the job's timeout if specified, or 5 minutes" [S9]. `jti` and `nbf` present [S9].          |
| Gitea Actions                             | **No.** "`id-token` … not currently supported by Gitea Actions" (docs 1.27.3; the local server is 1.22.4) [S10]                            | —                                                                                               | —                                                                                                                                                                                                         | —                                                                                                  |
| Cloud workload identity (GCP, AWS, Azure) | GCP: a **relying party**, which exchanges the GitHub token through STS for a short-lived Google credential [S11]. AWS, Azure: _unverified_ | Whatever the federated CI token carries                                                         | None of its own beyond the federated token's                                                                                                                                                              | —                                                                                                  |

- **GitHub Actions — chosen.** It is where the organisation's CI runs and where 3.1's producer will
  run. It publishes numeric repository and owner IDs [S1] that "can't be reused" [S11], a
  customisable audience [S3] and a single signing algorithm [S1].
- **GitLab CI — not chosen.** Capable, and its claims would fit the same binding model under a
  second `issuer`. No governed workspace runs there, and its lifetime can equal the job timeout,
  which this design would refuse above 900 s. The `issuer` field keeps it additive later.
- **Gitea Actions — not possible.** It cannot issue an ID token, so any Gitea support would need a
  non-OIDC credential or a broker: a different decision.
- **Cloud workload identity — rejected.** GCP federates the GitHub token rather than replacing it,
  so it adds a hop and a cloud dependency without adding a repository claim, and it moves the
  binding into cloud IAM conditions, outside TB-4's reviewed registry. AWS and Azure were not
  researched.

### Binding keys

- **Repository name, `repository`, or `sub` — rejected.** FR-1.2 forbids inferring authority from a
  repository name, and `sub` is name-based for repositories created before July 15, 2026 unless
  they opt in, while "Repository renames and transfers after July 15, 2026 also move to the
  immutable subject format" [S3]. A `sub` binding would therefore change form under a rename. A
  deleted-and-recreated repository of the same name would inherit a name binding.
- **`repo_property_workspace_id` — rejected.** It would work mechanically [S3], but it moves the
  authority that binds a token to a workspace from the reviewed registry to whoever administers the
  forge organisation's custom properties.
- **`repository_url` — rejected.** It is a free string checked only for being non-empty, and
  parsing it into a comparable form would still bind on a name.
- **`(issuer, repository_owner_id, repository_id)` — chosen**, for the reasons under "Principal to
  workspace binding".

### Registration contract

- **Optional binding fields under `workspace-registry/0` — rejected.** Additive on paper, but a
  registration without them loads and silently authorizes nothing.
- **`workspace-registry/1` with a required `workload_identity` block and an enforced version —
  chosen.**

## Consequences

### Work handed to other tasks

- **Task 2.1** implements the whole of the Decision: token verification, the binding index, the
  `workspace-registry/1` contract and its version check, the route scoping, the four statuses, the
  `openapi.json` declarations and `info.version` bump, the MIT-17 refusal reasons, and the
  registration migration. That is a larger specification than 2.1's row assumed, in a sprint already
  over capacity; task 2.3 remains Sprint 2's release valve.
- **Task 2.1** also carries the constraint that `control-plane-api` must not import `contracts`.
- **Task 2.1** owns the doc consequence of the read-route change: `docs/contracts.md`'s lifecycle
  diagram and `docs/architecture/overview.md:35` (with its rendered `overview.html`) both show the
  control plane returning an indicator view to human or organisational governance, which no route
  serves under this model.
- **Task 2.1** records a measured token from a real run: its `exp − iat`, and whether a job outside
  any reusable workflow carries `job_workflow_ref` and `job_workflow_sha`, and the
  formats of `run_id`, `run_attempt`, `sha` and `job_workflow_sha` that step 5 enforces from an
  inference. Its test fixtures take their shapes from that measured token, never from GitHub's
  example payload, which step 5 refuses.
- **Task 2.1** records the `actor_id` of a measured Dependabot-triggered run and sets the
  refused-actor constant from that measured value, not from this record. If a Dependabot-triggered
  run cannot obtain a token at all, there is nothing to measure or to refuse: 2.1 records that
  result, and the constant holds the account ID from [S14], marked unmeasured.
- **Task 2.2** persists the `submitted_by` envelope field that ADR-0004 defines, under the
  retention and version rules ADR-0004 states.
- **Task 3.1** requests the custom audience with `id-token: write`, and the registering human
  confirms the fork-token precondition in the registration commit.
- **Task 3.1 measures the fork-token inference** before any registration admits `pull_request` or
  `pull_request_review` on a public repository: a pull request from a fork, whose workflow declares
  `id-token: write`, calls `getIDToken`, and the call is shown to fail. If it succeeds, those
  events are not admitted on a public repository and this ADR is revisited.
- **Task 3.1 measures the Dependabot refusal**: a run Dependabot itself triggers on a pull request in a
  registered repository, whose workflow declares `id-token: write` and submits, is shown either to
  fail to obtain a token or to be refused with 403. It also re-runs that run as a human and records
  the token's `actor_id`: whether a re-run carries the original actor or the re-runner is
  _unverified_, and if it is the re-runner, the re-run is admitted as a same-repository run. It
  records the `actor_id` of a run triggered by a human review and by a human label on a Dependabot
  pull request, the case the Dependabot row says is admitted. If either carries the refused
  `actor_id`, it is refused instead, and the row and its residual are corrected.
- **Task 3.1 builds its adapter so that a pin means something**: the job that holds
  `id-token: write`, mints the token and submits is a separate job of the pinned reusable workflow
  that checks out and runs no pull-request-controlled code, and takes the gate's output as data.
  That job runs only on GitHub-hosted or other ephemeral runners: on a persistent self-hosted
  runner the gate job can leave behind files or processes the mint job then meets (_inferred_). It
  never interpolates a caller-supplied `inputs` value into a shell command, because the caller
  workflow is editable by whoever pushes the branch. The control plane checks neither.

### Residuals for Gate 2

The threat model is not edited by this task (founder's decision, Q-10), so these reach Gate 2 from
here:

- **Same-repository writers can mint valid tokens** from an edited workflow (Q-6, accepted as a
  residual). A pin narrows it only for runs whose token-holding job executes no
  pull-request-controlled code; nothing closes it.
- **A ref pin is bounded by the pinned ref's mutability.** Anyone who can move the pinned branch or
  tag changes what the pin admits; only `required_job_workflow_sha` removes that, at the cost of a
  registry commit per workflow change.
- **Fork pull requests on public repositories are refused only because GitHub is inferred not to
  issue an ID token to them**; no cited page says so. Task 3.1's measurement settles it before
  either pull-request event is admitted on a public repository.
- **Dependabot runs are refused by a deny-list of one `actor_id`**, whose value is _unverified_
  until task 2.1 measures it. A deny-list fails open: if Dependabot-triggered runs ever carry an
  `actor_id` outside the set, they are admitted as same-repository runs until a reviewed commit
  updates the constant. It does not cover a run a human triggers on a Dependabot pull request — a
  push, a review, a label or a reopen — which carries the human's `actor_id` (_inferred_) and is
  admitted from day one wherever its event is. That run executes the dependency update, so a
  malicious dependency reaches an admitted token unless the token-holding job runs none of it (task
  3.1's adapter shape). Its evidence is still labelled self-attested (ADR-0004).
- **The private-repository fork-token setting cannot be verified** by the control plane. The
  registration precondition is a human's word.
- **`jti` replay within the token lifetime**: 900 s of lifetime plus 60 s of skew, about 960 s
  after `iat` (Q-7).
- **Availability depends on GitHub's key set.** With no stale use of keys, a key-set outage that
  outlasts the cached set's remaining lifetime (at most 3600 s) answers 503 on every authenticated
  route. Because every fetch shares one 60 s budget, an unknown-`kid` refetch that fails shortly
  before the cache expires delays the expiry refetch, so 503 can last up to 60 s after GitHub
  recovers.
- **Revocation takes effect only on restart**, because policy and registrations are read at process
  start (TB-6): a suspended workspace keeps submitting until the process restarts.
- **The organisation-wide and human view is lost** in the MVP (Q-4).
- **Rename and transfer survival is unverified**; both fail closed and need a reviewed commit to
  recover.
- **Solo approval.** The approval of this ADR is one human's; the tier it falls under (T3) asks for
  an independent approver, which a solo founder cannot supply.

### Requirements trace

| Threat-model requirement for 1.4        | Answered in                                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1 — bind to a registered `workspace_id` | Decision › Principal to workspace binding                                                                          |
| 2 — usable as ADR-0002's `workspace_id` | Decision › Principal to workspace binding (survival table)                                                         |
| 3 — workload credential; forks, re-runs | Decision › Workload contexts (the event allowlist and the refused-actor set)                                       |
| 4 — read routes                         | Decision › Route authorization                                                                                     |
| 5 — `GET /health` unauthenticated       | Decision › Route authorization                                                                                     |
| 6 — distinguishable failure             | Decision › Wire statuses                                                                                           |
| 7 — audience                            | Decision › Audience                                                                                                |
| 8 — binding claims in the registry      | Decision › Principal to workspace binding (and its "Not compared" list); Registration contract (the workflow pins) |
| 9 — lifetime and replay                 | Decision › Token lifetime and replay                                                                               |
| 10 — key rotation                       | Decision › Keys and rotation                                                                                       |
| 11 — `Authorization` header only        | Decision › Credential transport                                                                                    |
| 12 — TLS on every hop                   | Decision › Credential transport                                                                                    |
| 13 — evidence attestation               | ADR-0004                                                                                                           |

Every task this ADR hands work to — 2.1, 2.2 and 3.1 — is a row in
`docs/specs/implementation-roadmap.md`.

### Threat-model status

- **MIT-1** ("Name an OIDC issuer and an authorization model…", owner 1.4) is **decided** by this
  ADR once it is Accepted. It has no enforcing path until task 2.1 ships MIT-2, so its Evidence
  column stays "—".
- **MIT-13** is decided by ADR-0004.
- **RR-11** reaches its review point. It stays open as a residual, and its reason changes from "no
  signing identity exists" to "attestation declined, and made visible" (ADR-0004).
- The threat model is not edited here; Gate 2's write-back carries these changes.

### Sources

Fetched 2026-09-29. [S12], [S13] and [S14] were fetched, and [S1], [S3], [S4], [S5] and [S6] were
re-fetched for the quotations added in review, on 2026-09-30.

- [S1] <https://token.actions.githubusercontent.com/.well-known/openid-configuration>
- [S2] <https://token.actions.githubusercontent.com/.well-known/jwks> (response header and body measured)
- [S3] <https://docs.github.com/en/actions/reference/security/oidc>
- [S4] <https://docs.github.com/en/actions/concepts/security/openid-connect> (example payload)
- [S5] <https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows>
- [S6] <https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax>
- [S7] <https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository>
- [S8] <https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs>
- [S9] <https://docs.gitlab.com/ci/secrets/id_token_authentication/>
- [S10] <https://docs.gitea.com/usage/actions/token-permissions/>
- [S11] <https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines>
- [S12] <https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-with-reusable-workflows>
- [S13] <https://docs.github.com/en/code-security/reference/supply-chain-security/troubleshoot-dependabot/dependabot-on-actions>
- [S14] <https://api.github.com/users/dependabot%5Bbot%5D> (the `dependabot[bot]` account; response body measured)
- Secondary, not relied on: <https://github.com/actions/toolkit/issues/2048>
