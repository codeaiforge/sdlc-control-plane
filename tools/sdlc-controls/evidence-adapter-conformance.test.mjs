import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import * as adapter from '../../packages/evidence-adapter/src/submit-evidence.mjs';
import { MAX_BODY_BYTES } from '../../packages/control-plane-api/src/admission.mjs';
import * as identity from '../../packages/workload-identity/src/constants.mjs';

// The evidence adapter's conformance check (task 3.1; threat model TB-9, MIT-20).
//
// packages/evidence-adapter imports nothing - it runs on a workspace's runner with no install -
// so the values it shares with the control plane are written twice, and this file holds the
// copies equal the way assertIssuerAgreement holds the issuer. It also holds the adapter to
// importing nothing and reading only the variables it documents, and holds the reusable workflow
// that runs it to the job shape ADR-0003 requires (AC-8).
//
// The imports above add no graph edge: tools/ is not an Nx project, so graph-fidelity's import
// scan (packages/*/src/ only) never sees them - the reasoning threat-model-conformance.test.mjs
// records for its own import of main.mjs. Picked up by the tools/sdlc-controls/*.test.mjs glob.
//
// What it cannot hold: that GitHub fills job.workflow_sha with the SHA the token's
// job_workflow_sha claims, that the runner is ephemeral, or what any claim says on a real run.
// Those are measurements (task 3.3, MIT-21), not file shapes.

const ADAPTER = 'packages/evidence-adapter/src/submit-evidence.mjs';
const WORKFLOW = '.github/workflows/submit-evidence.yml';
const SOURCE = readFileSync(ADAPTER, 'utf8');

// Comments stripped, so prose is never mistaken for code: a block comment, and a line comment
// that starts the line or follows whitespace - never the `//` inside a URL.
const codeOf = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
const CODE = codeOf(SOURCE);

// ---------------------------------------------------------------- C1, C2: copies held equal

test('C1 the adapter mints for the audience the verifier accepts', () => {
  assert.equal(adapter.AUDIENCE, identity.AUDIENCE);
});

test('C2 the adapter refuses locally what the control plane would refuse', () => {
  assert.equal(adapter.MAX_EVIDENCE_BYTES, MAX_BODY_BYTES);
  assert.equal(adapter.MAX_TOKEN_BYTES, identity.MAX_TOKEN_BYTES);
});

// --------------------------------------------------------- C3, C4, C5: a leaf that reads little

