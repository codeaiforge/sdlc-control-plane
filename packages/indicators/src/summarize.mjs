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
  };
}
