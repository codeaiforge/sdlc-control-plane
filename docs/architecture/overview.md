# Architecture overview

## Two-plane topology

```mermaid
flowchart TB
  subgraph Organizational[Human-owned SAFe decision plane]
    P[Portfolio / LPM\nstrategy, lean budgets, guardrails]
    S[Large Solution\nsolution intent, suppliers, compliance]
    A[ART coordination\nPI objectives, dependencies, flow]
    P --> S --> A
  end

  subgraph Core[SDLC Control Plane — federation and evidence]
    R[Workspace registry]
    I[Integration adapters\nportfolio • identity • forge • CI]
    E[Evidence intake & contract validation]
    G[Guardrail distribution]
    M[Indicators and traceability]
    R --> E --> M
    I --> R
    G --> I
  end

  subgraph Engineering[Replicated engineering control planes — one per workspace]
    N[Nx project graph\narchitecture of record]
    C[git-native SDLC controls\ntier, provenance, evidence/0]
    W[Team / ART delivery pipeline]
    N --> C --> W
  end

  Organizational -->|approved guardrails, Epic / capability references| Core
  Core -->|reviewed policy bindings| Engineering
  Engineering -->|graph, gate, provenance and delivery evidence| Core
  Core -->|indicators; never automated strategic decisions| Organizational
```

## Runtime boundaries

`contracts` owns validation and version recognition. `workspace-registry` owns the static identity and ownership metadata of a workspace. `guardrail-policy` evaluates a received record against an approved policy and returns a deterministic recommendation. `indicators` derives descriptive metrics only. `control-plane-api` composes them behind a small HTTP seam. All are Nx projects under `packages/` and own a `project.json`; the API is the sole initial deployable artifact, while the others are libraries.

No package has a direct dependency on an external portfolio, finance, or identity provider. Those integrations are ports represented by documented contracts until a specific customer system and credentials are selected.

## Non-goals

- Autonomous approval, prioritisation, budgeting, staffing, or release authority
- Replacing the workspace's Nx graph, CI, or SDLC gate
- Treating evidence as proof of business outcomes or regulatory compliance
