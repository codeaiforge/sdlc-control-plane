# Sprint 0 Progress

**Sprint**: 0 — Architecture foundation
**Dates**: Sep 20 – Sep 21, 2026 (Sep 20 delivery; Sep 21 reconstruction, remediation and gate)
**Last updated**: 2026-09-21 (Gate 1 signed off — Go; sprint closed)

---

## Task Status

| #   | Task                                                                 | Status | Notes                                                                                                                                         |
| --- | -------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.1 | Establish Nx project boundaries and graph-derived SDLC component map | Done   | `main` — five Nx projects discoverable; component map derives roots and fan-in from the graph. Graph-fidelity finding remediated 2026-09-21.  |
| 0.2 | Define evidence, registration, and guardrail contracts               | Done   | `main` — `contracts` exports the three schema versions and two validators; unsupported `schema_version` is rejected, not coerced.             |
| 0.3 | Implement registry, policy evaluator, and descriptive indicators     | Done   | `main` — registry, guardrail evaluator and indicator summary; two tests carry the "no portfolio decision" criterion.                          |
| 0.4 | Compose the initial API seam                                         | Done   | `main` — four routes testable through `createRequestHandler` without binding. Route-coverage finding remediated 2026-09-21; seam tests 1 → 8. |

No task ran on a feature branch. All four landed directly on `main` across commits `33e1ea3`…`d617726`, before the framework's branch-per-task convention existed in the repository.

## Additional Work Completed (not in roadmap)

| Item                                                      | Commit      | Notes                                                                                                                                                                                                                           |
| --------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture, ADR-0001, contracts and specs documentation | `d617726`   | Supports the MVP architecture decision gate, which requires ADR-0001 to agree with the graph and contract boundaries.                                                                                                           |
| `ai-nx-ready-framework` governance layer imported         | `4430cfc`   | 71 files applied by the framework's install script. Introduces the pipeline, roles, standards and provenance control this file is written under.                                                                                |
| Sprint 0 task records reconstructed                       | uncommitted | `.ai/sprints/sprint-0/tasks/0.1–0.4.md` — the pipeline did not run at the time, so these are reconstructions from the tree and git history.                                                                                     |
| Roadmap reconciled with the framework template            | uncommitted | Adds the `SP` and `Layer` columns, per-sprint Execution Waves, Goal, risk checkpoint and Definition of Done, plus the Story Point Reference, Velocity Summary, Risk Register and Dependency Map. Unblocks `run-task.prompt.md`. |
| Graph-fidelity and ADR-numbering checks wired into CI     | uncommitted | `tools/sdlc-controls/graph-fidelity.test.mjs` added; `tools/adr/check-numbering.mjs` wired into `test:controls`. Supports 0.1.                                                                                                  |

## Summary

- **Done**: 4 / 4 tasks
- **In progress**: 0 / 4 tasks
- **Not started**: 0 / 4 tasks
- **Story points completed**: 13 / 13 SP

## Current Wave

**Sprint 1, Wave 1** — tasks 1.1 and 1.2, unblocked by the completion of 0.2 and 0.4 and cleared to start by the Gate 1 sign-off below. They run in parallel; 1.3 waits on 1.1. Sprint 1 runs Sep 21 – Oct 2, 2026.

## Sprint 0 Definition of Done

Copied from the roadmap's Sprint 0 entry.

- [x] `pnpm exec nx graph` lists five projects with `scope:*` and `criticality:*` tags (verified 2026-09-21)
- [x] `nx run-many -t test` is green across all five projects (verified 2026-09-21 — 15 tests)
- [x] `generate-component-map.mjs` emits component paths and fan-in taken from the graph (verified 2026-09-21)
- [x] Project graph, contract boundaries and ADR-0001 agree
- [x] MVP architecture decision gate signed off by a human before Sprint 1 begins — **Go**, dsofianos (founder), 2026-09-21

## Blockers / Decisions Needed

- **Provenance record**: commit `4430cfc` carries `AI-Assisted: true` / `AI-Tool: claude-code` trailers while its body states "No AI provenance trailers". The trailers are correct and the body line is stale. The commit is already on `origin/main`, and `.ai/standards/ai-provenance.md` forbids rewriting history to adjust provenance — left in place, corrected here.
- **Sprint 1 estimates**: 1.1, 1.2 and 1.3 carry forward estimates at 3 SP each. Solo capacity is now planned at ~20 SP per 2-week sprint, but Sprint 0's 13 SP is a single-day burst, not a velocity baseline — recalibrate at Sprint 1 close, the first sprint actually executed through the pipeline.
- **Sprint 2 is planned over capacity**: 21 SP against ~20. Task 2.3 is a Should and is the planned release valve, deferring to Sprint 3 (18 SP). Decide at the Sprint 2 mid-point, Oct 9, 2026 — not at sprint end.

### Resolved

- ~~**Gate 1 — MVP architecture**~~: signed off **Go** by dsofianos (founder) on 2026-09-21. All four signals in the gate table read Go: five projects discoverable with criticality tags, validators rejecting an unknown schema version, `nx run-many -t test` green, and the component map deriving paths and fan-in from the live graph. Sprint 1 is cleared to start.
- ~~**Sprint 1 entry — roadmap non-conformance**~~: the roadmap was missing the `SP` and `Layer` columns, every Execution Waves table, the Story Point Reference and the per-sprint Goal / Definition of Done sections, so `run-task.prompt.md` could not read a row or classify a tier. Reconciled with `docs/specs/roadmap-template.md` on 2026-09-21 (roadmap v0.3). All four sprints now carry the eight required columns and their waves.
- ~~**0.1 — graph fidelity**~~: `indicators -> contracts` and `control-plane-api -> contracts` were declared in `project.json` with no matching import, inflating `contracts` fan-in from 2 to 4 and flipping it over the `shared` threshold. Both edges removed and `tools/sdlc-controls/graph-fidelity.test.mjs` added, which fails CI on a declared edge with no import or an import with no declared edge.
- ~~**Stray package directory**~~: `packages/control-plane-contracts/` existed as an empty directory pair, invisible to git and to the Nx graph. Removed; the fidelity check now also fails if any directory under `packages/` has no `project.json`.
- ~~**0.4 — route coverage**~~: `/v1/workspaces`, `/v1/indicators` and `POST /v1/evidence` had no test. All four routes and every status branch are now covered, including the assertion that rejected evidence never reaches the indicator summary (FR-2.2). Seam tests 1 → 8.
- ~~**Tooling — `check-numbering.mjs` unwired**~~: wired into `test:controls`, so it runs locally and in the `CI` workflow.
