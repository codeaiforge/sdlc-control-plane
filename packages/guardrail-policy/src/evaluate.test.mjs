import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { evaluateGuardrails } from './evaluate.mjs';

const policy = {
  policy_version: 'guardrails/0',
  policy_id: 'p@1',
  rules: { require_verified_controls: ['CAF-SDLC-002:tier'] },
};
const evidence = {
  schema_version: 'evidence/0',
  change_id: 'PR-1',
  binding_used: 'x',
  computed_at: '2026-09-18T00:00:00Z',
  tier: 'T0',
  affected_set: [],
  tool: { name: 'sdlc-controls', version: '0.2.0' },
  verification: { verified: ['CAF-SDLC-002:tier'] },
  result: { pass: true },
};
test('accepts evidence that meets an approved technical policy', () =>
  assert.equal(evaluateGuardrails(evidence, policy).accepted, true));
test('does not call an unmet technical rule a portfolio decision', () => {
  const result = evaluateGuardrails({ ...evidence, verification: { verified: [] } }, policy);
  assert.equal(result.disposition, 'needs-remediation');
});

// AC-13. The reason describes a missing claim, never a missing verification, because the list it
// is checked against is the submitter's own (ADR-0004).
test('a missing required control is reported as not claimed', () => {
  const result = evaluateGuardrails({ ...evidence, verification: { verified: [] } }, policy);
  assert.deepEqual(result.reasons, ['required control not claimed: CAF-SDLC-002:tier']);
});

// The next spelling of the same overstatement: every needs-remediation reason the evaluator can
// produce, each rule failing alone and all of them together, must say nothing about verification.
test('no needs-remediation reason speaks of verification', () => {
  const strict = {
    policy_version: 'guardrails/0',
    policy_id: 'p@1',
    rules: {
      minimum_evidence_schema: 'evidence/1',
      blocked_tiers: ['T0'],
      require_ai_provenance_when_assisted: true,
      require_verified_controls: ['CAF-SDLC-002:tier', 'CAF-SDLC-010:provenance'],
    },
  };
  const failing = { ...evidence, ai_assisted: true, verification: { verified: [] } };
  const probes = [
    [failing, strict],
    [failing, { ...policy, rules: { minimum_evidence_schema: 'evidence/1' } }],
    [failing, { ...policy, rules: { blocked_tiers: ['T0'] } }],
    [failing, { ...policy, rules: { require_ai_provenance_when_assisted: true } }],
    [failing, { ...policy, rules: { require_verified_controls: ['CAF-SDLC-002:tier'] } }],
  ];
  let seen = 0;
  for (const [record, rules] of probes) {
    const result = evaluateGuardrails(record, rules);
    assert.equal(result.disposition, 'needs-remediation');
    for (const reason of result.reasons) {
      seen += 1;
      assert.doesNotMatch(reason, /verif/i, reason);
    }
  }
  assert.ok(seen >= 9, 'the probe matrix stopped producing the reasons it exists to read');
});

test('the evaluator source carries no wording of verification in a reason', () => {
  const source = readFileSync(new URL('./evaluate.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /not verified/i);
  assert.doesNotMatch(source, /verified:/i);
  assert.doesNotMatch(source, /not\W+verif/i);
});
