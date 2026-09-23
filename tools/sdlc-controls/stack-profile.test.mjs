import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

// Stack profile conformance check.
//
// The pipeline dispatches on the stack profile by row name: .github/prompts/run-task.prompt.md
// reads "the stack profile's **Affected lint/test/build** command", "**Access control**",
// "**Data access**", and several more. A row under a different name, or missing entirely, is a
// row no phase can find — and the phase does not fail, it skips. That is the failure mode this
// exists to remove: docs/specs/stack.md was written free-form rather than from its template,
// 16 of the template's 19 rows were absent by name, and every check in this repository stayed
// green while Phase ⑥ had nothing to dispatch on for a decision ADR-0002 had already made.
//
// Two assertions, because a row can fail the pipeline in two different ways:
//
//   1. absent by name    -> the lookup finds nothing and the check is skipped
//   2. present but empty -> the lookup finds a blank and the check is skipped just as silently
//
// An undecided row is expected to read "Not selected — <who decides it>", which is a value.
// `N/A` is also a value, and means something different: the template says the pipeline skips an
// `N/A` check. Neither marker is asserted here, because which one a row deserves is a judgement
// this file cannot make — what it can insist on is that somebody made it.
//
// Picked up by the existing tools/sdlc-controls/*.test.mjs glob in `pnpm test:controls`.

const TEMPLATE = 'docs/specs/stack-template.md';
const PROFILE = 'docs/specs/stack.md';

// Column headers, not rows. The template names its first column differently per section.
const HEADERS = new Set(['Field', 'Purpose', 'Concern']);

const isSeparator = (cell) => /^[-: ]+$/.test(cell);

// Markdown table rows only: a line that starts with a pipe and has a second pipe after the
// first cell. Prose containing a pipe does not match, and neither does a fenced code block,
// because nothing in either document opens one inside a table.
function tableRows(path) {
  const rows = new Map();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\|([^|]*)\|(.*)$/.exec(line.trim());
    if (!match) continue;
    const name = match[1].trim();
    const value = match[2].replace(/\|\s*$/, '').trim();
    if (name === '' || isSeparator(name) || HEADERS.has(name)) continue;
    // First occurrence wins, so a row repeated by accident is reported once.
    if (!rows.has(name)) rows.set(name, value);
  }
  return rows;
}

test('the stack profile carries every row the template defines, under the template name', () => {
  const template = tableRows(TEMPLATE);
  const profile = tableRows(PROFILE);
  const missing = [...template.keys()].filter((name) => !profile.has(name));
  assert.deepEqual(
    missing,
    [],
    `${PROFILE} is missing ${missing.length} row(s) the pipeline looks up by name: ` +
      `${missing.join(', ')}. A renamed row is a missing row — the phase check is skipped, ` +
      `not failed, so nothing else here will notice.`,
  );
});

test('no row in the stack profile is left blank', () => {
  const template = tableRows(TEMPLATE);
  const blank = [...tableRows(PROFILE)]
    .filter(([name, value]) => template.has(name) && value === '')
    .map(([name]) => name);
  assert.deepEqual(
    blank,
    [],
    `${PROFILE} has ${blank.length} row(s) with no value: ${blank.join(', ')}. ` +
      `An undecided row reads "Not selected — <who decides it>"; a row that does not apply ` +
      `reads "N/A". A blank is indistinguishable from both.`,
  );
});
