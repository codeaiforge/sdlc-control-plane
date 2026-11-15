import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { EVIDENCE_SCHEMA_VERSION, validateEvidence } from './schema.mjs';

// The engine's evidence/0 schema is vendored beside this package as a reference, not as the
// validator: validateEvidence checks the minimum stable subset by hand (NFR-1.1, the roadmap risk
// register). A reference copy is only worth keeping if something holds the two together, so this
// file checks that the copy is the one SOURCE.md records, that the engine still tolerates additive
// fields and still rejects an unknown major, that the subset never requires a field the engine
// lets a real gate record omit, and that records shaped like the pinned gate's pass the subset.
// Each check is a function returning its problems, run once on the real inputs and once on a
// mutated copy, so a check cannot stay green by reading nothing.

const DIR = new URL('../schemas/evidence/0/', import.meta.url);
const BYTES = readFileSync(new URL('evidence.schema.json', DIR));
const SOURCE = readFileSync(new URL('SOURCE.md', DIR), 'utf8');
const SCHEMA = JSON.parse(BYTES.toString('utf8'));
const clone = (value) => structuredClone(value);

// Records as sdlc-controls v0.3.0 writes them: the engine's own TraderX example
// (examples/traderx/evidence/t0-web-client.json at v0.3.0), and a blocked T3 change.
const GATE_PASS = {
  schema_version: 'evidence/0',
  tool: { name: 'sdlc-controls', version: '0.3.0' },
  change_id: 'DEMO-t0-web-client',
  binding_used: 'git-native-baseline@2',
  tier: 'T0',
  affected_set: ['web-client'],
  unmatched_set: [],
  reasons: ['web-client criticality=low -> base T0'],
  controls_enforced: { min_approvers: 1, checks: ['lint'], deploy_approval: 'standard' },
  ai_assisted: false,
  accountable_approver: 'bob',
  approver_ne_author: true,
  approver_count: 1,
  approvers_other_than_author: 1,
  author: 'alice',
  head: '03871d33322af12ad5cf250239e0a23f2a5be1c1',
  self_escalated: false,
  verification: {
    approvers_supplied: true,
    verified: [
      'CAF-SDLC-002:tier',
      'CAF-SDLC-011:approver-count',
      'CAF-SDLC-011:independent-approver',
    ],
    recorded_not_verified: ['CAF-SDLC-010:ai-authorship', 'required-checks', 'deploy-approval'],
  },
  result: { pass: true, exit_code: 0, violations: [], violated: [] },
  map_version: 1,
  computed_at: '2026-10-19T15:27:05.445898209Z',
};
const GATE_BLOCKED = {
  ...clone(GATE_PASS),
  change_id: 'PR-7@c0ffee/1001.1',
  tier: 'T3',
  affected_set: ['alpha'],
  reasons: ['alpha criticality=critical -> base T3'],
  controls_enforced: { min_approvers: 2, checks: ['lint', 'sast'] },
  ai_assisted: true,
  ai_tool: 'claude-code',
  approver_count: 0,
  approvers_other_than_author: 0,
  verification: {
    approvers_supplied: true,
    verified: ['CAF-SDLC-002:tier', 'CAF-SDLC-011:approver-count'],
    recorded_not_verified: ['required-checks'],
  },
  result: {
    pass: false,
    exit_code: 1,
    violations: ['T3 needs 2 approvers other than the author; 0 approved'],
    violated: ['CAF-SDLC-011:approver-count'],
  },
};
const GATE_RECORDS = [GATE_PASS, GATE_BLOCKED];

// ------------------------------------------------------------------------------- (a) the copy

const recordedSha = (source) => /\| sha256 \| `([0-9a-f]{64})`/.exec(source)?.[1];
function shaProblems(bytes, source) {
  const recorded = recordedSha(source);
  if (!recorded) return ['SOURCE.md records no sha256'];
  const actual = createHash('sha256').update(bytes).digest('hex');
  return actual === recorded ? [] : [`sha256 ${actual} is not the recorded ${recorded}`];
}

