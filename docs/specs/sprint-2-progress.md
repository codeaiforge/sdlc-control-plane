# Sprint 2 Progress

**Sprint**: 2 — Production hardening
**Dates**: Oct 5 – Oct 16, 2026
**Last updated**: 2026-10-22 (task 2.4 — Done)

---

## Task Status

| #   | Task                                                               | Status      | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------ | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1 | Implement OIDC workload authentication and workspace authorization | Done        | `feat/2.1-oidc-workload-auth`, fast-forwarded to `main` and pushed without a PR — GitHub Actions OIDC verified over `node:crypto` in new `packages/workload-identity`, `workspace-registry/1` binding, own-workspace reads, 401/403/413/429/503, contract 0.2.0, refusal log; AC-20 measured (run 39384901065). 3 review cycles + 1 capped round; Phase ⑥ Pass after the axios override. Local tier gate: T3, approvers not supplied. Record: `.ai/sprints/sprint-2/tasks/2.1.md`                                                                                                                                                                                          |
| 2.2 | Implement durable evidence store and idempotent intake             | Done        | `feat/2.2-durable-evidence-store`, fast-forwarded to `main` and pushed without a PR — PostgreSQL 16 envelope log in new `packages/evidence-store` (postgres.js 3.4.9, four roles, `SECURITY DEFINER` redaction trigger, numbered-SQL migrations), replay idempotent across restarts and processes, 409/503, contract 0.3.0, SEC-6 closed; real-PostgreSQL integration tests in CI. Re-estimated 8 → 10 SP; AC-9 split to 2.5. 2 review cycles; Phase ⑥ Pass. Local tier gate: T3. Record: `.ai/sprints/sprint-2/tasks/2.2.md`                                                                                                                                              |
| 2.3 | Add telemetry, health, and retention verification                  | Not started | Blocked on 2.5 (and so on 2.2). Inherits I-3 (unthrottled refusal log, no peer address) from 2.1's security assessment                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 2.4 | Harden policy approval and AI provenance rules                     | Done        | `feat/2.4-policy-provenance-hardening`, fast-forwarded to `main` and pushed without a PR — `validateGuardrailPolicy` in `contracts` (closed `guardrails/0`, complete non-placeholder approval, typed rules, provenance rule held on); startup and `createRequestHandler` refuse an unusable policy; `ai_assisted` a required boolean, `ai_tool` a named tool when assisted; founder's decision POL-0001 (`884523a`, `baseline-engineering-controls@2`) resolved by `policy-conformance.test.mjs`; contract 0.4.0; MIT-11/12 in place. Re-estimated 3 → 5 SP. 2 review cycles + a Nit round; Phase ⑥ Pass. Local tier gate: T3. Record: `.ai/sprints/sprint-2/tasks/2.4.md` |
| 2.5 | Implement the 90-day retention expiry job                          | Not started | Split out of 2.2 at its Phase ① gate, 2026-10-20 (AC-9). Unblocked by 2.2, whose trigger it runs under; it must select `redacted_at IS NULL`, because the trigger refuses any update to a tombstone                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

## Additional Work Completed (not in roadmap)

| Item                                      | Commit    | Notes                                                                                            |
| ----------------------------------------- | --------- | ------------------------------------------------------------------------------------------------ |
| Ignore `.ai/sprints/*/work/` phase inputs | `0eff019` | Supports 2.1: briefs, specs and reviews survive a reboot, never committed                        |
| axios override, audit back to zero        | `445079d` | Supports 2.1's Phase ⑥ (SEC-1): 12 advisories via the `nx` devDependency                         |
| follow-redirects override, audit clean    | `edcfe4f` | Supports 2.2's Phase ⑤ (F-3): two high advisories via the `nx` devDependency, published mid-task |

## Summary

- **Done**: 3 / 5 tasks
- **In progress**: 0 / 5 tasks
- **Not started**: 2 / 5 tasks
- **Story points completed**: 23 / 31 SP

## Current Wave

**Wave 2** — 2.2 and 2.4 done; 2.5 (unblocked by 2.2) remains. 2.3 (Wave 3) waits on 2.5.

## Sprint 2 Definition of Done

- [x] An unauthenticated or unauthorized submission is refused — task 2.1; probes `ABU-1`, `AC-7-403` in its Phase ⑤ report
- [x] A replayed submission is idempotent and creates no duplicate record — task 2.2; `durable-service.integration.mjs`, `postgres-store.integration.mjs` (concurrent same-key appends leave one row)
- [x] Accepted evidence survives a process restart — task 2.2; the SIGKILL test in `durable-service.integration.mjs`
- [x] Policy changes are queryable from the git history of `config/control-plane/**`, the audit trail ADR-0002 decides (reworded at Gate 2, 2026-10-01: no API surface is built) — task 2.4 (Q-11); `git log -- config/control-plane/` lists `884523a`, the first real policy change (POL-0001, `@2`). Commits are signed; `CODEOWNERS` and branch protection remain absent (RR-1)
- [ ] Failed ingestion, delayed processing and retention violations are detectable by an operator

## Blockers / Decisions Needed

- **Sprint window**: the planned end date, Oct 16, has passed with 8 of 31 SP (2.3, 2.5) open. The roadmap's release valve is deferring 2.3 to Sprint 3; whether to extend Sprint 2, defer 2.3, or both is the founder's decision.
- **Task 2.1 — open findings by decision**: S-4, S-5, S-6 and six Nits (review); F-2 and the ABU-1/2/4/5 label updates (test); SEC-2, SEC-3, SEC-4, SEC-5 (security). Listed with owners in `.ai/sprints/sprint-2/tasks/2.1.md`. SEC-3 (Node 20 is end-of-life, and it is the verifier's only crypto library) has no owning task yet.
- **Task 2.2 — open by decision**: S-3 (`main.mjs` entry block untested), N-2 (review); Info I-1…I-6 (security); F-4 (id gaps, no action). Inputs to 2.5: the trigger checks a redaction's form, not the row's age (S-7), and 2.5 must select `redacted_at IS NULL`. Listed in `.ai/sprints/sprint-2/tasks/2.2.md`.
- **Task 2.4 — open by decision**: SEC-1 (the roadmap row's "real approval" is met by POL-0001 and the record test, not by the startup check; the row is not reworded); N-4 (ADR-0004:130 cites a moved `evaluate.mjs` line; ADRs not edited); N-5 (README still says guardrails are distributed) → README restructure; I-4 → 2.3 (`ai_tool` is unbounded below 1 MiB and stored as sent; any operator screen must escape it); I-7 = 2.1's SEC-3 (Node 20). Listed in `.ai/sprints/sprint-2/tasks/2.4.md`.
- **README restructure** (founder, 2026-10-20): align the README with the other CodeAIForge open-source repos (who it is for, how it works, honest ceiling, tests, maintainer), as additional work after 2.2, no SP. Not started.
- **Carried forward from Sprint 1 — proposed hardening task** (`docs/specs/sprint-1-progress.md`): no in-repo generator for `overview.html`, stale `tools/sdlc-controls/README.md`, the untested `criticality: 'critical'`, tag-pinned gate actions, and the component map missing `.ai/sprints/**`. 2.1's local gate run adds `.gitignore` to the unmatched paths. Still unowned and unscheduled.
- **Resolved — the AI provenance rule is fail-open** (Sprint 1's proposed task): scheduled as task 2.4 at 2.1's Phase ① gate (2026-10-07); delivered by task 2.4 (2026-10-22).
