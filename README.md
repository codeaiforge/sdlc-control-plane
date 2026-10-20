# SDLC Control Plane

The SDLC Control Plane is a federation layer for engineering governance. It aggregates **evidence** from many governed workspaces and distributes reviewed **guardrails** back to them. It is deliberately not a portfolio-management, finance, or autonomous decision-making system.

## Scope

| Concern              | This control plane does                                                               | It does not do                                 |
| -------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Team / ART execution | Receives Nx graph, SDLC gate, provenance, and delivery signals                        | Replace the workspace CI/CD pipeline           |
| ART coordination     | Registers workspaces; cross-workspace indicators are not served in the MVP (ADR-0003) | Plan work or resolve dependencies for teams    |
| Large Solution       | Supplies traceable evidence to solution-intent/MBSE tools                             | Own solution intent or supplier management     |
| Portfolio            | Distributes approved guardrails; no indicator view in the MVP (ADR-0003)              | Make investment, staffing, or budget decisions |

The architecture and delivery sequence are in [docs/architecture/overview.md](docs/architecture/overview.md) and [docs/specs/implementation-roadmap.md](docs/specs/implementation-roadmap.md), and the trust boundaries, abuse cases and residual risks the ingress path is being designed against are in [docs/architecture/threat-model.md](docs/architecture/threat-model.md). Every deployable and library is an Nx project under `packages/`, defined by its `project.json`. The API is the sole initial deployable artifact; the other projects are internal libraries it composes.

## Quick start

Requires Node.js 20 or later.

```sh
corepack enable
pnpm install
git config core.hooksPath .githooks   # enables the commit-msg provenance check
pnpm test
pnpm nx graph
```

`pnpm test` needs no database. CI also runs `pnpm audit`, `pnpm format:check`, `pnpm test:controls`, `pnpm test:integration` (against PostgreSQL, below) and `pnpm build`; run them before pushing.

### Integration tests

The integration tests run against a real PostgreSQL 16 server, never a simulator, and fail rather than skip without one. Locally:

```sh
docker run --rm -d --name evidence-pg -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:5432:5432 postgres:16-alpine
PGHOST=127.0.0.1 PGUSER=postgres PGPASSWORD=postgres pnpm test:integration
docker stop evidence-pg
```

The `PG*` variables name a cluster administrator; the harness creates the service's roles and a fresh database per test. Use `127.0.0.1`, not `localhost`: any host that is not a literal loopback address requires verified TLS.

### Running the service

The service runs only on its durable store, PostgreSQL 16, and refuses to start without it. Once per cluster, as an administrator, create the roles and the database, then give each role a password out of band; then apply the schema as `evidence_owner` and serve as `evidence_app`:

```sh
PGHOST=... PGUSER=<admin> PGPASSWORD=... PGDATABASE=postgres pnpm nx run evidence-store:bootstrap --database sdlc_control_plane
#   then, as the administrator: ALTER ROLE evidence_owner PASSWORD '...'; (and evidence_app, evidence_retention, evidence_audit)
PGHOST=... PGUSER=evidence_owner PGPASSWORD=... PGDATABASE=sdlc_control_plane pnpm nx run evidence-store:migrate
PGHOST=... PGUSER=evidence_app PGPASSWORD=... PGDATABASE=sdlc_control_plane pnpm start:api
```

Connection settings are `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` and `PGSSLROOTCERT`, and nothing else. The service refuses to start, with one line naming the reason, on an unusable configuration, an unreachable server, a non-loopback host without verified TLS, a role that could rewrite evidence, or a schema that is not the one it bundles. What the roles may do, and what is left to whoever deploys it, is the `Access control` row of [docs/specs/stack.md](docs/specs/stack.md).

The HTTP surface — routes, statuses and bodies — is [packages/control-plane-api/openapi.json](packages/control-plane-api/openapi.json), and a contract test fails when it and the seam disagree.

The API is authenticated by GitHub Actions OIDC ([ADR-0003](docs/adr/0003-github-actions-oidc-workload-authorization.md)): every route but `GET /health` needs a workload token bound to a registered workspace, and each caller sees only its own workspace. Accepted evidence is stored durably in PostgreSQL and a replay is answered as a duplicate across restarts (task 2.2); the submission quota is still per process. Every hop that carries the token needs TLS, and so does the database connection unless it is on loopback. The shipped `config/control-plane/workspaces.json` registers one example workspace, suspended, so out of the box no token is authorized. Current status is in the latest `docs/specs/sprint-*-progress.md`.

## Repository authority

1. Nx project graph — deployable and library boundaries
2. `docs/` — architecture, decisions, contracts, implementation plan
3. `config/` — reviewed policy and sample registration data
4. `AGENTS.md` — contributor adapter; it cannot redefine the preceding sources

The workspace adapter and CI approach are informed by [ai-ready-nx-workspace](https://github.com/codeaiforge/ai-ready-nx-workspace). Evidence shape and tier-control semantics align to [git-native-sdlc-controls](https://github.com/codeaiforge/git-native-sdlc-controls), whose `evidence/0` contract remains experimental before v1.0.

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
