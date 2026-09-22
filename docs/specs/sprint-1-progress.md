# Sprint 1 Progress

**Sprint**: 1 — MVP service boundary
**Dates**: Sep 21 – Oct 2, 2026
**Last updated**: 2026-09-22 (task 1.1 — Done)

---

## Task Status

| #   | Task                                                    | Status      | Notes                                                                                                                                             |
| --- | ------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1 | Define OpenAPI and error-response contract              | Done        | `feat/1.1-openapi-error-contract` — `openapi.json` published and held to the seam by two-sided contract tests. 3 review cycles, 9 Blockers fixed. |
| 1.2 | Add append-only persistence port and idempotency design | Not started | Unblocked — Wave 1, depends only on 0.2. See the 202 constraint below before starting.                                                            |
| 1.3 | Threat-model evidence ingress and policy administration | Not started | Wave 2 — blocked on 1.1, which is now complete. Carries an NFR-6.1 trace, so it tiers up to Complex regardless of its 3 SP.                       |

## Additional Work Completed (not in roadmap)

| Item                                           | Commit    | Notes                                                                                                                                                                                                                                                                       |
| ---------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Three robustness defects fixed in the 0.4 seam | `1d22133` | An aborted POST killed the process; a multi-byte character split across chunk boundaries silently corrupted `change_id`; the guardrail policy was the one configuration loaded unvalidated. All surfaced by publishing a contract and testing it two-sidedly. Supports 1.1. |

## Summary

- **Done**: 1 / 3 tasks
- **In progress**: 0 / 3 tasks
- **Not started**: 2 / 3 tasks
- **Story points completed**: 3 / 9 SP

## Current Wave

**Wave 1** — 1.2 remains, running in parallel with the now-complete 1.1. Wave 2 (task 1.3) is unblocked by 1.1's published ingress contract and can start whenever capacity allows.

## Sprint 1 Definition of Done

- [x] An OpenAPI document describes all four routes and their error responses — `packages/control-plane-api/openapi.json`
- [x] Contract tests cover accepted, invalid and incompatible evidence — named tests in `openapi.contract.test.mjs`
- [ ] An ADR names the store, idempotency key, retention window and audit-event boundary (1.2)
- [ ] A threat model documents trust boundaries, abuse cases, mitigations and residual risks (1.3)

## Blockers / Decisions Needed

- **Proposed roadmap task — the AI provenance rule is fail-open.** `evaluateGuardrails` tests `ai_tool` for truthiness, so `ai_tool: 42` satisfies CAF-SDLC-010's provenance requirement. `.ai/standards/ai-provenance.md` is explicit that provenance recording only "an AI was involved" is worthless because it names no accountable tool — and a number names no tool. `validateEvidence` does not inspect the field either, so nothing in the chain refuses it. Needs a task requiring a non-empty string, with a test proving `ai_tool: 42` is refused. `packages/control-plane-api/openapi.json` documents this weakness on the `ai_tool` field and points here. Owner: whoever takes the guardrail-policy package.
- **1.2 must decide whether the 202 body survives durable intake.** Today `202` carries a terminal disposition and the record is in the store before the response is written. `EvidenceAcceptedResponse` is `additionalProperties: false`, so 1.2 cannot add a `submission_id` additively — it must edit `openapi.json` and bump `info.version`. That is deliberate. 1.2's ADR should state explicitly whether the decision stays in the 202 body or moves behind a retrieval route.
- **Roadmap question — should 1.1's Trace include NFR-1.1?** The Done-when's "incompatible" case is defined only by NFR-1.1, which is traced by 0.2. The published document is where additive tolerance becomes externally visible, via the `additionalProperties` choice. Raised rather than edited in, because it changes what a verification phase checks against.
- **Task 0.4's record overstates what it delivered.** Three of the nine Blockers fixed in 1.1 were pre-existing defects in the 0.4 seam — a remote process-kill, silent corruption of `change_id`, and an unvalidated policy load — against a record that reads PASSED with one test. Not being rewritten, per the standing rule against retroactively amending finished records. Belongs in the Sprint 1 retrospective as a retrospective claim.

### Carried forward from Sprint 0

- **Sprint 2 is planned over solo capacity** at 21 SP against ~20. Task 2.3 is the named release valve; decide at the Oct 9 mid-point, not at sprint end.
