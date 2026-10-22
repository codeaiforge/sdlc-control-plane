import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACCEPTED_ISSUERS,
  ADMITTED_EVENT_ALLOWLIST,
  GUARDRAIL_APPROVAL_KEYS,
  GUARDRAIL_POLICY_KEYS,
  GUARDRAIL_RULE_KEYS,
  REGISTRATION_STATUSES,
  REGISTRY_SCHEMA_VERSION,
  isPlaceholderText,
  isUtcTimestamp,
  validateEvidence,
  validateGuardrailPolicy,
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
  ai_assisted: false,
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

// AI provenance (AC-5, AC-6, MIT-11). ai_assisted is required and boolean; ai_tool, when present,
// is a string naming a tool, and only on an assisted record.
const evidenceErrors = (overrides) => validateEvidence({ ...evidence, ...overrides }).errors;

test('ai_assisted must be the boolean true or false', () => {
  const { ai_assisted, ...withoutFlag } = evidence;
  assert.equal(ai_assisted, false);
  assert.deepEqual(validateEvidence(withoutFlag).errors, ['ai_assisted must be true or false']);
  for (const value of [null, 'yes', 'false', 'true', 1, 0, {}, [], undefined]) {
    assert.deepEqual(
      evidenceErrors({ ai_assisted: value }),
      ['ai_assisted must be true or false'],
      JSON.stringify(value),
    );
  }
  assert.deepEqual(validateEvidence({ ...evidence, ai_assisted: true }), { ok: true, errors: [] });
  assert.deepEqual(validateEvidence({ ...evidence, ai_assisted: false }), { ok: true, errors: [] });
});

test('ai_tool: 42 is refused', () => {
  assert.deepEqual(evidenceErrors({ ai_assisted: true, ai_tool: 42 }), [
    'ai_tool must be a string naming a tool',
  ]);
});

test('ai_tool: {} is refused', () => {
  assert.deepEqual(evidenceErrors({ ai_assisted: true, ai_tool: {} }), [
    'ai_tool must be a string naming a tool',
  ]);
});

test('ai_tool must be a string with a letter or digit', () => {
  for (const value of [
    [],
    true,
    null,
    '',
    '   ',
    '\t\n',
    undefined,
    '-',
    '.',
    '\u200b',
    ' \u2060 ',
  ]) {
    assert.deepEqual(
      evidenceErrors({ ai_assisted: true, ai_tool: value }),
      ['ai_tool must be a string naming a tool'],
      JSON.stringify(value),
    );
  }
  // At most one ai_tool reason, even when the record is not assisted either.
  assert.deepEqual(evidenceErrors({ ai_assisted: false, ai_tool: 42 }), [
    'ai_tool must be a string naming a tool',
  ]);
});

test('a named tool is accepted as sent, and only on an assisted record', () => {
  for (const ai_tool of ['claude-code', ' claude-code ', 'x', '7', 'ツール'])
    assert.deepEqual(validateEvidence({ ...evidence, ai_assisted: true, ai_tool }), {
      ok: true,
      errors: [],
    });
  assert.deepEqual(evidenceErrors({ ai_assisted: false, ai_tool: 'claude-code' }), [
    'ai_tool requires ai_assisted true',
  ]);
  // A tool on a record whose ai_assisted is malformed is reported once, as the flag.
  assert.deepEqual(evidenceErrors({ ai_assisted: 'yes', ai_tool: 'claude-code' }), [
    'ai_assisted must be true or false',
  ]);
});

// guardrails/0 (AC-1, AC-2, AC-4, AC-7; MIT-12). A complete, clearly synthetic policy; each test
// breaks one field.
const guardrailPolicy = (overrides = {}, approval = {}, rules = {}) => ({
  policy_version: 'guardrails/0',
  policy_id: 'test-policy@1',
  effective_from: '2026-01-01T00:00:00Z',
  approval: {
    decision_id: 'TEST-DECISION-1',
    approved_by: 'test-approver',
    approved_at: '2026-01-01T00:00:00Z',
    ...approval,
  },
  rules: {
    minimum_evidence_schema: 'evidence/0',
    blocked_tiers: [],
    require_ai_provenance_when_assisted: true,
    require_verified_controls: ['CAF-SDLC-002:tier'],
    ...rules,
  },
  ...overrides,
});
const policyErrors = (value) => validateGuardrailPolicy(value).errors;
const ABSENT = Symbol('absent');
const without = (object, key) => {
  const copy = { ...object };
  delete copy[key];
  return copy;
};
const TEXT = 'must be a string with a letter or digit and no leading or trailing whitespace';
const TIMESTAMP = 'must be a UTC timestamp YYYY-MM-DDTHH:MM:SSZ on a real calendar day';

test('a complete guardrails/0 policy is accepted', () => {
  assert.deepEqual(validateGuardrailPolicy(guardrailPolicy()), { ok: true, errors: [] });
});

