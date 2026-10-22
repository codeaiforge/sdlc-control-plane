import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import * as contracts from '../../packages/contracts/src/schema.mjs';
import * as evaluate from '../../packages/guardrail-policy/src/evaluate.mjs';

// guardrails/0 conformance (task 2.4, MIT-12).
//
// Four things describe the guardrail policy: the shipped file, the validator the service refuses
// to start without (validateGuardrailPolicy), the rules the evaluator reads, and the Outbound
// section of docs/contracts.md. This file holds them together, and resolves the shipped approval
// to its decision record in config/control-plane/decisions/.
//
// Here and not in a package's own tests: docs/contracts.md is no Nx project's test input, so a
// package test that read it would stay cached green after the page changed. `pnpm test:controls`
// runs this file uncached, from the repository root, in ci.yml and in sdlc-controls.yml.
//
// What no check here can show is who wrote the record: the record and the policy can be written
// by one person in one commit (threat model RR-9, RR-1). This test never holds the approval's
// values; it reads them from the two files.

const {
  GUARDRAIL_APPROVAL_KEYS,
  GUARDRAIL_POLICY_KEYS,
  GUARDRAIL_RULE_KEYS,
  isPlaceholderText,
  isUtcTimestamp,
  validateGuardrailPolicy,
} = contracts;

const POLICY_FILE = 'config/control-plane/guardrails.json';
const DECISIONS = 'config/control-plane/decisions';
const EVALUATOR = 'packages/guardrail-policy/src/evaluate.mjs';
const CONTRACTS_PAGE = 'docs/contracts.md';
const THIS_FILE = 'tools/sdlc-controls/policy-conformance.test.mjs';

const shipped = JSON.parse(readFileSync(POLICY_FILE, 'utf8'));

// --------------------------------------------------------------- the file and the validator

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sorted = (values) => [...values].sort();

// Key drift at each level, both directions: a key the file has and the validator does not admit,
// or one the validator admits and the file lacks.
function keyDrift(policy) {
  const problems = [];
  const compare = (value, known, level) => {
    const present = isObject(value) ? Object.keys(value) : [];
    for (const key of present)
      if (!known.includes(key)) problems.push(`${level}: ${key} is not an admitted key`);
    for (const key of known)
      if (!present.includes(key)) problems.push(`${level}: ${key} is missing`);
  };
  compare(policy, GUARDRAIL_POLICY_KEYS, 'top level');
  compare(policy?.approval, GUARDRAIL_APPROVAL_KEYS, 'approval');
  compare(policy?.rules, GUARDRAIL_RULE_KEYS, 'rules');
  return problems;
}

test('P1: the shipped policy passes validateGuardrailPolicy', () => {
  assert.deepEqual(validateGuardrailPolicy(shipped), { ok: true, errors: [] });
});

test('P2: the shipped keys at every level are exactly the exported key lists', () => {
  assert.deepEqual(keyDrift(shipped), []);
});

test('P3: the evaluator reads exactly the rules the validator admits, and re-exports it', () => {
  const source = readFileSync(EVALUATOR, 'utf8');
  const read = new Set([...source.matchAll(/\brules\.([a-z_]+)/g)].map((match) => match[1]));
  assert.deepEqual(sorted(read), sorted(GUARDRAIL_RULE_KEYS));
  // Every other way to read a rule is one the scan above would miss.
  assert.doesNotMatch(source, /\brules\s*\[/, 'a rule read by computed key');
  assert.doesNotMatch(source, /\}\s*=\s*(policy\??\.)?rules\b/, 'rules destructured');
  assert.doesNotMatch(source, /\brules\s*\?\.\s*[a-z_]/, 'a rule read by optional chaining');
  for (const name of [
    'validateGuardrailPolicy',
    'GUARDRAIL_POLICY_KEYS',
    'GUARDRAIL_APPROVAL_KEYS',
    'GUARDRAIL_RULE_KEYS',
  ])
    assert.equal(evaluate[name], contracts[name], `${name} is not the contracts export`);
});

test('P4: docs/contracts.md says what checks the policy, and names only real fields', () => {
  const page = readFileSync(CONTRACTS_PAGE, 'utf8');
  const start = page.indexOf('\n## Outbound: guardrail binding\n');
  assert.ok(start >= 0, 'the Outbound section is gone');
  const end = page.indexOf('\n## ', start + 1);
  const section = page.slice(start, end < 0 ? undefined : end);
  for (const name of ['`validateGuardrailPolicy`', THIS_FILE, `${DECISIONS}/`])
    assert.ok(section.includes(name), `the section no longer names ${name}`);
  assert.match(section, /No route serves it/);
  assert.doesNotMatch(section, /nothing checks|no contract test|distributed only after/i);
  assert.deepEqual(identifiersNotFields(section), []);
});