test('the vendored schema is the file SOURCE.md records, by sha256, from a named tag', () => {
  assert.deepEqual(shaProblems(BYTES, SOURCE), []);
  assert.match(SOURCE, /\| Tag +\| `v\d+\.\d+\.\d+` \(commit `[0-9a-f]{40}`\)/);
});

test('a changed byte, or a SOURCE.md without a sha256, is caught', () => {
  assert.equal(shaProblems(Buffer.concat([BYTES, Buffer.from(' ')]), SOURCE).length, 1);
  assert.deepEqual(shaProblems(BYTES, SOURCE.replace(/\| sha256 \|.*\n/, '')), [
    'SOURCE.md records no sha256',
  ]);
});

// ----------------------------------------------------------------------------- (b) NFR-1.1

// Every node of the schema, whatever keyword holds it: a closed object anywhere would make a
// pinned copy refuse the next engine release's additive field.
function closedNodes(node, path = '#') {
  if (node === null || typeof node !== 'object') return [];
  const problems = [];
  if (node.additionalProperties === false) problems.push(`${path} sets additionalProperties false`);
  if (Object.hasOwn(node, 'unevaluatedProperties'))
    problems.push(`${path} sets unevaluatedProperties`);
  for (const [key, child] of Object.entries(node))
    problems.push(...closedNodes(child, `${path}/${key}`));
  return problems;
}

// The major is expressible in the schema: schema_version is required and fixed by `const`, so a
// record of any other major fails it.
function majorProblems(schema) {
  const problems = [];
  if (!schema.required?.includes('schema_version')) problems.push('schema_version is not required');
  if (schema.properties?.schema_version?.const !== EVIDENCE_SCHEMA_VERSION)
    problems.push(`schema_version is not fixed to ${EVIDENCE_SCHEMA_VERSION} by const`);
  return problems;
}

test('the engine schema tolerates additive fields at every level and fixes the major (NFR-1.1)', () => {
  assert.deepEqual(closedNodes(SCHEMA), []);
  assert.deepEqual(majorProblems(SCHEMA), []);
  // The subset agrees on both halves: an additive field passes and another major does not.
  assert.deepEqual(validateEvidence({ ...GATE_PASS, a_later_field: { nested: 1 } }), {
    ok: true,
    errors: [],
  });
  assert.equal(validateEvidence({ ...GATE_PASS, schema_version: 'evidence/1' }).ok, false);
});

test('a closed object anywhere, or a major no longer fixed, is caught', () => {
  const closed = clone(SCHEMA);
  closed.$defs.result.additionalProperties = false;
  assert.deepEqual(closedNodes(closed), ['#/$defs/result sets additionalProperties false']);
  const unevaluated = clone(SCHEMA);
  unevaluated.properties.tool = { ...unevaluated.properties.tool, unevaluatedProperties: false };
  assert.deepEqual(closedNodes(unevaluated), ['#/properties/tool sets unevaluatedProperties']);
  const open = clone(SCHEMA);
  delete open.properties.schema_version.const;
  open.required = open.required.filter((key) => key !== 'schema_version');
  assert.equal(majorProblems(open).length, 2);
});

// ------------------------------------------------------- (c) the subset inside the engine's set

// The subset's required fields, read from validateEvidence itself rather than copied here: a leaf
// of a real gate record is required when the record without it fails the subset. A field the
// subset might come to require that no gate record carries is caught by (d) instead.
function leaves(value, path = []) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [path];
  return Object.entries(value).flatMap(([key, child]) => leaves(child, [...path, key]));
}
function without(record, path) {
  const copy = clone(record);
  const parent = path.slice(0, -1).reduce((node, key) => node[key], copy);
  delete parent[path.at(-1)];
  return copy;
}
function replaced(record, path, value) {
  const copy = clone(record);
  const parent = path.slice(0, -1).reduce((node, key) => node[key], copy);
  parent[path.at(-1)] = value;
  return copy;
}
const SUBSET_REQUIRED = leaves(GATE_PASS).filter(
  (path) => !validateEvidence(without(GATE_PASS, path)).ok,
);

