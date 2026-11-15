import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

// Diagram conformance check.
//
// docs/diagrams/README.md calls the Mermaid diagrams there the authoritative system views. A
// diagram decays the way the threat model does, silently: a route is renamed, a refusal code is
// split, a trust boundary is renumbered, a project gains an edge, and the picture still renders.
// This file fails when a diagram names something that no longer exists:
//
//   D1 every TB-n, MIT-n, ABU-n and RR-n is a row of the threat model, and every ADR-NNNN a file
//   D2 every route written `METHOD /path` is that path and method in openapi.json
//   D3 every code-shaped name, in a Mermaid block or in backticks, exists in the source, and
//      every word of a response box is a seam outcome (REFUSAL_REASONS or OUTCOMES)
//   D4 every path in a Sources section exists, every cited line range is inside its file, and
//      every file named in a Mermaid label or in backticks exists
//   D5 components.md's nodes, types, tags and edges equal the project graph, and it holds no
//      line this file cannot read
//   D6 each diagram has a title, one Mermaid block and a Sources section, index.md lists every
//      diagram, and every relative link resolves
//
// WHAT THIS CHECK DOES NOT CLAIM
//
// It cannot tell whether an arrow is true. A sequence that puts two existing steps in the wrong
// order, or a branch that ends at a real code the branch never sends, passes here. The diagrams
// were drawn against the code they cite, and their Sources say where; review is the control on
// whether they still say what it does. This file only holds them to names.
//
// D3's vocabulary is read from the source, never transcribed: a kebab-case code must be a string
// literal in a non-test module under packages/*/src/, a token of the evidence workflows, a project
// name or a project target; a snake_case, UPPER_SNAKE or camelCase identifier must appear in a
// non-test module, a migration, a workflow or a project.json. Comments are dropped from all of
// them first, by one rule per language (stripComments), so a name that survives only in a comment
// is not code. A renamed code still passes if the old name survives as a literal somewhere, which
// is the gap. A response box is held tighter: its words must be the seam's closed outcome lists,
// REFUSAL_REASONS and OUTCOMES, read as text from refusal-log.mjs and telemetry.mjs. A
// hyphenated English word in a Mermaid label fails as an unknown code: write labels without them.
//
// D5 reads project.json, not `nx graph`. Every edge of this workspace's graph is an
// `implicitDependencies` entry, because Nx does not resolve the deep relative imports the packages
// use (graph-fidelity.test.mjs, which also holds the declared list equal to the imports). So the
// project.json files are the graph, and reading them costs no Nx run and no daemon.
//
// node: imports only: nothing is imported from the packages, so reading this file's vocabulary
// cannot run a module's top level. Picked up by the tools/sdlc-controls/*.test.mjs glob of
// `pnpm test:controls` and of sdlc-controls.yml.

const DIAGRAMS = 'docs/diagrams';
// The index is repo-owned; docs/diagrams/README.md is vendored and not edited (task 3.1, Q-13).
const INDEX = `${DIAGRAMS}/index.md`;
const NOT_DIAGRAMS = new Set(['README.md', 'index.md']);
const THREAT_MODEL = 'docs/architecture/threat-model.md';
const OPENAPI = 'packages/control-plane-api/openapi.json';
const ADR_DIR = 'docs/adr';
const WORKFLOWS = ['.github/workflows/submit-evidence.yml', '.github/workflows/sdlc-controls.yml'];
const COMPONENTS = `${DIAGRAMS}/components.md`;

const read = (path) => readFileSync(path, 'utf8');
const sorted = (values) => [...new Set(values)].sort();

// ------------------------------------------------------------------------------- the diagrams

const diagramFiles = readdirSync(DIAGRAMS)
  .filter((file) => file.endsWith('.md') && !NOT_DIAGRAMS.has(file))
  .sort();
const diagrams = diagramFiles.map((file) => ({
  file: `${DIAGRAMS}/${file}`,
  text: read(`${DIAGRAMS}/${file}`),
}));

