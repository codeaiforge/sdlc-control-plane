import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACCEPTED_ISSUERS,
  ADMITTED_EVENT_ALLOWLIST,
  REGISTRATION_STATUSES,
  REGISTRY_SCHEMA_VERSION,
  validateEvidence,
  validateWorkspaceRegistration,
} from './schema.mjs';

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

// workspace-registry/1 (AC-5). One test per rule in ADR-0003's registration table, each probing
// the next spelling of a bad value as well as the obvious one.
const registration = (overrides = {}, identity = {}) => ({
  workspace_id: 'orders',
  display_name: 'Orders',
  value_stream: 'commerce',
  repository_url: 'https://example.invalid/orders',
  evidence_endpoint: 'https://example.invalid/evidence',
  owners: ['commerce'],
  status: 'active',
  workload_identity: {
    issuer: 'https://token.actions.githubusercontent.com',
    repository_owner_id: '65',
    repository_id: '74',
    admitted_events: ['push', 'pull_request'],
    ...identity,
  },
  ...overrides,
});
const errorsOf = (value) => validateWorkspaceRegistration(value).errors;

test('a complete workspace-registry/1 registration is accepted', () => {
  assert.deepEqual(validateWorkspaceRegistration(registration()), { ok: true, errors: [] });
});

test('the registry version and its vocabulary are the reviewed literals', () => {
  assert.equal(REGISTRY_SCHEMA_VERSION, 'workspace-registry/1');
  assert.deepEqual(ACCEPTED_ISSUERS, ['https://token.actions.githubusercontent.com']);
  assert.deepEqual(ADMITTED_EVENT_ALLOWLIST, ['push', 'pull_request', 'pull_request_review']);
  assert.deepEqual(REGISTRATION_STATUSES, ['active', 'suspended']);
  for (const frozen of [ACCEPTED_ISSUERS, ADMITTED_EVENT_ALLOWLIST, REGISTRATION_STATUSES])
    assert.equal(Object.isFrozen(frozen), true);
});

test('status must be active or suspended', () => {
  assert.equal(validateWorkspaceRegistration(registration({ status: 'suspended' })).ok, true);
  for (const status of ['retired', 'Active', 'ACTIVE', '', undefined, 1, ['active']]) {
    assert.deepEqual(errorsOf(registration({ status })), [
      'status must be one of active, suspended',
    ]);
  }
});

test('a missing or non-object workload_identity is refused', () => {
  for (const workload_identity of [undefined, null, [], 'github', 42]) {
    assert.deepEqual(errorsOf(registration({ workload_identity })), [
      'workload_identity must be an object',
    ]);
  }
});

test('an unknown issuer is refused', () => {
  for (const issuer of [
    'https://token.actions.githubusercontent.com/',
    'https://gitlab.com',
    'HTTPS://TOKEN.ACTIONS.GITHUBUSERCONTENT.COM',
    '',
    undefined,
  ]) {
    assert.deepEqual(errorsOf(registration({}, { issuer })), [
      'workload_identity.issuer must be an accepted issuer',
    ]);
  }
});

test("the ID fields refuse '074', 74, '', 21 digits and every other non-canonical form", () => {
  for (const key of ['repository_owner_id', 'repository_id']) {
    for (const value of ['074', '0', 74, '', '1'.repeat(21), ' 74', '7e1', '-74', undefined]) {
      assert.deepEqual(
        errorsOf(registration({}, { [key]: value })),
        [`workload_identity.${key} must be a canonical decimal string`],
        `${key}: ${JSON.stringify(value)}`,
      );
    }
    assert.equal(
      validateWorkspaceRegistration(registration({}, { [key]: '1'.repeat(20) })).ok,
      true,
    );
  }
});

test('admitted_events must be non-empty, unique, and inside the allowlist', () => {
  assert.deepEqual(errorsOf(registration({}, { admitted_events: [] })), [
    'workload_identity.admitted_events must be a non-empty array',
  ]);
  assert.deepEqual(errorsOf(registration({}, { admitted_events: 'push' })), [
    'workload_identity.admitted_events must be a non-empty array',
  ]);
  assert.deepEqual(errorsOf(registration({}, { admitted_events: ['push', 'push'] })), [
    'workload_identity.admitted_events must not repeat an event',
  ]);
  for (const event of [
    'pull_request_target',
    'workflow_dispatch',
    'dynamic',
    'workflow_run',
    'issue_comment',
    'merge_group',
    'schedule',
    'Push',
    '',
  ]) {
    assert.deepEqual(errorsOf(registration({}, { admitted_events: ['push', event] })), [
      'workload_identity.admitted_events holds an event outside the allowlist',
    ]);
  }
  assert.equal(
    validateWorkspaceRegistration(
      registration({}, { admitted_events: ['push', 'pull_request', 'pull_request_review'] }),
    ).ok,
    true,
  );
});

test('a ref pin must name a reusable workflow at a branch or tag ref', () => {
  const ok = 'codeaiforge/gates/.github/workflows/mint.yml@refs/heads/main';
  assert.equal(
    validateWorkspaceRegistration(registration({}, { required_job_workflow_ref: ok })).ok,
    true,
  );
  assert.equal(
    validateWorkspaceRegistration(
      registration({}, { required_job_workflow_ref: ok.replace('heads/main', 'tags/v1') }),
    ).ok,
    true,
  );
  for (const bad of [
    'codeaiforge/gates/.github/workflows/mint.yml',
    'codeaiforge/gates/.github/workflows/mint.yml@main',
    'codeaiforge/gates/.github/workflows/mint.yml@refs/pull/1/merge',
    'codeaiforge/.github/workflows/mint.yml@refs/heads/main',
    'codeaiforge/gates/workflows/mint.yml@refs/heads/main',
    'code aiforge/gates/.github/workflows/mint.yml@refs/heads/main',
    '',
    7,
  ]) {
    assert.deepEqual(errorsOf(registration({}, { required_job_workflow_ref: bad })), [
      'workload_identity.required_job_workflow_ref is not a reusable-workflow ref',
    ]);
  }
});

test('a sha pin must be 40 lowercase hex digits and needs a ref pin', () => {
  const ref = 'codeaiforge/gates/.github/workflows/mint.yml@refs/heads/main';
  const both = (sha) =>
    registration({}, { required_job_workflow_ref: ref, required_job_workflow_sha: sha });
  assert.equal(validateWorkspaceRegistration(both('c'.repeat(40))).ok, true);
  for (const sha of ['C'.repeat(40), 'c'.repeat(39), 'c'.repeat(41), 'g'.repeat(40), '', 7]) {
    assert.deepEqual(errorsOf(both(sha)), [
      'workload_identity.required_job_workflow_sha must be 40 lowercase hex digits',
    ]);
  }
  assert.deepEqual(errorsOf(registration({}, { required_job_workflow_sha: 'c'.repeat(40) })), [
    'workload_identity.required_job_workflow_sha requires required_job_workflow_ref',
  ]);
});

test('an unknown key in the workload_identity block is refused', () => {
  // The block is closed: a misspelled pin must fail at load rather than load and pin nothing.
  for (const key of ['required_job_workflow_refs', 'required_workflow_ref', 'repository', 'sub']) {
    assert.deepEqual(errorsOf(registration({}, { [key]: 'x' })), [
      `workload_identity.${key} is not a recognised field`,
    ]);
  }
});

test('the rest of the registration stays open to additive fields (NFR-1.1)', () => {
  assert.equal(validateWorkspaceRegistration(registration({ cost_centre: 'later' })).ok, true);
});
