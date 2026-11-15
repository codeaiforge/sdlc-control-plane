import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { StartupRefused } from './database-config.mjs';
import { RETENTION_WINDOW } from './expire.mjs';
import { loadMigrations } from './migrate.mjs';
import {
  AUDIT_ROLE,
  CHECK_STATEMENT_TIMEOUT_MS,
  EXIT,
  OVERDUE_GRACE,
  RetentionCheckRefused,
  USAGE,
  VIOLATIONS,
  assertAuditRole,
  formatReport,
  parseArgs,
  refusalCode,
  retentionCheck,
} from './retention-check.mjs';

// Unit tests, no database. What the check finds on a real server - a missed run, a held lock, an
// owner's bypass, every guard state, every refused role - is retention-check.integration.mjs's,
// against PostgreSQL 16.

const SCRIPT = new URL('./retention-check.mjs', import.meta.url).pathname;
const SOURCE = readFileSync(SCRIPT, 'utf8');
const CODE = SOURCE.split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n');

const AUDIT = { name: 'evidence_audit', session: 'evidence_audit' };
const ENABLED = { enabled: 'O', bundled: true, holds_window: true };

// A fake client in expire.test.mjs's style: a tagged-template function that records every
// statement with its bound values and answers by what the statement reads. `begin(mode, fn)`
// records the mode and runs fn on the same fake between BEGIN and COMMIT markers.
function fakeClient({
  role = {},
  present = true,
  trigger = ENABLED,
  held = { overdue: 0, oldest_hours: 731 },
  unaudited = 0,
  early = 0,
  fail = {},
} = {}) {
  const calls = [];
  const answer = (text) => {
    for (const [needle, error] of Object.entries(fail))
      if (text.includes(needle)) return Promise.reject(error);
    if (text.includes('pg_auth_members'))
      return Promise.resolve([
        { superuser: false, attributes: false, member: false, ...AUDIT, ...role },
      ]);
    if (text.includes('to_regclass') && text.includes('AS present'))
      return Promise.resolve([{ present }]);
    if (text.includes('pg_trigger')) return Promise.resolve(trigger === null ? [] : [trigger]);
    if (text.includes('AS overdue')) return Promise.resolve([held]);
    if (text.includes('AS unaudited')) return Promise.resolve([{ unaudited }]);
    if (text.includes('AS early')) return Promise.resolve([{ early }]);
    return Promise.resolve([{}]);
  };
  const sql = (strings, ...values) => {
    const text = strings.join('?');
    calls.push({ text, values });
    return answer(text);
  };
  sql.begin = async (mode, fn) => {
    calls.push({ text: 'BEGIN', mode });
    const result = await fn(sql);
    calls.push({ text: 'COMMIT' });
    return result;
  };
  return { sql, calls };
}

const refusedWith = (code) => (error) =>
  error instanceof RetentionCheckRefused && error.code === code;

test('the check refuses a superuser, an elevated attribute, a member of any role, and any role but evidence_audit, before anything else', async () => {
  for (const [role, code] of [
    [{ superuser: true }, 'role-unsafe'],
    [{ name: 'postgres', session: 'postgres', superuser: true }, 'role-unsafe'],
    [{ attributes: true }, 'role-unsafe'],
    [{ member: true }, 'role-unsafe'],
    [{ name: 'evidence_app', session: 'evidence_app' }, 'not-audit'],
    [{ name: 'evidence_retention', session: 'evidence_retention' }, 'not-audit'],
    [{ name: 'evidence_owner' }, 'not-audit'],
    // Logged in as another role and SET ROLE to audit: only a unit test can set this up without a
    // cluster-wide grant to the shared role.
    [{ session: 'evidence_app' }, 'not-audit'],
  ]) {
    const { sql, calls } = fakeClient({ role });
    await assert.rejects(retentionCheck(sql), refusedWith(code), JSON.stringify(role));
    assert.equal(calls.length, 1, 'only the role query ran');
  }
  assert.equal(AUDIT_ROLE, 'evidence_audit');
  // A failure of the first statement is the connection's, whatever the driver said.
  const { sql } = fakeClient({
    fail: { pg_auth_members: Object.assign(new Error('CANARY'), { code: 'SELF_SIGNED_CERT' }) },
  });
  await assert.rejects(assertAuditRole(sql), refusedWith('database-unreachable'));
});

test('every count is read in one repeatable-read, read-only transaction under the statement timeout', async () => {
  const { sql, calls } = fakeClient();
  await retentionCheck(sql);
  const begin = calls.findIndex(({ text }) => text === 'BEGIN');
  assert.equal(calls[begin].mode, 'isolation level repeatable read read only');
  assert.match(calls[begin + 1].text, /set_config\('statement_timeout', \?, true\)/);
  assert.deepEqual(calls[begin + 1].values, [String(CHECK_STATEMENT_TIMEOUT_MS)]);
  const reads = calls.slice(begin + 2, -1).map(({ text }) => text);
  assert.equal(reads.length, 5, 'schema, guard, held, unaudited, early');
  assert.equal(calls.at(-1).text, 'COMMIT');
  // The window and the grace are bound, never written into the text.
  const held = calls.find(({ text }) => text.includes('AS overdue'));
  assert.deepEqual(held.values, [RETENTION_WINDOW, OVERDUE_GRACE]);
  const early = calls.find(({ text }) => text.includes('AS early'));
  assert.deepEqual(early.values, [RETENTION_WINDOW]);
  const guard = calls.find(({ text }) => text.includes('pg_trigger'));
  assert.deepEqual(guard.values, [
    'evidence.guard_envelope_update()',
    `interval '${RETENTION_WINDOW}'`,
    'evidence_envelope_guard',
  ]);
});