const FENCE = /^```([a-z]*)\n([\s\S]*?)^```$/gm;
const mermaidBlocks = (text) =>
  [...text.matchAll(FENCE)].filter((match) => match[1] === 'mermaid').map((match) => match[2]);
// Prose with every fenced block removed, so a shell example is never read as a claim.
const prose = (text) => text.replace(FENCE, '');
const backticked = (text) => [...prose(text).matchAll(/`([^`\n]+)`/g)].map((match) => match[1]);

function section(text, heading) {
  const start = text.indexOf(`\n## ${heading}\n`);
  if (start === -1) return '';
  const rest = text.slice(start + heading.length + 5);
  const end = rest.search(/^## /m);
  return end === -1 ? rest : rest.slice(0, end);
}

// ------------------------------------------------------------------------------- the sources

const threatModel = read(THREAT_MODEL);
const DEFINED_IDS = new Set(
  [...threatModel.matchAll(/^\| ((?:TB|ABU|MIT|RR)-\d+) +\|/gm)].map((match) => match[1]),
);
const ADR_NUMBERS = new Set(
  readdirSync(ADR_DIR)
    .map((file) => /^(\d{4})-/.exec(file)?.[1])
    .filter(Boolean),
);

const openapi = JSON.parse(read(OPENAPI));
const ROUTES = new Set(
  Object.entries(openapi.paths).flatMap(([path, item]) =>
    Object.keys(item)
      .filter((key) => ['get', 'post', 'put', 'patch', 'delete'].includes(key))
      .map((method) => `${method.toUpperCase()} ${path}`),
  ),
);

const isTestModule = (file) => /\.(test|integration|fixture)\.mjs$/.test(file);
const projectDirs = readdirSync('packages')
  .filter((dir) => existsSync(`packages/${dir}/project.json`))
  .sort();
const projects = projectDirs.map((dir) => {
  const config = JSON.parse(read(`packages/${dir}/project.json`));
  const modules = readdirSync(`packages/${dir}/src`).filter((file) => file.endsWith('.mjs'));
  const importers = (target, filter) =>
    modules
      .filter(filter)
      .some((file) => read(`packages/${dir}/src/${file}`).includes(`from '../../${target}/`));
  return { dir, config, modules, importers };
});
const dirByName = new Map(projects.map(({ dir, config }) => [config.name, dir]));

const sourceModules = projects.flatMap(({ dir, modules }) =>
  modules.filter((file) => !isTestModule(file)).map((file) => `packages/${dir}/src/${file}`),
);
const migrations = readdirSync('packages/evidence-store/migrations').map(
  (file) => `packages/evidence-store/migrations/${file}`,
);
// One comment rule for every vocabulary below: a comment that mentions an old name is not code.
// In a module, `//` to the end of the line (whole-line or trailing) and `/* ... */`, outside a
// string; in a migration, `--` to the end of the line; in a workflow, `#` to the end of the line.
// A string is closed at the end of its line, so a quote the scanner misreads (one inside a regex
// literal) costs at most that line, and only by dropping names: the check then fails, never passes.
function stripModuleComments(text) {
  let out = '';
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '\n') quote = null;
    if (quote !== null) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === quote) quote = null;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i + 1] !== '\n') i += 1;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
      out += ' ';
    } else {
      if (c === "'" || c === '"' || c === '`') quote = c;
      out += c;
    }
  }
  return out;
}
const stripComments = (path, text) => {
  if (path.endsWith('.mjs')) return stripModuleComments(text);
  if (path.endsWith('.sql')) return text.replace(/--.*$/gm, '');
  if (path.endsWith('.yml')) return text.replace(/#.*$/gm, '');
  return text;
};
const readCode = (path) => stripComments(path, read(path));

const KEBAB = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/;
const codesOf = (moduleText) =>
  [...moduleText.matchAll(/'([a-z][a-z0-9]*(?:-[a-z0-9]+)*)'/g)].map((match) => match[1]);
const identifiersOf = (text) => text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];

