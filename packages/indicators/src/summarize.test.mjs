import assert from 'node:assert/strict';
import test from 'node:test';
import { EVIDENCE_ATTESTATION, summarizeEvidence } from './summarize.mjs';
test('keeps evidence indicators descriptive', () => {
  const result = summarizeEvidence([{ tier: 'T2', result: { pass: true } }]);
  assert.equal(result.by_tier.T2, 1);
  assert.match(result.note, /not a portfolio decision/);
});

// AC-12. The summary counts claims made by the caller's own workspace, not verified outcomes
// (ADR-0004), and says so in a field whose value is fixed. The literal is spelled out so that a
// change to the exported constant is what this assertion notices.
test('the summary carries evidence_attestation self-attested', () => {
  assert.equal(EVIDENCE_ATTESTATION, 'self-attested');
  assert.equal(summarizeEvidence([]).evidence_attestation, 'self-attested');
  assert.equal(
    summarizeEvidence([{ tier: 'T1', result: { pass: true } }]).evidence_attestation,
    'self-attested',
  );
});
