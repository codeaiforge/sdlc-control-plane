import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ACCEPTED_ISSUERS, admits, bindingKey, createRegistry } from './registry.mjs';

const ISSUER = 'https://token.actions.githubusercontent.com';

const registration = (overrides = {}, identity = {}) => ({
  workspace_id: 'orders',
  display_name: 'Orders',
  value_stream: 'commerce',
  repository_url: 'https://example.invalid/orders',
  evidence_endpoint: 'https://example.invalid/evidence',
  owners: ['commerce'],
  status: 'active',
  workload_identity: {
    issuer: ISSUER,
    repository_owner_id: '65',
    repository_id: '74',
    admitted_events: ['push', 'pull_request'],
    ...identity,
  },
  ...overrides,
});

const documentOf = (...workspaces) => ({ registry_version: 'workspace-registry/1', workspaces });

const principal = (overrides = {}) => ({
  issuer: ISSUER,
  repository_owner_id: '65',
  repository_id: '74',
  actor_id: '1000001',
  run_id: '1',
  run_attempt: '1',
  sha: 'a'.repeat(40),
  ref: 'refs/heads/main',
  event_name: 'push',
  workflow_ref: 'owner/repo/.github/workflows/gate.yml@refs/heads/main',
  job_workflow_ref: null,
  job_workflow_sha: null,
  ...overrides,
});

test('registry rejects duplicate workspace identities', () => {
  const registry = createRegistry(documentOf(registration()));
  assert.throws(
    () => registry.register(registration({}, { repository_id: '75' })),
    /already registered/,
  );
});

test('a document whose registry_version is not workspace-registry/1 throws', () => {
  for (const registry_version of ['workspace-registry/0', 'workspace-registry/2', '', undefined]) {
    assert.throws(
      () => createRegistry({ registry_version, workspaces: [registration()] }),
      /registry_version must be workspace-registry\/1/,
      String(registry_version),
    );
  }
  for (const document of [null, [], [registration()], 'workspace-registry/1'])
    assert.throws(() => createRegistry(document), /unsupported registry document/);
  assert.throws(
    () => createRegistry({ registry_version: 'workspace-registry/1' }),
    /workspaces must be an array/,
  );
});

test('an invalid registration throws at load', () => {
  assert.throws(
    () => createRegistry(documentOf(registration({}, { admitted_events: ['workflow_dispatch'] }))),
    /invalid workspace registration/,
  );
  const { workload_identity: _dropped, ...unbound } = registration();
  assert.throws(() => createRegistry(documentOf(unbound)), /workload_identity must be an object/);
});

test('two registrations with one triple throw', () => {
  assert.throws(
    () => createRegistry(documentOf(registration(), registration({ workspace_id: 'billing' }))),
    /workload identity already bound: billing repeats orders's triple/,
  );
  // The triple is the binding, not its parts: another repository under the same owner is fine.
  const registry = createRegistry(
    documentOf(registration(), registration({ workspace_id: 'billing' }, { repository_id: '75' })),
  );
  assert.equal(registry.list().length, 2);
});

test('bindingFor finds the workspace by JSON-encoded triple', () => {
  const registry = createRegistry(
    documentOf(registration(), registration({ workspace_id: 'billing' }, { repository_id: '75' })),
  );
  assert.equal(registry.bindingFor(principal()), 'orders');
  assert.equal(registry.bindingFor(principal({ repository_id: '75' })), 'billing');
  assert.equal(registry.bindingFor(principal({ repository_id: '76' })), undefined);
  assert.equal(registry.bindingFor(principal({ repository_owner_id: '66' })), undefined);
  assert.equal(registry.bindingFor(principal({ issuer: `${ISSUER}/` })), undefined);
  assert.equal(bindingKey(ISSUER, '65', '74'), JSON.stringify([ISSUER, '65', '74']));
});