// The code vocabulary: what a kebab-case name must be. Every lower-case single-quoted literal of
// a non-test module, kebab or not, the evidence workflows' kebab tokens, project names, targets.
const CODES = new Set([
  ...sourceModules.flatMap((path) => codesOf(readCode(path))),
  ...WORKFLOWS.flatMap((path) => readCode(path).split(/[^a-z0-9-]+/)).filter((t) => KEBAB.test(t)),
  ...projects.flatMap(({ config }) => [config.name, ...Object.keys(config.targets ?? {})]),
]);

// The outcome vocabulary: what every word of a response box must be. The seam's two closed lists,
// read as the literals inside each `export const NAME = Object.freeze([ ... ])` (OUTCOMES spreads
// REFUSAL_REASONS and adds the accepted, served and probe outcomes).
function frozenList(path, name) {
  const text = readCode(path);
  const start = text.indexOf(`export const ${name} = Object.freeze([`);
  if (start === -1) return [];
  const end = text.indexOf(']);', start);
  return codesOf(text.slice(start, end));
}
const REFUSAL_REASONS = frozenList(
  'packages/control-plane-api/src/refusal-log.mjs',
  'REFUSAL_REASONS',
);
const OUTCOME_CODES = new Set([
  ...REFUSAL_REASONS,
  ...frozenList('packages/control-plane-api/src/telemetry.mjs', 'OUTCOMES'),
]);

// The identifier corpus: where a snake_case, UPPER_SNAKE or camelCase name must appear.
const IDENTIFIERS = new Set(
  [
    ...sourceModules,
    ...migrations,
    ...WORKFLOWS,
    ...projectDirs.map((dir) => `packages/${dir}/project.json`),
  ].flatMap((path) => identifiersOf(readCode(path))),
);

// Every file in the working tree but dependencies, build output and .git: a file a diagram names
// by its bare name must be one of these, or a file a workflow writes (evidence.json).
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'tmp', '.nx', 'coverage']);
function walk(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), found);
    } else found.push(entry.name);
  }
  return found;
}
const FILE_NAMES = new Set(walk('.'));
const WORKFLOW_TEXT = WORKFLOWS.map(readCode).join('\n');

// ----------------------------------------------------------------------------- the checks

// D1. IDs that are not rows of the threat model, and ADR numbers with no file.
function unknownIds(text) {
  const problems = [];
  for (const [id] of text.matchAll(/\b(?:TB|MIT|ABU|RR)-\d+\b/g))
    if (!DEFINED_IDS.has(id)) problems.push(`${id} is not a row of ${THREAT_MODEL}`);
  for (const [, number] of text.matchAll(/\bADR-(\d{4})\b/g))
    if (!ADR_NUMBERS.has(number)) problems.push(`ADR-${number} has no file in ${ADR_DIR}`);
  return sorted(problems);
}

// D2. Routes that openapi.json does not declare, on that method.
function unknownRoutes(text) {
  return sorted(
    [...text.matchAll(/\b(GET|POST|PUT|PATCH|DELETE) (\/[A-Za-z0-9_/{}.-]*)/g)]
      .map((match) => `${match[1]} ${match[2].replace(/[.]+$/, '')}`)
      .filter((route) => !ROUTES.has(route))
      .map((route) => `${route} is not in ${OPENAPI}`),
  );
}

// Splits a label or a code span into the tokens D3 reads. A token keeps `.`, `/`, `:` and `@`, so
// a file name, a path, a URN or a tag stays one token and is not read as a code; trailing
// punctuation is dropped.
const tokens = (text) =>
  text
    .split(/[^A-Za-z0-9_\-:./@*]+/)
    .map((token) => token.replace(/[:.]+$/, ''))
    .filter(Boolean);

