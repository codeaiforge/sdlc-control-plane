# Authority and adapter standard

Use the repository authority order in `AGENTS.md`. Architecture is derived from the
machine-readable system model and `docs/`; `.ai/` supplies shared operating guidance.

Agent adapters are intentionally thin. They may configure a tool and link to shared
guidance, but they must not restate architectural decisions, boundaries, or governance
rules that belong in higher authority layers.
