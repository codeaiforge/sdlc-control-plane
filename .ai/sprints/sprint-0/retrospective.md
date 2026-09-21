## Sprint 0 Retrospective — 2026-09-21

> **Provenance** — tasks 0.1–0.4 were executed before the framework was imported, so the
> pipeline never ran and no task logged interventions as it worked. Task records were
> reconstructed on 2026-09-21 from the tree and git history. Metrics the pipeline would
> have captured are marked N/A rather than estimated; everything else was re-verified by
> running the gates.

### Velocity

- Planned: 13 SP across 4 waves (assigned retrospectively — no plan existed at execution time)
- Completed: 13 SP
- Ratio: 100%
- Carry-over: none

Sprint 0's 13 SP landed across a single day of AI-assisted commits. It is not a velocity
baseline for a solo developer — it measures a burst. Sprint 1 is the first sprint executed
through the pipeline and is where capacity gets calibrated.

### Sprint Metrics

| Metric                  | Value                                                       |
| ----------------------- | ----------------------------------------------------------- |
| Tasks completed         | 4 / 4                                                       |
| Tier distribution       | 1 Light, 2 Standard, 1 Complex (classified retrospectively) |
| Total files changed     | 30                                                          |
| Total lines changed     | +1648 / -0                                                  |
| Gate failure rate       | N/A — no gates ran at execution time                        |
| Avg review cycles       | N/A                                                         |
| Human intervention rate | N/A — not recorded                                          |
| Interventions per SP    | N/A                                                         |

### Per-Task Summary

| Task | SP  | Tier     | Gate Fails | Interventions | Files | Lines |
| ---- | --- | -------- | ---------- | ------------- | ----- | ----- |
| 0.1  | 5   | Complex  | N/A        | N/A           | 13    | +1353 |
| 0.2  | 2   | Light    | N/A        | N/A           | 3     | +65   |
| 0.3  | 3   | Standard | N/A        | N/A           | 9     | +127  |
| 0.4  | 3   | Standard | N/A        | N/A           | 5     | +103  |

### What Went Well

- The federation boundary is executable rather than described. Five Nx projects carry `scope:*` and `criticality:*` tags, and 0.1's component map reads them from the live graph instead of a checked-in list.
- 0.3 put the project's central non-goal under test. `does not call an unmet technical rule a portfolio decision` and `keeps evidence indicators descriptive` mean FR-3.2 is a property the code holds, not a sentence in the README.
- 0.4's `createRequestHandler` seam made every route testable without binding a port, which is what allowed the coverage gap to be closed later without restructuring anything.
- 0.2 chose zero dependencies at the contract boundary. The one place a library bump would become a governance event has no library.

### What to Improve

- Four tasks landed directly on `main` with no branch, no gate and no record. The work was sound, but nothing at the time could have shown that — the evidence had to be reconstructed a day later from diffs.
- Two `implicitDependencies` entries claimed imports that did not exist, and nothing noticed until an audit. The component map fed the tiering gate an inflated fan-in for `contracts` the whole time.
- `packages/control-plane-contracts/` sat in the tree as an empty directory — invisible to git, invisible to the graph, and invisible to every check that existed.
- 0.4 shipped with one test covering one of four routes, while its only trace (FR-2.2) ran through the three that were untested.
- Prettier was configured in Sprint 0 and never once run. All 22 source and markdown files failed `--check` when it was finally invoked.

### Risks for Sprint 1

- **1.2 may reopen the 0.2 contract.** If naming a concrete store and idempotency key forces an evidence-schema change, Sprint 2 must not start on top of the current contract. This is the sprint's real signal, not its task count.
- **1.1 and 1.3 are document deliverables** whose quality no test run verifies. The Done-when criteria are observable, but "threat model identifies abuse cases" passes or fails on judgment.
- **1.3 carries an NFR-6.1 trace**, which triggers a tier override to Complex regardless of its 3 SP — budget for eight phases, not six.
- **Sprint 2 is already planned over capacity** at 21 SP against ~20. The decision to defer 2.3 belongs at the Oct 9 mid-point, not at sprint end.

### Lessons Learned

- A rule nothing checks is a convention. Every Sprint 0 defect — false graph edges, the stray directory, unformatted files, the unwired ADR checker — was a documented intention with no executable check behind it. The fixes were all the same shape: add the check, prove it fails.
- Verify a derived signal end to end, not at its entry point. The component map genuinely read the graph; the graph was wrong. "Derived from X" is only as good as X.
- Reconstructed records must say they are reconstructed. Task files that read like pipeline output when no pipeline ran would be the same manufactured-after-the-fact declaration `ai-provenance.md` forbids for commit trailers.

### Human Intervention Summary

No interventions were logged during tasks 0.1–0.4 — the pipeline that records them did not
exist yet. Nothing should be read into the absence.

The corrections below occurred during the 2026-09-21 reconstruction and remediation, not
during task execution. They are recorded here because they motivate framework changes.

| Task | Phase          | Intervention                                                                      | Lesson                                                                                                |
| ---- | -------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| —    | Reconstruction | Agent proposed splitting a script-applied vendor import into ten thematic commits | Group commits by how the change was produced, not by theme. A script-applied drop is one commit.      |
| —    | Reconstruction | Agent asserted a vendor import needed no AI provenance trailers                   | The trailer describes the change, not the person committing. Provenance follows the content's origin. |
| —    | Reconstruction | Agent reported findings and stopped rather than fixing them                       | An audit that ends at a list leaves the defect in place. Fix, then prove the fix bites.               |

### Framework Improvements

- **`docs/specs/implementation-roadmap.md`**: reconciled with `roadmap-template.md` (v0.3). The roadmap shipped without the `SP` and `Layer` columns and without Execution Waves, which made `run-task.prompt.md` unable to read a row or classify a tier. Motivated by the Sprint 1 entry blocker.
- **`tools/sdlc-controls/graph-fidelity.test.mjs`** (added): fails when a declared Nx edge has no matching import or an import has no declared edge, and when a directory under `packages/` has no `project.json`. Motivated by the 0.1 finding and the stray-directory finding.
- **`package.json` + `.github/workflows/ci.yml`**: added `format` / `format:check` and a CI step, and wired `tools/adr/check-numbering.mjs` into `test:controls`. Motivated by two controls that existed but never ran.
- **`.prettierignore`** (added): excludes the vendored framework import so formatting does not destroy the baseline the next upstream sync diffs against. Motivated by the tension between repo-wide formatting and a clean vendor drop.
- **`.ai/sprints/README.md`** (proposed, not yet changed): the directory states that agents write these files as they work, but says nothing about work that predates the framework. A short note on reconstructing records — and on marking them as reconstructions — would have removed the judgment call made here. Motivated by the reconstruction of 0.1–0.4.
- **`.github/prompts/run-task.prompt.md`** (proposed, not yet changed): step 1 reads eight roadmap columns and step 2 depends on `SP`, but nothing checks that the roadmap provides them. A conformance check between the roadmap and its template would have caught this before it blocked a sprint, rather than at the moment a task was first executed.

### Trend Comparison

First sprint — no prior data for comparison.