test('a missing schema is refused, before any count', async () => {
  const { sql, calls } = fakeClient({ present: false });
  await assert.rejects(retentionCheck(sql), refusedWith('schema-mismatch'));
  assert.equal(calls.filter(({ text }) => /AS (overdue|unaudited|early)/.test(text)).length, 0);
});

test('each guard state is reported, and every state but enabled is a violation', async () => {
  for (const [trigger, guard, violation] of [
    [ENABLED, 'enabled', null],
    [{ ...ENABLED, enabled: 'A' }, 'enabled', null],
    [{ ...ENABLED, enabled: 'D' }, 'disabled', 'guard-disabled'],
    [{ ...ENABLED, enabled: 'R' }, 'disabled', 'guard-disabled'],
    [null, 'absent', 'guard-absent'],
    [{ ...ENABLED, bundled: false }, 'replaced', 'guard-replaced'],
    [{ ...ENABLED, holds_window: false }, 'replaced', 'guard-replaced'],
    [{ ...ENABLED, holds_window: null }, 'replaced', 'guard-replaced'],
    // Replaced outranks disabled: the function in force is not the bundled one at all.
    [{ enabled: 'D', bundled: false, holds_window: true }, 'replaced', 'guard-replaced'],
  ]) {
    const result = await retentionCheck(fakeClient({ trigger }).sql);
    assert.equal(result.guard, guard, JSON.stringify(trigger));
    assert.deepEqual(result.violations, violation === null ? [] : [violation]);
    const last = formatReport(result).at(-1);
    if (violation === null) assert.equal(last, 'retention-check: no violation found');
    else assert.equal(last, `retention-check: violation found: ${violation}`);
  }
});

test('violations are named in the fixed order, whatever finds them', async () => {
  const result = await retentionCheck(
    fakeClient({
      trigger: { ...ENABLED, enabled: 'D' },
      held: { overdue: 3, oldest_hours: 2300 },
      unaudited: 2,
      early: 1,
    }).sql,
  );
  assert.deepEqual(result, {
    guard: 'disabled',
    overdue: 3,
    oldestHeldHours: 2300,
    unaudited: 2,
    early: 1,
    violations: ['guard-disabled', 'overdue-payload', 'unaudited-redaction', 'early-redaction'],
  });
  assert.deepEqual(VIOLATIONS, [
    'guard-absent',
    'guard-replaced',
    'guard-disabled',
    'overdue-payload',
    'unaudited-redaction',
    'early-redaction',
  ]);
  assert.equal(Object.isFrozen(VIOLATIONS), true);
});

test('the report is seven fixed lines: counts and hours only, the ceiling every time', async () => {
  const clean = await retentionCheck(fakeClient().sql);
  assert.deepEqual(formatReport(clean), [
    'retention-check: guard trigger evidence_envelope_guard: enabled',
    'retention-check: payloads held past 2160 hours + 48 hours grace: 0 found',
    'retention-check: oldest payload still held: 731 hours',
    'retention-check: redacted envelopes with no audit row: 0 found',
    'retention-check: redactions earlier than 2160 hours after receipt: 0 found',
    'retention-check: cannot see deleted rows, redacted bytes still in dead tuples, WAL or backups, or any value the owner or a superuser rewrote, received_at included',
    'retention-check: no violation found',
  ]);
  const empty = await retentionCheck(fakeClient({ held: { overdue: 0, oldest_hours: null } }).sql);
  assert.equal(formatReport(empty)[2], 'retention-check: oldest payload still held: none held');
  const dirty = await retentionCheck(
    fakeClient({ held: { overdue: 4, oldest_hours: 2209 }, unaudited: 1 }).sql,
  );
  assert.deepEqual(formatReport(dirty).slice(1, 4), [
    'retention-check: payloads held past 2160 hours + 48 hours grace: 4 found',
    'retention-check: oldest payload still held: 2209 hours',
    'retention-check: redacted envelopes with no audit row: 1 found',
  ]);
  assert.equal(
    formatReport(dirty).at(-1),
    'retention-check: violation found: overdue-payload, unaudited-redaction',
  );
});

