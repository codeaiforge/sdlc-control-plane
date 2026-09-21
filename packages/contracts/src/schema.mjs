export const EVIDENCE_SCHEMA_VERSION = 'evidence/0';
export const REGISTRY_SCHEMA_VERSION = 'workspace-registry/0';
export const GUARDRAIL_SCHEMA_VERSION = 'guardrails/0';
export const TIERS = new Set(['T0', 'T1', 'T2', 'T3']);

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

export function validateWorkspaceRegistration(value) {
  const errors = [];
  if (!isObject(value)) return { ok: false, errors: ['registration must be an object'] };
  for (const key of [
    'workspace_id',
    'display_name',
    'value_stream',
    'repository_url',
    'evidence_endpoint',
    'status',
  ]) {
    if (!hasString(value, key)) errors.push(`${key} must be a non-empty string`);
  }
  if (!Array.isArray(value.owners) || value.owners.length === 0)
    errors.push('owners must be a non-empty array');
  return { ok: errors.length === 0, errors };
}
