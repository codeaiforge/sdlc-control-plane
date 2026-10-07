export const EVIDENCE_SCHEMA_VERSION = 'evidence/0';
export const REGISTRY_SCHEMA_VERSION = 'workspace-registry/1';
export const GUARDRAIL_SCHEMA_VERSION = 'guardrails/0';
export const TIERS = new Set(['T0', 'T1', 'T2', 'T3']);

// workspace-registry/1's vocabulary (ADR-0003 › Registration contract, Workload contexts). Frozen
// arrays rather than Sets, because Object.freeze does not freeze a Set's contents.
//
// The accepted issuer is also packages/workload-identity's ISSUER, which step 4 compares `iss`
// against. That package imports nothing, so the string is written twice; control-plane-api
// refuses to start unless this set is exactly [ISSUER], so a change to one copy alone fails at
// startup rather than drifting.
export const ACCEPTED_ISSUERS = Object.freeze(['https://token.actions.githubusercontent.com']);
// No registration can admit an event outside this set in the MVP: pull_request_target,
// workflow_run, issue_comment, merge_group, workflow_dispatch, schedule and Dependabot's
// `dynamic` are refused whatever a registration says.
export const ADMITTED_EVENT_ALLOWLIST = Object.freeze([
  'push',
  'pull_request',
  'pull_request_review',
]);
export const REGISTRATION_STATUSES = Object.freeze(['active', 'suspended']);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasString = (value, key) => typeof value?.[key] === 'string' && value[key].length > 0;

export function validateEvidence(value) {
  const errors = [];
  if (!isObject(value)) return { ok: false, errors: ['evidence must be an object'] };
  if (value.schema_version !== EVIDENCE_SCHEMA_VERSION)
    errors.push('unsupported evidence schema_version');
  for (const key of ['change_id', 'binding_used', 'computed_at']) {
    if (!hasString(value, key)) errors.push(`${key} must be a non-empty string`);
  }
  if (!TIERS.has(value.tier)) errors.push('tier must be one of T0, T1, T2, T3');
  if (!Array.isArray(value.affected_set)) errors.push('affected_set must be an array');
  if (
    !isObject(value.tool) ||
    !hasString(value.tool, 'name') ||
    !hasString(value.tool, 'version')
  ) {
    errors.push('tool.name and tool.version are required');
  }
  if (!isObject(value.verification) || !Array.isArray(value.verification.verified)) {
    errors.push('verification.verified must be an array');
  }
  if (!isObject(value.result) || typeof value.result.pass !== 'boolean') {
    errors.push('result.pass must be a boolean');
  }
  return { ok: errors.length === 0, errors };
}

// Canonical decimal, compared as a string and never parsed: a number loses precision above 2^53
// and reads "074" as 74.
const CANONICAL_ID = /^[1-9][0-9]{0,19}$/;
const JOB_WORKFLOW_REF =
  /^[^/\s]+\/[^/\s]+\/\.github\/workflows\/[^@/\s]+@refs\/(heads|tags)\/\S+$/;
const SHA1_HEX = /^[0-9a-f]{40}$/;
// Closed, unlike the rest of the registration: a misspelled pin field would otherwise load and
// pin nothing. This is an exception to NFR-1.1's additive tolerance for this one block, accepted
// at task 2.1's Phase ② gate (2026-10-07) and recorded in docs/contracts.md.
const WORKLOAD_IDENTITY_KEYS = [
  'issuer',
  'repository_owner_id',
  'repository_id',
  'admitted_events',
  'required_job_workflow_ref',
  'required_job_workflow_sha',
];

function validateWorkloadIdentity(value, errors) {
  if (!isObject(value)) {
    errors.push('workload_identity must be an object');
    return;
  }
  for (const key of Object.keys(value)) {
    if (!WORKLOAD_IDENTITY_KEYS.includes(key))
      errors.push(`workload_identity.${key} is not a recognised field`);
  }
  if (!ACCEPTED_ISSUERS.includes(value.issuer))
    errors.push('workload_identity.issuer must be an accepted issuer');
  for (const key of ['repository_owner_id', 'repository_id']) {
    if (typeof value[key] !== 'string' || !CANONICAL_ID.test(value[key]))
      errors.push(`workload_identity.${key} must be a canonical decimal string`);
  }
  const events = value.admitted_events;
  if (!Array.isArray(events) || events.length === 0)
    errors.push('workload_identity.admitted_events must be a non-empty array');
  else {
    if (new Set(events).size !== events.length)
      errors.push('workload_identity.admitted_events must not repeat an event');
    for (const event of events) {
      if (!ADMITTED_EVENT_ALLOWLIST.includes(event))
        errors.push(`workload_identity.admitted_events holds an event outside the allowlist`);
    }
  }
  const hasRef = Object.hasOwn(value, 'required_job_workflow_ref');
  if (
    hasRef &&
    !(
      typeof value.required_job_workflow_ref === 'string' &&
      JOB_WORKFLOW_REF.test(value.required_job_workflow_ref)
    )
  )
    errors.push('workload_identity.required_job_workflow_ref is not a reusable-workflow ref');
  if (Object.hasOwn(value, 'required_job_workflow_sha')) {
    if (!(
      typeof value.required_job_workflow_sha === 'string' &&
      SHA1_HEX.test(value.required_job_workflow_sha)
    ))
      errors.push('workload_identity.required_job_workflow_sha must be 40 lowercase hex digits');
    if (!hasRef)
      errors.push('workload_identity.required_job_workflow_sha requires required_job_workflow_ref');
  }
}

export function validateWorkspaceRegistration(value) {
  const errors = [];
  if (!isObject(value)) return { ok: false, errors: ['registration must be an object'] };
  for (const key of [
    'workspace_id',
    'display_name',
    'value_stream',
    'repository_url',
    'evidence_endpoint',
  ]) {
    if (!hasString(value, key)) errors.push(`${key} must be a non-empty string`);
  }
  if (!REGISTRATION_STATUSES.includes(value.status))
    errors.push('status must be one of active, suspended');
  if (!Array.isArray(value.owners) || value.owners.length === 0)
    errors.push('owners must be a non-empty array');
  validateWorkloadIdentity(value.workload_identity, errors);
  return { ok: errors.length === 0, errors };
}