test('the guardrails/0 key lists are the reviewed literals, frozen', () => {
  assert.deepEqual(GUARDRAIL_POLICY_KEYS, [
    'policy_version',
    'policy_id',
    'effective_from',
    'approval',
    'rules',
  ]);
  assert.deepEqual(GUARDRAIL_APPROVAL_KEYS, ['decision_id', 'approved_by', 'approved_at']);
  assert.deepEqual(GUARDRAIL_RULE_KEYS, [
    'minimum_evidence_schema',
    'blocked_tiers',
    'require_ai_provenance_when_assisted',
    'require_verified_controls',
  ]);
  for (const frozen of [GUARDRAIL_POLICY_KEYS, GUARDRAIL_APPROVAL_KEYS, GUARDRAIL_RULE_KEYS])
    assert.equal(Object.isFrozen(frozen), true);
});

test('a policy that is not an object is refused and nothing else is said', () => {
  for (const value of [null, undefined, [], 'guardrails/0', 42])
    assert.deepEqual(policyErrors(value), ['policy must be an object']);
});

test('every guardrails/0 level is closed to unrecognised fields', () => {
  assert.deepEqual(policyErrors(guardrailPolicy({ owner: 'x' })), [
    'owner is not a recognised field',
  ]);
  assert.deepEqual(policyErrors(guardrailPolicy({}, { ticket: 'x' })), [
    'approval.ticket is not a recognised field',
  ]);
  assert.deepEqual(policyErrors(guardrailPolicy({}, {}, { max_tier: 'T3' })), [
    'rules.max_tier is not a recognised field',
  ]);
});

test('policy_version must be guardrails/0', () => {
  for (const policy_version of ['guardrails/1', '', undefined, 0])
    assert.deepEqual(policyErrors(guardrailPolicy({ policy_version })), [
      'policy_version must be guardrails/0',
    ]);
  assert.deepEqual(policyErrors(without(guardrailPolicy(), 'policy_version')), [
    'policy_version must be guardrails/0',
  ]);
});

test('policy_id must be text with no surrounding whitespace', () => {
  for (const policy_id of ['', '  ', ' p@1', 'p@1 ', 42, null, undefined, '-', '@', '\u200b'])
    assert.deepEqual(
      policyErrors(guardrailPolicy({ policy_id })),
      [`policy_id ${TEXT}`],
      JSON.stringify(policy_id),
    );
  assert.deepEqual(policyErrors(without(guardrailPolicy(), 'policy_id')), [`policy_id ${TEXT}`]);
});

test('AC-1: a missing or non-object approval is refused', () => {
  assert.deepEqual(policyErrors(without(guardrailPolicy(), 'approval')), [
    'approval must be an object',
  ]);
  for (const approval of [null, [], 'x', 42])
    assert.deepEqual(policyErrors(guardrailPolicy({ approval })), ['approval must be an object']);
});

test('AC-2: each approval text field is refused when absent, blank, padded or not a string', () => {
  for (const key of ['decision_id', 'approved_by']) {
    for (const value of [ABSENT, '', '  ', ' x', 'x ', 42, null]) {
      const approval = guardrailPolicy().approval;
      if (value === ABSENT) delete approval[key];
      else approval[key] = value;
      assert.deepEqual(
        policyErrors(guardrailPolicy({ approval })),
        [`approval.${key} ${TEXT}`],
        `${key}: ${String(value)}`,
      );
    }
  }
});

// S-3: a value with no letter or digit in any script names nothing, though /\S/ finds it non-blank.
test('AC-2: an approval text field with no letter or digit is refused', () => {
  for (const key of ['decision_id', 'approved_by']) {
    for (const value of ['-', '.', '--', '\u200b', '\u2060', '-\u200b-']) {
      const approval = { ...guardrailPolicy().approval, [key]: value };
      assert.deepEqual(
        policyErrors(guardrailPolicy({ approval })),
        [`approval.${key} ${TEXT}`],
        `${key}: ${JSON.stringify(value)}`,
      );
    }
    for (const value of ['P1', 'Ωmega', '７', 'Ä.-'])
      assert.equal(
        validateGuardrailPolicy(guardrailPolicy({}, { [key]: value })).ok,
        true,
        `${key}: ${value}`,
      );
  }
});