test('C3 the adapter imports node: built-ins and nothing else', () => {
  const specifiers = [
    ...CODE.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
    ...CODE.matchAll(/\bimport\s*\(\s*['"]([^'"]*)['"]/g),
    ...CODE.matchAll(/\bimport\s+['"]([^'"]+)['"]/g),
  ].map((match) => match[1]);
  assert.ok(specifiers.length >= 5, 'the import scan found the imports');
  assert.deepEqual(
    specifiers.filter((specifier) => !specifier.startsWith('node:')),
    [],
    `${ADAPTER} imports something other than a node: built-in; it runs with no install`,
  );
  assert.doesNotMatch(CODE, /\brequire\s*\(|\bimport\s*\(\s*[^'"]/);
});

const ENTRYPOINT = 'if (isEntrypoint(process.argv[1], import.meta.url)) {';
const DOCUMENTED = [
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'GITHUB_STEP_SUMMARY',
];

test('C4 process is named only by the entrypoint, and only the documented variables are read', () => {
  const at = CODE.indexOf(ENTRYPOINT);
  assert.ok(at > 0, `${ADAPTER} has no entrypoint statement "${ENTRYPOINT}"`);
  assert.equal(CODE.indexOf(ENTRYPOINT, at + 1), -1, 'one entrypoint statement');
  const body = CODE.slice(0, at);
  for (const spelling of [
    /\bprocess\b/,
    /['"]node:process['"]/,
    /\bgetenv\b/i,
    /import\.meta\.env/,
  ])
    assert.doesNotMatch(body, spelling, `${ADAPTER} reaches the process outside its entrypoint`);
  const tail = CODE.slice(at);
  assert.deepEqual(
    [...tail.matchAll(/\bprocess\.(\w+)/g)].map((match) => match[1]).sort(),
    ['argv', 'argv', 'env', 'exitCode', 'exitCode', 'stdout'],
    'the entrypoint touches only argv, env, stdout and exitCode',
  );
  assert.doesNotMatch(CODE, /\benv\??\.?\[/, 'a variable read by computed name cannot be checked');
  const read = new Set([...CODE.matchAll(/\benv\??\.([A-Z][A-Z0-9_]*)/g)].map((match) => match[1]));
  assert.deepEqual([...read].sort(), DOCUMENTED);
});

test('C5 no non-test module of control-plane-api imports the adapter, so the service does not ship it', () => {
  const dir = 'packages/control-plane-api/src';
  const shipped = readdirSync(dir).filter((file) => !/\.(test|integration)\.mjs$/.test(file));
  assert.ok(shipped.includes('main.mjs'));
  for (const file of shipped)
    assert.doesNotMatch(readFileSync(`${dir}/${file}`, 'utf8'), /evidence-adapter\//, file);
});

// ------------------------------------------------------------------ a deliberately small YAML

// The reusable workflow is read by this reader and nothing else, so the shape test below reads
// what GitHub reads only for the constructs this reader understands - and it refuses every other
// one, rather than guess: anchors, aliases, tags, directives, a second document, complex keys,
// flow collections other than the empty mapping {}, block scalars other than `run: |`, tab
// indentation and repeated keys all throw. Every scalar stays a string. No dependency (Q-11).
function readYamlSubset(text) {
  const lines = text.split('\n');
  let index = 0;
  const fail = (message, at = index) => {
    throw new Error(`yaml-subset: line ${at + 1}: ${message}`);
  };

  // A line's content with its comment removed: a # at the start or after whitespace, outside
  // quotes, begins a comment.
  const strip = (line) => {
    let quote = null;
    for (let at = 0; at < line.length; at += 1) {
      const char = line[at];
      if (quote) {
        if (char === quote) quote = null;
      } else if (char === "'" || char === '"') quote = char;
      else if (char === '#' && (at === 0 || /\s/.test(line[at - 1])))
        return line.slice(0, at).trimEnd();
    }
    return line.trimEnd();
  };
  const indentOf = (line) => {
    const lead = /^[ \t]*/.exec(line)[0];
    if (lead.includes('\t')) fail('tab in indentation');
    return lead.length;
  };
  // The next line that carries content, or null.
  const peek = () => {
    while (index < lines.length) {
      const content = strip(lines[index]);
      if (content.trim() !== '') {
        if (/^(---|\.\.\.)(\s|$)/.test(content)) fail('a document marker: one document only');
        if (/^%/.test(content)) fail('a directive');
        return { indent: indentOf(content), content: content.trim() };
      }
      index += 1;
    }
    return null;
  };

  const scalar = (raw) => {
    if (raw === '{}') return {};
    if (/^[{[]/.test(raw)) fail('a flow collection other than {}');
    if (/^[&*!%@`|>?]/.test(raw)) fail(`an indicator this reader does not understand: ${raw[0]}`);
    if (raw.startsWith("'")) {
      const match = /^'((?:[^']|'')*)'$/.exec(raw);
      if (!match) fail('a malformed single-quoted scalar');
      return match[1].replace(/''/g, "'");
    }
    if (raw.startsWith('"')) {
      if (!/^"(?:[^"\\]|\\["\\nt])*"$/.test(raw))
        fail('a double-quoted scalar this reader does not understand');
      return JSON.parse(raw);
    }
    if (/:\s|\s#|:$/.test(raw)) fail('a plain scalar this reader cannot split');
    return raw;
  };

  const blockScalar = (parentIndent) => {
    const body = [];
    let contentIndent = null;
    while (index < lines.length) {
      const line = lines[index];
      if (line.trim() === '') {
        body.push('');
        index += 1;
        continue;
      }
      const indent = indentOf(line);
      if (indent <= parentIndent) break;
      contentIndent ??= indent;
      if (indent < contentIndent) fail('a block scalar line indented less than its first');
      body.push(line.slice(contentIndent));
      index += 1;
    }
    while (body.length > 0 && body.at(-1) === '') body.pop();
    return `${body.join('\n')}\n`;
  };

  const keyValue = (content) => {
    const match = /^([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(content);
    if (!match) fail(`not a "key: value" line this reader understands: ${content}`);
    return [match[1], match[2] ?? ''];
  };

  function mapping(indent) {
    const result = {};
    for (let next = peek(); next !== null && next.indent === indent; next = peek()) {
      if (next.content.startsWith('-')) fail('a sequence item where a mapping key belongs');
      const [key, rest] = keyValue(next.content);
      if (Object.hasOwn(result, key)) fail(`the key ${key} is repeated`);
      index += 1;
      if (rest === '|') {
        if (key !== 'run') fail('a block scalar outside run:');
        result[key] = blockScalar(indent);
      } else if (rest === '') {
        const child = peek();
        result[key] = child !== null && child.indent > indent ? block(child.indent) : null;
      } else {
        result[key] = scalar(rest);
        const child = peek();
        if (child !== null && child.indent > indent) fail('indented content after a scalar value');
      }
    }
    return result;
  }

  function sequence(indent) {
    const result = [];
    for (let next = peek(); next !== null && next.indent === indent; next = peek()) {
      if (!/^-(\s|$)/.test(next.content)) fail('a mapping key where a sequence item belongs');
      const item = next.content.slice(1).trim();
      if (item === '') {
        index += 1;
        const child = peek();
        result.push(child !== null && child.indent > indent ? block(child.indent) : null);
      } else if (/^[A-Za-z0-9_-]+:(\s|$)/.test(item)) {
        // `- key: value` opens a mapping whose keys sit two columns in.
        lines[index] = `${' '.repeat(indent + 2)}${item}`;
        result.push(mapping(indent + 2));
      } else {
        index += 1;
        result.push(scalar(item));
      }
    }
    return result;
  }

  function block(indent) {
    const next = peek();
    return /^-(\s|$)/.test(next.content) ? sequence(indent) : mapping(indent);
  }

  const first = peek();
  if (first === null || first.indent !== 0) fail('no top-level mapping');
  const document = mapping(0);
  if (peek() !== null) fail('content this reader did not consume');
  return document;
}

test('C7 the YAML-subset reader reads its grammar and refuses everything else', () => {
  assert.deepEqual(
    readYamlSubset(
      [
        '# a comment',
        'name: x # trailing',
        'on:',
        '  workflow_call:',
        'permissions: {}',
        'jobs:',
        '  a:',
        "    if: github.server_url == 'https://github.com'",
        '    steps:',
        '      - uses: o/r@abc # v1',
        '        with:',
        '          path: "p"',
        '      - run: |',
        '          echo one # not a yaml comment',
        '',
        '          echo two',
        '',
      ].join('\n'),
    ),
    {
      name: 'x',
      on: { workflow_call: null },
      permissions: {},
      jobs: {
        a: {
          if: "github.server_url == 'https://github.com'",
          steps: [
            { uses: 'o/r@abc', with: { path: 'p' } },
            { run: 'echo one # not a yaml comment\n\necho two\n' },
          ],
        },
      },
    },
  );
  const refused = {
    anchor: 'a: &x 1\nb: 2\n',
    alias: 'a: 1\nb: *a\n',
    tag: 'a: !!str 1\n',
    'second document': 'a: 1\n---\nb: 2\n',
    'flow mapping': 'a: { b: 1 }\n',
    'flow sequence': 'a: [1, 2]\n',
    'folded scalar': 'run: >\n  x\n',
    'block scalar outside run': 'script: |\n  x\n',
    'tab indentation': 'a:\n\tb: 1\n',
    'repeated key': 'a: 1\na: 2\n',
    'complex key': '? a\n: 1\n',
    'ambiguous plain scalar': 'a: b: c\n',
    directive: '%YAML 1.2\na: 1\n',
  };
  for (const [name, text] of Object.entries(refused))
    assert.throws(() => readYamlSubset(text), /yaml-subset/, name);
});

// ------------------------------------------------------------------------- C6: the job shape

const WORKFLOW_TEXT = readFileSync(WORKFLOW, 'utf8');
const workflow = readYamlSubset(WORKFLOW_TEXT);
const RUNNERS = ['ubuntu-latest', 'ubuntu-24.04', 'ubuntu-22.04'];
const PINNED_ACTION = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/;
const RUN = [
  'set -u',
  'status=0',
  'node evidence-adapter/packages/evidence-adapter/src/submit-evidence.mjs "$RECORD" || status=$?',
  'if [ "$status" -eq 3 ]; then exit 0; fi',
  'exit "$status"',
];

test('C6 the workflow is called only, takes nothing from its caller, and grants nothing at the top', () => {
  assert.deepEqual(Object.keys(workflow).sort(), ['jobs', 'name', 'on', 'permissions']);
  assert.deepEqual(
    workflow.on,
    { workflow_call: null },
    'workflow_call only, with no inputs or secrets',
  );
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(Object.keys(workflow.jobs), ['submit'], 'exactly one job');
});

test('C6 the one job holds id-token alone, on a GitHub-hosted runner, inside five minutes', () => {
  const job = workflow.jobs.submit;
  assert.deepEqual(Object.keys(job).sort(), [
    'if',
    'permissions',
    'runs-on',
    'steps',
    'timeout-minutes',
  ]);
  assert.equal(job.if, "github.server_url == 'https://github.com'");
  assert.deepEqual(job.permissions, { 'id-token': 'write', contents: 'read' });
  assert.ok(
    RUNNERS.includes(job['runs-on']),
    `runs-on ${job['runs-on']} is not a GitHub-hosted label`,
  );
  assert.match(job['timeout-minutes'], /^[1-5]$/);
});

test("C6 every action is pinned by SHA, and the one checkout is this workflow's own source", () => {
  const { steps } = workflow.jobs.submit;
  const uses = steps.filter((step) => Object.hasOwn(step, 'uses')).map((step) => step.uses);
  assert.ok(uses.length >= 3);
  for (const action of uses)
    assert.match(action, PINNED_ACTION, `${action} is not pinned to a commit`);
  const checkouts = steps.filter((step) => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkouts.length, 1, 'exactly one checkout');
  assert.deepEqual(checkouts[0].with, {
    repository: '${{ job.workflow_repository }}',
    ref: '${{ job.workflow_sha }}',
    path: 'evidence-adapter',
    'sparse-checkout': ADAPTER,
    'sparse-checkout-cone-mode': 'false',
    'persist-credentials': 'false',
  });
});

test('C6 the one script runs only the adapter, maps no-record to success, and interpolates nothing', () => {
  const scripts = workflow.jobs.submit.steps.filter((step) => Object.hasOwn(step, 'run'));
  assert.equal(scripts.length, 1);
  const lines = scripts[0].run
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  assert.deepEqual(lines, RUN);
  assert.equal(scripts[0].run.includes('${{'), false, 'no expression inside run:');
  assert.deepEqual(scripts[0].env, {
    RECORD: '${{ runner.temp }}/sdlc-controls-evidence/evidence.json',
  });
});

test('C6 an expression appears only in with:, env: and if:, and names nothing the caller controls', () => {
  const misplaced = [];
  const walk = (value, path) => {
    if (typeof value === 'string') {
      const under = path.slice(-2);
      if (
        value.includes('${{') &&
        !(under[0] === 'with' || under[0] === 'env' || under.at(-1) === 'if')
      )
        misplaced.push(path.join('.'));
    } else if (value !== null && typeof value === 'object')
      for (const [key, item] of Object.entries(value)) walk(item, [...path, key]);
  };
  walk(workflow, []);
  assert.deepEqual(misplaced, []);
  const code = WORKFLOW_TEXT.split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
  for (const name of ['inputs.', 'secrets.', 'github.event', 'github.head_ref'])
    assert.equal(code.includes(name), false, `${WORKFLOW} names ${name}`);
});
