import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// ADR conformance check.
//
// .ai/standards/adr.md mandates four header bullets, in one order, with constrained values, and
// four H2 sections, in one order. Until now nothing read it: tools/adr/check-numbering.mjs
// checks that an ADR's number is unique, inside a declared block and matches its filename, and
// stops there. An ADR could carry no Status, a Trace naming no requirement, or its sections in
// any order, and every check in this repository would stay green — which is the workspace's own
// definition of a convention rather than a control.
//
// Picked up by the existing tools/sdlc-controls/*.test.mjs glob in `pnpm test:controls` and in
// .github/workflows/sdlc-controls.yml, so this file needs no package.json or workflow change.

const DIR = 'docs/adr';
const FILE_RE = /^\d{4}-.+\.md$/;
const TEMPLATE = '0000-template.md';

// ADR-0001 predates this standard: it carries "## Status" as a section rather than the four
// header bullets, and it names no Deciders. It stays exempt rather than being retrofitted.
// Adding a Deciders line to it now would manufacture an approval record nobody made — the same
// act .ai/standards/ai-provenance.md refuses for commit trailers, in terms that apply here
// exactly ("a declaration applied after the fact is one nobody made at the time"). The standard
// has its own clean path for a record that no longer fits: supersede it with a new ADR, which
// leaves both the original and the correction visible. A backdated retrofit leaves neither.
const GRANDFATHERED = new Set(['0001-federated-control-plane.md']);

const BULLET_RE = /^- \*\*(Status|Date|Deciders|Trace)\*\*:\s*(\S.*)$/;
const REQUIRED_BULLETS = ['Status', 'Date', 'Deciders', 'Trace'];
const REQUIRED_SECTIONS = ['Context', 'Decision', 'Options Considered', 'Consequences'];
const STATUS_RE = /^(Proposed|Accepted|Superseded by ADR-\d{4}|Deprecated)$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TRACE_RE = /(FR-\d+\.\d+|NFR-\d+\.\d+|Infra|Testing)/;

const adrs = readdirSync(DIR)
  .filter((file) => FILE_RE.test(file) && file !== TEMPLATE && !GRANDFATHERED.has(file))
  .sort()
  .map((file) => ({ file, body: readFileSync(join(DIR, file), 'utf8') }));

// The header bullets in the order they appear, so a check on their values cannot pass by reading
// a bullet from somewhere else in the document.
const headerBullets = (body) =>
  body
    .split('\n')
    .map((line) => BULLET_RE.exec(line))
    .filter(Boolean)
    .map((match) => [match[1], match[2].trim()]);

const isRealDate = (value) => {
  const parts = DATE_RE.exec(value);
  if (!parts) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

test('every ADR carries the four header bullets, in the standard order, with usable values', () => {
  assert.ok(adrs.length > 0, `${DIR} holds no ADR this check can read, so it checks nothing`);
  for (const { file, body } of adrs) {
    const bullets = headerBullets(body);
    const header = new Map(bullets);
    assert.deepEqual(
      bullets.map(([name]) => name),
      REQUIRED_BULLETS,
      `${file}: header bullets missing, duplicated or out of the order .ai/standards/adr.md fixes`,
    );
    assert.match(header.get('Status'), STATUS_RE, `${file}: Status is not a lifecycle state`);
    assert.ok(
      isRealDate(header.get('Date')),
      `${file}: Date "${header.get('Date')}" is not a real YYYY-MM-DD`,
    );
    assert.ok(header.get('Deciders').length > 0, `${file}: Deciders names nobody`);
    assert.match(
      header.get('Trace'),
      TRACE_RE,
      `${file}: Trace names no FR/NFR ID and neither Infra nor Testing, so the chain requirement -> decision -> code is broken`,
    );
  }
});

test('every ADR carries the four mandated sections, in the standard order', () => {
  for (const { file, body } of adrs) {
    assert.deepEqual(
      [...body.matchAll(/^## (.+)$/gm)].map((match) => match[1].trim()),
      REQUIRED_SECTIONS,
      `${file}: H2 sections missing, extra or out of the order .ai/standards/adr.md fixes`,
    );
  }
});

test('an accepted compliance ADR names the roles that approved it', () => {
  // .ai/standards/adr.md: an ADR tracing a Compliance requirement (an NFR-6.* ID) needs
  // Security-role sign-off in addition to Architect approval before it is Accepted. Two things
  // are checked, because either one alone is passable by an ADR nobody approved: the roles have
  // to be named, AND the record must not still say the approval is outstanding. "Accepted" on
  // top of "pending Architect review" is a record contradicting itself, and the contradiction
  // resolves in favour of the sentence that says nobody has signed.
  for (const { file, body } of adrs) {
    const header = new Map(headerBullets(body));
    if (header.get('Status') !== 'Accepted' || !/NFR-6\.\d+/.test(header.get('Trace'))) continue;
    const deciders = header.get('Deciders');
    assert.match(
      deciders,
      /architect/i,
      `${file}: accepted with an NFR-6 trace but names no architect`,
    );
    assert.match(
      deciders,
      /security/i,
      `${file}: accepted with an NFR-6 trace but names no security role`,
    );
    assert.doesNotMatch(
      deciders,
      /\b(pending|awaiting|unapproved|not yet|tbd|tbc)\b/i,
      `${file}: Accepted, but Deciders still records the approval as outstanding`,
    );
  }
});

test('every grandfathered exemption still has a file to exempt', () => {
  // An exemption that outlives its file is a silent licence: rename or delete the ADR and the
  // name sits here forever, ready to exempt whatever is written under it next.
  for (const file of GRANDFATHERED) {
    assert.ok(
      existsSync(join(DIR, file)),
      `${file} is exempted from the ADR standard but no longer exists; drop the exemption`,
    );
  }
});
