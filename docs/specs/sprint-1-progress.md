# Sprint 1 Progress

**Sprint**: 1 — MVP service boundary
**Dates**: Sep 21 – Oct 2, 2026
**Last updated**: 2026-09-28 (task 1.3 — Done)

---

## Task Status

| #   | Task                                                    | Status      | Notes                                                                                                                                                                                                                                                                                   |
| --- | ------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1 | Define OpenAPI and error-response contract              | Done        | `feat/1.1-openapi-error-contract` — `openapi.json` published and held to the seam by two-sided contract tests. 3 review cycles, 9 Blockers fixed.                                                                                                                                       |
| 1.2 | Add append-only persistence port and idempotency design | Done        | `feat/1.2-persistence-port-idempotency` — ADR-0002 (Proposed) plus an evidence port and a portable conformance suite 2.2 writes its adapter against. 3 review cycles + 1 authorised round, 11 Blockers fixed; Phase ⑧ failed once and was re-verified.                                  |
| 1.3 | Threat-model evidence ingress and policy administration | Done        | `docs/1.3-threat-model-ingress`, fast-forwarded to `main` without a PR — `docs/architecture/threat-model.md` plus an executable conformance check. 3 review cycles + 1 capped round; Phase ⑤ passed on cycle 3; Phase ⑥ Conditional Pass, conditions applied. Acceptances await Gate 2. |
| 1.4 | Select OIDC issuer and authorization model              | Not started | Added 2026-09-23 during 1.3's Phase ①. Gate 2 requires a named OIDC issuer and authorization model approved before Sprint 2 implementation, and the only task producing it was 2.1 — inside the sprint the gate guards. Depends on 1.3.                                                 |

## Additional Work Completed (not in roadmap)

| Item                                           | Commit              | Notes                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Governance repair carried on the 1.2 branch    | `d89e573`…`7f51b43` | A vendor drift report (`tools/vendor/drift.mjs`), a stack-profile control, a dependency-audit remediation clearing 5 advisories, and two patches to `ai-ready-nx-workspace`. Each was prompted by a defect the pipeline surfaced while running 1.2. Whether this belongs on a task branch is a retrospective question. |
| Three robustness defects fixed in the 0.4 seam | `1d22133`           | An aborted POST killed the process; a multi-byte character split across chunk boundaries silently corrupted `change_id`; the guardrail policy was the one configuration loaded unvalidated. All surfaced by publishing a contract and testing it two-sidedly. Supports 1.1.                                            |

## Summary

- **Done**: 3 / 4 tasks
- **In progress**: 0 / 4 tasks
- **Not started**: 1 / 4 tasks
- **Story points completed**: 9 / 12 SP

## Current Wave

**Waves 1 and 2 complete** — 1.1, 1.2 and 1.3 are Done. **Wave 3** is the remaining work: task 1.4, unblocked by 1.3 and carrying the thirteen requirements in the threat model's "Requirements handed to task 1.4" section — including an evidence-attestation decision its Done-when does not name. 1.4 tiers up on its `auth` layer.

## Sprint 1 Definition of Done

- [x] An OpenAPI document describes all four routes and their error responses — `packages/control-plane-api/openapi.json`
- [x] Contract tests cover accepted, invalid and incompatible evidence — named tests in `openapi.contract.test.mjs`
- [x] An ADR names the store, idempotency key, retention window and audit-event boundary — `docs/adr/0002-append-only-evidence-envelope-log.md`, Status **Proposed** pending Gate 2
- [x] A threat model documents trust boundaries, abuse cases, mitigations and residual risks — `docs/architecture/threat-model.md`; residual-risk acceptances pending Gate 2
- [ ] A named OIDC issuer and an authorization model binding a principal to a registered workspace are approved (1.4)

## Blockers / Decisions Needed

- **Proposed roadmap task — the AI provenance rule is fail-open.** `evaluateGuardrails` tests `ai_tool` for truthiness, so `ai_tool: 42` satisfies CAF-SDLC-010's provenance requirement. `.ai/standards/ai-provenance.md` is explicit that provenance recording only "an AI was involved" is worthless because it names no accountable tool — and a number names no tool. `validateEvidence` does not inspect the field either, so nothing in the chain refuses it. Needs a task requiring a non-empty string, with a test proving `ai_tool: 42` is refused. `packages/control-plane-api/openapi.json` documents this weakness on the `ai_tool` field and points here. Owner: whoever takes the guardrail-policy package. The threat model now carries the same weakness as ABU-9 (`ai_tool: {}` is accepted too) and gives the provenance rule — and its missing test — to 2.1 under MIT-11 and Gate 2 finding 6.
- **Resolved — the 202 body survives durable intake unchanged.** ADR-0002 § "The 202: the terminal disposition stays in the response body" decides it: the terminal disposition stays, no `submission_id` is added, and `info.version` is not bumped. Making intake asynchronous is recorded as a real option that changes what the 202 means to every caller, and so is not taken silently.
- **`main` has no branch protection, and the PR gate never runs on a direct push.** Task 1.3 reached `main` by fast-forward: CI passed, but `sdlc-controls.yml` triggers only on `pull_request`, so a change the gate tiers **T3** (two approvers, one independent) merged with none. This is the threat model's ABU-6 and RR-1 in practice. Fix is forge configuration: require pull requests on `main` and make `sdlc-controls / controls` a required check.
- **Nothing runs `pnpm audit` in CI, and no task owns it.** Task 1.2 cleared five advisories and pinned two transitive dependencies by override; both the clean result and the pins rot unwatched until a workflow runs the command the stack profile names.
- **Five stack-profile rows read `Not selected`.** `Data access` (2.2) is the one with security weight — it decides whether parameterisation is a reviewable convention or a property of a query builder. `Migrations + verify` and `Integration test harness` are 2.2's, `Auth mechanism` is 1.4's to select and 2.1's to implement, `Scaffold new lib/module` is undecided.
- **Roadmap question — should 1.1's Trace include NFR-1.1?** The Done-when's "incompatible" case is defined only by NFR-1.1, which is traced by 0.2. The published document is where additive tolerance becomes externally visible, via the `additionalProperties` choice. Raised rather than edited in, because it changes what a verification phase checks against.
- **Task 0.4's record overstates what it delivered.** Three of the nine Blockers fixed in 1.1 were pre-existing defects in the 0.4 seam — a remote process-kill, silent corruption of `change_id`, and an unvalidated policy load — against a record that reads PASSED with one test. Not being rewritten, per the standing rule against retroactively amending finished records. Belongs in the Sprint 1 retrospective as a retrospective claim.

### Carried forward from Sprint 0

- **Sprint 2 is planned over solo capacity** at 21 SP against ~20. Task 2.3 is the named release valve; decide at the Oct 9 mid-point, not at sprint end.
