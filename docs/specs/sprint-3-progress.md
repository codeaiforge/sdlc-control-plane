# Sprint 3 Progress

**Sprint**: 3 — Federation integrations
**Dates**: Oct 19 – Dec 13, 2026 (extended from Oct 30 by the founder, 2026-11-15)
**Last updated**: 2026-11-15 (task 2.3 — Done)

---

## Task Status

| #   | Task                                                                    | Status      | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ----------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 3.1 | Build the `ai-ready-nx-workspace` evidence adapter                      | Done        | `feat/3.1-nx-workspace-evidence-adapter`, fast-forwarded to `main` without a PR — new leaf `packages/evidence-adapter` (mints per attempt for the fixed audience, sends the gate's bytes unchanged, bounded retries, token never printed, endpoint a reviewed constant, `null` until a deployment) and reusable workflow `submit-evidence.yml` (one `id-token` job, own source at `job.workflow_sha`, SHA-pinned actions, shape held exactly by a conformance test); E2E with the real `sdlc-controls` v0.2.0 over a fixture on PostgreSQL 16. 2 review cycles + a Nit round; Phase ⑥ Pass. Local tier gate: T3. Record: `.ai/sprints/sprint-3/tasks/3.1.md` |
| 3.2 | Integrate one named portfolio/ALM system                                | Not started | Gate 3: owner named 2026-11-15, the founder, for codeaiforge's demo Jira; the mapping and data classification are approved at its Phase ① and ② gates, or it drops. Needs a read-only Jira API token and the site URL.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 3.3 | Measure fork and Dependabot tokens and register `ai-ready-nx-workspace` | Not started | Split out of 3.1 at its Phase ① gate, 2026-11-14. Needs `evidence-adapter/v0.1.0` tagged on the GitHub mirror, a second GitHub account and Dependabot on the repository.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 2.3 | Add telemetry, health, and retention verification                       | Done        | `feat/2.3-telemetry-health-retention`, fast-forwarded to `main` without a PR — every response counted and lined (`telemetry` snapshot every 60 s and at shutdown, per process), unauthenticated `GET /ready` (single-flight, cached 2 s, ADR-0005), a `startup` line naming the policy in force, and `evidence-store:retention-check` (overdue payloads, bypassed or early redactions, guard pinned as the migrations make it; exit 0/1/2/3). 3 review cycles; Phase ⑥ Pass. Local tier gate: T3. Record: `.ai/sprints/sprint-3/tasks/2.3.md`                                                                                                                |

## Additional Work Completed (not in roadmap)

| Item | Commit | Notes |
| ---- | ------ | ----- |
| None | —      | —     |

## Summary

- **Done**: 2 / 4 tasks
- **In progress**: 0 / 4 tasks
- **Not started**: 2 / 4 tasks
- **Story points completed**: 10 / 21 SP (3.1 5, 3.2 8, 3.3 3, 2.3 5)

## Current Wave

**Wave 2** — 2.3 done (2026-11-15). Next: 3.2, which needs the demo Jira's read-only API token and site URL; its mapping is approved at its Phase ①/② gates. Then 3.3, which also waits on a second GitHub account and Dependabot (`evidence-adapter/v0.1.0` is cut, pre-release).

## Sprint 3 Definition of Done

- [x] A fixture workspace publishes contract-valid evidence from its own gate
- [ ] External Epic/capability references reconcile against registered workspaces
- [ ] No automated portfolio authority is granted by the integration
- [ ] Fork, Dependabot and runner token claims measured on real runs, a blocked gate shown to submit, the workflow's actions moved to v7/v8, and `ai-ready-nx-workspace` registered (3.3, Should)

## Blockers / Decisions Needed

- **Sprint window**: the planned end, Oct 30, 2026 — also the MVP target — passed with 3.1 still open. The founder accepted the slip and moved both to Dec 13, 2026 (2026-11-15): 16 SP left in four weeks.
- **Task 3.2**: the owner is the founder, for a demo system: it proves the mechanism, not a customer's mapping, and the owner is also the approver (RR-1). A read-only Jira API token and the site URL are needed at its start.
- **Task 3.3**: the fork and Dependabot measurements need a second GitHub account and Dependabot enabled.
- **Deploy target** (`stack.md` › Deploy, Not selected): until one is chosen, `CONTROL_PLANE_ENDPOINT` stays `null` and every wired workspace's submit job exits 2.
- **ADR review before a real registration**: per-run change ids make indicators count gate runs, not changes (3.1's Q-4 B, RR-15).
- **Task 3.1 — open by decision**: N-1, N-2 (review); N-4 (commit `7d3ace3`'s bullet overclaims retries of 500); O-1, O-2, O-4 (test); L-2's untested fail-closed checkout; I-1 → 3.3, I-2, I-3 (security). Listed in `.ai/sprints/sprint-3/tasks/3.1.md`.
- **Task 2.3 — open by decision**: O-1/F-4 (`expire` prints a raw SQLSTATE, 2.5, backlog); O-2; O-3 (`check-timeout` against a hung database unit-only, confirmed by hand); O-4/F-3; RR-16 at its Gate 3 review point; `stack.md` Observability collector, scraper and alerting Not selected, with ingress rate limiting and log rotation, decided with the deploy target. F-1 resolved: RR-12 wording accepted by the founder (`6021a92`). Listed in `.ai/sprints/sprint-3/tasks/2.3.md`.
- **Carried forward from Sprint 2**: 2.1's SEC-3 (Node 20 is end-of-life, and it is the verifier's only crypto library) has no owning task; the README restructure (founder, 2026-10-20) is not started.

## Task 3.1 — Done ✅

### What shipped (3.1)

- `packages/evidence-adapter` — the submit module and its 30 unit tests
- `.github/workflows/submit-evidence.yml` — the reusable workflow a workspace calls after its gate, `@<tag>`
- `packages/control-plane-api/src/evidence-adapter.integration.mjs` — 6 E2E tests over the real seam and gate binary
- `tools/sdlc-controls/evidence-adapter-conformance.test.mjs` — the workflow's exact shape and the shared literals
- `ci.yml` installs Go and exactly `sdlc-controls@v0.2.0` for integration

### Notes (3.1)

- 3.3 was split out (Q-2 A); the goal's _real_ workspace is 3.3 plus a deployment.
- Four ADR-0003 wording deviations are recorded in `docs/contracts.md`; no ADR edited.

## Task 2.3 — Done ✅

### What shipped (2.3)

- `packages/control-plane-api/src/telemetry.mjs` — closed event lines and per-process counts for every response, the totality test beside it
- `packages/control-plane-api/src/readiness.mjs` — `GET /ready`, single-flight and cached, with the check beside the store in `postgres-store.mjs`
- `packages/evidence-store/src/retention-check.mjs` — `pnpm nx run evidence-store:retention-check`, as `evidence_audit`, read-only
- `docs/adr/0005-unauthenticated-readiness-probe.md` — the probe-route class, Accepted
- Threat model: MIT-18 in place, ABU-18/MIT-22, RR-12 successor, RR-16; `stack.md` Observability row; openapi 0.5.0

### Notes (2.3)

- Detection is per process, on stderr, with no collector: counts reset on restart and nothing alerts until a deploy target is chosen (RR-12).
- `retention-check` finds by effect and states its ceiling every run; the deployment's scheduler runs it after `expire`.
- Two commit subjects (`7db32f5`, `3feb573`) over-claim; corrected in the record, not by rewriting signed history.
