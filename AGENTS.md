# SDLC Control Plane contributor guide

Read [docs/architecture/overview.md](docs/architecture/overview.md) and [docs/contracts.md](docs/contracts.md) before changing an integration boundary.

The HTTP surface itself is [packages/control-plane-api/openapi.json](packages/control-plane-api/openapi.json) — read it before changing a route, a status code or a response body, and change it in the same commit as the seam.

Authority order is: Nx project graph, `docs/`, `config/`, then this file. Agents and contributors consume that architecture; they do not duplicate it in agent-specific instructions.

- Use `pnpm nx` for project tasks.
- Keep Portfolio and Large Solution decisions human-owned. Code may record or route a decision, never autonomously make investment, budget, staffing, or release-authority decisions.
- Evidence is append-only at the boundary. Reject malformed or unsupported contract versions rather than silently coercing them.
- Changes to policy, contract validation, CI, or the component-map generator are critical control-surface changes.
- AI-assisted commits carry CAF-SDLC-010 provenance trailers. [`.ai/standards/ai-provenance.md`](.ai/standards/ai-provenance.md) is the convention and `.githooks/commit-msg` enforces it. This line names no tool on purpose: it said `Codex` long after the assistant changed to Claude, because it restated the convention instead of pointing at it — which is what the authority order three lines above forbids.
