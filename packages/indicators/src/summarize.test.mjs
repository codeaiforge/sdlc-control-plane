import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeEvidence } from './summarize.mjs';
test('keeps evidence indicators descriptive', () => {
  const result = summarizeEvidence([{ tier: 'T2', result: { pass: true } }]);
  assert.equal(result.by_tier.T2, 1);
  assert.match(result.note, /not a portfolio decision/);
});