// D3. Names that do not exist in the source. `codes` and `identifiers` are injectable so the
// negative cases can run against the real vocabulary unchanged.
function unknownNames(
  text,
  { codes = CODES, identifiers = IDENTIFIERS, outcomes = OUTCOME_CODES } = {},
) {
  const problems = [];
  // A block's first line is its diagram type (sequenceDiagram, stateDiagram-v2), Mermaid's word.
  const blocks = mermaidBlocks(text).map((block) => block.replace(/^.*\n/, ''));
  const spans = [...blocks, ...backticked(text)];
  // Node ids, participant and state aliases are the diagram's own names, not the code's.
  const local = new Set(
    blocks.flatMap((block) => [
      ...[...block.matchAll(/(?:^|\s)([A-Za-z][\w-]*)(?=\[|\{|\(\[)/gm)].map((match) => match[1]),
      ...[...block.matchAll(/\bparticipant (\w+)|\bstate "[^"]*" as (\w+)/g)].map(
        (match) => match[1] ?? match[2],
      ),
    ]),
  );
  for (const token of spans.flatMap(tokens)) {
    if (KEBAB.test(token)) {
      if (!codes.has(token)) problems.push(`${token} is not a code in the source`);
    } else if (local.has(token)) {
      continue;
    } else if (
      /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(token) ||
      /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(token) ||
      /^[a-z]+[A-Z][A-Za-z0-9]*$/.test(token)
    ) {
      if (!identifiers.has(token)) problems.push(`${token} is not an identifier in the source`);
    }
  }
  // A response box in a flowchart, `["NNN code, code or code"]`, `<br/>` breaks allowed: every
  // word after the status is a seam outcome, one-word outcomes included, which the kebab rule above
  // cannot see, and a literal that is not an outcome (a header name, an encoding) is refused.
  for (const block of mermaidBlocks(text))
    for (const [, list] of block.matchAll(/\["[1-5]\d\d ([^"]+)"\]/g))
      for (const code of list.split(/\s*,\s*|\s*<br\/>\s*|\s+or\s+/).filter(Boolean))
        if (!outcomes.has(code)) problems.push(`${code} is not a seam outcome code`);
  return sorted(problems);
}

// D4. Source paths that do not exist, and line ranges past the end of their file. A bare
// `:12-34` continues the path before it in the same section.
function brokenSources(text) {
  const problems = [];
  let last = null;
  for (const span of backticked(section(text, 'Sources'))) {
    const continued = /^:(\d+)(?:-(\d+))?$/.exec(span);
    const cited = /^([\w./*-]+?)(?::(\d+)(?:-(\d+))?)?$/.exec(span);
    let path;
    let end;
    if (continued) {
      path = last;
      end = Number(continued[2] ?? continued[1]);
    } else if (cited && (cited[1].includes('/') || /\.(md|mjs|json|yml|sql)$/.test(cited[1]))) {
      path = cited[1];
      end = cited[2] === undefined ? undefined : Number(cited[3] ?? cited[2]);
      last = path;
    } else continue;
    if (path === null) {
      problems.push(`${span} has no path before it`);
      continue;
    }
    if (!existsSync(path)) {
      problems.push(`${path} does not exist`);
      continue;
    }
    if (end !== undefined && read(path).split('\n').length < end)
      problems.push(`${path}:${end} is past the end of the file`);
  }
  return sorted(problems);
}

// D4. Files named outside Sources: in a Mermaid label or in backticks. A path must exist (a `*`
// segment matches any one entry); a bare file name must be a file in the tree or one a workflow
// writes. A `:12-34` suffix is dropped; a `**` pattern names a tree, not a file, and is skipped.
const FILE_TOKEN = /\.(mjs|sql|yml|json|md)$/;
function pathExists(path) {
  let candidates = ['.'];
  for (const segment of path.split('/')) {
    candidates = candidates.flatMap((base) => {
      if (segment !== '*') return [join(base, segment)];
      try {
        return readdirSync(base).map((entry) => join(base, entry));
      } catch {
        return [];
      }
    });
  }
  return candidates.some((candidate) => existsSync(candidate));
}
function missingFiles(text, { fileNames = FILE_NAMES } = {}) {
  const blocks = mermaidBlocks(text).map((block) => block.replace(/^.*\n/, ''));
  const problems = [];
  for (const raw of [...blocks, ...backticked(text)].flatMap(tokens)) {
    const token = raw.replace(/:\d+(?:-\d+)?$/, '');
    if (!FILE_TOKEN.test(token) || token.includes('**') || /^[a-z]+:/.test(token)) continue;
    if (token.includes('/')) {
      if (!pathExists(token.replace(/^\.\//, ''))) problems.push(`${token} does not exist`);
    } else if (!fileNames.has(token) && !WORKFLOW_TEXT.includes(token))
      problems.push(`no file named ${token}`);
  }
  return sorted(problems);
}

// D5. The components diagram against the project graph.
// Every line of the block must be the header, blank, a `%%` comment, a node or an edge in one of
// the two arrow forms; a trailing `;` is Mermaid's and allowed. Any other line - another arrow
// syntax, `a --> b & c`, a style - is refused rather than skipped, so an edge cannot hide in it.
const HEADER = /^flowchart (?:TD|TB|BT|LR|RL)\s*;?\s*$/;
const NODE = /^\s*([a-z][a-z0-9-]*)\["([^"]*)"\]\s*;?\s*$/;
const EDGE =
  /^\s*([a-z][a-z0-9-]*)\s+(-->|-\.->|-\.\s+"[^"]*"\s+\.->)\s+([a-z][a-z0-9-]*)\s*;?\s*$/;

function readComponents(text) {
  const [block] = mermaidBlocks(text);
  const nodes = {};
  const edges = [];
  const unread = [];
  for (const line of (block ?? '').split('\n')) {
    if (line.trim() === '' || HEADER.test(line) || /^\s*%%/.test(line)) continue;
    const node = NODE.exec(line);
    if (node) {
      const [, id, label] = node;
      const [name, details = ''] = label.split('<br/>');
      const parts = details.split(' · ');
      nodes[id] = { name, type: parts[0], tags: sorted(parts.slice(1)) };
      continue;
    }
    const edge = EDGE.exec(line);
    if (edge) edges.push(`${edge[1]} ${edge[2].startsWith('-.') ? '-.->' : '-->'} ${edge[3]}`);
    else unread.push(line.trim());
  }
  return { nodes, edges: sorted(edges), unread };
}

// The graph as the diagram must draw it: an edge is dotted when no non-test module of the
// importing project imports the target, solid otherwise.
function expectedComponents() {
  const nodes = {};
  const edges = [];
  for (const { config, importers } of projects) {
    nodes[config.name] = {
      name: config.name,
      type: config.projectType === 'application' ? 'app' : 'lib',
      tags: sorted(config.tags ?? []),
    };
    for (const target of config.implicitDependencies ?? []) {
      const dir = dirByName.get(target) ?? target;
      const shipped = importers(dir, (file) => !isTestModule(file));
      edges.push(`${config.name} ${shipped ? '-->' : '-.->'} ${target}`);
    }
  }
  return { nodes, edges: sorted(edges) };
}

function componentDrift(text) {
  const drawn = readComponents(text);
  const expected = expectedComponents();
  const problems = drawn.unread.map((line) => `line "${line}" is not a node or an edge`);
  for (const name of sorted([...Object.keys(drawn.nodes), ...Object.keys(expected.nodes)])) {
    const want = expected.nodes[name];
    const have = drawn.nodes[name];
    if (!want) problems.push(`node ${name} is not a project`);
    else if (!have) problems.push(`project ${name} is not drawn`);
    else if (JSON.stringify(have) !== JSON.stringify(want))
      problems.push(
        `node ${name} reads ${JSON.stringify(have)}, the project ${JSON.stringify(want)}`,
      );
  }
  for (const edge of drawn.edges)
    if (!expected.edges.includes(edge)) problems.push(`edge ${edge} is not in the graph`);
  for (const edge of expected.edges)
    if (!drawn.edges.includes(edge)) problems.push(`edge ${edge} is not drawn`);
  return problems;
}

// D6. Shape, the index and links.
function shapeProblems(file, text) {
  const problems = [];
  if (!/^# \S/.test(text)) problems.push(`${file} does not start with a title`);
  if (mermaidBlocks(text).length !== 1) problems.push(`${file} has not exactly one Mermaid block`);
  if (section(text, 'Sources').trim() === '') problems.push(`${file} has no Sources section`);
  return problems;
}

function brokenLinks(file, text) {
  return sorted(
    [...prose(text).matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)]
      .map((match) => match[1])
      .filter((target) => !/^[a-z]+:/.test(target))
      .filter((target) => !existsSync(normalize(join(dirname(file), target))))
      .map((target) => `${file} links to ${target}, which does not exist`),
  );
}

// ------------------------------------------------------------------------------- the tests

test('D0 the diagrams and the vocabulary were read, not skipped', () => {
  assert.deepEqual(diagramFiles, [
    'components.md',
    'evidence-lifecycle.md',
    'evidence-submission.md',
    'route-authorization.md',
    'trust-boundaries.md',
  ]);
  assert.equal(DEFINED_IDS.size > 60, true, 'the threat model ID scan found its rows');
  assert.ok(ROUTES.size > 0, 'the openapi.json route scan found routes');
  for (const code of ['body-not-json', 'key-set-unavailable', 'overdue-payload', 'mint-refused'])
    assert.ok(CODES.has(code), `the vocabulary scan found ${code}`);
  assert.ok(REFUSAL_REASONS.includes('verifier-fault'), 'REFUSAL_REASONS was read');
  for (const outcome of ['appended', 'duplicate', 'served', 'live', 'ready', 'not-ready'])
    assert.ok(OUTCOME_CODES.has(outcome), `OUTCOMES was read: ${outcome}`);
  assert.ok(FILE_NAMES.has('key-set.mjs'), 'the file walk found key-set.mjs');
  for (const name of ['received_at', 'RETENTION_WINDOW', 'evaluateGuardrails'])
    assert.ok(IDENTIFIERS.has(name), `the identifier scan found ${name}`);
  assert.equal(projects.length, 8, 'eight projects under packages/');
});

for (const { file, text } of diagrams) {
  test(`D1-D4, D6 ${file} names only what exists`, () => {
    assert.deepEqual(unknownIds(text), [], 'IDs');
    assert.deepEqual(unknownRoutes(text), [], 'routes');
    assert.deepEqual(unknownNames(text), [], 'names');
    assert.deepEqual(brokenSources(text), [], 'Sources');
    assert.deepEqual(missingFiles(text), [], 'files named');
    assert.deepEqual(shapeProblems(file, text), [], 'shape');
    assert.deepEqual(brokenLinks(file, text), [], 'links');
  });
}

test('D3 the outcome boxes of route-authorization.md were read', () => {
  const text = read(`${DIAGRAMS}/route-authorization.md`);
  const boxes = [...mermaidBlocks(text)[0].matchAll(/\["[1-5]\d\d ([^"]+)"\]/g)];
  assert.ok(boxes.length >= 20, `found ${boxes.length} response boxes`);
});

test('D5 components.md draws exactly the project graph', () => {
  const text = read(COMPONENTS);
  assert.equal(Object.keys(readComponents(text).nodes).length, 8, 'the node scan found 8 nodes');
  assert.deepEqual(componentDrift(text), []);
});

test('D5 restyling an edge never adds or drops one', () => {
  // A dotted edge here must still be a declared edge: expectedComponents() only restyles it.
  const declared = projects.flatMap(({ config }) =>
    (config.implicitDependencies ?? []).map((target) => `${config.name} ${target}`),
  );
  const drawn = expectedComponents().edges.map((edge) => edge.replace(/ (?:-->|-\.->) /, ' '));
  assert.deepEqual(sorted(drawn), sorted(declared));
});

test('D6 the index lists every diagram, and only diagrams that exist', () => {
  const index = read(INDEX);
  const listed = sorted([...index.matchAll(/\]\(([\w-]+\.md)\)/g)].map((match) => match[1])).filter(
    (file) => !NOT_DIAGRAMS.has(file),
  );
  assert.deepEqual(listed, diagramFiles);
  assert.deepEqual(brokenLinks(INDEX, index), []);
});

// ------------------------------------------------------------------------- negative cases

const routeDoc = read(`${DIAGRAMS}/route-authorization.md`);
const lifecycleDoc = read(`${DIAGRAMS}/evidence-lifecycle.md`);
const trustDoc = read(`${DIAGRAMS}/trust-boundaries.md`);
const componentsDoc = read(COMPONENTS);

const mustFail = (problems, pattern) => {
  assert.ok(problems.length > 0, 'the edited diagram was accepted');
  assert.ok(
    problems.some((problem) => pattern.test(problem)),
    `no problem matched ${pattern}: ${problems.join('; ')}`,
  );
};

test('D1 refuses an ID the threat model does not have, and an ADR with no file', () => {
  mustFail(unknownIds(trustDoc.replace('TB-9 ·', 'TB-10 ·')), /TB-10 is not a row/);
  mustFail(unknownIds(lifecycleDoc.replace('RR-4', 'RR-99')), /RR-99/);
  mustFail(unknownIds(`${trustDoc}\nADR-0042`), /ADR-0042 has no file/);
});

test('D2 refuses a route openapi.json does not declare, or on the wrong method', () => {
  mustFail(unknownRoutes(routeDoc.replace('GET /v1/indicators', 'GET /v1/policies')), /policies/);
  mustFail(unknownRoutes(routeDoc.replace('"GET /health"', '"POST /health"')), /POST \/health/);
});

test('D3 refuses a renamed code, in a label, in backticks and in a response box', () => {
  mustFail(unknownNames(routeDoc.replace('400 body-not-json', '400 body-not-jsn')), /body-not-jsn/);
  mustFail(
    unknownNames(lifecycleDoc.replace('| `overdue-payload`', '| `overdue-payloads`')),
    /overdue-payloads/,
  );
  mustFail(unknownNames(routeDoc.replace('409 conflict', '409 conflicted')), /conflicted/);
  // A code removed from the source is refused even though the diagram did not change.
  const codes = new Set([...CODES].filter((code) => code !== 'refused-actor'));
  mustFail(unknownNames(routeDoc, { codes }), /refused-actor/);
  // A hyphenated English word in a label reads as an unknown code.
  mustFail(unknownNames(trustDoc.replace('cache lifetime', 'cache life-time')), /life-time/);
});

test('D3 refuses a renamed identifier', () => {
  mustFail(unknownNames(lifecycleDoc.replace('(OVERDUE_GRACE)', '(OVERDUE_WINDOW)')), /OVERDUE/);
  mustFail(unknownNames(lifecycleDoc.replace('as evidence_app,', 'as evidence_writer,')), /writer/);
});

test('D4 refuses a missing source path and a line range past the end of its file', () => {
  mustFail(
    brokenSources(lifecycleDoc.replace('src/expire.mjs:19-27', 'src/expiry.mjs:19-27')),
    /expiry\.mjs does not exist/,
  );
  mustFail(
    brokenSources(lifecycleDoc.replace('src/expire.mjs:19-27', 'src/expire.mjs:19-9999')),
    /past the end/,
  );
  mustFail(brokenSources(lifecycleDoc.replace('`:88-119`', '`:88-9999`')), /expire\.mjs:9999/);
});

test('D5 refuses a dropped edge, an extra edge, a changed tag and a wrong edge style', () => {
  mustFail(
    componentDrift(componentsDoc.replace('  guardrail-policy --> contracts\n', '')),
    /guardrail-policy --> contracts is not drawn/,
  );
  mustFail(
    componentDrift(
      componentsDoc.replace(
        '  workspace-registry --> contracts\n',
        '  workspace-registry --> contracts\n  indicators --> contracts\n',
      ),
    ),
    /indicators --> contracts is not in the graph/,
  );
  mustFail(
    componentDrift(
      componentsDoc.replace(
        'scope:reporting · criticality:medium',
        'scope:reporting · criticality:low',
      ),
    ),
    /node indicators/,
  );
  mustFail(
    componentDrift(
      componentsDoc.replace(
        'control-plane-api -. "test only" .-> evidence-adapter',
        'control-plane-api --> evidence-adapter',
      ),
    ),
    /evidence-adapter/,
  );
});

test('D6 refuses a diagram with no Sources section, and a link to nothing', () => {
  const file = `${DIAGRAMS}/evidence-lifecycle.md`;
  mustFail(shapeProblems(file, lifecycleDoc.replace('## Sources', '## Notes')), /no Sources/);
  mustFail(
    brokenLinks(file, lifecycleDoc.replace('(evidence-submission.md)', '(evidence-intake.md)')),
    /evidence-intake\.md/,
  );
});

test('D3 a response box takes seam outcomes only, not any literal', () => {
  // Both are single-quoted literals in a package module, so the kebab rule alone would pass them.
  assert.ok(CODES.has('content-type') && CODES.has('utf8'), 'the literals exist as codes');
  mustFail(
    unknownNames(routeDoc.replace('401 alg-unsupported', '401 content-type')),
    /content-type is not a seam outcome/,
  );
  mustFail(
    unknownNames(routeDoc.replace('429 quota-exceeded', '429 utf8')),
    /utf8 is not a seam outcome/,
  );
  // An outcome dropped from the closed lists is refused even though the diagram did not change.
  const outcomes = new Set([...OUTCOME_CODES].filter((code) => code !== 'not-ready'));
  mustFail(unknownNames(routeDoc, { outcomes }), /not-ready is not a seam outcome/);
});

test('D3 a name kept alive only by a comment is not code', () => {
  const module = [
    '// OVERDUE_WINDOW was renamed; old-code is gone',
    "const OVERDUE_GRACE = 'kept-code'; // 'trailing-code' OLD_TRAILING",
    "/* 'block-code' OLD_BLOCK */ const url = 'https://example.test'; const next = 'after-url';",
  ].join('\n');
  const stripped = stripComments('example.mjs', module);
  const codes = codesOf(stripped);
  const identifiers = identifiersOf(stripped);
  assert.deepEqual(codes.sort(), ['after-url', 'kept-code']);
  for (const name of ['OVERDUE_WINDOW', 'OLD_TRAILING', 'OLD_BLOCK'])
    assert.ok(!identifiers.includes(name), `${name} was read from a comment`);
  assert.ok(identifiers.includes('OVERDUE_GRACE'));
  assert.deepEqual(identifiersOf(stripComments('m.sql', 'SELECT a; -- old_column\n')), [
    'SELECT',
    'a',
  ]);
});

test('D4 refuses a file named in a label or in backticks that does not exist', () => {
  mustFail(
    missingFiles(trustDoc.replace('<br/>key-set.mjs"', '<br/>keyset.mjs"')),
    /no file named keyset\.mjs/,
  );
  mustFail(
    missingFiles(
      componentsDoc.replace(
        '`tools/sdlc-controls/generate-component-map.mjs`',
        '`tools/sdlc-controls/component-map.mjs`',
      ),
    ),
    /component-map\.mjs does not exist/,
  );
  // A file the source tree loses is refused even though the diagram did not change.
  const fileNames = new Set([...FILE_NAMES].filter((name) => name !== 'key-set.mjs'));
  mustFail(missingFiles(trustDoc, { fileNames }), /no file named key-set\.mjs/);
});

test('D5 refuses a line it cannot read, and accepts a trailing semicolon', () => {
  mustFail(
    componentDrift(
      componentsDoc.replace('  indicators["', '  indicators ==> contracts\n  indicators["'),
    ),
    /line "indicators ==> contracts" is not a node or an edge/,
  );
  mustFail(
    componentDrift(
      componentsDoc.replace(
        '  workspace-registry --> contracts\n',
        '  workspace-registry --> contracts & indicators\n',
      ),
    ),
    /is not a node or an edge/,
  );
  assert.deepEqual(
    componentDrift(
      componentsDoc.replace(
        '  guardrail-policy --> contracts\n',
        '  guardrail-policy --> contracts;\n',
      ),
    ),
    [],
  );
});
