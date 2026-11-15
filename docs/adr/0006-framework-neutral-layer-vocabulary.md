# ADR-0006: Name the organisational layers team, multi-team, programme and portfolio, and keep framework terms in optional mapping docs

- **Status**: Proposed
- **Date**: 2026-11-15
- **Deciders**: Proposed by the Architect role. Approval pending: no human has approved it yet; this record states a proposal, not an approval.
- **Trace**: Infra

## Context

[ADR-0001](0001-federated-control-plane.md) decided that the control plane federates workspace
governance instead of centralising delivery execution. It stated that decision in the
vocabulary of one scaling framework, SAFe: "SAFe Portfolio and Large Solution layers". The
README's Scope table, the contributor guide, the architecture overview and the sample workspace
registration followed it with "Team / ART", "ART coordination", "Large Solution" and "PI
objectives".

The organisations the control plane is meant to serve are not only SAFe shops. Many adopt
evidence-based change governance because of DORA (EU 2022/2554) ICT change-management
obligations, an ISO/IEC 42001 AI management system, or the EU AI Act's record-keeping and
human-oversight duties, and organise their delivery with another framework or none. For them a
product whose own documentation speaks in SAFe layers reads as a tool for somebody else.

Framework terms in the product's identity also carry a second cost. SAFe and Scaled Agile
Framework are registered trademarks of Scaled Agile, Inc., and a product described in their
terms risks implying an affiliation or endorsement that does not exist.

The control plane's behaviour does not depend on any of those terms. Nothing in `packages/`
reads a layer name; the registry records a workspace, its owners and its value-stream
reference, and the guardrail policy is applied the same way whatever the organisation calls its
layers. The question is only which words the product's own documents, configuration and code
use.

## Decision

We will name the organisational layers in the product's documentation, configuration and code
with framework-neutral terms: **team**, **multi-team**, **programme** and **portfolio**. A
time-boxed planning cadence is a **planning period** (a **quarter** where it is plainly a
period of time), and the role that coordinates delivery across teams is a **delivery lead**.

Framework-specific terms appear only in optional mapping documents under `docs/mappings/`, one
per framework (`docs/mappings/<framework>.md`), which show how the control plane's outputs can
feed that framework's practices. A mapping document uses a framework's trademarks nominatively,
to name the framework, and carries the owner's trademark notice.

## Options Considered

- **Option A — keep SAFe vocabulary throughout**: no edits, and precise for SAFe adopters. It
  narrows the market to one framework's users, makes every non-SAFe reader translate, and keeps
  the endorsement risk in the product's identity.
- **Option B — neutral vocabulary, framework terms in optional mapping docs (chosen)**: the
  product reads the same to every organisation, and a SAFe adopter still gets a precise
  translation in one place. The cost is one mapping document per framework, which must be kept
  true to what the control plane actually provides.
- **Option C — neutral vocabulary, no mappings**: the least to maintain, but leaves each SAFe,
  LeSS or other framework adopter to work out the correspondence alone, which is where a
  governance tool is most often misread.
- **Option D — a configurable layer glossary in the registry**: lets each organisation name its
  own layers. Nothing in the code reads a layer name today, so it adds a configuration surface
  and a contract change to solve a wording problem.

## Consequences

- ADR-0001's terminology is superseded by this record; its architecture decision — federate
  workspace governance, keep delivery execution in the workspace — stands unchanged. ADR-0001
  carries one line pointing here and is otherwise not edited.
- New framework mappings go in `docs/mappings/<framework>.md`. The first is
  `docs/mappings/safe.md`. A mapping states what the control plane
  provides at each layer as it is built, including what it does not provide yet.
- Accepted ADRs keep the words they were approved with. ADR-0002's retention basis ("one SAFe
  Program Increment … plus margin") is a reason recorded at the time, not product vocabulary,
  and is left as written.
- "Value stream" is not renamed by this record. FR-1.2 and the registry's `value_stream` field
  use it as a neutral reference to a business area, and renaming a contract field is a separate
  decision.
- The sample registry keeps the workspace id `payments-art`; only its display name changes. The
  id is an identifier that tests and demo setups reference, not vocabulary.
- Reviewers have one more thing to check: a framework term outside `docs/mappings/` and accepted
  ADRs is a defect against this record.
