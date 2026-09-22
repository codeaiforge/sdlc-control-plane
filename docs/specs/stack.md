# Stack Profile — SDLC Control Plane

## Identity

| Field                | Value                                                                                                                                                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language             | Node.js 20+ / native ESM JavaScript                                                                                                                                                                                                 |
| Framework            | Node `http` composition seam; production framework still unselected. Persistence adapter selected in Sprint 1: PostgreSQL 16+, per [ADR-0002](../adr/0002-append-only-evidence-envelope-log.md) — Proposed, pending Gate 2 approval |
| Nx plugin / executor | Explicit `project.json` command targets                                                                                                                                                                                             |
| Package manager      | pnpm 10.15.1                                                                                                                                                                                                                        |

## Commands

| Purpose                   | Command                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------- |
| Test                      | `pnpm nx run-many -t test`                                                                          |
| Build                     | `pnpm nx run-many -t build`                                                                         |
| Typecheck                 | `pnpm nx run-many -t typecheck`                                                                     |
| Graph-derived control map | `pnpm nx graph --file=graph.json && node tools/sdlc-controls/generate-component-map.mjs graph.json` |
| SDLC adapter test         | `pnpm test:controls`                                                                                |

## Conventions

| Concern            | Mechanism                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------- |
| Contracts          | Versioned, strict minimum-subset JavaScript validators in `packages/contracts`            |
| Project boundaries | Nx `project.json` per project, tags, and graph-derived component map                      |
| Evidence           | `evidence/0` compatibility with `git-native-sdlc-controls`                                |
| Policy             | Versioned configuration with an approving decision reference; technical dispositions only |
| Test harness       | Node built-in `node:test`                                                                 |

## Deploy

| Field       | Value                                                                        |
| ----------- | ---------------------------------------------------------------------------- |
| Artifact    | One `control-plane-api` service artifact composed from internal libraries    |
| Target      | Not selected; requires approved identity, persistence, and operations design |
| Verify gate | Authenticated integration and recovery tests before production deployment    |
