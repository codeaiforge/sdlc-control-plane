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
- **Not compared:** `sub`, `repository`, `repository_owner`, `repository_url` and `repo_property_*`.
  - Names are refused because FR-1.2 says the system "does not infer people, teams, or authority
    from a repository name".
  - `sub` is name-based for any repository created before July 15, 2026 unless it has opted in to
    the immutable format [S3]. `ai-ready-nx-workspace` predates that date (Phase ① measurement).
  - Custom properties appear in the token "prefixed with `repo_property_`" [S3]. Binding on one
    would make the forge organisation's administrators, rather than TB-4's reviewed registry, the
    authority that decides which workspace a token speaks for.
- `workspace_id` stays **registry-assigned** and is never derived from a claim, so ADR-0002's
  all-time key does not move when anything in the token does (requirement 2).

What happens to the resolved `workspace_id` when the world changes:

| Event                                                   | Outcome                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Token rotation                                          | **Survives.** A token carries no workspace identifier; the registry assigns it.                                                                                                                                                                                                            |
| Repository rename                                       | **Survives if `repository_id` is stable across a rename.** That is _unverified_; it is _inferred_ from GitHub offering an immutable, ID-based `sub` format [S3]. If it is not stable, the token matches nothing and is refused (403) until a reviewed registry commit records the new ID.  |
| Transfer to another owner                               | `repository_owner_id` changes, so the triple no longer matches: **403** until a reviewed commit updates the binding. That commit keeps the same `workspace_id` only if a human decides it is still the same workspace. Whether `repository_id` itself survives a transfer is _unverified_. |
| Issuer re-registration (a second issuer, or enterprise) | The registration's `issuer` changes by reviewed commit; `workspace_id` is unchanged. ADR-0002's key is unaffected because `workspace_id` is not derived from the issuer.                                                                                                                   |
| Repository deleted and its name re-used                 | The new repository has a new ID, so it is refused. GCP's guidance for the same problem: use "the numeric `*_id` fields instead, which are unique and can't be reused" [S11].                                                                                                               |

### Registration contract: `workspace-registry/1`

Every registration gains a **required** object `workload_identity`:

| Field                       | Type and normalised form                                                                           | Comparison with the token                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `issuer`                    | string; a member of the control plane's accepted-issuer constant set, which has exactly one member | `iss` equals it exactly                                                                                |
| `repository_owner_id`       | string matching `^[1-9][0-9]{0,19}$` — decimal digits, no sign, no leading zero                    | the claim is a JSON string of the same form, compared by **string equality**; never parsed as a number |
| `repository_id`             | same as `repository_owner_id`                                                                      | same                                                                                                   |
| `admitted_events`           | non-empty array of unique strings, each a member of `{push, pull_request, pull_request_review}`    | `event_name` is a member                                                                               |
| `required_job_workflow_ref` | optional string of the form `<owner>/<repo>/.github/workflows/<file>@refs/(heads\|tags)/<name>`    | when present, the `job_workflow_ref` claim is present and equals it exactly                            |

- The ID fields are strings because the claims are strings [S4], and because a numeric parse loses
  precision above 2^53 and accepts `"074"` as `74`. Equality on a canonical string form has neither
  failure.
- `job_workflow_ref` is "For jobs using a reusable workflow, the ref path to the reusable workflow"
  [S3]. Pinning it is the optional hardening the founder chose for the same-repository risk under
  "Workload contexts" (Q-6): an edited caller workflow no longer mints an admitted token unless it
  calls the pinned reusable workflow at the pinned ref.
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
- Dependabot jobs carry `event_name` `dynamic` [S3], which is outside the allowlist.
- `issue_comment` is outside the allowlist.

