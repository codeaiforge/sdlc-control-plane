import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { routes } from '../../packages/control-plane-api/src/main.mjs';

// Threat model conformance check.
//
// docs/architecture/threat-model.md is the artifact Gate 2's first signal reads: "Trust
// boundaries, abuse cases, mitigations and residual risks documented and reviewed", against a
// no-go of "Residual risks unlisted or unreviewed". A document is not a control, and the four
// ways this one decays are all invisible to a reader skimming it:
//
//   1. a route is added to the seam and no boundary covers it     -> a surface nobody modelled
//   2. an ID is referenced that was renamed or never existed      -> a mitigation pointing at air
//   3. a mitigation is owned by a task number nobody scheduled    -> an owner that cannot deliver
//   4. a residual risk loses its acceptance and reads as accepted -> a risk nobody signed for
//
// Every one of those leaves the document looking complete. This check fails on each.
//
// WHAT THIS CHECK DOES NOT CLAIM
//
// It cannot judge whether an abuse case is well chosen, or whether the set of them is complete.
// A threat model that omits the one threat that matters passes here, because completeness is a
// judgement about a system and this file only reads a file.
//
// It cannot judge whether a mitigation mitigates. MIT-n addressing ABU-n is a claim of
// relevance, and the only thing verified is that both IDs exist and that the two tables agree
// about the pairing in both directions.
//
// It cannot tell a reviewed residual risk from a typed one. `pending Gate 2` becoming
// `<name>, YYYY-MM-DD` is an edit, and an edit is what a human approval looks like from in here.
// What it can insist on is that somebody's name and a real date are present before the row stops
// saying the acceptance is outstanding.
//
// It does not verify the ingress body limit is implemented. Task 1.3 ships no production code;
// the limit is a specification for 2.1, and all that is checked is that the specification names
// every field 2.1 needs.
//
// It does not read packages/control-plane-api/openapi.json, deliberately. That document is held
// to the seam in both directions by packages/control-plane-api/src/openapi.contract.test.mjs,
// which is its one reader; a second reader here would be a second source of truth about the
// published contract, and the two would eventually disagree about which one was right.
//
// And it is co-authored with the document it checks, in the same task, by the same agent. A
// check written alongside its subject tests the subject against its author's intent, not against
// anybody's independent judgement. Phase (4)'s review is the control on that. This file is not.
//
// Picked up by the existing tools/sdlc-controls/*.test.mjs glob in `pnpm test:controls` and in
// .github/workflows/sdlc-controls.yml, so this file needs no package.json or workflow change.
//
// `routes` is imported from the seam rather than transcribed, so a route added there without a
// boundary fails here. Importing main.mjs is safe and adds no graph edge: its listen is guarded
// on process.argv[1] (main.mjs:117), and tools/ is not an Nx project, so graph-fidelity's import
// scan (which reads only packages/*/src/) never sees it.
//
// Everything else is an inline literal, but NOT for a fan-in reason: since tools/ contributes no
// edge, importing packages/contracts from here could not change its fan-in either, and an earlier
// version of this comment claimed it could. The real reason is the one openapi.contract.test.mjs
// records - a fixture imported from the package under test follows a version bump silently, which
// is the drift these checks exist to notice.

const DOC = 'docs/architecture/threat-model.md';
const ROADMAP = 'docs/specs/implementation-roadmap.md';
const ADR_DIR = 'docs/adr';
const CONDITION_ADR = '0002';

const SOURCE = readFileSync(DOC, 'utf8');
const LINES = SOURCE.split('\n');
const ROADMAP_SOURCE = readFileSync(ROADMAP, 'utf8');

// ---------------------------------------------------------------------------- header + sections

const BULLET_RE = /^- \*\*(Status|Date|Scope|Trace|Classification)\*\*:\s*(\S.*)$/;
const REQUIRED_BULLETS = ['Status', 'Date', 'Scope', 'Trace', 'Classification'];
const REQUIRED_SECTIONS = [
  'Scope and method',
  'System under analysis',
  'Trust boundaries',
  'Abuse cases',
  'Mitigations',
  'Residual risks',
  'Ingress body limit — specification for task 2.1',
  'Policy administration',
  'Requirements handed to task 1.4',
  'Findings handed to Gate 2',
];

const STATUS_RE = /^(Proposed|Accepted|Superseded by .+|Deprecated)$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TRACE_RE = /(FR-\d+\.\d+|NFR-\d+\.\d+)/;
// A classification names a level, what it covers, and who decided it when. ADR-0002 left this
// "undetermined" and handed the question here; a document that answers it with another shrug
// would close the ADR's open question without answering it.
const CLASSIFICATION_RE =
  /^(PUBLIC|INTERNAL|CONFIDENTIAL|RESTRICTED) — (\S.*) \((\S[^()]*), (\d{4}-\d{2}-\d{2})\)$/;

