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
// What a name or reference needs, in any script: "-", "." and a lone zero-width space are not
// blank to /\S/, and name nothing.
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

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
  // AI provenance (CAF-SDLC-010, MIT-11). ai_assisted is required so the provenance rule cannot be
  // skipped by leaving it out; a tool, when named, must be a string naming one, and only on an
  // assisted record, because naming a tool implies assistance. An assisted record with no tool is
  // not a contract failure: the policy decides it (needs-remediation), so FR-3.1 reads literally.
  if (typeof value.ai_assisted !== 'boolean') errors.push('ai_assisted must be true or false');
  if (Object.hasOwn(value, 'ai_tool')) {
    if (typeof value.ai_tool !== 'string' || !HAS_LETTER_OR_DIGIT.test(value.ai_tool))
      errors.push('ai_tool must be a string naming a tool');
    else if (value.ai_assisted === false) errors.push('ai_tool requires ai_assisted true');
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

// guardrails/0, closed at every level: a misspelt rule would otherwise load and enforce nothing.
// A second exception to NFR-1.1's additive tolerance, accepted at task 2.4's Phase ① gate
// (2026-10-22) and recorded in docs/contracts.md. tools/sdlc-controls/policy-conformance.test.mjs
// holds these lists, the shipped file, the rules evaluate.mjs reads and that page together.
export const GUARDRAIL_POLICY_KEYS = Object.freeze([
  'policy_version',
  'policy_id',
  'effective_from',
  'approval',
  'rules',
]);
export const GUARDRAIL_APPROVAL_KEYS = Object.freeze(['decision_id', 'approved_by', 'approved_at']);
export const GUARDRAIL_RULE_KEYS = Object.freeze([
  'minimum_evidence_schema',
  'blocked_tiers',
  'require_ai_provenance_when_assisted',
  'require_verified_controls',
]);

// A word an unfilled template or an example leaves behind, or a non-answer. Matched against whole
// alphanumeric runs, never substrings, so LPM-EXAMPLE-001 and TBD are refused and a surname that
// contains "todo" is not. Look-alike letters from another script escape it, as they escape
// adr-conformance.test.mjs's outstanding-words rule.
export const PLACEHOLDER_TOKEN =
  /^(examples?|samples?|placeholder|dummy|changeme|todo|tbd|tbc|tba|fixme|pending|awaiting|unknown|none|null|x{3,})\d*$/;
// n/a spans two alphanumeric runs, so it is matched whole here: not inside a longer run on either
// side, so "n/a" and "TEAM-N/A" are refused and "an/am" is not.
const NOT_APPLICABLE = /(?<![A-Za-z0-9])n\/a\d*(?![A-Za-z0-9])/i;

export function isPlaceholderText(value) {
  if (typeof value !== 'string') return false;
  if (/[<>]/.test(value) || NOT_APPLICABLE.test(value)) return true;
  return (value.match(/[A-Za-z0-9]+/g) ?? []).some((token) =>
    PLACEHOLDER_TOKEN.test(token.toLowerCase()),
  );
}

// The full form only, and a real calendar instant: Date rolls 2026-02-30 and T24:00:00 over to the
// next day rather than refusing them, so the round trip is what catches them. Two values that pass
// compare correctly as strings.
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
export function isUtcTimestamp(value) {
  if (typeof value !== 'string' || !UTC_TIMESTAMP.test(value)) return false;
  const instant = new Date(value);
  return !Number.isNaN(instant.getTime()) && instant.toISOString() === value.replace('Z', '.000Z');
}

// Non-blank, with no leading or trailing whitespace: a value compared as written, never trimmed.
const isText = (value) => typeof value === 'string' && /\S/.test(value) && value === value.trim();
const isName = (value) => isText(value) && HAS_LETTER_OR_DIGIT.test(value);
const TEXT = 'must be a string with a letter or digit and no leading or trailing whitespace';
const TIMESTAMP = 'must be a UTC timestamp YYYY-MM-DDTHH:MM:SSZ on a real calendar day';

function unrecognised(value, known, prefix, errors) {
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) errors.push(`${prefix}${key} is not a recognised field`);
  }
}

function validateApproval(approval, effectiveFrom, errors) {
  if (!isObject(approval)) {
    errors.push('approval must be an object');
    return;
  }
  unrecognised(approval, GUARDRAIL_APPROVAL_KEYS, 'approval.', errors);
  if (!isName(approval.decision_id)) errors.push(`approval.decision_id ${TEXT}`);
  else if (isPlaceholderText(approval.decision_id))
    errors.push('approval.decision_id is a placeholder, not a decision reference');
  if (!isName(approval.approved_by)) errors.push(`approval.approved_by ${TEXT}`);
  else if (isPlaceholderText(approval.approved_by))
    errors.push('approval.approved_by is a placeholder, not an approver');
  if (!isUtcTimestamp(approval.approved_at)) errors.push(`approval.approved_at ${TIMESTAMP}`);
  else if (isUtcTimestamp(effectiveFrom) && approval.approved_at > effectiveFrom)
    errors.push('approval.approved_at must not be after effective_from');
}

const distinct = (values) => new Set(values).size === values.length;

function validateRules(rules, errors) {
  if (!isObject(rules)) {
    errors.push('rules must be an object');
    return;
  }
  unrecognised(rules, GUARDRAIL_RULE_KEYS, 'rules.', errors);
  if (rules.minimum_evidence_schema !== EVIDENCE_SCHEMA_VERSION)
    errors.push(`rules.minimum_evidence_schema must be ${EVIDENCE_SCHEMA_VERSION}`);
  const tiers = rules.blocked_tiers;
  if (!Array.isArray(tiers) || !tiers.every((tier) => TIERS.has(tier)) || !distinct(tiers))
    errors.push('rules.blocked_tiers must be an array of distinct tiers from T0, T1, T2, T3');
  if (rules.require_ai_provenance_when_assisted !== true)
    errors.push('rules.require_ai_provenance_when_assisted must be true');
  const controls = rules.require_verified_controls;
  if (!Array.isArray(controls) || !controls.every(isText) || !distinct(controls))
    errors.push('rules.require_verified_controls must be an array of distinct non-blank strings');
}

// The form of an approved policy, checked before the service will start (MIT-12): one reason per
// failing field, naming the field and never its value. Whether the approval is real is not
// decidable here; the decision record test checks what the repository can show.
export function validateGuardrailPolicy(value) {
  if (!isObject(value)) return { ok: false, errors: ['policy must be an object'] };
  const errors = [];
  unrecognised(value, GUARDRAIL_POLICY_KEYS, '', errors);
  if (value.policy_version !== GUARDRAIL_SCHEMA_VERSION)
    errors.push(`policy_version must be ${GUARDRAIL_SCHEMA_VERSION}`);
  if (!isName(value.policy_id)) errors.push(`policy_id ${TEXT}`);
  if (!isUtcTimestamp(value.effective_from)) errors.push(`effective_from ${TIMESTAMP}`);
  validateApproval(value.approval, value.effective_from, errors);
  validateRules(value.rules, errors);
  return { ok: errors.length === 0, errors };
}
