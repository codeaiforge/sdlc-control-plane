# SDLC Control Plane — MVP Requirements

**Version:** 0.1 — September 2026  
**Method:** EARS  
**Scope:** Federated engineering governance MVP; not portfolio-management automation

## 1. Workspace federation

### FR-1.1: Register a governed workspace `[Ubiquitous]`

The system shall record a workspace ID, repository reference, value stream, owners, evidence endpoint, and lifecycle status.

**Acceptance criteria**

- [ ] A registration without an owner, repository reference, or evidence endpoint is rejected.
- [ ] Duplicate workspace IDs are rejected.
- [ ] Registered workspaces can be listed deterministically.

### FR-1.2: Preserve ownership context `[Ubiquitous]`

The system shall retain the declared workspace owners and value-stream reference with the registration.

**Acceptance criteria**

- [ ] The registry returns owners and value stream with each workspace.
- [ ] The system does not infer people, teams, or authority from a repository name.

## 2. Evidence intake

### FR-2.1: Accept compatible SDLC evidence `[Event-driven]`

When a governed workspace submits an `evidence/0` record, the system shall validate the required evidence fields before evaluating policy.

**Acceptance criteria**

- [ ] The record requires a schema version, change ID, tier, affected set, tool identity, verification data, result, and timestamp.
- [ ] An unsupported schema version is rejected rather than coerced.
- [ ] A valid record receives a policy disposition.

### FR-2.2: Reject malformed evidence `[Unwanted behavior]`

If an evidence record is malformed or incompatible, the system shall reject it with actionable validation reasons and shall not count it in indicators.

**Acceptance criteria**

- [ ] Invalid tier values are rejected.
- [ ] A missing required verified-control list is rejected.
- [ ] Rejected evidence does not change the indicator summary.

## 3. Technical guardrails

### FR-3.1: Evaluate approved engineering policy `[Event-driven]`

When valid evidence is received, the system shall evaluate it against a versioned guardrail policy containing an approval reference.

**Acceptance criteria**

- [ ] A policy identifies its version, ID, effective date, and approving decision reference.
- [ ] A record missing a required verified control receives `needs-remediation`.
- [ ] AI-assisted evidence without required provenance receives `needs-remediation`.

### FR-3.2: Keep strategic decisions human-owned `[Ubiquitous]`

The system shall not autonomously approve investment, staffing, budget, prioritisation, or release authority.

**Acceptance criteria**

- [ ] Policy output is a technical disposition, not a portfolio decision.
- [ ] Approved-policy metadata links to a human or governance-body decision.

## 4. Descriptive indicators

### FR-4.1: Summarise submitted evidence `[Event-driven]`

When accepted evidence is available, the system shall provide a descriptive count by SDLC tier and passing result.

**Acceptance criteria**

- [ ] The summary reports total and passing records.
- [ ] The summary reports T0–T3 counts.
- [ ] The response labels itself as an engineering indicator, not a compliance conclusion.

## 5. Non-functional requirements

### NFR-1.1: Contract compatibility `[Ubiquitous]`

The system shall reject an unknown major contract version and tolerate unrecognised additive fields on a supported version.

### NFR-2.1: Authentication and authorization `[Ubiquitous]`

Before a production endpoint accepts evidence, the system shall authenticate the calling workload and authorize it for the registered workspace.

### NFR-3.1: Durable, idempotent evidence intake `[Ubiquitous]`

Before production use, the system shall store accepted evidence durably and shall make retrying the same submission idempotent.

### NFR-6.1: Human oversight and auditability `[Ubiquitous]`

The system shall retain the approving decision reference and an audit trail for policy changes; it shall not represent automated technical checks as human approval or regulatory certification.
