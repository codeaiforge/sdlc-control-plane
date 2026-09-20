# Specifications

This directory is the product-delivery source of truth: requirements, the roadmap, stack profile, and sprint records used by the SDLC workflow.

## Instances and templates

| Template | Instance | Purpose |
| --- | --- | --- |
| `requirements-template.md` | `mvp-requirements.md` | Stable EARS requirements and acceptance criteria |
| `roadmap-template.md` | `implementation-roadmap.md` | Ordered, traceable delivery work |
| `sprint-progress-template.md` | `sprint-{N}-progress.md` | One execution record per sprint |
| `stack-template.md` | `stack.md` | Active technology and verification profile |

The instance filenames are stable references. Do not rename requirement IDs after a roadmap task, ADR, or commit has traced them.

## Conventions

- Use `FR-<area>.<number>` for functional requirements and `NFR-<area>.<number>` for non-functional requirements.
- Write requirements in EARS form: “When… the system shall…”, “The system shall…”, or “If… the system shall…”.
- Use `<sprint>.<task>` task IDs; task IDs remain immutable once execution begins.
- `NFR-6.*` denotes compliance / human-oversight work and requires the Security and Compliance review paths when implemented.
- The roadmap records intent and sequencing; the Git-native SDLC gate computes change risk independently.
