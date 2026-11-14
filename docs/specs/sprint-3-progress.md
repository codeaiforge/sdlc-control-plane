# Sprint 3 Progress

**Sprint**: 3 — Federation integrations
**Dates**: Oct 19 – Oct 30, 2026
**Last updated**: 2026-11-14 (task 3.1 — Done)

---

## Task Status

| #   | Task                                                                    | Status      | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ----------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 3.1 | Build the `ai-ready-nx-workspace` evidence adapter                      | Done        | `feat/3.1-nx-workspace-evidence-adapter`, fast-forwarded to `main` without a PR — new leaf `packages/evidence-adapter` (mints per attempt for the fixed audience, sends the gate's bytes unchanged, bounded retries, token never printed, endpoint a reviewed constant, `null` until a deployment) and reusable workflow `submit-evidence.yml` (one `id-token` job, own source at `job.workflow_sha`, SHA-pinned actions, shape held exactly by a conformance test); E2E with the real `sdlc-controls` v0.2.0 over a fixture on PostgreSQL 16. 2 review cycles + a Nit round; Phase ⑥ Pass. Local tier gate: T3. Record: `.ai/sprints/sprint-3/tasks/3.1.md` |
| 3.2 | Integrate one named portfolio/ALM system                                | Not started | Gate 3: no integration owner named; drops if none is named (risk checkpoint).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 3.3 | Measure fork and Dependabot tokens and register `ai-ready-nx-workspace` | Not started | Split out of 3.1 at its Phase ① gate, 2026-11-14. Needs `evidence-adapter/v0.1.0` tagged on the GitHub mirror, a second GitHub account and Dependabot on the repository.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 2.3 | Add telemetry, health, and retention verification                       | Not started | Deferred from Sprint 2 by the founder, 2026-10-22; unblocked (2.5 done). Owns missed-run detection (2.5) and escaping `ai_tool` on any operator screen (2.4's I-4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## Additional Work Completed (not in roadmap)

| Item | Commit | Notes |
| ---- | ------ | ----- |
| None | —      | —     |

## Summary

- **Done**: 1 / 4 tasks
- **In progress**: 0 / 4 tasks
- **Not started**: 3 / 4 tasks
- **Story points completed**: 5 / 21 SP (3.1 5, 3.2 8, 3.3 3, 2.3 5)

## Current Wave

**Wave 2** — 3.3 is unblocked by 3.1 once the founder cuts `evidence-adapter/v0.1.0` on the GitHub mirror. Wave 1's 3.2 waits on Gate 3 (a named integration owner); 2.3, absorbed from Sprint 2, can run now.

## Sprint 3 Definition of Done

- [x] A fixture workspace publishes contract-valid evidence from its own gate
- [ ] External Epic/capability references reconcile against registered workspaces
- [ ] No automated portfolio authority is granted by the integration
- [ ] Fork, Dependabot and runner token claims measured on real runs, a blocked gate shown to submit, the workflow's actions moved to v7/v8, and `ai-ready-nx-workspace` registered (3.3, Should)

## Blockers / Decisions Needed

- **Sprint window**: the planned end, Oct 30, 2026 — also the MVP target — passed with 3.1 still open; it was done on 2026-11-14 (3.1's Q-9 A). No replan yet: the founder's call.
- **Task 3.2**: Gate 3 needs a named, accountable owner for the target system who approves the mapping and data classification; without one, 3.2 drops.
- **Task 3.3**: the first tag, `evidence-adapter/v0.1.0`, is the founder's to cut; the fork and Dependabot measurements need a second GitHub account and Dependabot enabled.
- **Deploy target** (`stack.md` › Deploy, Not selected): until one is chosen, `CONTROL_PLANE_ENDPOINT` stays `null` and every wired workspace's submit job exits 2.
- **ADR review before a real registration**: per-run change ids make indicators count gate runs, not changes (3.1's Q-4 B, RR-15).
- **Task 3.1 — open by decision**: N-1, N-2 (review); N-4 (commit `7d3ace3`'s bullet overclaims retries of 500); O-1, O-2, O-4 (test); L-2's untested fail-closed checkout; I-1 → 3.3, I-2, I-3 (security). Listed in `.ai/sprints/sprint-3/tasks/3.1.md`.
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