test('AC-2: timestamps must be full-form UTC on a real calendar day', () => {
  for (const value of ['2026-01-01T00:00:00Z', '2024-02-29T23:59:59Z'])
    assert.equal(isUtcTimestamp(value), true, value);
  for (const value of [
    '2026-02-30T00:00:00Z',
    '2026-02-29T00:00:00Z',
    '2026-01-01T24:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-10-22',
    '2026-01-01T00:00:00+00:00',
    '2026-01-01T00:00:00.000Z',
    '2026-01-01 00:00:00Z',
    '2026-01-01T00:00:00z',
    ' 2026-01-01T00:00:00Z',
    '',
    1767225600000,
    null,
    undefined,
  ])
    assert.equal(isUtcTimestamp(value), false, String(value));
  for (const effective_from of ['2026-02-30T00:00:00Z', '2026-01-01', ABSENT]) {
    const policy = guardrailPolicy({ effective_from });
    if (effective_from === ABSENT) delete policy.effective_from;
    assert.deepEqual(policyErrors(policy), [`effective_from ${TIMESTAMP}`], String(effective_from));
  }
  for (const approved_at of ['2026-01-01T24:00:00Z', '2026-01-01T00:00:00+00:00', ABSENT]) {
    const policy = guardrailPolicy({}, { approved_at });
    if (approved_at === ABSENT) delete policy.approval.approved_at;
    assert.deepEqual(
      policyErrors(policy),
      [`approval.approved_at ${TIMESTAMP}`],
      String(approved_at),
    );
  }
});

test('AC-2: the approval may not be dated after the policy takes effect', () => {
  assert.deepEqual(policyErrors(guardrailPolicy({}, { approved_at: '2026-01-01T00:00:01Z' })), [
    'approval.approved_at must not be after effective_from',
  ]);
  assert.equal(
    validateGuardrailPolicy(guardrailPolicy({}, { approved_at: '2026-01-01T00:00:00Z' })).ok,
    true,
  );
  assert.equal(
    validateGuardrailPolicy(guardrailPolicy({}, { approved_at: '2025-12-31T23:59:59Z' })).ok,
    true,
  );
});

test('AC-2: one reason per failing field, none of them quoting a value', () => {
  const CANARY = 'CANARY-VALUE';
  const errors = policyErrors({
    policy_version: CANARY,
    policy_id: ` ${CANARY}`,
    effective_from: CANARY,
    approval: { decision_id: ` ${CANARY}`, approved_by: 42, approved_at: CANARY },
    rules: { minimum_evidence_schema: CANARY },
  });
  assert.deepEqual(errors, [
    'policy_version must be guardrails/0',
    `policy_id ${TEXT}`,
    `effective_from ${TIMESTAMP}`,
    `approval.decision_id ${TEXT}`,
    `approval.approved_by ${TEXT}`,
    `approval.approved_at ${TIMESTAMP}`,
    'rules.minimum_evidence_schema must be evidence/0',
    'rules.blocked_tiers must be an array of distinct tiers from T0, T1, T2, T3',
    'rules.require_ai_provenance_when_assisted must be true',
    'rules.require_verified_controls must be an array of distinct non-blank strings',
  ]);
  for (const reason of errors) assert.doesNotMatch(reason, /CANARY/, reason);
});

test('AC-3: a placeholder decision reference or approver is refused', () => {
  for (const decision_id of [
    'LPM-EXAMPLE-001',
    'lpm_example_001',
    'EXAMPLE001',
    'TBD',
    'xxxx',
    '<decision-id>',
    'decision-<id>',
    'SAMPLE-1',
    'todo',
    'Placeholder',
    'N/A',
    'n/a',
    'DEC-N/A',
    'none',
    'NULL',
    'TBA',
  ])
    assert.deepEqual(
      policyErrors(guardrailPolicy({}, { decision_id })),
      ['approval.decision_id is a placeholder, not a decision reference'],
      decision_id,
    );
  for (const approved_by of [
    'pending',
    'TBD',
    '<approved_by>',
    'unknown',
    'changeme',
    'n/a',
    'None',
    'null',
    'tba',
  ])
    assert.deepEqual(
      policyErrors(guardrailPolicy({}, { approved_by })),
      ['approval.approved_by is a placeholder, not an approver'],
      approved_by,
    );
});

test('AC-3: the placeholder rule reads whole tokens, not substrings', () => {
  // The synthetic values every fixture uses, and real names that contain a listed word.
  for (const text of ['TEST-DECISION-1', 'test-approver', 'Atodorov', 'Exampleton', 'tbdx', 'xx'])
    assert.equal(isPlaceholderText(text), false, text);
  for (const text of ['Nonen', 'Nullman', 'tbax', 'na', 'an/am', 'n/ab', 'zn/a', 'n-a'])
    assert.equal(isPlaceholderText(text), false, text);
  for (const text of ['EXAMPLES', 'samples', 'dummy2', 'FIXME', 'tbc', 'awaiting', 'XXX9', '>'])
    assert.equal(isPlaceholderText(text), true, text);
  // n/a spans two alphanumeric runs, so it is matched as a whole, bounded the same way.
  for (const text of ['n/a', 'N/A', 'x N/A', 'TEAM-N/A', 'n/a2', '(n/a)', 'none1', 'Null', 'TBA'])
    assert.equal(isPlaceholderText(text), true, text);
  assert.equal(validateGuardrailPolicy(guardrailPolicy({}, { approved_by: 'Atodorov' })).ok, true);
  // Known escape, stated rather than claimed away: a look-alike letter from another script.
  assert.equal(isPlaceholderText('EXAMPLЕ-001'), false);
});

