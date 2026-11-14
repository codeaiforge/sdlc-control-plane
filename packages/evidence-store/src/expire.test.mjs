import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  BATCH_SIZE,
  BATCH_STATEMENT_TIMEOUT_MS,
  ExpiryRefused,
  RETENTION_WINDOW,
  USAGE,
  expire,
  parseArgs,
} from './expire.mjs';
import { loadMigrations } from './migrate.mjs';

// Unit tests, no database. What the job does on a real server - the window boundary, the trigger's
// tombstone, concurrent runs, the statement timeout, each role refused - is
// expire.integration.mjs's, against PostgreSQL 16.

const RETENTION = { name: 'evidence_retention', session: 'evidence_retention' };

// A fake client: a tagged-template function that records every statement with its bound values
// and answers by what the statement reads. `begin(fn)` runs fn on the same fake, between BEGIN and
// COMMIT markers; each UPDATE answers the next count from `counts`.
function fakeClient({
  role = {},
  applied = loadMigrations(),
  schemaError = null,
  counts = [0],
} = {}) {
  const calls = [];
  const queue = [...counts];
  const sql = (strings, ...values) => {
    const text = strings.join('?');
    calls.push({ text, values });
    if (text.includes('pg_auth_members'))
      return Promise.resolve([
        { superuser: false, attributes: false, member: false, ...RETENTION, ...role },
      ]);
    if (text.includes('to_regclass')) return Promise.resolve([{ present: true }]);
    if (text.includes('FROM evidence.schema_migrations')) {
      if (schemaError) return Promise.reject(schemaError);
      return Promise.resolve(applied.map(({ version, checksum }) => ({ version, checksum })));
    }
    if (text.includes('UPDATE evidence.'))
      return Promise.resolve(Object.assign([], { count: queue.shift() }));
    return Promise.resolve([{}]);
  };
  sql.begin = async (fn) => {
    calls.push({ text: 'BEGIN' });
    const result = await fn(sql);
    calls.push({ text: 'COMMIT' });
    return result;
  };
  return { sql, calls };
}

const refusedWith = (code) => (error) => error instanceof ExpiryRefused && error.code === code;
const updates = (calls) => calls.filter(({ text }) => text.includes('UPDATE evidence.'));

test('expire refuses a superuser, an elevated attribute, a member of any role, and any role but evidence_retention, before anything else', async () => {
  for (const [role, code] of [
    [{ superuser: true }, 'role-unsafe'],
    [{ name: 'postgres', session: 'postgres', superuser: true }, 'role-unsafe'],
    [{ attributes: true }, 'role-unsafe'],
    [{ member: true }, 'role-unsafe'],
    [{ name: 'evidence_app', session: 'evidence_app' }, 'not-retention'],
    [{ name: 'evidence_owner' }, 'not-retention'],
    // Logged in as another role and SET ROLE to retention: only a unit test can set this up
    // without a cluster-wide grant to the shared role.
    [{ session: 'evidence_app' }, 'not-retention'],
  ]) {
    const { sql, calls } = fakeClient({ role });
    await assert.rejects(expire(sql), refusedWith(code), JSON.stringify(role));
    assert.equal(calls.length, 1, 'only the role query ran');
  }
});

test('expire refuses a schema that is not exactly the bundled one, and an unreadable one, before any UPDATE', async () => {
  for (const options of [
    { applied: loadMigrations().slice(0, 1) },
    { applied: loadMigrations().map((m) => ({ ...m, checksum: '0'.repeat(64) })) },
    { schemaError: Object.assign(new Error('permission denied'), { code: '42501' }) },
  ]) {
    const { sql, calls } = fakeClient(options);
    await assert.rejects(expire(sql), refusedWith('schema-mismatch'));
    assert.deepEqual(updates(calls), []);
    assert.equal(
      calls.some(({ text }) => text === 'BEGIN'),
      false,
    );
  }
  // Any other error from the schema read is not a mismatch, and keeps its own code.
  const { sql } = fakeClient({ schemaError: Object.assign(new Error('x'), { code: '57P01' }) });
  await assert.rejects(expire(sql), { code: '57P01' });
});

