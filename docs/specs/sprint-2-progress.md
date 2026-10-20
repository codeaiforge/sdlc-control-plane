# Sprint 2 Progress

**Sprint**: 2 — Production hardening
**Dates**: Oct 5 – Oct 16, 2026
**Last updated**: 2026-10-20 (task 2.1 — Done)

---

## Task Status

| #   | Task                                                               | Status      | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------ | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1 | Implement OIDC workload authentication and workspace authorization | Done        | `feat/2.1-oidc-workload-auth`, fast-forwarded to `main` and pushed without a PR — GitHub Actions OIDC verified over `node:crypto` in new `packages/workload-identity`, `workspace-registry/1` binding, own-workspace reads, 401/403/413/429/503, contract 0.2.0, refusal log; AC-20 measured (run 39384901065). 3 review cycles + 1 capped round; Phase ⑥ Pass after the axios override. Local tier gate: T3, approvers not supplied. Record: `.ai/sprints/sprint-2/tasks/2.1.md` |
| 2.2 | Implement durable evidence store and idempotent intake             | Not started | Unblocked by 2.1. Inherits SEC-6 (a rejecting store exits the process) and the integration-harness choice (`stack.md`)                                                                                                                                                                                                                                                                                                                                                            |
| 2.3 | Add telemetry, health, and retention verification                  | Not started | Blocked on 2.5 (and so on 2.2). Inherits I-3 (unthrottled refusal log, no peer address) from 2.1's security assessment                                                                                                                                                                                                                                                                                                                                                            |
| 2.4 | Harden policy approval and AI provenance rules                     | Not started | Unblocked by 2.1. Needs the founder's real approval record to replace `LPM-EXAMPLE-001` (2.1's Q-4)                                                                                                                                                                                                                                                                                                                                                                               |
| 2.5 | Implement the 90-day retention expiry job                          | Not started | Split out of 2.2 at its Phase ① gate, 2026-10-20 (AC-9). Blocked on 2.2, whose trigger it runs under; it must select `redacted_at IS NULL`, because the trigger refuses any update to a tombstone                                                                                                                                                                                                                                                                                 |

## Additional Work Completed (not in roadmap)

| Item                                      | Commit    | Notes                                                                     |
| ----------------------------------------- | --------- | ------------------------------------------------------------------------- |
| Ignore `.ai/sprints/*/work/` phase inputs | `0eff019` | Supports 2.1: briefs, specs and reviews survive a reboot, never committed |
| axios override, audit back to zero        | `445079d` | Supports 2.1's Phase ⑥ (SEC-1): 12 advisories via the `nx` devDependency  |

## Summary

- **Done**: 1 / 5 tasks
- **In progress**: 0 / 5 tasks
- **Not started**: 4 / 5 tasks
- **Story points completed**: 8 / 29 SP

## Current Wave

**Wave 2** — 2.2 and 2.4, both unblocked by 2.1, then 2.5 after 2.2. 2.2 and 2.4 both edit `main.mjs`, so they run one after the other; 2.3 (Wave 3) waits on 2.5.

## Sprint 2 Definition of Done

- [x] An unauthenticated or unauthorized submission is refused — task 2.1; probes `ABU-1`, `AC-7-403` in its Phase ⑤ report
- [ ] A replayed submission is idempotent and creates no duplicate record
- [ ] Accepted evidence survives a process restart
- [ ] Policy changes are queryable from the git history of `config/control-plane/**`, the audit trail ADR-0002 decides (reworded at Gate 2, 2026-10-01: no API surface is built)
- [ ] Failed ingestion, delayed processing and retention violations are detectable by an operator

## Blockers / Decisions Needed

- **Sprint window**: the planned end date, Oct 16, has passed with 21 SP (2.2, 2.3, 2.4, 2.5) open. The roadmap's release valve is deferring 2.3 to Sprint 3; whether to extend Sprint 2, defer 2.3, or both is the founder's decision.
- **Task 2.1 — open findings by decision**: S-4, S-5, S-6 and six Nits (review); F-2 and the ABU-1/2/4/5 label updates (test); SEC-2, SEC-3, SEC-4, SEC-5 (security). Listed with owners in `.ai/sprints/sprint-2/tasks/2.1.md`. SEC-3 (Node 20 is end-of-life, and it is the verifier's only crypto library) has no owning task yet.
- **Carried forward from Sprint 1 — proposed hardening task** (`docs/specs/sprint-1-progress.md`): no in-repo generator for `overview.html`, stale `tools/sdlc-controls/README.md`, the untested `criticality: 'critical'`, tag-pinned gate actions, and the component map missing `.ai/sprints/**`. 2.1's local gate run adds `.gitignore` to the unmatched paths. Still unowned and unscheduled.
- **Resolved — the AI provenance rule is fail-open** (Sprint 1's proposed task): scheduled as task 2.4 at 2.1's Phase ① gate (2026-10-07).
