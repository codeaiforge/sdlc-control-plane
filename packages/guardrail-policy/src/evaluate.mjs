import {
  EVIDENCE_SCHEMA_VERSION,
  GUARDRAIL_SCHEMA_VERSION,
  TIERS,
  validateEvidence,
} from '../../contracts/src/schema.mjs';

// The policy's validator, re-exported so control-plane-api reaches it through this package and
// never imports contracts. evaluateGuardrails does not call it per request: the service checks
// the policy once, before it starts.
export {
  GUARDRAIL_APPROVAL_KEYS,
  GUARDRAIL_POLICY_KEYS,
  GUARDRAIL_RULE_KEYS,
  validateGuardrailPolicy,
} from '../../contracts/src/schema.mjs';

export function evaluateGuardrails(evidence, policy) {
  const validation = validateEvidence(evidence);
  if (!validation.ok)
    return { accepted: false, disposition: 'rejected', reasons: validation.errors };
  if (policy?.policy_version !== GUARDRAIL_SCHEMA_VERSION) {
    return {
      accepted: false,
      disposition: 'rejected',
      reasons: ['unsupported guardrail policy version'],
    };
  }
  // Every rule is read as rules.<key>: policy-conformance.test.mjs reads those names out of this
  // source and holds them equal to the keys the policy validator admits.
  const rules = policy.rules ?? {};
  const reasons = [];
  if (rules.minimum_evidence_schema && rules.minimum_evidence_schema !== EVIDENCE_SCHEMA_VERSION) {
    reasons.push('policy requests an unsupported evidence schema');
  }
  if (!TIERS.has(evidence.tier)) reasons.push('invalid evidence tier');
  // An array or nothing: a string would otherwise block every tier it contains as a substring.
  if (Array.isArray(rules.blocked_tiers) && rules.blocked_tiers.includes(evidence.tier))
    reasons.push(`tier ${evidence.tier} is blocked by policy`);
  // Fail-closed: applied unless a policy turns it off, and the policy validator refuses a policy
  // that does. The record has passed validateEvidence, so a present ai_tool names a tool.
  if (
    rules.require_ai_provenance_when_assisted !== false &&
    evidence.ai_assisted === true &&
    !Object.hasOwn(evidence, 'ai_tool')
  ) {
    reasons.push('AI-assisted evidence is missing ai_tool provenance');
  }
  // "not claimed", because that is what is missing: the record's own list does not name the
  // control. The list is the submitter's word (ADR-0004), so a reason that spoke of verification
  // would describe a check the control plane never ran.
  if (Array.isArray(rules.require_verified_controls)) {
    for (const required of rules.require_verified_controls) {
      if (!evidence.verification.verified.includes(required))
        reasons.push(`required control not claimed: ${required}`);
    }
  }
  return {
    accepted: reasons.length === 0,
    disposition: reasons.length === 0 ? 'accepted' : 'needs-remediation',
    policy_id: policy.policy_id,
    reasons,
  };
}