test('expire runs batches until one redacts nothing, each in its own transaction under a timeout', async () => {
  const { sql, calls } = fakeClient({ counts: [3, 2, 0] });
  assert.deepEqual(await expire(sql, { batchSize: 3, statementTimeoutMs: 200 }), {
    redacted: 5,
    batches: 2,
  });
  const batches = calls.slice(calls.findIndex(({ text }) => text === 'BEGIN'));
  assert.deepEqual(
    batches.map(({ text }) =>
      text === 'BEGIN' || text === 'COMMIT'
        ? text
        : text.includes('set_config')
          ? 'timeout'
          : 'update',
    ),
    [
      'BEGIN',
      'timeout',
      'update',
      'COMMIT',
      'BEGIN',
      'timeout',
      'update',
      'COMMIT',
      'BEGIN',
      'timeout',
      'update',
      'COMMIT',
    ],
  );
  for (const { text, values } of calls.filter(({ text }) => text.includes('set_config'))) {
    assert.match(text, /set_config\('statement_timeout', \?, true\)/);
    assert.deepEqual(values, ['200']);
  }
  for (const { values } of updates(calls)) assert.deepEqual(values, [RETENTION_WINDOW, 3]);
});

test('the defaults are the reviewed literals, and nothing else is accepted', async () => {
  const { sql, calls } = fakeClient();
  assert.deepEqual(await expire(sql), { redacted: 0, batches: 0 });
  assert.deepEqual(updates(calls)[0].values, [RETENTION_WINDOW, BATCH_SIZE]);
  assert.deepEqual(calls.find(({ text }) => text.includes('set_config')).values, [
    String(BATCH_STATEMENT_TIMEOUT_MS),
  ]);
  // Checked before any query: a bad option is the caller's error, not a refusal.
  for (const [option, max] of [
    ['batchSize', BATCH_SIZE],
    ['statementTimeoutMs', BATCH_STATEMENT_TIMEOUT_MS],
  ])
    for (const bad of [0, -1, 1.5, '10', Number.NaN, null, max + 1]) {
      const fake = fakeClient();
      await assert.rejects(expire(fake.sql, { [option]: bad }), TypeError, `${option} ${bad}`);
      assert.deepEqual(fake.calls, [], 'no query');
    }
});

// The window is written twice, here and in the trigger. A drift either way breaks the job: a
// shorter job window selects rows the trigger refuses, a longer one leaves old payloads.
test('the job and the trigger hold the same window: 2160 hours, strict', () => {
  assert.equal(RETENTION_WINDOW, '2160 hours');
  assert.equal(BATCH_SIZE, 1000);
  assert.equal(BATCH_STATEMENT_TIMEOUT_MS, 30000);
  const guard = loadMigrations()
    .filter(({ text }) => text.includes('FUNCTION evidence.guard_envelope_update()'))
    .at(-1);
  assert.equal(guard.name, 'retention-window');
  const check = `>= statement_timestamp() - interval '${RETENTION_WINDOW}'`;
  assert.equal(guard.text.split(check).length - 1, 1, check);
});

test('the job builds no SQL text, deletes nothing, and its one UPDATE only nulls the payload', () => {
  const source = readFileSync(new URL('./expire.mjs', import.meta.url), 'utf8');
  const code = source
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  assert.doesNotMatch(code, /\.unsafe\s*\(/);
  assert.doesNotMatch(code, /\b(?:sql|tx)\(/, 'no identifier helper');
  assert.doesNotMatch(code, /\b(?:DELETE|TRUNCATE|INSERT)\b/);
  assert.equal(code.match(/\bUPDATE\s+evidence\./g).length, 1);
  assert.deepEqual(
    [...code.matchAll(/\bSET\s+(\w+\s*=\s*\w+)/g)].map((m) => m[1]),
    ['evidence = NULL'],
  );
  assert.match(code, /FOR UPDATE SKIP LOCKED\)\s+AND redacted_at IS NULL`/);
  assert.match(code, /WHERE redacted_at IS NULL\s+AND received_at < statement_timestamp\(\)/);
});

test('the CLI takes no arguments, and a usage error exits 2 before reading any configuration', () => {
  assert.deepEqual(parseArgs([]), {});
  for (const argv of [['--force'], ['expire'], ['--batch-size', '10']])
    assert.equal(parseArgs(argv), null, JSON.stringify(argv));
  const script = new URL('./expire.mjs', import.meta.url).pathname;
  for (const argv of [['--force'], ['expire']]) {
    const result = spawnSync(process.execPath, [script, ...argv], {
      env: { PATH: process.env.PATH },
      encoding: 'utf8',
    });
    assert.equal(result.status, 2, JSON.stringify(argv));
    assert.equal(result.stderr, `${USAGE}\n`);
    assert.equal(result.stdout, '');
  }
});

test('the CLI with no usable PG* configuration exits 1 as config-invalid, before connecting', () => {
  const script = new URL('./expire.mjs', import.meta.url).pathname;
  const result = spawnSync(process.execPath, [script], {
    env: { PATH: process.env.PATH },
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'expire refused: config-invalid\n');
  assert.equal(result.stdout, '');
});
