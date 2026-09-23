# Sprint 1 Progress

**Sprint**: 1 — MVP service boundary
**Dates**: Sep 21 – Oct 2, 2026
**Last updated**: 2026-09-23 (task 1.2 — Done)

---

## Task Status

| #   | Task                                                    | Status      | Notes                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1.1 | Define OpenAPI and error-response contract              | Done        | `feat/1.1-openapi-error-contract` — `openapi.json` published and held to the seam by two-sided contract tests. 3 review cycles, 9 Blockers fixed.                                                                                                      |
| 1.2 | Add append-only persistence port and idempotency design | Done        | `feat/1.2-persistence-port-idempotency` — ADR-0002 (Proposed) plus an evidence port and a portable conformance suite 2.2 writes its adapter against. 3 review cycles + 1 authorised round, 11 Blockers fixed; Phase ⑧ failed once and was re-verified. |
| 1.3 | Threat-model evidence ingress and policy administration | Not started | Wave 2 — blocked on 1.1, which is now complete. Carries an NFR-6.1 trace, so it tiers up to Complex regardless of its 3 SP.                                                                                                                            |

## Additional Work Completed (not in roadmap)

| Item                                           | Commit              | Notes                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Governance repair carried on the 1.2 branch    | `d89e573`…`7f51b43` | A vendor drift report (`tools/vendor/drift.mjs`), a stack-profile control, a dependency-audit remediation clearing 5 advisories, and two patches to `ai-ready-nx-workspace`. Each was prompted by a defect the pipeline surfaced while running 1.2. Whether this belongs on a task branch is a retrospective question. |
| Three robustness defects fixed in the 0.4 seam | `1d22133`           | An aborted POST killed the process; a multi-byte character split across chunk boundaries silently corrupted `change_id`; the guardrail policy was the one configuration loaded unvalidated. All surfaced by publishing a contract and testing it two-sidedly. Supports 1.1.                                            |

## Summary

- **Done**: 2 / 3 tasks
- **In progress**: 0 / 3 tasks
- **Not started**: 1 / 3 tasks
- **Story points completed**: 6 / 9 SP

## Current Wave

**Wave 1 complete** — 1.1 and 1.2 are both Done. **Wave 2** is the remaining work: task 1.3, unblocked by 1.1's published ingress contract and now carrying four inputs from 1.2's security assessment (unbounded request body at ingress, evidence data classification, and the `Data access` decision that 2.2 inherits). 1.3 tiers up to Complex on its NFR-6.1 trace regardless of its 3 SP.

## Sprint 1 Definition of Done

- [x] An OpenAPI document describes all four routes and their error responses — `packages/control-plane-api/openapi.json`
- [x] Contract tests cover accepted, invalid and incompatible evidence — named tests in `openapi.contract.test.mjs`
- [x] An ADR names the store, idempotency key, retention window and audit-event boundary — `docs/adr/0002-append-only-evidence-envelope-log.md`, Status **Proposed** pending Gate 2
- [ ] A threat model documents trust boundaries, abuse cases, mitigations and residual risks (1.3)

## Blockers / Decisions Needed

- **Proposed roadmap task — the AI provenance rule is fail-open.** `evaluateGuardrails` tests `ai_tool` for truthiness, so `ai_tool: 42` satisfies CAF-SDLC-010's provenance requirement. `.ai/standards/ai-provenance.md` is explicit that provenance recording only "an AI was involved" is worthless because it names no accountable tool — and a number names no tool. `validateEvidence` does not inspect the field either, so nothing in the chain refuses it. Needs a task requiring a non-empty string, with a test proving `ai_tool: 42` is refused. `packages/control-plane-api/openapi.json` documents this weakness on the `ai_tool` field and points here. Owner: whoever takes the guardrail-policy package.
- **Resolved — the 202 body survives durable intake unchanged.** ADR-0002 § "The 202: the terminal disposition stays in the response body" decides it: the terminal disposition stays, no `submission_id` is added, and `info.version` is not bumped. Making intake asynchronous is recorded as a real option that changes what the 202 means to every caller, and so is not taken silently.
- **Nothing runs `pnpm audit` in CI, and no task owns it.** Task 1.2 cleared five advisories and pinned two transitive dependencies by override; both the clean result and the pins rot unwatched until a workflow runs the command the stack profile names.
- **Five stack-profile rows read `Not selected`.** `Data access` (2.2) is the one with security weight — it decides whether parameterisation is a reviewable convention or a property of a query builder. `Migrations + verify` and `Integration test harness` are 2.2's, `Auth mechanism` is 2.1's, `Scaffold new lib/module` is undecided.
- **Roadmap question — should 1.1's Trace include NFR-1.1?** The Done-when's "incompatible" case is defined only by NFR-1.1, which is traced by 0.2. The published document is where additive tolerance becomes externally visible, via the `additionalProperties` choice. Raised rather than edited in, because it changes what a verification phase checks against.
- **Task 0.4's record overstates what it delivered.** Three of the nine Blockers fixed in 1.1 were pre-existing defects in the 0.4 seam — a remote process-kill, silent corruption of `change_id`, and an unvalidated policy load — against a record that reads PASSED with one test. Not being rewritten, per the standing rule against retroactively amending finished records. Belongs in the Sprint 1 retrospective as a retrospective claim.

### Carried forward from Sprint 0

- **Sprint 2 is planned over solo capacity** at 21 SP against ~20. Task 2.3 is the named release valve; decide at the Oct 9 mid-point, not at sprint end.
