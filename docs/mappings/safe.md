# Mapping to SAFe® (optional)

The control plane is framework-agnostic: its documents, configuration and code name the
organisational layers team, multi-team, programme and portfolio
([ADR-0006](../adr/0006-framework-neutral-layer-vocabulary.md)). This page is for
organisations that run SAFe. It shows how the control plane's outputs can feed SAFe-style
guardrails at each SAFe layer, and says plainly what is not built. Nothing here is needed to
use the control plane, and nothing in it changes how the control plane behaves.

| Control plane layer | SAFe layer     | What the control plane provides there today                                                                                                                                                                                                                                                                                      |
| ------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| team                | Team           | Evidence intake: `POST /v1/evidence` receives a workspace's SDLC gate evidence (`evidence/0`) and AI provenance, authenticated to the workspace that sent it, and stores an accepted record append-only. `GET /v1/indicators` gives descriptive indicators over that workspace's own accepted evidence.                          |
| multi-team          | ART            | The workspace registry: each workspace with its owners and value-stream reference. Cross-workspace indicators are **not** served in the MVP: each caller sees only its own workspace ([ADR-0003](../adr/0003-github-actions-oidc-workload-authorization.md)). No planning, dependency or flow data is held.                      |
| programme           | Large Solution | Traceability: every accepted record stays bound to its workspace, change and the policy it was evaluated under. No solution-intent, MBSE or supplier integration is built.                                                                                                                                                       |
| portfolio           | Portfolio      | Guardrail policy: one approved `guardrails/0` policy, refused at startup if its approval is incomplete, stamped on every decision. The control plane records and applies the policy; it makes no investment, budget or staffing decision, and no portfolio or ALM integration and no organisation-wide indicator view exist yet. |

The approver recorded on the guardrail policy (`approval.approved_by` in
`config/control-plane/guardrails.json`) can be the AI Value Architect role defined in
AI-Native SAFe.

---

SAFe and Scaled Agile Framework are registered trademarks of Scaled Agile, Inc. This project is
not affiliated with or endorsed by Scaled Agile, Inc.
