import assert from 'node:assert/strict';
import test from 'node:test';
import { createRegistry } from './registry.mjs';
const registration = { workspace_id: 'orders', display_name: 'Orders', value_stream: 'commerce', repository_url: 'https://example.invalid/orders', evidence_endpoint: 'https://example.invalid/evidence', owners: ['commerce'], status: 'active' };
test('registry rejects duplicate workspace identities', () => {
  const registry = createRegistry([registration]);
  assert.throws(() => registry.register(registration), /already registered/);
});