// Every identifier the section puts in code font, a dotted one segment by segment, is a field
// guardrails/0 has or a name in this list. A span that is not an identifier - a path, a version
// such as guardrails/0, a command - names no field and is not read.
const NON_FIELD_IDENTIFIERS = new Set(['validateGuardrailPolicy']);
function identifiersNotFields(section) {
  const known = new Set([
    ...GUARDRAIL_POLICY_KEYS,
    ...GUARDRAIL_APPROVAL_KEYS,
    ...GUARDRAIL_RULE_KEYS,
  ]);
  const unknown = [];
  const seen = new Set();
  for (const [, span] of section.matchAll(/`([^`\n]+)`/g)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(span)) continue;
    if (NON_FIELD_IDENTIFIERS.has(span)) continue;
    for (const segment of span.split('.')) {
      seen.add(segment);
      if (!known.has(segment)) unknown.push(segment);
    }
  }
  // The section names both blocks today; a scan that stops seeing them has stopped reading.
  for (const name of ['approval', 'rules'])
    assert.ok(seen.has(name), `the field scan no longer reads \`${name}\` in the section`);
  return unknown;
}

test('P4: the field scan refuses a field guardrails/0 does not have', () => {
  const page = readFileSync(CONTRACTS_PAGE, 'utf8');
  const start = page.indexOf('\n## Outbound: guardrail binding\n');
  const end = page.indexOf('\n## ', start + 1);
  const section = page.slice(start, end);
  assert.deepEqual(identifiersNotFields(section), [], 'control: the shipped section passes');
  for (const [stray, named] of [
    ['`owner`', ['owner']],
    ['`approver`', ['approver']],
    ['`approval.owner`', ['owner']],
    ['`rules.blocked_tier`', ['blocked_tier']],
  ])
    assert.deepEqual(identifiersNotFields(`${section} ${stray}`), named, stray);
  assert.throws(() => identifiersNotFields('`policy_id` only'), /no longer reads `approval`/);
});

test('P5: the drift checks refuse a drifted copy of the shipped file', () => {
  const drifted = [
    ['an extra top-level key', (copy) => (copy.owner = 'platform')],
    ['effective_from dropped', (copy) => delete copy.effective_from],
    [
      'blocked_tiers renamed blocked_tier',
      (copy) => {
        copy.rules.blocked_tier = copy.rules.blocked_tiers;
        delete copy.rules.blocked_tiers;
      },
    ],
  ];
  for (const [name, edit] of drifted) {
    const copy = structuredClone(shipped);
    edit(copy);
    assert.equal(validateGuardrailPolicy(copy).ok, false, `P1 accepts ${name}`);
    assert.notDeepEqual(keyDrift(copy), [], `P2 accepts ${name}`);
  }
});

// ------------------------------------------------------------------- the decision record