test('AC-4: a missing or non-object rules block is refused', () => {
  assert.deepEqual(policyErrors(without(guardrailPolicy(), 'rules')), ['rules must be an object']);
  for (const rules of [null, 'x', [], 42])
    assert.deepEqual(policyErrors(guardrailPolicy({ rules })), ['rules must be an object']);
});

test('AC-4: a misspelt rule is refused, and the rule it should have been is missing', () => {
  const policy = guardrailPolicy();
  policy.rules.blocked_tier = policy.rules.blocked_tiers;
  delete policy.rules.blocked_tiers;
  assert.deepEqual(policyErrors(policy), [
    'rules.blocked_tier is not a recognised field',
    'rules.blocked_tiers must be an array of distinct tiers from T0, T1, T2, T3',
  ]);
});

test('AC-4: minimum_evidence_schema must be evidence/0', () => {
  for (const value of [ABSENT, 'evidence/1', '', null]) {
    const policy = guardrailPolicy({}, {}, { minimum_evidence_schema: value });
    if (value === ABSENT) delete policy.rules.minimum_evidence_schema;
    assert.deepEqual(
      policyErrors(policy),
      ['rules.minimum_evidence_schema must be evidence/0'],
      String(value),
    );
  }
});

test('AC-4: blocked_tiers must be an array of distinct known tiers', () => {
  for (const blocked_tiers of [[], ['T0'], ['T3', 'T2', 'T1', 'T0']])
    assert.equal(validateGuardrailPolicy(guardrailPolicy({}, {}, { blocked_tiers })).ok, true);
  for (const value of [ABSENT, 'T0', 'xT0x', ['T0', 'T0'], ['T9'], ['t0'], [0], null, {}]) {
    const policy = guardrailPolicy({}, {}, { blocked_tiers: value });
    if (value === ABSENT) delete policy.rules.blocked_tiers;
    assert.deepEqual(
      policyErrors(policy),
      ['rules.blocked_tiers must be an array of distinct tiers from T0, T1, T2, T3'],
      JSON.stringify(value),
    );
  }
});

test('AC-4: require_verified_controls must be an array of distinct text values', () => {
  for (const require_verified_controls of [[], ['a'], ['a', 'b']])
    assert.equal(
      validateGuardrailPolicy(guardrailPolicy({}, {}, { require_verified_controls })).ok,
      true,
    );
  for (const value of [ABSENT, 'CAF', ['a', 'a'], [''], [' a'], ['a '], [1], null]) {
    const policy = guardrailPolicy({}, {}, { require_verified_controls: value });
    if (value === ABSENT) delete policy.rules.require_verified_controls;
    assert.deepEqual(
      policyErrors(policy),
      ['rules.require_verified_controls must be an array of distinct non-blank strings'],
      JSON.stringify(value),
    );
  }
});

test('AC-7: the provenance rule must be on', () => {
  for (const value of [ABSENT, false, 'true', 1, null]) {
    const policy = guardrailPolicy({}, {}, { require_ai_provenance_when_assisted: value });
    if (value === ABSENT) delete policy.rules.require_ai_provenance_when_assisted;
    assert.deepEqual(
      policyErrors(policy),
      ['rules.require_ai_provenance_when_assisted must be true'],
      String(value),
    );
  }
});

// The evaluator's probe applies here too (ADR-0004): no reason a validator produces may speak of
// verification. Field names are names, not claims, so they are taken out before the reason is read.
test('no validator reason speaks of verification', () => {
  const FIELD_NAMES = /\b(require_verified_controls|verification\.verified)\b/g;
  const reasons = new Set([
    ...validateEvidence({}).errors,
    ...evidenceErrors({ ai_assisted: null, ai_tool: 42 }),
    ...evidenceErrors({ ai_assisted: false, ai_tool: 'claude-code' }),
    ...policyErrors(null),
    ...policyErrors({ approval: { x: 1 }, rules: { x: 1 }, x: 1 }),
    ...policyErrors(guardrailPolicy({}, { decision_id: 'TBD', approved_by: 'TBD' })),
    ...policyErrors(guardrailPolicy({}, { approved_at: '2026-01-02T00:00:00Z' })),
    ...policyErrors(guardrailPolicy({ approval: null, rules: null })),
  ]);
  assert.ok(reasons.size >= 25, 'the probe stopped producing the reasons it exists to read');
  for (const reason of reasons)
    assert.doesNotMatch(reason.replace(FIELD_NAMES, ''), /verif/i, reason);
});
