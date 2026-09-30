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
// "outstanding" looks like. It includes the phrases this repository's own Proposed records use
// ("No human has approved it yet; this record states a proposal, not an approval"), so an approval
// commit that edits only the word "pending" still fails.
const OUTSTANDING_RE =
  /\b(pending|awaiting|unapproved|yet|outstanding|tbd|tbc|not approved|not an approval|no human)\b/i;
const ANY_DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/g;
const APPROVED_BY_RE = /\bapproved by\b/i;

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

// Why an Accepted header does not record a real approval; empty when it does. Acceptance is a
// human act at a point in time, so it needs a sentence of its own — "Approved by <who> …, <date>" —
// whose date is a real day no earlier than the record's Date (an approval of a decision not yet
// written is not an approval of it) and no later than `latest`. An NFR-6 record also needs the
// Architect and Security roles named in that sentence, after "approved by": .ai/standards/adr.md requires both to
// sign off, and a proposer clause ("Proposed by the Architect role…") names them without either
// approving. Sentences split at a full stop or semicolon followed by a space, which no date
// contains. YYYY-MM-DD strings order the same way the dates do, so string comparison is date
// comparison. Known escapes: a negation or a non-approver this list does not name ("never approved by",
// "approved by nobody"), and
// look-alike letters from another script ("pеnding" with a Cyrillic е). This reads words, not
// intent; who wrote the approval is the PR gate's question, not this check's.
const approvalProblems = (header, latest) => {
  const deciders = header.get('Deciders');
  const problems = [];
  if (OUTSTANDING_RE.test(deciders))
    problems.push('Deciders still records the approval as outstanding');
  const approval = deciders
    .split(/[.;]\s/)
    .find(
      (sentence) =>
        APPROVED_BY_RE.test(sentence) &&
        (sentence.match(ANY_DATE_RE) ?? []).some(
          (date) => isRealDate(date) && date >= header.get('Date') && date <= latest,
        ),
    );
  // The roles count only from "approved by" on, so a proposer clause joined to the approval by a
  // comma cannot name them for it.
  const granted = approval?.slice(approval.search(APPROVED_BY_RE));
  if (!approval)
    problems.push(
      `Deciders has no "Approved by …" sentence carrying a real date from the record's Date ${header.get('Date')} to ${latest}`,
    );
  else if (
    /NFR-6\.\d+/.test(header.get('Trace')) &&
    !(/architect/i.test(granted) && /security/i.test(granted))
  )
    problems.push(
      'traces NFR-6, but its "Approved by" sentence does not name both the Architect and Security roles',
    );
  return problems;
};

// Tomorrow in UTC, so an approval dated in the approver's own time zone ahead of UTC still passes.
const LATEST_APPROVAL = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

test('the docs/adr directory holds nothing this check silently skips', () => {
  // A file the ADR filter does not match (0005-x.MD, a subdirectory) is read by no check here and
  // none in check-numbering, so an Accepted record could sit there unexamined.
  for (const entry of readdirSync(DIR, { withFileTypes: true })) {
    assert.ok(
      entry.isFile() && (entry.name === 'README.md' || FILE_RE.test(entry.name)),
      `${DIR}/${entry.name} is not an NNNN-*.md ADR or the README, so no ADR check reads it`,
    );
  }
});

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

test('an accepted ADR records a dated approval, naming both roles when it traces NFR-6', () => {
  // .ai/standards/adr.md: an ADR tracing a Compliance requirement (an NFR-6.* ID) needs
  // Security-role sign-off in addition to Architect approval before it is Accepted. Every Accepted
  // ADR, whatever it traces, must stop saying its approval is outstanding and record when it was
  // given; approvalProblems says exactly what is read.
  for (const { file, body } of adrs) {
    const header = new Map(headerBullets(body));
    if (header.get('Status') !== 'Accepted') continue;
    assert.deepEqual(approvalProblems(header, LATEST_APPROVAL), [], `${file}: Accepted, but`);
  }
});

test('the approval check refuses the edits a hurried approval commit would make', () => {
  // Nothing in docs/adr is Accepted under this check yet, so without these probes it would pass
  // by reading nothing. Each probe is an edit that flips a Status and leaves the record unapproved,
  // and must fail on exactly the rule it names, so a probe cannot stay green for the wrong reason.
  const header = (deciders, trace = 'NFR-2.1, NFR-6.1') =>
    new Map([
      ['Status', 'Accepted'],
      ['Date', '2026-09-29'],
      ['Deciders', deciders],
      ['Trace', trace],
    ]);
  const latest = '2026-10-01';
  const OUTSTANDING = /still records the approval as outstanding/;
  const UNDATED = /no "Approved by …" sentence/;
  const ROLES = /does not name both/;
  for (const [deciders, trace] of [
    [
      'Proposed by the Architect role. Approved by dsofianos (founder) for the Architect and Security Engineer roles, 2026-09-30.',
    ],
    // Roles are required only of an NFR-6 record.
    ['Approved by dsofianos, 2026-09-30.', 'NFR-2.1'],
  ]) {
    assert.deepEqual(approvalProblems(header(deciders, trace), latest), [], deciders);
  }
  for (const [deciders, rule] of [
    // Only "Approval is pending" replaced; the rest of ADR-0004's Proposed line left in place.
    [
      'Proposed by the Architect role, with the Security Engineer role co-designing. Approved by the founder for the Architect and Security roles, 2026-09-30. No human has approved it yet; this record states a proposal, not an approval.',
      OUTSTANDING,
    ],
    [
      'Approval outstanding. Approved by dsofianos for the Architect and Security roles, 2026-09-30.',
      OUTSTANDING,
    ],
    // The roles are named only by the proposer clause, in its own sentence or joined by a comma.
    [
      'Proposed by the Architect role, with the Security Engineer role. Approved by dsofianos, 2026-09-30.',
      ROLES,
    ],
    [
      'Proposed by the Architect role with the Security Engineer role co-designing, and approved by dsofianos, 2026-09-30.',
      ROLES,
    ],
    ['Approved by dsofianos for the Architect and Security roles, 2099-12-31.', UNDATED],
    ['Approved by dsofianos for the Architect and Security roles, 2026-09-28.', UNDATED],
    ['Approved by dsofianos for the Architect and Security roles, 2026-02-30.', UNDATED],
    // A date and the roles, but no sentence that says an approval was given.
    ['Architect and Security Engineer roles: dsofianos (founder), 2026-09-30.', UNDATED],
  ]) {
    const problems = approvalProblems(header(deciders), latest);
    assert.equal(problems.length, 1, `${deciders}: ${problems.join('; ') || 'passed'}`);
    assert.match(problems[0], rule, deciders);
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
    if (grandfathered.has(number))
      assert.fail(
        `${PROFILE} ${where} links ADR-${number}, but ${grandfathered.get(number)} is grandfathered and carries no header Status to compare it with; mention it without a link or a status`,
      );
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