test('a triple whose parts alias under a join does not collide', () => {
  assert.notEqual(bindingKey('a|b', 'c', 'd'), bindingKey('a', 'b|c', 'd'));
  assert.equal(['a|b', 'c', 'd'].join('|'), ['a', 'b|c', 'd'].join('|'));
  // Numeric IDs cannot carry a separator, but a join on "" can still alias two of them.
  assert.notEqual(bindingKey(ISSUER, '1', '23'), bindingKey(ISSUER, '12', '3'));
  const registry = createRegistry(
    documentOf(
      registration({}, { repository_owner_id: '1', repository_id: '23' }),
      registration({ workspace_id: 'billing' }, { repository_owner_id: '12', repository_id: '3' }),
    ),
  );
  assert.equal(
    registry.bindingFor(principal({ repository_owner_id: '1', repository_id: '23' })),
    'orders',
  );
  assert.equal(
    registry.bindingFor(principal({ repository_owner_id: '12', repository_id: '3' })),
    'billing',
  );
});

test("bindingFor('__proto__'…) finds nothing", () => {
  const registry = createRegistry(documentOf(registration()));
  for (const value of ['__proto__', 'constructor', 'toString']) {
    assert.equal(
      registry.bindingFor({ issuer: value, repository_owner_id: value, repository_id: value }),
      undefined,
    );
  }
  assert.equal(registry.get('__proto__'), undefined);
  assert.equal(registry.get('constructor'), undefined);
});

test('a stored registration is deep-frozen and is not the caller object', () => {
  const submitted = registration();
  const registry = createRegistry(documentOf(submitted));
  submitted.workload_identity.repository_id = '999';
  const stored = registry.get('orders');
  assert.equal(stored.workload_identity.repository_id, '74');
  assert.throws(() => {
    stored.workload_identity.admitted_events.push('workflow_dispatch');
  }, TypeError);
  assert.throws(() => {
    stored.status = 'active';
  }, TypeError);
  assert.equal(registry.bindingFor(principal()), 'orders');
});

test('list stays sorted by workspace_id (FR-1.1)', () => {
  const registry = createRegistry(
    documentOf(
      registration({ workspace_id: 'zeta' }, { repository_id: '1' }),
      registration({ workspace_id: 'alpha' }, { repository_id: '2' }),
    ),
  );
  assert.deepEqual(
    registry.list().map((entry) => entry.workspace_id),
    ['alpha', 'zeta'],
  );
});

test('admits returns each reason', () => {
  const pinnedRef = 'owner/gates/.github/workflows/mint.yml@refs/heads/main';
  const pinnedSha = 'c'.repeat(40);
  const pinned = registration(
    {},
    { required_job_workflow_ref: pinnedRef, required_job_workflow_sha: pinnedSha },
  );
  const matching = principal({ job_workflow_ref: pinnedRef, job_workflow_sha: pinnedSha });
  assert.equal(admits(registration(), principal()), null);
  assert.equal(admits(pinned, matching), null);
  assert.equal(admits(registration({ status: 'suspended' }), principal()), 'not-active');
  assert.equal(
    admits(registration(), principal({ event_name: 'workflow_dispatch' })),
    'event-not-admitted',
  );
  assert.equal(
    admits(registration(), principal({ event_name: 'pull_request_review' })),
    'event-not-admitted',
  );
  assert.equal(admits(pinned, principal({ job_workflow_sha: pinnedSha })), 'pin-ref', 'ref absent');
  assert.equal(
    admits(pinned, { ...matching, job_workflow_ref: `${pinnedRef}x` }),
    'pin-ref',
    'ref unequal',
  );
  assert.equal(admits(pinned, { ...matching, job_workflow_sha: null }), 'pin-sha', 'sha absent');
  assert.equal(
    admits(pinned, { ...matching, job_workflow_sha: 'd'.repeat(40) }),
    'pin-sha',
    'sha unequal',
  );
  // Status is checked first: a suspended registration refuses whatever else matches.
  assert.equal(admits({ ...pinned, status: 'suspended' }, principal()), 'not-active');
});

test('the accepted-issuer set is re-exported for the seam’s startup check', () => {
  assert.deepEqual(ACCEPTED_ISSUERS, [ISSUER]);
});

test('the shipped workspaces.json loads and none of its registrations is active', () => {
  // R-9: the example's IDs are placeholders, and a placeholder that happened to equal a real
  // repository's ID would authorize it. Nothing shipped is active until a real one is reviewed in.
  const shipped = JSON.parse(
    readFileSync(new URL('../../../config/control-plane/workspaces.json', import.meta.url)),
  );
  const registry = createRegistry(shipped);
  assert.ok(registry.list().length > 0);
  for (const entry of registry.list()) assert.notEqual(entry.status, 'active', entry.workspace_id);
});
