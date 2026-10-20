import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  MIGRATIONS_DIR,
  MigrationRefused,
  USAGE,
  assertDatabaseName,
  bootstrap,
  loadMigrations,
  migrate,
  parseArgs,
  runsAs,
} from './migrate.mjs';

// Unit tests, no database. What the runner does on a real server - applying 0001 to an empty
// database, refusing a non-owner and a superuser, refusing checksum drift - is
// migrate.integration.mjs's, against PostgreSQL 16.

const OWNER_HEADER = '-- runs as: evidence_owner\n';

function migrationsDir(t, files) {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-migrations-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return pathToFileURL(`${dir}/`);
}

const refusedWith = (code) => (error) => error instanceof MigrationRefused && error.code === code;

test('the bundled migrations load in order, each stating that it runs as evidence_owner', () => {
  const migrations = loadMigrations();
  assert.deepEqual(
    migrations.map(({ version, name, runsAs: role }) => ({ version, name, role })),
    [{ version: 1, name: 'evidence-envelope', role: 'evidence_owner' }],
  );
  const bytes = readFileSync(new URL('0001-evidence-envelope.sql', MIGRATIONS_DIR));
  assert.equal(migrations[0].checksum, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(migrations[0].text, bytes.toString('utf8'));
});

test('every SQL file in the package names the one role it runs as on its first line', () => {
  const expected = {
    'migrations/0001-evidence-envelope.sql': 'evidence_owner',
    'sql/bootstrap.sql': 'cluster admin',
    'sql/audit-queries.sql': 'evidence_audit',
  };
  const found = {};
  for (const dir of ['migrations', 'sql'])
    for (const file of readdirSync(new URL(`../${dir}/`, import.meta.url)))
      found[`${dir}/${file}`] = runsAs(
        readFileSync(new URL(`../${dir}/${file}`, import.meta.url), 'utf8'),
      );
  assert.deepEqual(found, expected);
});

test('files are applied in version order whatever order the directory lists them in', (t) => {
  const dir = migrationsDir(t, {
    '0002-second.sql': `${OWNER_HEADER}SELECT 2;`,
    '0001-first.sql': `${OWNER_HEADER}SELECT 1;`,
    '0003-third-one.sql': `${OWNER_HEADER}SELECT 3;`,
  });
  assert.deepEqual(
    loadMigrations(dir).map(({ version, name }) => `${version}:${name}`),
    ['1:first', '2:second', '3:third-one'],
  );
});

test('a gap, a duplicate number or a first version other than 1 is refused', (t) => {
  for (const files of [
    { '0001-a.sql': OWNER_HEADER, '0003-c.sql': OWNER_HEADER },
    { '0002-b.sql': OWNER_HEADER },
    { '0001-a.sql': OWNER_HEADER, '0001-b.sql': OWNER_HEADER },
  ])
    assert.throws(() => loadMigrations(migrationsDir(t, files)), refusedWith('gap'));
});

test('a file that is not NNNN-slug.sql is refused rather than skipped', (t) => {
  for (const name of [
    'README.md',
    '1-short.sql',
    '0001-Upper.sql',
    '0001_underscore.sql',
    '0001-.sql',
  ])
    assert.throws(
      () => loadMigrations(migrationsDir(t, { '0001-ok.sql': OWNER_HEADER, [name]: OWNER_HEADER })),
      refusedWith('unknown-file'),
      name,
    );
});

test('a migration that does not state evidence_owner on its first line is refused', (t) => {
  for (const text of [
    'SELECT 1;',
    '-- runs as: evidence_app\nSELECT 1;',
    '\n-- runs as: evidence_owner\nSELECT 1;',
    '-- runs as: cluster admin\nSELECT 1;',
  ])
    assert.throws(
      () => loadMigrations(migrationsDir(t, { '0001-a.sql': text })),
      refusedWith('runs-as'),
      JSON.stringify(text),
    );
});

test('the checksum is over the exact bytes, so any edit to an applied file is detectable', (t) => {
  const before = loadMigrations(migrationsDir(t, { '0001-a.sql': `${OWNER_HEADER}SELECT 1;` }));
  const after = loadMigrations(migrationsDir(t, { '0001-a.sql': `${OWNER_HEADER}SELECT 1; ` }));
  assert.notEqual(before[0].checksum, after[0].checksum);
  assert.match(before[0].checksum, /^[0-9a-f]{64}$/);
});

// A fake client: a tagged-template function that records every statement and answers the role
// query with the row it is given. Enough to prove the role check runs before anything else.
function fakeClient(roleRow) {
  const calls = [];
  const sql = (strings) => {
    calls.push(strings.join('?'));
    return Promise.resolve([roleRow]);
  };
  sql.begin = async () => {
    calls.push('BEGIN');
  };
  sql.unsafe = async (text) => {
    calls.push(text);
  };
  return { sql, calls };
}

test('migrate refuses a role that is not evidence_owner, and a superuser, before any DDL', async () => {
  for (const [row, code] of [
    [{ name: 'evidence_app', session: 'evidence_app', superuser: false }, 'not-owner'],
    [{ name: 'evidence_owner', session: 'postgres', superuser: false }, 'not-owner'],
    [{ name: 'evidence_owner', session: 'evidence_owner', superuser: true }, 'superuser'],
    [{ name: 'postgres', session: 'postgres', superuser: true }, 'superuser'],
  ]) {
    const { sql, calls } = fakeClient(row);
    await assert.rejects(migrate(sql), refusedWith(code), JSON.stringify(row));
    assert.equal(calls.length, 1, 'only the role query ran');
    assert.doesNotMatch(calls[0], /CREATE|INSERT|ALTER/);
  }
});

test('bootstrap refuses a database name that is not a plain identifier, before any statement', async () => {
  for (const name of [
    '',
    'Upper',
    'has space',
    'semi;colon',
    'quo"te',
    'a'.repeat(64),
    '1abc',
    undefined,
  ])
    assert.throws(() => assertDatabaseName(name), refusedWith('database-name'), String(name));
  const { sql, calls } = fakeClient({});
  await assert.rejects(
    bootstrap(sql, { database: 'x; DROP DATABASE postgres' }),
    refusedWith('database-name'),
  );
  assert.deepEqual(calls, []);
  assert.doesNotThrow(() => assertDatabaseName('sdlc_control_plane'));
});

test('the CLI accepts exactly three commands and nothing else', () => {
  assert.deepEqual(parseArgs(['migrate']), { command: 'migrate' });
  assert.deepEqual(parseArgs(['status']), { command: 'status' });
  assert.deepEqual(parseArgs(['bootstrap', '--database', 'db']), {
    command: 'bootstrap',
    database: 'db',
  });
  for (const argv of [
    [],
    ['migrate', '--force'],
    ['bootstrap'],
    ['bootstrap', 'db'],
    ['bootstrap', '--database'],
    ['rollback'],
    ['status', 'extra'],
  ])
    assert.equal(parseArgs(argv), null, JSON.stringify(argv));
});

test('a usage error exits 2 before reading any configuration', () => {
  const script = new URL('./migrate.mjs', import.meta.url).pathname;
  for (const argv of [[], ['bootstrap'], ['drop']]) {
    const result = spawnSync(process.execPath, [script, ...argv], {
      env: { PATH: process.env.PATH },
      encoding: 'utf8',
    });
    assert.equal(result.status, 2, JSON.stringify(argv));
    assert.equal(result.stderr, `${USAGE}\n`);
    assert.equal(result.stdout, '');
  }
});