const isRealDate = (value) => {
  if (!DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

// The bullets in the order they appear, so a check on their values cannot pass by reading a
// bullet from somewhere else in the document.
const headerBullets = LINES.map((line) => BULLET_RE.exec(line))
  .filter(Boolean)
  .map((match) => [match[1], match[2].trim()]);
const header = new Map(headerBullets);

// --------------------------------------------------------------------------------------- tables

// Markdown table rows only. A cell may not contain a pipe, and that rule is enforced by
// construction rather than by a search: splitting on the pipe turns an embedded one into an
// extra cell, and a row whose cell count does not match its header is recorded as malformed and
// dropped. The guard test then notices that fewer rows parsed than the raw source declares.
const isTableLine = (line) => /^\|.*\|$/.test(line.trim());
const cellsOf = (line) =>
  line
    .trim()
    .slice(1, -1)
    .split('|')
    .map((cell) => cell.trim());
const isSeparator = (cells) => cells.every((cell) => /^:?-{3,}:?$/.test(cell));

function readTable(headers) {
  const start = LINES.findIndex(
    (line) => isTableLine(line) && cellsOf(line).join('\u0000') === headers.join('\u0000'),
  );
  if (start === -1) return { found: false, headers, rows: [], malformed: [] };
  const rows = [];
  const malformed = [];
  for (let index = start + 1; index < LINES.length && isTableLine(LINES[index]); index += 1) {
    const cells = cellsOf(LINES[index]);
    if (isSeparator(cells)) continue;
    if (cells.length !== headers.length) {
      malformed.push({ line: index + 1, text: LINES[index].trim(), count: cells.length });
      continue;
    }
    rows.push(Object.fromEntries(headers.map((name, column) => [name, cells[column]])));
  }
  return { found: true, headers, rows, malformed };
}

const TRUST_HEADERS = [
  'ID',
  'Boundary',
  'Untrusted side',
  'Trusted side',
  'Surfaces',
  'Assets crossing',
  'STRIDE coverage',
  'Control',
  'Status',
];
const ABUSE_HEADERS = ['ID', 'Boundary', 'STRIDE', 'Abuse case', 'Answered by'];
const MITIGATION_HEADERS = ['ID', 'Mitigation', 'Addresses', 'Owning task', 'Evidence'];
const RESIDUAL_HEADERS = [
  'ID',
  'Residual risk',
  'From',
  'Why accepted',
  'Accepted by',
  'Review point',
];

const TABLES = {
  'Trust boundaries': { prefix: 'TB', ...readTable(TRUST_HEADERS) },
  'Abuse cases': { prefix: 'ABU', ...readTable(ABUSE_HEADERS) },
  Mitigations: { prefix: 'MIT', ...readTable(MITIGATION_HEADERS) },
  'Residual risks': { prefix: 'RR', ...readTable(RESIDUAL_HEADERS) },
};

const boundaries = TABLES['Trust boundaries'].rows;
const abuses = TABLES['Abuse cases'].rows;
const mitigations = TABLES.Mitigations.rows;
const residuals = TABLES['Residual risks'].rows;

// ------------------------------------------------------------------------------- cell grammars

const STRIDE_LETTERS = ['S', 'T', 'R', 'I', 'D', 'E'];
// All six letters, in order, single-spaced. Each value is `n/a` or a comma-separated ABU list.
// An omitted letter would be indistinguishable from a letter nobody considered, so the shape
// requires every one of them to be written down.
const COVERAGE_RE = /^S:(\S+) T:(\S+) R:(\S+) I:(\S+) D:(\S+) E:(\S+)$/;
const COVERAGE_VALUE_RE = /^(n\/a|ABU-\d+(,ABU-\d+)*)$/;

const SURFACE_PREFIXES = ['git', 'process', 'store', 'forge'];
const ROUTE_TOKEN_RE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \/\S*$/;
const NON_ROUTE_TOKEN_RE = new RegExp(`^(${SURFACE_PREFIXES.join('|')}):\\S+$`);
const STATUS_CELL_RE = /^(current|conditional on ADR-(\d{4}))$/;
// A boundary's control as it stands today. `executable check` has to name the file that fails when
// the control breaks - a check nobody can find is a convention with a better name.
const CONTROL_RE = /^(none|convention|executable check `([^`]+)`)$/;
const ID_LIST_RE = (prefix) => new RegExp(`^${prefix}-\\d+(, ${prefix}-\\d+)*$`);
const EVIDENCE_PATH_RE = /^`([^`]+)`$/;
const TASK_ID_RE = /^\d+\.\d+$/;
const ACCEPTED_NAME_RE = /^(\S.*?),\s*(\d{4}-\d{2}-\d{2})$/;
const PENDING_RE = /\b(pending|awaiting|unapproved|not yet|tbd|tbc|unreviewed)\b/i;

// Backticked tokens, and nothing else. Stripping them must leave only separators - otherwise a
// surface could be written as prose, which is a surface no reader of this file can enumerate.
function surfaceTokens(cell) {
  const tokens = [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
  const residue = cell.replace(/`[^`]+`/g, '').trim();
  return { tokens, clean: /^[\s,]*$/.test(residue) };
}

function parseCoverage(cell) {
  const match = COVERAGE_RE.exec(cell);
  if (!match) return null;
  const byLetter = new Map();
  for (const [index, letter] of STRIDE_LETTERS.entries()) {
    const value = match[index + 1];
    if (!COVERAGE_VALUE_RE.test(value)) return null;
    byLetter.set(letter, value === 'n/a' ? [] : value.split(','));
  }
  return byLetter;
}

const idList = (cell) => cell.split(',').map((value) => value.trim());

// A task ID is real only if the roadmap declares a row for it. The two assertions inside the
// mitigation test prove this predicate still discriminates - a predicate that answers true for
// everything would make the ownership check unfalsifiable while it kept passing.
// The roadmap row's Trace cell for this task. The document has to carry every requirement the
// task was scheduled against; dropping one from its header is dropping it from the model.
const roadmapTrace = (id) => {
  const row = ROADMAP_SOURCE.split('\n').find((line) =>
    new RegExp(`^\\|\\s*${id.replace(/\./g, '\\.')}\\s*\\|`).test(line),
  );
  return row ? [...row.matchAll(/N?FR-\d+\.\d+/g)].map((match) => match[0]) : [];
};

const roadmapHasTask = (id) =>
  new RegExp(`^\\|\\s*${id.replace(/\./g, '\\.')}\\s*\\|`, 'm').test(ROADMAP_SOURCE);

const adrFile = (number) =>
  readdirSync(ADR_DIR).find((file) => file.startsWith(`${number}-`) && file.endsWith('.md'));

function adrStatus(number) {
  const file = adrFile(number);
  if (!file) return null;
  const match = /^- \*\*Status\*\*:\s*(\S.*)$/m.exec(readFileSync(`${ADR_DIR}/${file}`, 'utf8'));
  return match ? match[1].trim() : null;
}

// ---------------------------------------------------------------- T1: header bullets

test('T1 the threat model carries the five header bullets, in order, with usable values', () => {
  assert.deepEqual(
    headerBullets.map(([name]) => name),
    REQUIRED_BULLETS,
    `${DOC}: header bullets missing, duplicated or out of order. Restore exactly, at the top: ` +
      REQUIRED_BULLETS.map((name) => `- **${name}**: <value>`).join(', '),
  );
  assert.match(header.get('Status'), STATUS_RE, `${DOC}: Status is not a lifecycle state`);
  assert.ok(
    isRealDate(header.get('Date')),
    `${DOC}: Date "${header.get('Date')}" is not a real YYYY-MM-DD`,
  );
  assert.ok(header.get('Scope').length > 0, `${DOC}: Scope names no layer`);
  assert.match(
    header.get('Trace'),
    TRACE_RE,
    `${DOC}: Trace names no FR/NFR ID, so the chain requirement -> threat -> mitigation is broken`,
  );
  const scheduled = roadmapTrace('1.3');
  assert.ok(
    scheduled.length > 0,
    `${ROADMAP}: task 1.3's row traces nothing, so this compares nothing`,
  );
  const dropped = scheduled.filter((id) => !header.get('Trace').includes(id));
  assert.deepEqual(
    dropped,
    [],
    `${DOC}: Trace drops ${dropped.join(', ')}, which ${ROADMAP} schedules task 1.3 against`,
  );
  const classification = header.get('Classification');
  assert.match(
    classification,
    CLASSIFICATION_RE,
    `${DOC}: Classification "${classification}" does not name a level, what it covers, and who ` +
      `decided it when. Write it as: LEVEL — <what it covers> (<who>, <YYYY-MM-DD>). ADR-0002 ` +
      `handed the undetermined classification to this task; re-stating it as undetermined ` +
      `closes that question without answering it.`,
  );
  const [, , , decider, decided] = CLASSIFICATION_RE.exec(classification);
  assert.ok(
    isRealDate(decided),
    `${DOC}: the Classification decision date is not a real YYYY-MM-DD`,
  );
  assert.doesNotMatch(
    decider,
    PENDING_RE,
    `${DOC}: the Classification is attributed to "${decider}", which says nobody decided it`,
  );
});

// ---------------------------------------------------------------- T2: sections

test('T2 the threat model carries the ten mandated sections, in order', () => {
  assert.deepEqual(
    [...SOURCE.matchAll(/^## (.+)$/gm)].map((match) => match[1].trim()),
    REQUIRED_SECTIONS,
    `${DOC}: H2 sections missing, extra, renamed or out of order. A renamed section is a ` +
      `missing section: the parser below keys tables by the headings around them, and a reader ` +
      `looking for "Residual risks" at Gate 2 finds nothing rather than finding it moved.`,
  );
});

// ---------------------------------------------------------------- T3: route totality

test('T3 every route the seam exports appears as a surface on some trust boundary', () => {
  assert.ok(
    routes.length > 0,
    'packages/control-plane-api/src/main.mjs exported no routes, so this check compares nothing',
  );
  const errors = [];
  const covered = new Set();
  const served = new Set(routes.map((route) => `${route.method} ${route.path}`));
  for (const row of boundaries) {
    const { tokens, clean } = surfaceTokens(row.Surfaces);
    if (!clean)
      errors.push(
        `${row.ID}: Surfaces holds text outside a backticked token, so no reader can enumerate ` +
          `it. Every surface is a token: \`POST /v1/evidence\` or \`git:config/control-plane/**\`.`,
      );
    if (tokens.length === 0) errors.push(`${row.ID}: Surfaces names nothing`);
    for (const token of tokens) {
      if (ROUTE_TOKEN_RE.test(token)) {
        if (!served.has(token))
          errors.push(
            `${row.ID}: surface \`${token}\` is shaped like a route but the seam serves no such ` +
              `route. A typo here reads as coverage of a surface that does not exist.`,
          );
        covered.add(token);
      } else if (!NON_ROUTE_TOKEN_RE.test(token))
        errors.push(
          `${row.ID}: surface \`${token}\` is neither a route ("METHOD /path") nor a prefixed ` +
            `non-route surface (${SURFACE_PREFIXES.join('|')}:<path>)`,
        );
    }
  }
  const missing = routes
    .map((route) => `${route.method} ${route.path}`)
    .filter((route) => !covered.has(route));
  assert.deepEqual(
    missing,
    [],
    `${missing.length} route(s) the seam serves cross no trust boundary in ${DOC}: ` +
      `${missing.join(', ')}. Add each one to the Surfaces cell of the boundary that carries ` +
      `it — an unmodelled route is an unmodelled attack surface, and the seam grew it without ` +
      `this document noticing.`,
  );
  assert.deepEqual(errors, [], errors.join('\n'));
});

// ---------------------------------------------------------------- T4: STRIDE totality

test('T4 every trust boundary indexes all six STRIDE letters and records its control', () => {
  const errors = [];
  for (const row of boundaries) {
    if (!parseCoverage(row['STRIDE coverage']))
      errors.push(
        `${row.ID}: STRIDE coverage "${row['STRIDE coverage']}" is not all six letters in ` +
          `order. Write it as: S:<v> T:<v> R:<v> I:<v> D:<v> E:<v>, where each <v> is n/a or a ` +
          `comma-separated ABU list with no spaces. A dropped letter reads as a letter nobody ` +
          `considered, which is the one thing a STRIDE pass exists to rule out.`,
      );
    const control = CONTROL_RE.exec(row.Control);
    if (!control)
      errors.push(
        `${row.ID}: Control "${row.Control}" is not none, convention, or executable check ` +
          `\`<path>\`. A boundary whose control state is unrecorded reads as controlled.`,
      );
    else if (control[2] && !existsSync(control[2]))
      errors.push(
        `${row.ID}: Control names \`${control[2]}\`, which does not exist. The boundary claims ` +
          `a check this repository does not have.`,
      );
    if (!STATUS_CELL_RE.test(row.Status))
      errors.push(
        `${row.ID}: Status "${row.Status}" is neither "current" nor "conditional on ADR-NNNN"`,
      );
    else {
      const number = STATUS_CELL_RE.exec(row.Status)[2];
      if (number && !adrFile(number))
        errors.push(`${row.ID}: conditional on ADR-${number}, which is not a file in ${ADR_DIR}`);
    }
  }
  assert.deepEqual(errors, [], errors.join('\n'));
});

// ---------------------------------------------------------------- T5: referential integrity

test('T5 every ID referenced resolves, and every ID declared is referenced', () => {
  const errors = [];
  const boundaryIds = new Set(boundaries.map((row) => row.ID));
  const abuseIds = new Set(abuses.map((row) => row.ID));
  const mitigationIds = new Set(mitigations.map((row) => row.ID));

  // Boundary -> abuse, and the letters each abuse is indexed under.
  const indexedUnder = new Map();
  // Which boundaries index each abuse case, so the abuse row's own Boundary cell can be held to
  // one of them rather than to mere existence.
  const indexingBoundaries = new Map();
  for (const row of boundaries) {
    const coverage = parseCoverage(row['STRIDE coverage']);
    if (!coverage) continue; // T4 reports the malformed cell; this test would only echo it.
    for (const [letter, ids] of coverage) {
      for (const id of ids) {
        if (!abuseIds.has(id))
          errors.push(
            `${row.ID} indexes ${id} under ${letter}, but ${DOC} declares no such abuse case. ` +
              `Either add the row or correct the reference — a boundary pointing at a missing ` +
              `abuse case reads as covered.`,
          );
        if (!indexedUnder.has(id)) indexedUnder.set(id, new Set());
        indexedUnder.get(id).add(letter);
        if (!indexingBoundaries.has(id)) indexingBoundaries.set(id, new Set());
        indexingBoundaries.get(id).add(row.ID);
      }
    }
  }

  // Abuse -> boundary, and the reverse of the index above.
  for (const row of abuses) {
    if (!boundaryIds.has(row.Boundary))
      errors.push(`${row.ID}: Boundary "${row.Boundary}" is not a declared trust boundary`);
    const letters = indexedUnder.get(row.ID);
    // `continue`, not a dangling else: everything below reads `letters`, and an earlier edit that
    // inserted a check between this `if` and its `else` re-parented the `else` onto the new
    // condition, so an unindexed abuse case threw TypeError instead of reporting itself. The
    // diagnostic this branch exists to print is the most likely decay in the whole file.
    if (!letters) {
      errors.push(
        `${row.ID} is declared but no trust boundary indexes it, so nothing says where it ` +
          `applies. Add ${row.ID} to the STRIDE coverage cell of the boundary it crosses.`,
      );
      continue;
    }
    // The Boundary cell must name a boundary that actually indexes this case, not merely one
    // that exists. Checking only existence left the column decorative: every abuse case could be
    // repointed at an unrelated boundary and the suite stayed green, which is the one-directional
    // integrity this file's own header claims not to have.
    const indexedBy = indexingBoundaries.get(row.ID);
    if (indexedBy && !indexedBy.has(row.Boundary))
      errors.push(
        `${row.ID}: Boundary says "${row.Boundary}" but the STRIDE coverage that files this ` +
          `case is on ${[...indexedBy].sort().join(', ')}. Point the row at a boundary that ` +
          `indexes it, or index it under the boundary the row names.`,
      );
    {
      const declared = row.STRIDE.split(',').map((value) => value.trim());
      const invalid = declared.filter((letter) => !STRIDE_LETTERS.includes(letter));
      if (invalid.length > 0)
        errors.push(`${row.ID}: STRIDE "${row.STRIDE}" names ${invalid.join(', ')}`);
      const expected = STRIDE_LETTERS.filter((letter) => letters.has(letter));
      const actual = STRIDE_LETTERS.filter((letter) => declared.includes(letter));
      if (expected.join(',') !== actual.join(','))
        errors.push(
          `${row.ID}: STRIDE column says "${actual.join(', ')}" but the trust-boundary index ` +
            `files it under "${expected.join(', ')}". The two have to agree, or the index and ` +
            `the abuse case are describing different threats under one ID.`,
        );
    }
  }

  // Abuse <-> mitigation, both directions. "Answered by" and "Addresses" are one relation
  // written down twice, and a relation written down twice diverges unless something compares it.
  const answeredBy = new Map();
  for (const row of abuses) {
    if (!ID_LIST_RE('MIT').test(row['Answered by'])) {
      errors.push(
        `${row.ID}: "Answered by" is "${row['Answered by']}", not a comma-separated MIT list. ` +
          `An abuse case with no mitigation is a residual risk; move it or answer it.`,
      );
      continue;
    }
    for (const id of idList(row['Answered by'])) {
      if (!mitigationIds.has(id))
        errors.push(`${row.ID} is answered by ${id}, which ${DOC} does not declare`);
      answeredBy.set(`${id}->${row.ID}`, true);
    }
  }
  for (const row of mitigations) {
    if (!ID_LIST_RE('ABU').test(row.Addresses)) {
      errors.push(
        `${row.ID}: "Addresses" is "${row.Addresses}", not a comma-separated ABU list. A ` +
          `mitigation that addresses nothing is scope nobody asked for.`,
      );
      continue;
    }
    for (const id of idList(row.Addresses)) {
      if (!abuseIds.has(id))
        errors.push(`${row.ID} addresses ${id}, which ${DOC} does not declare`);
      else if (!answeredBy.has(`${row.ID}->${id}`))
        errors.push(
          `${row.ID} addresses ${id}, but ${id}'s "Answered by" does not name ${row.ID}. ` +
            `Add it there, or drop ${id} here.`,
        );
      answeredBy.delete(`${row.ID}->${id}`);
    }
  }
  for (const pair of answeredBy.keys()) {
    const [mitigation, abuse] = pair.split('->');
    errors.push(
      `${abuse} is answered by ${mitigation}, but ${mitigation}'s "Addresses" does not name ` +
        `${abuse}. Add it there, or drop ${mitigation} from ${abuse}.`,
    );
  }

  // Residual -> abuse.
  for (const row of residuals) {
    if (!ID_LIST_RE('ABU').test(row.From)) {
      errors.push(`${row.ID}: "From" is "${row.From}", not a comma-separated ABU list`);
      continue;
    }
    for (const id of idList(row.From)) {
      if (!abuseIds.has(id))
        errors.push(`${row.ID} derives from ${id}, which ${DOC} does not declare`);
    }
  }

  assert.deepEqual(errors, [], errors.join('\n'));
});

// ---------------------------------------------------------------- T6: mitigation ownership

test('T6 every mitigation is owned by a task that exists or a control already in place', () => {
  // Guards on the predicate itself. A roadmapHasTask that answered true for everything would
  // leave the ownership assertion below passing forever while checking nothing.
  assert.ok(roadmapHasTask('1.3'), `${ROADMAP} has no row for task 1.3, so the lookup is broken`);
  assert.ok(
    !roadmapHasTask('9.9'),
    `${ROADMAP} appears to declare task 9.9, so the ownership lookup no longer discriminates`,
  );

  const errors = [];
  for (const row of mitigations) {
    const owner = row['Owning task'];
    const evidence = row.Evidence;
    const path = EVIDENCE_PATH_RE.exec(evidence)?.[1];

    if (owner === 'in place') {
      if (!path)
        errors.push(
          `${row.ID}: owned "in place" but Evidence is "${evidence}". A mitigation that is ` +
            `already in place has a file enforcing it — name it as a backticked repo path.`,
        );
    } else if (!TASK_ID_RE.test(owner)) {
      errors.push(
        `${row.ID}: "Owning task" is "${owner}", which is neither "in place" nor a task ID`,
      );
    } else if (!roadmapHasTask(owner)) {
      errors.push(
        `${row.ID}: owned by task ${owner}, which ${ROADMAP} does not schedule. A mitigation ` +
          `owned by a task nobody planned is a mitigation nobody is going to write — either add ` +
          `the task to the roadmap or re-point ${row.ID} at one that exists.`,
      );
    }

    if (owner !== 'in place' && evidence !== '—')
      errors.push(
        `${row.ID}: owned by task ${owner} but Evidence is "${evidence}". A mitigation still to ` +
          `be delivered has no evidence yet; citing a file reads as a control already in place.`,
      );
    else if (evidence !== '—' && !path)
      errors.push(
        `${row.ID}: Evidence is "${evidence}", which is neither "—" nor a backticked repo path`,
      );
    if (path && !existsSync(path))
      errors.push(
        `${row.ID}: Evidence names \`${path}\`, which does not exist. The mitigation claims a ` +
          `control this repository does not have.`,
      );
  }
  assert.deepEqual(errors, [], errors.join('\n'));
});

// ---------------------------------------------------------------- T7: residual acceptance

test('T7 every residual risk records who accepted it, or that nobody has yet', () => {
  const errors = [];
  for (const row of residuals) {
    const accepted = row['Accepted by'];
    if (accepted === 'pending Gate 2') {
      // A risk awaiting the gate is a complete record of an incomplete decision.
    } else {
      const match = ACCEPTED_NAME_RE.exec(accepted);
      if (!match)
        errors.push(
          `${row.ID}: "Accepted by" is "${accepted}". It reads either "pending Gate 2" or ` +
            `"<name>, YYYY-MM-DD". A blank is not a third option: Gate 2's no-go condition is ` +
            `"Residual risks unlisted or unreviewed", and an empty cell is both.`,
        );
      else {
        if (!isRealDate(match[2]))
          errors.push(`${row.ID}: acceptance date "${match[2]}" is not a real YYYY-MM-DD`);
        if (PENDING_RE.test(match[1]))
          errors.push(
            `${row.ID}: accepted by "${match[1]}" — the record names an acceptor and still says ` +
              `the approval is outstanding. A record contradicting itself resolves in favour of ` +
              `the half that says nobody signed.`,
          );
      }
    }
    if (row['Why accepted'].length === 0)
      errors.push(`${row.ID}: "Why accepted" is blank, so the acceptance has no stated basis`);
    if (row['Review point'].length === 0)
      errors.push(`${row.ID}: "Review point" is blank, so nothing brings this risk back`);
  }
  assert.deepEqual(errors, [], errors.join('\n'));
});

// ---------------------------------------------------------------- T8: body-limit completeness

const BODY_LIMIT_SECTION = 'Ingress body limit — specification for task 2.1';
const DISPOSITIONS = ['respond then destroy', 'respond then drain'];
const BODY_LIMIT_BULLETS = [
  'Byte cap',
  'Counted',
  'Wire status',
  'Disposition',
  'Contract consequence',
  'Owning task',
];

function sectionLines(heading) {
  const start = LINES.indexOf(`## ${heading}`);
  if (start === -1) return [];
  const rest = LINES.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return end === -1 ? rest : rest.slice(0, end);
}

test('T8 the ingress body limit names every field task 2.1 has to implement', () => {
  const lines = sectionLines(BODY_LIMIT_SECTION);
  assert.ok(lines.length > 0, `${DOC}: no "## ${BODY_LIMIT_SECTION}" section to read`);

  const bullets = [];
  lines.forEach((line, index) => {
    const match = /^- \*\*([^*]+)\*\*:\s*(\S.*)$/.exec(line);
    if (match) bullets.push({ name: match[1].trim(), value: match[2].trim(), index });
  });

  assert.deepEqual(
    bullets.map((bullet) => bullet.name),
    BODY_LIMIT_BULLETS,
    `${DOC}: the body-limit bullets are missing, renamed or out of order. Task 2.1 reads them ` +
      `by name; a missing one is a decision 2.1 has to make on its own, in code, under sprint ` +
      `pressure. Restore exactly: ${BODY_LIMIT_BULLETS.map((n) => `- **${n}**: <value>`).join(', ')}`,
  );

  const value = new Map(bullets.map((bullet) => [bullet.name, bullet.value]));
  const cap = Number(value.get('Byte cap'));
  assert.ok(
    Number.isInteger(cap) && cap > 0,
    `${DOC}: "Byte cap" is "${value.get('Byte cap')}", not a positive integer of bytes. A cap ` +
      `written in MB is a cap two implementers will round differently.`,
  );
  assert.match(
    value.get('Wire status'),
    /^4\d{2}$/,
    `${DOC}: "Wire status" is "${value.get('Wire status')}", not a 4xx. An oversized body is ` +
      `the client's to fix; any other class tells the producer something false about it.`,
  );
  assert.ok(
    DISPOSITIONS.includes(value.get('Disposition')),
    `${DOC}: "Disposition" is "${value.get('Disposition')}", not one of ${DISPOSITIONS.join(' | ')}. ` +
      `Whether the socket is destroyed or drained is the decision 2.1 must not make alone.`,
  );
  for (const required of ['openapi.json', 'info.version'])
    assert.ok(
      value.get('Contract consequence').includes(required),
      `${DOC}: "Contract consequence" does not mention ${required}. A new status is a published ` +
        `contract change and a version bump; 2.1 has to be told both.`,
    );
  assert.ok(
    value.get('Contract consequence').includes(value.get('Wire status')),
    `${DOC}: "Contract consequence" does not mention status ${value.get('Wire status')}. The ` +
      `seam is held to openapi.json in both directions, so a status the limit introduces has to ` +
      `be declared there in the same change — say so here or 2.1 will not know.`,
  );
  const owner = value.get('Owning task');
  assert.ok(
    owner === 'in place' || (TASK_ID_RE.test(owner) && roadmapHasTask(owner)),
    `${DOC}: the body limit's "Owning task" is "${owner}", which ${ROADMAP} does not schedule`,
  );

  // Every bullet carries its reason beneath it. A field with no reason is a number 2.1 will
  // change the first time it is inconvenient, because nothing records what it was chosen against.
  const unreasoned = bullets.filter((bullet, position) => {
    const until = bullets[position + 1]?.index ?? lines.length;
    return !lines
      .slice(bullet.index + 1, until)
      .some((line) => line.trim().length > 0 && !line.startsWith('- '));
  });
  assert.deepEqual(
    unreasoned.map((bullet) => bullet.name),
    [],
    `${DOC}: ${unreasoned.length} body-limit bullet(s) state a value with no reason beneath: ` +
      `${unreasoned.map((bullet) => bullet.name).join(', ')}`,
  );
});

// ---------------------------------------------------------------- T9: self-retiring conditionality

test('T9 a boundary conditional on ADR-0002 retires itself once that ADR is decided', () => {
  const file = adrFile(CONDITION_ADR);
  assert.ok(file, `${ADR_DIR} holds no ADR-${CONDITION_ADR}, so this condition can never resolve`);
  const status = adrStatus(CONDITION_ADR);
  assert.ok(status, `${ADR_DIR}/${file} carries no "- **Status**:" bullet this check can read`);

  const conditional = boundaries.filter(
    (row) => row.Status === `conditional on ADR-${CONDITION_ADR}`,
  );

  if (status === 'Proposed') {
    // The guard against a silent licence: while the ADR is a proposal, at least one row has to
    // be marked conditional, or this test asserts nothing and would go on asserting nothing
    // after the ADR is decided.
    assert.ok(
      conditional.length > 0,
      `ADR-${CONDITION_ADR} is still Proposed and no boundary in ${DOC} is marked "conditional ` +
        `on ADR-${CONDITION_ADR}", so this check is asserting nothing. Either a boundary ` +
        `describing the proposed durable store lost its condition, or this condition should go.`,
    );
    return;
  }

  assert.deepEqual(
    conditional.map((row) => row.ID),
    [],
    `ADR-${CONDITION_ADR} is now "${status}", so ${conditional.length} boundary row(s) in ` +
      `${DOC} still describe it as a proposal: ${conditional.map((row) => row.ID).join(', ')}. ` +
      `Promote each one — change its Status cell from "conditional on ADR-${CONDITION_ADR}" to ` +
      `"current" and re-read its Trusted side, which now describes a store that exists.`,
  );
});

// ---------------------------------------------------------------- T10: guards on the guard

// Every assertion above checks that the document's *structure* holds together. None of them
// required it to say anything: a review demonstrated an 88-line document with the letter "x" in
// every descriptive cell, "n/a" in seven prose sections and a one-byte cap passing all ten. A
// threat model that describes nothing is not a threat model, and "it parsed" is not the claim
// this file exists to make.
//
// A first version of this test was defeated by substituting one character: it named "x+" and
// ".+" as repeatable placeholders but "-" as a singleton, so a cell of twenty-four hyphens
// passed where a single hyphen failed, and it measured length with whitespace included, so
// "x x x x x x x x x x x x" cleared a twenty-four character bar. Both are fixed below by
// testing the property rather than the counterexample: any cell that is one character repeated
// is a placeholder whatever that character is, and length counts non-space characters only.
//
// The bar is deliberately low - a short sentence clears it. It cannot tell a considered abuse
// case from a plausible-sounding one, and nothing here should be read as claiming it can. What
// it removes is a cell that carries no words.
const MIN_PROSE = 24;
// A boundary's name is a label, not a sentence - "Network peer to HTTP seam" is 21 non-space
// characters and says everything it needs to. Holding a label to the prose bar would force
// padding, which is the opposite of what this test is for.
const MIN_LABEL = 12;
// Named fillers, plus any run of a single character: "---", "___", "!!!" and "xxx" are all the
// same non-statement, and enumerating the characters is what let the first version through.
const PLACEHOLDER = /^(n\/a|tbd|todo|none|\u2014|(.)\2*)$/i;
// `Review point` is structured, not prose - its real values are "Gate 2", "Task 2.1" - so it
// gets a grammar instead of a length bar. Holding it to MIN_PROSE would fail the live document.
const REVIEW_POINT = /^(Gate \d+|Task \d+\.\d+)( and task \d+\.\d+)?$/;

test('T11 the descriptive cells actually describe something', () => {
  const errors = [];
  const check = (rows, columns, minimum = MIN_PROSE) => {
    for (const row of rows) {
      for (const column of columns) {
        const value = (row[column] ?? '').trim();
        // Non-space length: whitespace is not content, and counting it is how a row of single
        // letters separated by spaces cleared the bar.
        const dense = value.replace(/\s+/g, '').length;
        if (PLACEHOLDER.test(value))
          errors.push(
            `${row.ID}: "${column}" is "${value}", which states nothing. A row whose ` +
              `text is a placeholder passes every structural check here and tells a reader nothing.`,
          );
        else if (dense < minimum)
          errors.push(
            `${row.ID}: "${column}" carries ${dense} non-space characters, under the ` +
              `${minimum} this check requires. Say what it is, or remove the row.`,
          );
      }
    }
  };
  check(boundaries, ['Boundary', 'Untrusted side', 'Trusted side'], MIN_LABEL);
  check(boundaries, ['Assets crossing']);
  check(abuses, ['Abuse case']);
  check(mitigations, ['Mitigation']);
  // "Why accepted" is the basis Gate 2 reads to decide. T7 only refused it empty, so a single
  // hyphen - rejected everywhere else in this test - passed both checks.
  check(residuals, ['Residual risk', 'Why accepted']);
  for (const row of residuals) {
    if (!REVIEW_POINT.test(row['Review point']))
      errors.push(
        `${row.ID}: "Review point" is "${row['Review point']}", which names no gate or task. ` +
          `Use "Gate N" or "Task N.N" so the re-review has a trigger somebody owns.`,
      );
  }
  assert.deepEqual(errors, [], errors.join('\n'));
});

test('T10 the parser behind every assertion above actually read the document', () => {
  for (const [name, table] of Object.entries(TABLES)) {
    assert.ok(
      table.found,
      `${DOC}: no table under "${name}" with the exact header row ` +
        `"${table.headers.join(' | ')}". A renamed column is a missing table, and every ` +
        `assertion keyed on it passes over zero rows rather than failing.`,
    );
    assert.ok(table.rows.length > 0, `${DOC}: the "${name}" table parsed zero rows`);
    assert.deepEqual(
      table.malformed,
      [],
      `${DOC}: ${table.malformed.length} row(s) in "${name}" do not split into ` +
        `${table.headers.length} cells — a cell containing a literal pipe, or a missing ` +
        `column: ${table.malformed.map((row) => `line ${row.line} (${row.count} cells)`).join(', ')}`,
    );
  }

  // Row-count identity. The tables above are found by their header; this counts ID-prefixed rows
  // in the raw source instead, so a row that fell out of the parse - wrong cell count, stranded
  // under a different table, orphaned after a blank line - is a discrepancy rather than a silence.
  const parsed = Object.values(TABLES).reduce((total, table) => total + table.rows.length, 0);
  const declared = LINES.filter((line) => /^\| (TB|ABU|MIT|RR)-/.test(line)).length;
  assert.equal(
    parsed,
    declared,
    `${DOC}: ${declared} ID-prefixed row(s) in the source but ${parsed} parsed. Some row is not ` +
      `where this check looks for it.`,
  );

  // IDs unique, and dense from 1. A gap is a row somebody deleted without renumbering, and the
  // deleted ID is still referenced somewhere by anything that was pointing at it.
  for (const [name, table] of Object.entries(TABLES)) {
    const numbers = table.rows.map((row) => Number(row.ID.slice(table.prefix.length + 1)));
    assert.equal(
      new Set(numbers).size,
      numbers.length,
      `${DOC}: "${name}" repeats an ID, so one of them is unreachable by reference`,
    );
    assert.deepEqual(
      [...numbers].sort((a, b) => a - b),
      numbers.map((_, index) => index + 1),
      `${DOC}: "${name}" IDs are not ${table.prefix}-1..${table.prefix}-${numbers.length}`,
    );
  }

  // Every STRIDE letter observed at least once across the whole index. Six letters that all read
  // n/a everywhere is a STRIDE pass nobody ran, and it satisfies every other assertion here.
  const observed = new Set();
  for (const row of boundaries) {
    const coverage = parseCoverage(row['STRIDE coverage']);
    if (!coverage) continue;
    for (const [letter, ids] of coverage) if (ids.length > 0) observed.add(letter);
  }
  assert.deepEqual(
    STRIDE_LETTERS.filter((letter) => !observed.has(letter)),
    [],
    `${DOC}: no trust boundary names an abuse case under ${STRIDE_LETTERS.filter(
      (letter) => !observed.has(letter),
    ).join(', ')}. Every letter reading n/a everywhere is a STRIDE pass that was never run.`,
  );
});
