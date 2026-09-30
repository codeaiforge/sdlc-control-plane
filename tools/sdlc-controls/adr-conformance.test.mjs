import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

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
// Words a Deciders line uses to say nobody has signed yet. One definition, read by every check
// that asks whether an approval is outstanding, so the checks cannot disagree about what
// "outstanding" looks like.
const OUTSTANDING_RE = /\b(pending|awaiting|unapproved|not yet|tbd|tbc)\b/i;
const ANY_DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/g;

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
  // Security-role sign-off in addition to Architect approval before it is Accepted, so the roles
  // have to be named. Naming them alone is passable by an ADR nobody approved ("pending Architect
  // review" names the architect); the next test, which covers every Accepted ADR and not only
  // this kind, is what refuses a Deciders line that still says the approval is outstanding.
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
  }
});

test('an accepted ADR no longer records its approval as outstanding, whatever it traces', () => {
  // The compliance check above fires only on an NFR-6 trace, so an ADR tracing anything else could
  // read Accepted over a Deciders line that still says "pending" and every check stayed green.
  // Acceptance is a human act at a point in time, so the line that records it has to carry the
  // date it happened as well as stop saying it has not. That date cannot precede the record's
  // own Date: an approval dated before the decision was written is not an approval of it. A
  // Deciders line whose only date is the day it was proposed still passes when the two days
  // coincide; this check reads dates, not intent. One qualifying date is enough, so an earlier
  // date beside it on the same line also passes.
  for (const { file, body } of adrs) {
    const header = new Map(headerBullets(body));
    if (header.get('Status') !== 'Accepted') continue;
    const deciders = header.get('Deciders');
    assert.doesNotMatch(
      deciders,
      OUTSTANDING_RE,
      `${file}: Accepted, but Deciders still records the approval as outstanding`,
    );
    const dates = (deciders.match(ANY_DATE_RE) ?? []).filter(isRealDate);
    assert.ok(
      dates.length > 0,
      `${file}: Accepted, but Deciders carries no real YYYY-MM-DD for when the approval was made`,
    );
    // YYYY-MM-DD strings order the same way the dates do, so string comparison is date comparison.
    assert.ok(
      dates.some((date) => date >= header.get('Date')),
      `${file}: Accepted, but no date in Deciders (${dates.join(', ')}) is on or after the record's Date ${header.get('Date')}`,
    );
  }
});

test('a proposed ADR says in its Deciders that the approval is outstanding', () => {
  // The other direction. A Proposed record whose Deciders reads like a sign-off ("Approved by the
  // founder") claims an approval its Status denies, and an agent can write that sentence as
  // easily as a human. Saying so explicitly is the only state a Proposed record may be in. The
  // match is on any outstanding-word, so a negated one ("nothing pending") also passes.
  for (const { file, body } of adrs) {
    const header = new Map(headerBullets(body));
    if (header.get('Status') !== 'Proposed') continue;
    assert.match(
      header.get('Deciders'),
      OUTSTANDING_RE,
      `${file}: Proposed, but Deciders does not say the approval is outstanding`,
    );
  }
});

test('the stack profile states each ADR it links at the status the ADR itself records', () => {
  // docs/specs/stack.md names ADRs with their status beside the link, in the form
  // "[<text>](<path>) — <Status>". That status is a copy, and a copy rots the moment the ADR is
  // approved or superseded unless something compares the two. What is enforced, exactly:
  //
  // - An inline link is an ADR link when its target's file name is NNNN-*.md or its text names
  //   ADR-NNNN (hyphen, space or nothing between), whatever else the text says. Each one must
  //   resolve, relative to docs/specs/, to that ADR's actual file under docs/adr/ — a URL, a
  //   broken relative path or a different ADR's file fails — and must be followed at once by
  //   " — <Status>" equal to the ADR's own Status. A #fragment is allowed and ignored.
  // - Outside links, "ADR-NNNN — <lifecycle word>" is a status statement too and is compared.
  // - At least one ADR link must be found, so a change of format cannot make this read nothing.
  //
  // Not enforced: a status written in any other shape of prose ("ADR-0003 is Accepted",
  // "ADR-0003 (Accepted)" without a link), and reference-style links.
  const PROFILE = 'docs/specs/stack.md';
  const profile = readFileSync(PROFILE, 'utf8');
  const byNumber = new Map(
    adrs.map(({ file, body }) => [
      file.slice(0, 4),
      { file, status: new Map(headerBullets(body)).get('Status') },
    ]),
  );
  const grandfathered = new Map([...GRANDFATHERED].map((file) => [file.slice(0, 4), file]));
  const STATUS_AFTER = /^ — (Superseded by ADR-\d{4}|[A-Za-z]+)/;
  const LINK_RE = /\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
  const NAMED_RE = /\bADR[-\s]?(\d{4})\b/i;

  const compare = (number, stated, where) => {
    if (grandfathered.has(number)) {
      assert.fail(
        `${PROFILE} ${where} states a status for ADR-${number}, but ${grandfathered.get(number)} is grandfathered and carries no header Status to compare it with; mention it without a link or a status`,
      );
    }
    const adr = byNumber.get(number);
    assert.ok(adr, `${PROFILE} ${where} names ADR-${number}, but ${DIR} holds no such ADR`);
    assert.equal(
      stated,
      adr.status,
      `${PROFILE} ${where} says ADR-${number} is ${stated}, but ${adr.file} says ${adr.status}`,
    );
    return adr;
  };

  let found = 0;
  for (const link of profile.matchAll(LINK_RE)) {
    const [whole, text, target] = link;
    const path = target.split('#')[0];
    const byTarget = /^(\d{4})-.+\.md$/.exec(basename(path))?.[1];
    const byText = NAMED_RE.exec(text)?.[1];
    if (!byTarget && !byText) continue;
    found += 1;
    const where = `link ${whole}`;
    assert.ok(
      !byTarget || !byText || byTarget === byText,
      `${PROFILE} ${where}: the text names ADR-${byText} but the target is ADR-${byTarget}'s file`,
    );
    const number = byTarget ?? byText;
    const after = STATUS_AFTER.exec(profile.slice(link.index + whole.length));
    assert.ok(
      after,
      `${PROFILE} ${where} is not followed by " — <Status>", so its status escapes this check`,
    );
    const adr = compare(number, after[1], where);
    assert.ok(
      !/^[a-z][a-z0-9+.-]*:/i.test(path) && join(dirname(PROFILE), path) === join(DIR, adr.file),
      `${PROFILE} ${where} does not resolve to ${join(DIR, adr.file)}`,
    );
  }
  assert.ok(found > 0, `${PROFILE} links no ADR this check can read, so it checks nothing`);

  const prose = profile.replace(LINK_RE, ' ');
  const STATED_RE =
    /\bADR[-\s]?(\d{4}) — (Superseded by ADR-\d{4}|Proposed|Accepted|Deprecated|Superseded)\b/gi;
  for (const [whole, number, stated] of prose.matchAll(STATED_RE)) {
    compare(number, stated, `text "${whole}"`);
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
