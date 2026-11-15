# Diagram index

The Mermaid diagrams of this repository. [README.md](README.md) is vendored and not edited here;
this index is the repository's own.

| Diagram                                          | What it shows                                                                                       | Explains                                                                  |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| [trust-boundaries.md](trust-boundaries.md)       | TB-1 to TB-9: each side, and what crosses                                                           | [threat model](../architecture/threat-model.md) › Trust boundaries        |
| [evidence-submission.md](evidence-submission.md) | one submission, from the workspace gate through the adapter's retries to the stored envelope        | [contracts](../contracts.md) › Producer: the evidence adapter             |
| [route-authorization.md](route-authorization.md) | how the seam admits a request: probe routes, ADR-0003's steps 1 to 6, every status and outcome code | [architecture overview](../architecture/overview.md), ADR-0003, ADR-0005  |
| [evidence-lifecycle.md](evidence-lifecycle.md)   | one envelope from append to tombstone, and where `retention-check` reports each violation           | [README](../../README.md) › Retention                                     |
| [components.md](components.md)                   | the Nx projects, their `scope:*` and `criticality:*` tags, and the project graph's edges            | [architecture overview](../architecture/overview.md) › Runtime boundaries |

Each diagram file has a title, what it shows and leaves out, one Mermaid block, a legend where
shapes or styles carry meaning, and a Sources list.

`tools/sdlc-controls/diagrams-conformance.test.mjs` (run by `pnpm test:controls`) fails when a
diagram names a threat-model ID, an ADR, a route, a code, an identifier or a file that no longer
exists (in a Sources list, a Mermaid label or backticks), when a response box names something
that is not a seam outcome, when this index misses a diagram, or when `components.md` stops
matching the project graph. It holds names, not arrows: whether a diagram still says what the
code does is a review question.
