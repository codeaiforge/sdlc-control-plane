import assert from 'node:assert/strict';
import test from 'node:test';
import { validateEvidence, validateWorkspaceRegistration } from './schema.mjs';

const evidence = {
  schema_version: 'evidence/0',
  change_id: 'PR-42',
  binding_used: 'git-native-baseline@1',
  computed_at: '2026-09-18T00:00:00Z',
  tier: 'T1',
  affected_set: ['orders'],
  tool: { name: 'sdlc-controls', version: '0.2.0' },
  verification: { verified: ['CAF-SDLC-002:tier'] },
  result: { pass: true },
};

test('accepts the required evidence/0 subset', () =>
  assert.equal(validateEvidence(evidence).ok, true));
test('rejects unknown evidence versions', () =>
  assert.equal(validateEvidence({ ...evidence, schema_version: 'evidence/1' }).ok, false));
test('rejects a registration without accountable owners', () => {
  assert.equal(validateWorkspaceRegistration({ workspace_id: 'x' }).ok, false);
});