const resolve = (schema, node) => {
  if (node?.$ref === undefined) return node;
  const name = /^#\/\$defs\/(\w+)$/.exec(node.$ref)?.[1];
  return resolve(schema, schema.$defs?.[name]);
};

// What the engine admits at a leaf, as sample values of every kind its own keywords allow there.
function engineSamples(node, current) {
  if (Object.hasOwn(node, 'const')) return [node.const];
  if (node.enum) return node.enum;
  const byType = {
    string: [typeof current === 'string' ? current : 'x'],
    boolean: [true, false],
    integer: [0, 1],
    array: Array.isArray(current) ? [[], current] : [[]],
  };
  return byType[node.type] ?? [];
}

// For each subset-required path: every segment is in the engine's required list of its parent,
// the leaf has a type, and every value the engine admits there the subset admits too, so the
// subset can never demand something a real gate record may legitimately carry or omit.
function subsetProblems(schema, record, paths) {
  const problems = [];
  for (const path of paths) {
    const name = path.join('.');
    let node = schema;
    for (const key of path) {
      node = resolve(schema, node);
      if (!node?.required?.includes(key)) problems.push(`${name}: engine does not require ${key}`);
      node = node?.properties?.[key];
    }
    node = resolve(schema, node);
    if (!node) {
      problems.push(`${name}: engine schema has no such field`);
      continue;
    }
    const current = path.reduce((value, key) => value[key], record);
    const samples = engineSamples(node, current);
    if (samples.length === 0) problems.push(`${name}: engine gives it no type or value set`);
    for (const sample of samples)
      if (!validateEvidence(replaced(record, path, sample)).ok)
        problems.push(
          `${name}: the subset refuses ${JSON.stringify(sample)}, which the engine admits`,
        );
  }
  return problems;
}

test('the subset requires only what the engine requires, at the same path and type', () => {
  // The read must find the subset, or this test checks nothing.
  assert.ok(SUBSET_REQUIRED.length >= 10, `subset read as ${SUBSET_REQUIRED.join(', ')}`);
  for (const path of ['schema_version', 'tool.name', 'verification.verified', 'result.pass'])
    assert.ok(
      SUBSET_REQUIRED.some((found) => found.join('.') === path),
      path,
    );
  assert.deepEqual(subsetProblems(SCHEMA, GATE_PASS, SUBSET_REQUIRED), []);
});

test('a subset field the engine stops requiring, or retypes, is caught', () => {
  const optional = clone(SCHEMA);
  optional.required = optional.required.filter((key) => key !== 'change_id');
  assert.deepEqual(subsetProblems(optional, GATE_PASS, SUBSET_REQUIRED), [
    'change_id: engine does not require change_id',
  ]);
  const nested = clone(SCHEMA);
  nested.$defs.result.required = ['exit_code', 'violations'];
  assert.deepEqual(subsetProblems(nested, GATE_PASS, SUBSET_REQUIRED), [
    'result.pass: engine does not require pass',
  ]);
  const retyped = clone(SCHEMA);
  retyped.$defs.result.properties.pass = { type: 'string' };
  assert.deepEqual(subsetProblems(retyped, GATE_PASS, SUBSET_REQUIRED), [
    'result.pass: the subset refuses "x", which the engine admits',
  ]);
  const widened = clone(SCHEMA);
  widened.$defs.tier.enum = [...widened.$defs.tier.enum, 'T4'];
  assert.deepEqual(subsetProblems(widened, GATE_PASS, SUBSET_REQUIRED), [
    'tier: the subset refuses "T4", which the engine admits',
  ]);
});

// --------------------------------------------------------------- (d) real-shaped records pass

test('records shaped as the pinned gate writes them pass the subset', () => {
  for (const record of GATE_RECORDS)
    assert.deepEqual(validateEvidence(record), { ok: true, errors: [] }, record.change_id);
});

test('a gate-shaped record missing a subset field fails the subset', () => {
  for (const path of SUBSET_REQUIRED)
    assert.equal(validateEvidence(without(GATE_BLOCKED, path)).ok, false, path.join('.'));
});
