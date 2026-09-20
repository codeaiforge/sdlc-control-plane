import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateGuardrails } from './evaluate.mjs';

const policy = { policy_version: 'guardrails/0', policy_id: 'p@1', rules: { require_verified_controls: ['CAF-SDLC-002:tier'] } };
const evidence = {
  schema_version: 'evidence/0', change_id: 'PR-1', binding_used: 'x', computed_at: '2026-09-18T00:00:00Z', tier: 'T0', affected_set: [],
  tool: { name: 'sdlc-controls', version: '0.2.0' }, verification: { verified: ['CAF-SDLC-002:tier'] }, result: { pass: true },
};
test('accepts evidence that meets an approved technical policy', () => assert.equal(evaluateGuardrails(evidence, policy).accepted, true));
test('does not call an unmet technical rule a portfolio decision', () => {
  const result = evaluateGuardrails({ ...evidence, verification: { verified: [] } }, policy);
  assert.equal(result.disposition, 'needs-remediation');
});
