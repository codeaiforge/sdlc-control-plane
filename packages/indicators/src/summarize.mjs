// Every disposition and every indicator is labelled with what its inputs are: the submitting
// workload's own claims, bound to its verified run identity and not verified themselves
// (ADR-0004). The seam stamps the same constant on decisions, so it has one definition.
export const EVIDENCE_ATTESTATION = 'self-attested';

export function summarizeEvidence(records) {
  const byTier = { T0: 0, T1: 0, T2: 0, T3: 0 };
  let passed = 0;
  for (const record of records) {
    if (Object.hasOwn(byTier, record.tier)) byTier[record.tier] += 1;
    if (record.result?.pass === true) passed += 1;
  }
  return {
    total_records: records.length,
    passing_records: passed,
    by_tier: byTier,
    note: 'Descriptive engineering indicator only; not a portfolio decision or compliance conclusion.',
    evidence_attestation: EVIDENCE_ATTESTATION,
  };
}
