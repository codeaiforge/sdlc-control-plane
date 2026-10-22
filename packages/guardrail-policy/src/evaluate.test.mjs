import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { evaluateGuardrails, validateGuardrailPolicy } from './evaluate.mjs';

const policy = {
  policy_version: 'guardrails/0',
  policy_id: 'p@1',
  effective_from: '2026-01-01T00:00:00Z',
  approval: {
    decision_id: 'TEST-DECISION-1',
    approved_by: 'test-approver',
    approved_at: '2026-01-01T00:00:00Z',
  },
  rules: {
    minimum_evidence_schema: 'evidence/0',
    blocked_tiers: [],
    require_ai_provenance_when_assisted: true,
    require_verified_controls: ['CAF-SDLC-002:tier'],
  },
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
  ai_assisted: false,
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

// AC-10. One named test per rule, so a deleted branch fails a test that says which rule went.
// Each runs under a policy the validator accepts, and has a control: the same record passes once
// the cause is removed, so the test fails for the rule and not for anything else.
const withRules = (rules) => ({ ...policy, rules: { ...policy.rules, ...rules } });

test('the provenance rule is applied: assisted without a tool needs remediation', () => {
  assert.equal(validateGuardrailPolicy(policy).ok, true);
  assert.deepEqual(evaluateGuardrails({ ...evidence, ai_assisted: true }, policy), {
    accepted: false,
    disposition: 'needs-remediation',
    policy_id: 'p@1',
    reasons: ['AI-assisted evidence is missing ai_tool provenance'],
  });
  assert.equal(
    evaluateGuardrails({ ...evidence, ai_assisted: true, ai_tool: 'claude-code' }, policy).accepted,
    true,
    'control: the same record naming its tool is accepted',
  );
});

test('the blocked_tiers rule is applied: a blocked tier needs remediation', () => {
  const blocking = withRules({ blocked_tiers: ['T0'] });
  assert.equal(validateGuardrailPolicy(blocking).ok, true);
  assert.deepEqual(evaluateGuardrails(evidence, blocking), {
    accepted: false,
    disposition: 'needs-remediation',
    policy_id: 'p@1',
    reasons: ['tier T0 is blocked by policy'],
  });
  assert.equal(
    evaluateGuardrails({ ...evidence, tier: 'T1' }, blocking).accepted,
    true,
    'control: a tier the policy does not block is accepted under the same policy',
  );
});

// AC-7, fail-closed. The evaluator does not validate the policy (the service does, before it
// starts), so it must not read a missing key as "off": only an explicit false turns the rule off,
// and validateGuardrailPolicy refuses a policy that says false.
test('the provenance rule applies when a policy omits it', () => {
  const { require_ai_provenance_when_assisted, ...rest } = policy.rules;
  assert.equal(require_ai_provenance_when_assisted, true);
  const omitting = { ...policy, rules: rest };
  assert.deepEqual(evaluateGuardrails({ ...evidence, ai_assisted: true }, omitting).reasons, [
    'AI-assisted evidence is missing ai_tool provenance',
  ]);
  assert.deepEqual(
    evaluateGuardrails({ ...evidence, ai_assisted: true }, { ...policy, rules: undefined }).reasons,
    ['AI-assisted evidence is missing ai_tool provenance'],
  );
  assert.equal(
    evaluateGuardrails(
      { ...evidence, ai_assisted: true },
      withRules({ require_ai_provenance_when_assisted: false }),
    ).accepted,
    true,
  );
  assert.equal(
    validateGuardrailPolicy(withRules({ require_ai_provenance_when_assisted: false })).ok,
    false,
  );
});

test('a malformed provenance claim is a contract failure, decided before any policy', () => {
  for (const overrides of [
    { ai_assisted: 'yes' },
    { ai_assisted: true, ai_tool: 42 },
    { ai_assisted: false, ai_tool: 'claude-code' },
  ]) {
    const result = evaluateGuardrails({ ...evidence, ...overrides }, policy);
    assert.equal(result.disposition, 'rejected', JSON.stringify(overrides));
    assert.equal(Object.hasOwn(result, 'policy_id'), false);
  }
  const { ai_assisted, ...unflagged } = evidence;
  assert.equal(ai_assisted, false);
  assert.deepEqual(evaluateGuardrails(unflagged, policy), {
    accepted: false,
    disposition: 'rejected',
    reasons: ['ai_assisted must be true or false'],
  });
});

// A list rule of the wrong type on an unvalidated policy is refused, as an unsupported version
// is (fail-closed, review S-1): it neither matches by substring nor reads as "off". Absent, a
// list rule blocks or requires nothing.
for (const [rule, value] of [
  ['blocked_tiers', 'xT0x'],
  ['require_verified_controls', 'CAF'],
]) {
  test(`${rule} present but not a list is an unsupported policy, not accepted`, () => {
    for (const malformed of [value, null, {}, 1]) {
      assert.deepEqual(
        evaluateGuardrails(evidence, withRules({ [rule]: malformed })),
        {
          accepted: false,
          disposition: 'rejected',
          reasons: [`unsupported guardrail policy: ${rule} is not a list`],
        },
        JSON.stringify(malformed),
      );
    }
    const { [rule]: _dropped, ...rest } = policy.rules;
    assert.equal(
      evaluateGuardrails(evidence, { ...policy, rules: rest }).accepted,
      true,
      'control: the same policy without the rule accepts',
    );
  });
}

// Review N2-2: the same one level up. A rules block that is not a plain object is not "no rules".
test('rules present but not an object is an unsupported policy, not accepted', () => {
  for (const malformed of ['T1', 42, [], null]) {
    assert.deepEqual(
      evaluateGuardrails(evidence, { ...policy, rules: malformed }),
      {
        accepted: false,
        disposition: 'rejected',
        reasons: ['unsupported guardrail policy: rules is not an object'],
      },
      JSON.stringify(malformed),
    );
  }
  const { rules: _dropped, ...rest } = policy;
  assert.equal(evaluateGuardrails(evidence, rest).accepted, true, 'control: absent rules accept');
});

// Phase ⑤ F-1: the gate itself, run, not only read from the source.
test('a policy of another version is an unsupported policy, not evaluated', () => {
  for (const version of ['guardrails/1', undefined]) {
    assert.deepEqual(evaluateGuardrails(evidence, { ...policy, policy_version: version }), {
      accepted: false,
      disposition: 'rejected',
      reasons: ['unsupported guardrail policy version'],
    });
  }
  assert.equal(
    evaluateGuardrails(evidence, policy).accepted,
    true,
    'control: guardrails/0 accepts',
  );
});

test('the version gate reads the contracts constant, not a literal', () => {
  const source = readFileSync(new URL('./evaluate.mjs', import.meta.url), 'utf8');
  assert.match(source, /policy\?\.policy_version !== GUARDRAIL_SCHEMA_VERSION/);
  assert.doesNotMatch(source, /'guardrails\/0'/);
});
