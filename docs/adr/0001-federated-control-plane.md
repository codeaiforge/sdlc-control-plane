# ADR-0001: Federate workspace governance instead of centralising delivery execution

## Status

Accepted — 2026-09-18

## Context

`ai-ready-nx-workspace` gives an individual engineering workspace an architecture-of-record and executable SDLC controls. SAFe Portfolio and Large Solution layers span many workspaces and include human strategy, investment, and solution decisions.

## Decision

Build the control plane as a federation layer. It accepts versioned technical evidence and workspace registrations, evaluates approved technical guardrails, and exposes descriptive indicators. A workspace remains responsible for its own Nx graph and CI gate. Portfolio and Large Solution decisions enter the system only as approved references and reviewed policy inputs.

## Consequences

The system can scale across repositories without misrepresenting CI as portfolio governance. It needs explicit adapters and a durable identity/data design before production deployment. It cannot claim autonomous compliance or business approval.