test('a value that is not a whole count is never printed: the run is refused as failed', async () => {
  for (const held of [
    { overdue: 'CANARY-row-value', oldest_hours: 1 },
    { overdue: -1, oldest_hours: 1 },
    { overdue: 0, oldest_hours: 1.5 },
    { overdue: 0, oldest_hours: '2026-11-15T00:00:00Z' },
  ])
    await assert.rejects(retentionCheck(fakeClient({ held }).sql), refusedWith('failed'));
  await assert.rejects(retentionCheck(fakeClient({ unaudited: '7' }).sql), refusedWith('failed'));
  assert.throws(
    () =>
      formatReport({
        guard: 'CANARY',
        overdue: 0,
        oldestHeldHours: null,
        unaudited: 0,
        early: 0,
        violations: [],
      }),
    refusedWith('failed'),
  );
  assert.throws(
    () =>
      formatReport({
        guard: 'enabled',
        overdue: 0,
        oldestHeldHours: null,
        unaudited: 0,
        early: 0,
        violations: ['CANARY'],
      }),
    refusedWith('failed'),
  );
});

test('an error maps to a refusal code by class and SQLSTATE, never by message', () => {
  const coded = (code, message = 'CANARY driver message') =>
    Object.assign(new Error(message), { code });
  for (const [error, code] of [
    [new RetentionCheckRefused('not-audit'), 'not-audit'],
    [new RetentionCheckRefused('CANARY-unlisted'), 'failed'],
    [new StartupRefused('config-invalid'), 'config-invalid'],
    [coded('57014'), 'timed-out'],
    [coded('42501'), 'schema-mismatch'],
    [coded('42P01'), 'schema-mismatch'],
    [coded('08006'), 'database-unreachable'],
    [coded('28P01'), 'database-unreachable'],
    [coded('ECONNREFUSED'), 'database-unreachable'],
    [coded('XX000', 'statement timeout 57014 permission denied'), 'failed'],
    [new Error('no code'), 'failed'],
    [null, 'failed'],
  ])
    assert.equal(refusalCode(error), code, String(error?.code ?? error));
  assert.deepEqual(EXIT, { none: 0, found: 1, usage: 2, refused: 3 });
});

test('the window comes from expire.mjs by import, the other literals are reviewed values', () => {
  assert.equal(OVERDUE_GRACE, '48 hours');
  assert.equal(CHECK_STATEMENT_TIMEOUT_MS, 30000);
  assert.match(SOURCE, /import \{ RETENTION_WINDOW \} from '\.\/expire\.mjs';/);
  assert.doesNotMatch(SOURCE, /2160/, 'the window is never re-typed here');
  assert.match(SOURCE, /export const OVERDUE_GRACE = '48 hours';/);
  // The import is the pin to the trigger: expire.test.mjs holds RETENTION_WINDOW to 0002.
  const guard = loadMigrations()
    .filter(({ text }) => text.includes('FUNCTION evidence.guard_envelope_update()'))
    .at(-1);
  assert.ok(guard.text.includes(`interval '${RETENTION_WINDOW}'`));
});

test('the check builds no SQL text, writes nothing, and reads no payload', () => {
  assert.doesNotMatch(CODE, /\.unsafe\s*\(/);
  assert.doesNotMatch(CODE, /\b(?:sql|tx)\(/, 'no identifier helper');
  assert.doesNotMatch(CODE, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|LOCK)\b/);
  assert.doesNotMatch(CODE, /\bevidence\b(?!\.|_)/, 'the payload column is never named');
  assert.match(CODE, /sql\.begin\('isolation level repeatable read read only'/);
  for (const spelling of [/process\.env/, /import\.meta\.env/]) assert.doesNotMatch(CODE, spelling);
});

test('nothing it prints claims compliance, verification, certification or a pass', async () => {
  const banned = /\b(compliant|compliance|verified|certified|pass|passed)\b/i;
  assert.doesNotMatch(SOURCE, banned);
  assert.doesNotMatch(USAGE, banned);
  for (const options of [{}, { trigger: null, held: { overdue: 1, oldest_hours: 9999 }, early: 2 }])
    for (const line of formatReport(await retentionCheck(fakeClient(options).sql)))
      assert.doesNotMatch(line, banned, line);
});

test('the CLI takes no arguments, and a usage error exits 2 before reading any configuration', () => {
  assert.deepEqual(parseArgs([]), {});
  for (const argv of [['--grace-hours', '1'], ['check'], ['--fix']])
    assert.equal(parseArgs(argv), null, JSON.stringify(argv));
  for (const argv of [['--grace-hours', '1'], ['check']]) {
    const result = spawnSync(process.execPath, [SCRIPT, ...argv], {
      env: { PATH: process.env.PATH },
      encoding: 'utf8',
    });
    assert.equal(result.status, EXIT.usage, JSON.stringify(argv));
    assert.equal(result.stderr, `${USAGE}\n`);
    assert.equal(result.stdout, '');
  }
});

test('the CLI with no usable PG* configuration exits 3 as config-invalid, before connecting', () => {
  const result = spawnSync(process.execPath, [SCRIPT], {
    env: { PATH: process.env.PATH, PGPASSWORD: 'CANARY-PGPASSWORD' },
    encoding: 'utf8',
  });
  assert.equal(result.status, EXIT.refused);
  assert.equal(result.stderr, 'retention-check refused: config-invalid\n');
  assert.equal(result.stdout, '');
});
