import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
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
// flow collections other than the empty mapping {}, block scalars other than `run: |`, tabs and
// repeated keys all throw. So does any character another YAML parser could read as a line break
// or as whitespace where this reader does not (a carriage return, U+0085, U+2028, U+2029, a BOM,
// a no-break space, any control character), even inside a comment: a line this reader drops as a
// comment must be one line to every parser. Outside comments only printable ASCII is read.
// Every scalar stays a string. No dependency (Q-11).
function readYamlSubset(text) {
  const lines = text.split('\n');
  let index = 0;
  const fail = (message, at = index) => {
    throw new Error(`yaml-subset: line ${at + 1}: ${message}`);
  };
  lines.forEach((line, at) => {
    if (/[\x00-\x1F\x7F-\x9F]|[^\S ]/u.test(line))
      fail('a control character, or whitespace other than a space', at);
  });
  const ascii = (content) => {
    if (/[^\x20-\x7E]/.test(content))
      fail('a character outside printable ASCII, outside a comment');
    return content;
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
  const indentOf = (line) => /^ */.exec(line)[0].length;
  // The next line that carries content, or null.
  const peek = () => {
    while (index < lines.length) {
      const content = strip(lines[index]);
      if (content.trim() !== '') {
        if (/^(---|\.\.\.)(\s|$)/.test(content)) fail('a document marker: one document only');
        if (/^%/.test(content)) fail('a directive');
        return { indent: indentOf(content), content: ascii(content.trim()) };
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
      body.push(ascii(line.slice(contentIndent)));
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
    'tab separator': 'a:\tb\n',
    'carriage return in a comment': `a: 1 # x${String.fromCharCode(13)}b: 2\n`,
    'U+2028 in a comment': `a: 1 # x${String.fromCharCode(0x2028)}b: 2\n`,
    'U+0085 in a comment': `a: 1 # x${String.fromCharCode(0x85)}b: 2\n`,
    'no-break space indentation': `a:\n${String.fromCharCode(0xa0)} b: 1\n`,
    'byte order mark': `${String.fromCharCode(0xfeff)}a: 1\n`,
    'non-ASCII outside a comment': `a: ${String.fromCharCode(0xe9)}\n`,
    'repeated key': 'a: 1\na: 2\n',
    'complex key': '? a\n: 1\n',
    'ambiguous plain scalar': 'a: b: c\n',
    directive: '%YAML 1.2\na: 1\n',
  };
  for (const [name, text] of Object.entries(refused))
    assert.throws(() => readYamlSubset(text), /yaml-subset/, name);
});

// ------------------------------------------------------------------------- C6: the job shape

// The whole file, held exactly: every key at every level, every step in order with its exact key
// set and values, and the three actions at their reviewed commits. Anything not written here - a
// working-directory, a shell, a step if: or continue-on-error, an env var such as NODE_OPTIONS,
// another download path, a fourth action - can put caller code or the token within reach of the
// token job (TB-9, ABU-17), so admitting it means editing this test. Only runs-on and
// timeout-minutes keep the latitude AC-8 gives them.
const WORKFLOW_TEXT = readFileSync(WORKFLOW, 'utf8');
const RUNNERS = ['ubuntu-latest', 'ubuntu-24.04', 'ubuntu-22.04'];
// Literal, never ${{ job.workflow_repository }}: checkout reads an empty repository as the
// caller's, at the caller's ref (review S-1).
const OWN_REPOSITORY = 'codeaiforge/sdlc-control-plane';
const ACTIONS = {
  checkout: 'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803',
  setupNode: 'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38',
  download: 'actions/download-artifact@018cc2cf5baa6db3ef3c5f8a56943fffe632ef53',
};
// Explicit !cancelled(): without a status function the if: is success() && ..., which might skip
// the submit job after a blocked gate (review S-2). github.com only: Gitea cannot mint, and GHES
// has no job.workflow_* context.
const JOB_IF = "${{ !cancelled() && github.server_url == 'https://github.com' }}";
const RUN = [
  'set -u',
  'status=0',
  'node evidence-adapter/packages/evidence-adapter/src/submit-evidence.mjs "$RECORD" || status=$?',
  "# 3 = no record: the gate exited 2 (or earlier); the gate's own job already failed.",
  'if [ "$status" -eq 3 ]; then exit 0; fi',
  'exit "$status"',
  '',
].join('\n');
const STEPS = [
  {
    uses: ACTIONS.checkout,
    with: {
      repository: OWN_REPOSITORY,
      ref: '${{ job.workflow_sha }}',
      path: 'evidence-adapter',
      'sparse-checkout': ADAPTER,
      'sparse-checkout-cone-mode': 'false',
      'persist-credentials': 'false',
    },
  },
  { uses: ACTIONS.setupNode, with: { 'node-version': '24' } },
  // continue-on-error is the design's: a missing artifact is "no record" (exit 3), not a failure.
  {
    id: 'record',
    'continue-on-error': 'true',
    uses: ACTIONS.download,
    with: { name: 'sdlc-controls-evidence', path: '${{ runner.temp }}/sdlc-controls-evidence' },
  },
  {
    name: 'Submit the evidence record (never prints the token)',
    env: { RECORD: '${{ runner.temp }}/sdlc-controls-evidence/evidence.json' },
    run: RUN,
  },
];
const STEP_NAMES = ['checkout', 'setup-node', 'download-artifact', 'submit'];

const keysOf = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).sort()
    : null;

// Every way a workflow text departs from the shape, one message each; [] is conformance. A text
// the reader refuses is a message too, so an unreadable file never passes.
function shapeErrors(text) {
  let workflow;
  try {
    workflow = readYamlSubset(text);
  } catch (error) {
    return [error.message];
  }
  const errors = [];
  const same = (actual, expected, what) => {
    if (!isDeepStrictEqual(actual, expected))
      errors.push(`${what} is ${JSON.stringify(actual)}, not ${JSON.stringify(expected)}`);
  };
  same(keysOf(workflow), ['jobs', 'name', 'on', 'permissions'], 'the top-level key set');
  same(workflow.name, 'submit-evidence', 'name');
  same(workflow.on, { workflow_call: null }, 'on (workflow_call only, no inputs or secrets)');
  same(workflow.permissions, {}, 'the top-level permissions');
  same(keysOf(workflow.jobs), ['submit'], 'the job set');
  const job = workflow.jobs?.submit;
  if (keysOf(job) === null) return [...errors, 'jobs.submit is not a mapping'];
  same(
    keysOf(job),
    ['if', 'permissions', 'runs-on', 'steps', 'timeout-minutes'],
    'the job key set',
  );
  same(job.if, JOB_IF, "the job's if:");
  same(job.permissions, { 'id-token': 'write', contents: 'read' }, "the job's permissions");
  if (!RUNNERS.includes(job['runs-on']))
    errors.push(`runs-on ${JSON.stringify(job['runs-on'])} is not a GitHub-hosted label`);
  if (!/^[1-5]$/.test(job['timeout-minutes']))
    errors.push(`timeout-minutes ${JSON.stringify(job['timeout-minutes'])} is not 1 to 5`);
  if (!Array.isArray(job.steps)) return [...errors, 'steps is not a sequence'];

  for (const step of job.steps)
    if (Object.hasOwn(step ?? {}, 'uses') && !Object.values(ACTIONS).includes(step.uses))
      errors.push(`uses ${JSON.stringify(step.uses)} is not one of the three pinned actions`);
  same(job.steps.length, STEPS.length, 'the number of steps');
  job.steps.forEach((step, at) => {
    const label = `step ${at + 1} (${STEP_NAMES[at] ?? 'extra'})`;
    const expected = STEPS[at];
    if (expected === undefined) {
      errors.push(`${label} is not in the reviewed list: ${JSON.stringify(step)}`);
      return;
    }
    same(keysOf(step), keysOf(expected), `${label}'s key set`);
    for (const key of Object.keys(expected)) same(step?.[key], expected[key], `${label}'s ${key}`);
  });

  // Belt and braces over the exact shape: where an expression may appear, and what it may name.
  const walk = (value, path) => {
    if (typeof value === 'string') {
      const under = path.slice(-2);
      if (
        value.includes('${{') &&
        !(under[0] === 'with' || under[0] === 'env' || under.at(-1) === 'if')
      )
        errors.push(`an expression at ${path.join('.')}`);
    } else if (value !== null && typeof value === 'object')
      for (const [key, item] of Object.entries(value)) walk(item, [...path, key]);
  };
  walk(workflow, []);
  const code = text
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
  for (const name of ['inputs.', 'secrets.', 'github.event', 'github.head_ref'])
    if (code.includes(name)) errors.push(`${WORKFLOW} names ${name}`);
  return errors;
}

test('C6 the workflow is exactly the reviewed shape', () => {
  assert.deepEqual(shapeErrors(WORKFLOW_TEXT), []);
});

// One edit of the real file per row; each must be refused for the stated reason. The first four
// are the cycle-1 review's (B-1), the S-1/S-2 rows undo those fixes, the rest are other ways in.
const SUBMIT = '      - name: Submit the evidence record (never prints the token)\n';
const SETUP_NODE =
  '      - uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6.5.0\n' +
  '        with:\n' +
  '          node-version: 24\n';
const ELSEWHERE = `someone/anything@${'a'.repeat(40)}`;
const replaceOnce = (text, from, to) => {
  assert.equal(text.split(from).length, 2, `the edit's anchor appears once: ${from}`);
  return text.replace(from, () => to);
};
const insertBefore = (text, anchor, lines) => replaceOnce(text, anchor, `${lines}${anchor}`);
const insertAfter = (text, anchor, lines) => replaceOnce(text, anchor, `${anchor}${lines}`);
const DOWNLOAD_PATH = '          path: ${{ runner.temp }}/sdlc-controls-evidence\n';
const CHECKOUT =
  '      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6.1.0\n';
const JOB_IF_LINE = `    if: ${JOB_IF}\n`;
const RECORD_LINE = '          RECORD: ${{ runner.temp }}/sdlc-controls-evidence/evidence.json\n';

const EDITS = [
  [
    'B-1.1 the artifact downloaded over the adapter source',
    (text) =>
      replaceOnce(
        text,
        DOWNLOAD_PATH,
        '          path: evidence-adapter/packages/evidence-adapter/src\n',
      ),
    /^step 3 \(download-artifact\)'s with is /,
  ],
  [
    'B-1.2 working-directory on the submit step',
    (text) =>
      insertAfter(text, SUBMIT, '        working-directory: ../../_temp/sdlc-controls-evidence\n'),
    /^step 4 \(submit\)'s key set is /,
  ],
  [
    'B-1.3 an extra SHA-pinned action',
    (text) => insertBefore(text, SUBMIT, `      - uses: ${ELSEWHERE}\n`),
    /is not one of the three pinned actions/,
  ],
  [
    'B-1.4 if: false on the submit step',
    (text) => insertAfter(text, SUBMIT, '        if: false\n'),
    /^step 4 \(submit\)'s key set is /,
  ],
  [
    'S-1 the checkout repository taken from the job context again',
    (text) =>
      replaceOnce(
        text,
        `          repository: ${OWN_REPOSITORY}\n`,
        '          repository: ${{ job.workflow_repository }}\n',
      ),
    /^step 1 \(checkout\)'s with is /,
  ],
  [
    'S-2 the job if: without !cancelled()',
    (text) => replaceOnce(text, JOB_IF_LINE, "    if: github.server_url == 'https://github.com'\n"),
    /^the job's if: is /,
  ],
  [
    'a job if: that never runs',
    (text) => replaceOnce(text, JOB_IF_LINE, '    if: false\n'),
    /^the job's if: is /,
  ],
  [
    'continue-on-error on the submit step',
    (text) => insertAfter(text, SUBMIT, '        continue-on-error: true\n'),
    /^step 4 \(submit\)'s key set is /,
  ],
  [
    'another shell for the submit step',
    (text) => insertAfter(text, SUBMIT, '        shell: node {0}\n'),
    /^step 4 \(submit\)'s key set is /,
  ],
  [
    'NODE_OPTIONS in the submit step env',
    (text) => insertAfter(text, RECORD_LINE, '          NODE_OPTIONS: --require ./x.cjs\n'),
    /^step 4 \(submit\)'s env is /,
  ],
  [
    'the script also runs the record',
    (text) =>
      replaceOnce(text, '          status=0\n', '          status=0\n          node "$RECORD"\n'),
    /^step 4 \(submit\)'s run is /,
  ],
  [
    'an expression in a script comment',
    (text) =>
      replaceOnce(
        text,
        '          status=0\n',
        '          status=0 # ${{ github.event.pull_request.title }}\n',
      ),
    /^an expression at jobs\.submit\.steps\.3\.run$/,
  ],
  [
    'an if: on the checkout step',
    (text) => insertAfter(text, CHECKOUT, '        if: false\n'),
    /^step 1 \(checkout\)'s key set is /,
  ],
  [
    "a checkout of the caller's commit",
    (text) =>
      replaceOnce(
        text,
        '          ref: ${{ job.workflow_sha }}\n',
        '          ref: ${{ github.sha }}\n',
      ),
    /^step 1 \(checkout\)'s with is /,
  ],
  [
    'a checkout that keeps its credentials',
    (text) =>
      replaceOnce(
        text,
        '          persist-credentials: false\n',
        '          persist-credentials: true\n',
      ),
    /^step 1 \(checkout\)'s with is /,
  ],
  [
    'an artifact from another repository and run',
    (text) =>
      insertAfter(text, DOWNLOAD_PATH, '          repository: someone/else\n          run-id: 1\n'),
    /^step 3 \(download-artifact\)'s with is /,
  ],
  [
    'an allowed action at a tag',
    (text) =>
      replaceOnce(
        text,
        'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38',
        'actions/setup-node@v6',
      ),
    /^uses "actions\/setup-node@v6" is not one of the three pinned actions$/,
  ],
  [
    'the steps reordered',
    (text) => insertBefore(replaceOnce(text, SETUP_NODE, ''), SUBMIT, SETUP_NODE),
    /^step 2 \(setup-node\)'s key set is /,
  ],
  [
    'a fifth step that runs a command',
    (text) => `${text}      - run: echo more\n`,
    /^step 5 \(extra\) is not in the reviewed list/,
  ],
  [
    'job defaults with a working-directory',
    (text) =>
      insertAfter(
        text,
        '    runs-on: ubuntu-latest\n',
        '    defaults:\n      run:\n        working-directory: x\n',
      ),
    /^the job key set is /,
  ],
  [
    'a job container',
    (text) => insertAfter(text, '    runs-on: ubuntu-latest\n', '    container: node:24\n'),
    /^the job key set is /,
  ],
  [
    'a top-level env',
    (text) => insertBefore(text, 'jobs:\n', 'env:\n  NODE_OPTIONS: --require ./x.cjs\n'),
    /^the top-level key set is /,
  ],
  [
    'a top-level id-token grant',
    (text) => replaceOnce(text, 'permissions: {}\n', 'permissions:\n  id-token: write\n'),
    /^the top-level permissions is /,
  ],
  [
    'an input',
    (text) =>
      insertAfter(
        text,
        '  workflow_call:\n',
        '    inputs:\n      endpoint:\n        type: string\n',
      ),
    /^on \(workflow_call only/,
  ],
  [
    'a self-hosted runner',
    (text) => replaceOnce(text, '    runs-on: ubuntu-latest\n', '    runs-on: self-hosted\n'),
    /is not a GitHub-hosted label$/,
  ],
  [
    'a longer timeout',
    (text) => replaceOnce(text, '    timeout-minutes: 5\n', '    timeout-minutes: 30\n'),
    /^timeout-minutes "30" is not 1 to 5$/,
  ],
  [
    'a repeated job if:',
    (text) => insertAfter(text, JOB_IF_LINE, '    if: false\n'),
    /^yaml-subset: .*the key if is repeated$/,
  ],
  [
    'a step hidden behind a carriage return in a comment',
    (text) =>
      insertBefore(
        text,
        SUBMIT,
        `      # note${String.fromCharCode(13)}      - uses: ${ELSEWHERE}\n`,
      ),
    /^yaml-subset: .*a control character, or whitespace other than a space$/,
  ],
  [
    'a step hidden behind U+2028 in a comment',
    (text) =>
      insertBefore(
        text,
        SUBMIT,
        `      # note${String.fromCharCode(0x2028)}      - uses: ${ELSEWHERE}\n`,
      ),
    /^yaml-subset: .*a control character, or whitespace other than a space$/,
  ],
];

for (const [name, edit, reason] of EDITS)
  test(`C6 refuses an edit: ${name}`, () => {
    const errors = shapeErrors(edit(WORKFLOW_TEXT));
    assert.ok(
      errors.some((error) => reason.test(error)),
      `expected an error matching ${reason}, got ${JSON.stringify(errors)}`,
    );
  });
