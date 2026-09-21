# SDLC Control Plane

The SDLC Control Plane is a federation layer for engineering governance. It aggregates **evidence** from many governed workspaces and distributes reviewed **guardrails** back to them. It is deliberately not a portfolio-management, finance, or autonomous decision-making system.

## Scope

| Concern              | This control plane does                                        | It does not do                                 |
| -------------------- | -------------------------------------------------------------- | ---------------------------------------------- |
| Team / ART execution | Receives Nx graph, SDLC gate, provenance, and delivery signals | Replace the workspace CI/CD pipeline           |
| ART coordination     | Registers workspaces and presents cross-workspace indicators   | Plan work or resolve dependencies for teams    |
| Large Solution       | Supplies traceable evidence to solution-intent/MBSE tools      | Own solution intent or supplier management     |
| Portfolio            | Exposes indicators and distributes approved guardrails         | Make investment, staffing, or budget decisions |

The architecture and delivery sequence are in [docs/architecture/overview.md](docs/architecture/overview.md) and [docs/specs/implementation-roadmap.md](docs/specs/implementation-roadmap.md). Every deployable and library is an Nx project under `packages/`, defined by its `project.json`. The API is the sole initial deployable artifact; the other projects are internal libraries it composes.

## Quick start

```sh
corepack enable
pnpm install
pnpm test
pnpm nx graph
pnpm start:api
```

The sample API is intentionally in-memory and unauthenticated. It proves the boundary and contract flow only; production adapters are a planned deployment concern.

## Repository authority

1. Nx project graph — deployable and library boundaries
2. `docs/` — architecture, decisions, contracts, implementation plan
3. `config/` — reviewed policy and sample registration data
4. `AGENTS.md` — contributor adapter; it cannot redefine the preceding sources

The workspace adapter and CI approach are informed by [ai-ready-nx-workspace](https://github.com/codeaiforge/ai-ready-nx-workspace). Evidence shape and tier-control semantics align to [git-native-sdlc-controls](https://github.com/codeaiforge/git-native-sdlc-controls), whose `evidence/0` contract remains experimental before v1.0.