// The record's file name is its decision id; a name that is not a plain file name cannot be one.
const RECORD_STEM = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const BULLET = /^- \*\*(Decision|Policy|Effective from)\*\*: (.+)$/;
const APPROVAL_LINE = /^Approved by (.+), (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\.$/;
// adr-conformance.test.mjs's rule: an approval is not dated in the future; one day of slack for
// time zones.
const LATEST_APPROVAL = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

// What the record says, read line by line and never trimmed: values are compared as written.
function parseDecisionRecord(text) {
  const lines = text.split('\n');
  const h2 = lines.map((line, index) => [line, index]).filter(([line]) => line.startsWith('## '));
  const indexOf = (heading) => h2.find(([line]) => line === heading)?.[1] ?? -1;
  const rulesAt = indexOf('## Rules');
  const approvalAt = indexOf('## Approval');
  const rulesLines =
    rulesAt < 0 ? [] : lines.slice(rulesAt + 1, approvalAt > rulesAt ? approvalAt : undefined);
  const fences = rulesLines.flatMap((line, index) => (line === '```json' ? [index] : []));
  let rules;
  let rulesError;
  if (fences.length === 1) {
    const close = rulesLines.indexOf('```', fences[0] + 1);
    try {
      rules = JSON.parse(rulesLines.slice(fences[0] + 1, close < 0 ? undefined : close).join('\n'));
    } catch {
      rulesError = 'the rules block is not JSON';
    }
  }
  return {
    h1: lines[0],
    bullets: lines
      .map((line) => BULLET.exec(line))
      .filter(Boolean)
      .map((m) => [m[1], m[2]]),
    h2: h2.map(([line]) => line),
    ruleBlocks: fences.length,
    rules,
    rulesError,
    approvals: lines
      .map((line, index) => [APPROVAL_LINE.exec(line), index])
      .filter(([match]) => match)
      .map(([match, index]) => ({
        by: match[1],
        at: match[2],
        underApproval: index > approvalAt && approvalAt >= 0,
      })),
  };
}

// Every way the record and the policy can disagree, as a list; [] means the record vouches for
// exactly this policy.
function decisionRecordProblems(text, stem, policy, latest = LATEST_APPROVAL) {
  const problems = [];
  const record = parseDecisionRecord(text);
  if (!validateGuardrailPolicy(policy).ok)
    problems.push('the policy fails validateGuardrailPolicy');
  if (!RECORD_STEM.test(stem)) problems.push('the file name is not a decision id');
  if (stem !== policy.approval?.decision_id)
    problems.push('the file name is not approval.decision_id');
  const title = `# ${stem}: `;
  if (!record.h1.startsWith(title) || !/\S/.test(record.h1.slice(title.length)))
    problems.push('the first line is not "# <decision-id>: <title>"');
  if (
    !isDeepStrictEqual(
      record.bullets.map(([name]) => name),
      ['Decision', 'Policy', 'Effective from'],
    )
  )
    problems.push(
      'the header bullets are not Decision, Policy, Effective from, once each, in order',
    );
  else {
    const [[, decision], [, policyId], [, effective]] = record.bullets;
    if (decision !== stem) problems.push('Decision is not the file name');
    if (policyId !== policy.policy_id) problems.push('Policy is not policy_id');
    if (effective !== policy.effective_from) problems.push('Effective from is not effective_from');
  }
  if (!isDeepStrictEqual(record.h2, ['## Rules', '## Approval']))
    problems.push('the H2 sections are not exactly Rules then Approval');
  if (record.ruleBlocks !== 1) problems.push('Rules does not hold exactly one json block');
  else if (record.rulesError) problems.push(record.rulesError);
  else if (!isDeepStrictEqual(record.rules, policy.rules)) problems.push('the rules differ');
  if (record.approvals.length !== 1) problems.push('there is not exactly one approval line');
  else {
    const [{ by, at, underApproval }] = record.approvals;
    if (!underApproval) problems.push('the approval line is not under Approval');
    if (by !== policy.approval?.approved_by)
      problems.push('the approver is not approval.approved_by');
    if (at !== policy.approval?.approved_at) problems.push('the date is not approval.approved_at');
    if (isPlaceholderText(by)) problems.push('the approver is a placeholder');
    if (!isUtcTimestamp(at)) problems.push('the date is not a UTC timestamp');
    else {
      if (isUtcTimestamp(policy.effective_from) && at > policy.effective_from)
        problems.push('the approval is dated after effective_from');
      if (at.slice(0, 10) > latest) problems.push('the approval is dated in the future');
    }
  }
  return problems;
}

const records = () =>
  existsSync(DECISIONS) ? readdirSync(DECISIONS, { withFileTypes: true }) : [];

test('P6: the decisions directory holds only decision records, and each one parses', () => {
  const entries = records();
  assert.ok(entries.length > 0, `${DECISIONS} holds no decision record`);
  for (const entry of entries) {
    assert.ok(entry.isFile(), `${entry.name} is not a file`);
    assert.match(entry.name, /\.md$/, `${entry.name} is not a .md record`);
    const stem = entry.name.slice(0, -'.md'.length);
    assert.match(stem, RECORD_STEM, `${entry.name} is not named <decision-id>.md`);
    const record = parseDecisionRecord(readFileSync(join(DECISIONS, entry.name), 'utf8'));
    assert.equal(record.bullets.length, 3, `${entry.name}: header bullets`);
    assert.equal(record.ruleBlocks, 1, `${entry.name}: rules block`);
    assert.equal(record.rulesError, undefined, `${entry.name}: ${record.rulesError}`);
    assert.equal(record.approvals.length, 1, `${entry.name}: approval line`);
  }
});

const shippedRecordPath = () => join(DECISIONS, `${shipped.approval.decision_id}.md`);

test('P7: the shipped approval resolves to a decision record that matches it', () => {
  assert.ok(existsSync(shippedRecordPath()), `no decision record at ${shippedRecordPath()}`);
  const text = readFileSync(shippedRecordPath(), 'utf8');
  assert.deepEqual(decisionRecordProblems(text, shipped.approval.decision_id, shipped), []);
});

test('P8: the record check refuses the edits a hurried approval would make', () => {
  const policy = {
    policy_version: 'guardrails/0',
    policy_id: 'test-policy@1',
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
  const write = ({
    rules = policy.rules,
    approval = 'Approved by test-approver, 2026-01-01T00:00:00Z.',
  } = {}) =>
    [
      '# TEST-DECISION-1: A synthetic decision for this test',
      '',
      '- **Decision**: TEST-DECISION-1',
      '- **Policy**: test-policy@1',
      '- **Effective from**: 2026-01-01T00:00:00Z',
      '',
      'Prose, not parsed.',
      '',
      '## Rules',
      '',
      '```json',
      JSON.stringify(rules, null, 2),
      '```',
      '',
      '## Approval',
      '',
      approval,
      '',
    ].join('\n');
  const good = write();
  const problems = (text, stem = 'TEST-DECISION-1', against = policy, latest = '2026-10-22') =>
    decisionRecordProblems(text, stem, against, latest);
  assert.deepEqual(problems(good), [], 'control: the synthetic record matches its policy');
  const swap = (from, to) => {
    assert.ok(good.includes(from), from);
    return good.replace(from, to);
  };
  const future = structuredClone(policy);
  future.effective_from = '2999-01-01T00:00:00Z';
  future.approval.approved_at = '2999-01-01T00:00:00Z';
  const tbd = structuredClone(policy);
  tbd.approval.approved_by = 'TBD';
  const probes = [
    ['a missing bullet', problems(swap('- **Policy**: test-policy@1\n', '')), 'header bullets'],
    [
      'reordered bullets',
      problems(
        swap(
          '- **Decision**: TEST-DECISION-1\n- **Policy**: test-policy@1\n',
          '- **Policy**: test-policy@1\n- **Decision**: TEST-DECISION-1\n',
        ),
      ),
      'header bullets',
    ],
    [
      'a duplicated bullet',
      problems(
        swap(
          '- **Policy**: test-policy@1\n',
          '- **Policy**: test-policy@1\n- **Policy**: test-policy@1\n',
        ),
      ),
      'header bullets',
    ],
    [
      'Decision is not the file name',
      problems(swap('- **Decision**: TEST-DECISION-1', '- **Decision**: TEST-DECISION-2')),
      'Decision is not',
    ],
    [
      'the file is not the decision id',
      problems(good, 'TEST-DECISION-2'),
      'file name is not approval',
    ],
    [
      'Policy differs',
      problems(swap('- **Policy**: test-policy@1', '- **Policy**: test-policy@2')),
      'Policy is not',
    ],
    [
      'Effective from differs',
      problems(
        swap(
          '- **Effective from**: 2026-01-01T00:00:00Z',
          '- **Effective from**: 2026-01-02T00:00:00Z',
        ),
      ),
      'Effective from is not',
    ],
    ['no rules block', problems(swap('```json', '```')), 'json block'],
    [
      'an added rule key',
      problems(write({ rules: { ...policy.rules, extra: true } })),
      'rules differ',
    ],
    [
      'a changed rule value',
      problems(write({ rules: { ...policy.rules, blocked_tiers: ['T3'] } })),
      'rules differ',
    ],
    [
      'two approval lines',
      problems(
        write({
          approval:
            'Approved by test-approver, 2026-01-01T00:00:00Z.\nApproved by test-approver, 2026-01-01T00:00:00Z.',
        }),
      ),
      'exactly one approval line',
    ],
    [
      'the approver differs by case',
      problems(write({ approval: 'Approved by Test-approver, 2026-01-01T00:00:00Z.' })),
      'approver is not',
    ],
    [
      'the approver has a trailing space',
      problems(write({ approval: 'Approved by test-approver , 2026-01-01T00:00:00Z.' })),
      'approver is not',
    ],
    [
      'approved_at differs',
      problems(write({ approval: 'Approved by test-approver, 2025-12-31T00:00:00Z.' })),
      'date is not approval',
    ],
    [
      'an approval dated after tomorrow',
      problems(
        swap('2026-01-01T00:00:00Z.', '2999-01-01T00:00:00Z.').replace(
          '- **Effective from**: 2026-01-01T00:00:00Z',
          '- **Effective from**: 2999-01-01T00:00:00Z',
        ),
        'TEST-DECISION-1',
        future,
      ),
      'dated in the future',
    ],
    [
      'approver TBD',
      problems(
        write({ approval: 'Approved by TBD, 2026-01-01T00:00:00Z.' }),
        'TEST-DECISION-1',
        tbd,
      ),
      'approver is a placeholder',
    ],
    [
      'an unfilled template',
      problems(write({ approval: 'Approved by <approved_by>, <approved_at>.' })),
      'exactly one approval line',
    ],
    ['an extra H2', problems(swap('## Approval', '## Notes\n\n## Approval')), 'H2 sections'],
  ];
  for (const [name, found, expected] of probes)
    assert.ok(
      found.some((problem) => problem.includes(expected)),
      `${name}: expected a problem containing "${expected}", got ${JSON.stringify(found)}`,
    );
});

test('P9: the shipped record was read, not skipped', () => {
  const record = parseDecisionRecord(readFileSync(shippedRecordPath(), 'utf8'));
  assert.equal(record.bullets.length, 3);
  assert.ok(isObject(record.rules) && Object.keys(record.rules).length > 0, 'no rules were read');
  assert.equal(record.approvals.length, 1);
});