| Context                                                                                                               | Outcome                                                            | Claim that distinguishes it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pull request from a fork                                                                                              | **Refused**                                                        | **No claim distinguishes it.** Nothing in `claims_supported` names the head repository [S1]. What follows: for a workflow from a forked repository "you can't grant `write` access" through `permissions`, except where an administrator selected "Send write tokens to workflows from pull requests" [S6]; so `id-token: write` is unavailable (_inferred_ — the permission's value is literally `write`, and no page says so verbatim). That setting applies "to private repositories only" [S7]. On a private or internal repository with it on, a fork token would be indistinguishable from a same-repository one. Registration therefore carries a **precondition**, confirmed by the registering human in the reviewed commit, that the setting is off. The control plane cannot verify it; it is a Gate 2 residual. Whether a fork token would carry the base repository's `repository_id` is _unverified_, and the refusal does not depend on it. |
| Pull request from outside the organisation, and any trigger that runs untrusted code in the base repository's context | **Refused**                                                        | An outsider cannot push a branch to the base repository (_inferred_ from the permission model), so an external pull request is a fork pull request, above. `event_name` of `pull_request_target`, `workflow_run` or `issue_comment` is refused by the allowlist.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Re-run of an old pipeline                                                                                             | **Admitted if its event is admitted**                              | `run_attempt` other than `"1"` [S1], [S4]. A re-run is possible "up to 30 days after its initial run", uses "the same `GITHUB_SHA` … and `GITHUB_REF`", and uses "the privileges of the actor who initially triggered the workflow" [S8]. It is evaluated against the **current** registration, so a suspended workspace cannot be re-run into acceptance. Its evidence resolves through ADR-0002: an identical body is `duplicate`, a differing body is `conflict`, and the first record stands.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Pull request from a branch of the same repository                                                                     | **Admitted if `pull_request` / `pull_request_review` is admitted** | `event_name`, plus, for `pull_request`, a `ref` of `refs/pull/N/merge`, the documented ref for that event [S5]. The `ref` a `pull_request_review` run carries is _unverified_ and is not relied on. The risk this admits is recorded as a residual: anyone with write access can edit the workflow on a branch and mint a valid token.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

**The limit of authentication, stated once.** A verified token proves which repository and which run
submitted the evidence. It does not prove that the gate which produced the evidence ran
unmodified. Anyone who can push to a registered repository can edit a workflow and mint a token
whose binding claims match — on a same-repository pull request, a push, or a feature branch.
`required_job_workflow_ref` narrows that to the pinned reusable workflow, which still reads
inputs the pull request controls. ADR-0004 is the answer to what a disposition may therefore claim.

### Route authorization

Routing is unchanged and comes first: a request that matches no entry in `routes` on exact method
and path (`packages/control-plane-api/src/main.mjs:105-109`) is answered 404 before any credential
is read. Every route in `routes` (`main.mjs:48-98`):

| Route                                  | Principal                                                   | May read or write                                                                                                                                                                                                                          |
| -------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /health`                          | **Unauthenticated.** No credential is read, even if sent.   | Liveness only. It carries no data and checks no dependency, and deployment tooling probes it without a credential.                                                                                                                         |
| `GET /v1/workspaces`                   | A workload principal bound to workspace W                   | Reads `{ "data": [registration W] }` — a list of exactly one. No other registration is disclosed.                                                                                                                                          |
| `GET /v1/indicators`                   | A workload principal bound to workspace W                   | Reads `summarizeEvidence` over the records of envelopes whose `workspace_id` is W. Today the route summarises `evidenceStore.listRecords()` (`main.mjs:63`); the seam filters `evidenceStore.list()` instead, so the port does not change. |
| `POST /v1/evidence`                    | A workload principal bound to W whose `event_name` W admits | Writes one envelope with `workspace_id` = W, taken from the principal and never from the body.                                                                                                                                             |
| Policy and registration administration | **No principal this model authenticates**                   | Stays the TB-6 path: a reviewed commit to `config/control-plane/**`, read at process start. No route administers either.                                                                                                                   |

- This is MIT-3's shape ("Scope every read route to the authorized principal"), which task 2.1
  owns.
- The organisation-wide and human view of the indicator is **lost** in the MVP, by the founder's
  decision. It is a Gate 2 residual. FR-1.1's criterion "Registered workspaces can be listed
  deterministically" still holds for the library's `list()`, which is unchanged; over HTTP the list
  is always the caller's own single entry.

### Wire statuses

| Status | Meaning                       | When                                                                                                                                                                                                                                                    |
| ------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 401    | Unauthenticated               | Missing, malformed or repeated `Authorization`; bad signature; wrong `iss`, `aud` or `alg`; unknown `kid` after the permitted refetch; expired or not yet valid; lifetime over the maximum. Sent with `WWW-Authenticate: Bearer error="invalid_token"`. |
| 403    | Authenticated, not authorized | A valid token matching no `active` registration; an `event_name` the registration does not admit; a `job_workflow_ref` mismatch. **One identical body for every case.**                                                                                 |
| 422    | Refused by policy             | Existing and unchanged.                                                                                                                                                                                                                                 |
| 503    | Key set unavailable           | The key set cannot be fetched or parsed (an addition beyond requirement 6; see "Keys and rotation"). The fault is the control plane's, not the caller's credential.                                                                                     |

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
    lifetime bounds this — at most 900 s accepted — and it is a Gate 2 residual.
  - Tracking `jti` needs state shared across processes, which is task 2.2's store; 2.2 depends on
    2.1, so tracking in 2.1 would invert the roadmap's dependency. A per-process cache would
    protect one process and read as protection for all of them.

### Keys and rotation

- **Source:** the pinned `jwks_uri` [S1], fetched over HTTPS only, following no redirect, with a
  5 s timeout and a 64 KiB response cap.
- **Cache:** for the response's `Cache-Control` `max-age`, clamped to **[60 s, 3600 s]**. The JWKS
  was measured answering `cache-control: public, max-age=3600, must-revalidate` [S2]. No key is used
  past that bound: there is no stale-while-error.
- **Unknown `kid`:** one single-flight refetch, at most once per 60 s across the process. If the
  `kid` is still unknown, 401. This bounds how hard a stream of forged `kid` values can drive the
  control plane against GitHub.
- **Fail closed:** a fetch failure, a parse failure or an empty key set answers **503** on every
  authenticated route. The control plane never verifies against nothing and never admits an
  unverified token.
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
  repository name, and `sub` is name-based for repositories created before July 15, 2026 [S3]. A
  deleted-and-recreated repository of the same name would inherit the binding.
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
  diagram shows the control plane returning an indicator view to human governance, which no route
  serves under this model.
- **Task 2.2** persists the `submitted_by` envelope field that ADR-0004 defines.
- **Task 3.1** requests the custom audience with `id-token: write`, and the registering human
  confirms the fork-token precondition in the registration commit.
- **Revocation** takes effect only on restart, because policy and registrations are read at process
  start (TB-6).

### Residuals for Gate 2

The threat model is not edited by this task (founder's decision, Q-10), so these reach Gate 2 from
here:

- **Same-repository writers can mint valid tokens** from an edited workflow (Q-6, accepted as a
  residual). `required_job_workflow_ref` narrows it; nothing closes it.
- **The private-repository fork-token setting cannot be verified** by the control plane. The
  registration precondition is a human's word.
- **`jti` replay within the token lifetime**, bounded at 900 s accepted (Q-7).
- **The organisation-wide and human view is lost** in the MVP (Q-4).
- **Rename and transfer survival is unverified**; both fail closed and need a reviewed commit to
  recover.
- **Solo approval.** The approval of this ADR is one human's; the tier it falls under (T3) asks for
  an independent approver, which a solo founder cannot supply.

### Requirements trace

| Threat-model requirement for 1.4        | Answered in                                                |
| --------------------------------------- | ---------------------------------------------------------- |
| 1 — bind to a registered `workspace_id` | Decision › Principal to workspace binding                  |
| 2 — usable as ADR-0002's `workspace_id` | Decision › Principal to workspace binding (survival table) |
| 3 — workload credential; forks, re-runs | Decision › Workload contexts                               |
| 4 — read routes                         | Decision › Route authorization                             |
| 5 — `GET /health` unauthenticated       | Decision › Route authorization                             |
| 6 — distinguishable failure             | Decision › Wire statuses                                   |
| 7 — audience                            | Decision › Audience                                        |
| 8 — binding claims in the registry      | Decision › Registration contract: `workspace-registry/1`   |
| 9 — lifetime and replay                 | Decision › Token lifetime and replay                       |
| 10 — key rotation                       | Decision › Keys and rotation                               |
| 11 — `Authorization` header only        | Decision › Credential transport                            |
| 12 — TLS on every hop                   | Decision › Credential transport                            |
| 13 — evidence attestation               | ADR-0004                                                   |

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

Fetched 2026-09-29.

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
- Secondary, not relied on: <https://github.com/actions/toolkit/issues/2048>
