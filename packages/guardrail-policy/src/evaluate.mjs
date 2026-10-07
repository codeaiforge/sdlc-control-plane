import { EVIDENCE_SCHEMA_VERSION, TIERS, validateEvidence } from '../../contracts/src/schema.mjs';

export function evaluateGuardrails(evidence, policy) {
  const validation = validateEvidence(evidence);
  if (!validation.ok)
    return { accepted: false, disposition: 'rejected', reasons: validation.errors };
  if (policy?.policy_version !== 'guardrails/0') {
    return {
      accepted: false,
      disposition: 'rejected',
      reasons: ['unsupported guardrail policy version'],
    };
  }
  const rules = policy.rules ?? {};
  const reasons = [];
  if (rules.minimum_evidence_schema && rules.minimum_evidence_schema !== EVIDENCE_SCHEMA_VERSION) {
    reasons.push('policy requests an unsupported evidence schema');
  }
  if (!TIERS.has(evidence.tier)) reasons.push('invalid evidence tier');
  if (rules.blocked_tiers?.includes(evidence.tier))
    reasons.push(`tier ${evidence.tier} is blocked by policy`);
  if (rules.require_ai_provenance_when_assisted && evidence.ai_assisted && !evidence.ai_tool) {
    reasons.push('AI-assisted evidence is missing ai_tool provenance');
  }
  // "not claimed", because that is what is missing: the record's own list does not name the
  // control. The list is the submitter's word (ADR-0004), so a reason that spoke of verification
  // would describe a check the control plane never ran.
  for (const required of rules.require_verified_controls ?? []) {
    if (!evidence.verification.verified.includes(required))
      reasons.push(`required control not claimed: ${required}`);
  }
  return {
    accepted: reasons.length === 0,
    disposition: reasons.length === 0 ? 'accepted' : 'needs-remediation',
    policy_id: policy.policy_id,
    reasons,
  };
}
