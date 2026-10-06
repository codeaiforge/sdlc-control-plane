# SDLC Control Plane

The SDLC Control Plane is a federation layer for engineering governance. It aggregates **evidence** from many governed workspaces and distributes reviewed **guardrails** back to them. It is deliberately not a portfolio-management, finance, or autonomous decision-making system.

## Scope

| Concern              | This control plane does                                        | It does not do                                 |
| -------------------- | -------------------------------------------------------------- | ---------------------------------------------- |
| Team / ART execution | Receives Nx graph, SDLC gate, provenance, and delivery signals | Replace the workspace CI/CD pipeline           |
| ART coordination     | Registers workspaces and presents cross-workspace indicators   | Plan work or resolve dependencies for teams    |
| Large Solution       | Supplies traceable evidence to solution-intent/MBSE tools      | Own solution intent or supplier management     |
| Portfolio            | Exposes indicators and distributes approved guardrails         | Make investment, staffing, or budget decisions |

The architecture and delivery sequence are in [docs/architecture/overview.md](docs/architecture/overview.md) and [docs/specs/implementation-roadmap.md](docs/specs/implementation-roadmap.md), and the trust boundaries, abuse cases and residual risks the ingress path is being designed against are in [docs/architecture/threat-model.md](docs/architecture/threat-model.md). Every deployable and library is an Nx project under `packages/`, defined by its `project.json`. The API is the sole initial deployable artifact; the other projects are internal libraries it composes.

## Quick start

Requires Node.js 20 or later.

```sh
corepack enable
pnpm install
git config core.hooksPath .githooks   # enables the commit-msg provenance check
pnpm test
pnpm nx graph
pnpm start:api
```

CI also runs `pnpm format:check`, `pnpm test:controls` and `pnpm build`; run them before pushing.

The HTTP surface — routes, statuses and bodies — is [packages/control-plane-api/openapi.json](packages/control-plane-api/openapi.json), and a contract test fails when it and the seam disagree.

The API is intentionally in-memory and unauthenticated: anyone who can reach the port can submit evidence and read every registration and indicator (threat model ABU-1, ABU-4). Do not expose it beyond localhost. Identity and durable storage are decided in [docs/adr/](docs/adr/) and scheduled in Sprint 2; current status is in the latest `docs/specs/sprint-*-progress.md`.

## Repository authority

1. Nx project graph — deployable and library boundaries
2. `docs/` — architecture, decisions, contracts, implementation plan
3. `config/` — reviewed policy and sample registration data
4. `AGENTS.md` — contributor adapter; it cannot redefine the preceding sources

The workspace adapter and CI approach are informed by [ai-ready-nx-workspace](https://github.com/codeaiforge/ai-ready-nx-workspace). Evidence shape and tier-control semantics align to [git-native-sdlc-controls](https://github.com/codeaiforge/git-native-sdlc-controls), whose `evidence/0` contract remains experimental before v1.0.

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
