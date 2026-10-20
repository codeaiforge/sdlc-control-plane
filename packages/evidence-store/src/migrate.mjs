// The schema's two stages and their runner (stack.md "Migrations + verify", ADR-0002 "A third role
// owns the schema"). Plain numbered SQL files under migrations/, applied in order, each in its own
// transaction together with its schema_migrations row; a file already applied is never re-run,
// and one whose bytes changed since it was applied stops everything.
//
//   bootstrap  as a cluster administrator, once: the four roles (sql/bootstrap.sql), then the
//              database, owned by evidence_owner, with CONNECT for the three other roles only
//   migrate    as evidence_owner, and refused as anything else, a superuser included
//   status     as any role that can read evidence.schema_migrations
//
// The service never migrates: it checks that what is applied is exactly what is bundled and
// refuses to start otherwise (postgres-store.mjs assertSchemaCurrent). `sql.unsafe` is used here,
// and only here outside test code, because a migration file is SQL text by definition; it executes
// the bundled files and nothing a caller supplies.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

export const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
export const BOOTSTRAP_FILE = new URL('../sql/bootstrap.sql', import.meta.url);
export const OWNER_ROLE = 'evidence_owner';
export const CONNECT_ROLES = Object.freeze([
  'evidence_app',
  'evidence_retention',
  'evidence_audit',
]);

// One literal key for every migrating session, so two runners serialise instead of racing.
const MIGRATION_LOCK = 2026102202;
const FILE_RE = /^(\d{4})-([a-z0-9]+(?:-[a-z0-9]+)*)\.sql$/;
const RUNS_AS_RE = /^-- runs as: (\S.*)$/;
const DATABASE_NAME_RE = /^[a-z_][a-z0-9_]{0,62}$/;

// A refusal is a decision with a fixed code, never a driver message: the CLI prints the code.
export class MigrationRefused extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'MigrationRefused';
    this.code = code;
  }
}

// Every .sql file states, on its first line, the one role it runs as. The runner reads that line
// rather than trusting a comment further down, and refuses a file that names another role.
export function runsAs(text) {
  return RUNS_AS_RE.exec(text.split('\n', 1)[0])?.[1] ?? null;
}

export function checksum(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function loadMigrations(dir = MIGRATIONS_DIR) {
  const migrations = [];
  for (const file of readdirSync(dir).sort()) {
    const match = FILE_RE.exec(file);
    if (!match) throw new MigrationRefused('unknown-file', file);
    const bytes = readFileSync(new URL(file, dir));
    const text = bytes.toString('utf8');
    if (runsAs(text) !== OWNER_ROLE) throw new MigrationRefused('runs-as', file);
    migrations.push({
      version: Number(match[1]),
      name: match[2],
      checksum: checksum(bytes),
      text,
      runsAs: runsAs(text),
    });
  }
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1)
      throw new MigrationRefused(
        'gap',
        `expected version ${index + 1}, found ${migration.version}`,
      );
  });
  return migrations;
}

async function assertMigratingRole(sql) {
  const [role] = await sql`
    SELECT current_user AS name, session_user AS session, rolsuper AS superuser
      FROM pg_catalog.pg_roles WHERE rolname = current_user`;
  if (role.superuser) throw new MigrationRefused('superuser');
  if (role.name !== OWNER_ROLE || role.session !== OWNER_ROLE)
    throw new MigrationRefused('not-owner');
}

async function readApplied(sql) {
  const [{ present }] = await sql`
    SELECT pg_catalog.to_regclass('evidence.schema_migrations') IS NOT NULL AS present`;
  if (!present) return null;
  return sql`SELECT version, name, checksum, applied_at, applied_by
               FROM evidence.schema_migrations ORDER BY version`;
}

// Applied rows must be a prefix of the bundled files, byte for byte by checksum.
function verifyApplied(applied, migrations) {
  for (const row of applied) {
    const bundled = migrations[row.version - 1];
    if (bundled === undefined || bundled.version !== row.version)
      throw new MigrationRefused('unknown-applied', `version ${row.version}`);
    if (bundled.checksum !== row.checksum || bundled.name !== row.name)
      throw new MigrationRefused('checksum-mismatch', `version ${row.version}`);
  }
}

export async function migrate(sql, { migrations = loadMigrations() } = {}) {
  await assertMigratingRole(sql);
  await sql.begin(async (tx) => {
    await tx`SELECT pg_catalog.pg_advisory_xact_lock(${MIGRATION_LOCK})`;
    await tx`CREATE SCHEMA IF NOT EXISTS evidence`;
    await tx`
      CREATE TABLE IF NOT EXISTS evidence.schema_migrations (
        version integer PRIMARY KEY,
        name text NOT NULL,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT statement_timestamp(),
        applied_by text NOT NULL DEFAULT current_user
      )`;
  });
  const appliedNow = [];
  for (const migration of migrations) {
    const done = await sql.begin(async (tx) => {
      await tx`SELECT pg_catalog.pg_advisory_xact_lock(${MIGRATION_LOCK})`;
      const applied = await readApplied(tx);
      verifyApplied(applied, migrations);
      if (applied.some((row) => row.version === migration.version)) return false;
      await tx.unsafe(migration.text);
      await tx`
        INSERT INTO evidence.schema_migrations (version, name, checksum)
        VALUES (${migration.version}, ${migration.name}, ${migration.checksum})`;
      return true;
    });
    if (done) appliedNow.push(migration.version);
  }
  return { applied: appliedNow, current: migrations.at(-1)?.version ?? 0 };
}

export async function status(sql, { migrations = loadMigrations() } = {}) {
  const applied = (await readApplied(sql)) ?? [];
  verifyApplied(applied, migrations);
  const done = new Set(applied.map((row) => row.version));
  return {
    applied: applied.map(({ version, name, checksum: sum, applied_at, applied_by }) => ({
      version,
      name,
      checksum: sum,
      applied_at: applied_at.toISOString(),
      applied_by,
    })),
    pending: migrations.filter((m) => !done.has(m.version)).map((m) => m.version),
  };
}

export function assertDatabaseName(database) {
  if (typeof database !== 'string' || !DATABASE_NAME_RE.test(database))
    throw new MigrationRefused('database-name');
}

export async function bootstrap(sql, { database, file = BOOTSTRAP_FILE } = {}) {
  assertDatabaseName(database);
  const text = readFileSync(file, 'utf8');
  if (runsAs(text) !== 'cluster admin') throw new MigrationRefused('runs-as', 'bootstrap.sql');
  await sql.unsafe(text);
  const [existing] = await sql`
    SELECT pg_catalog.pg_get_userbyid(datdba) AS owner
      FROM pg_catalog.pg_database WHERE datname = ${database}`;
  if (existing === undefined) {
    // An identifier, so it cannot be a bound parameter: sql(name) quotes it as one. The name has
    // already been held to a plain lowercase identifier above.
    await sql`CREATE DATABASE ${sql(database)} OWNER evidence_owner`;
  } else if (existing.owner !== OWNER_ROLE) {
    throw new MigrationRefused('database-owner', database);
  }
  await sql`REVOKE ALL ON DATABASE ${sql(database)} FROM PUBLIC`;
  await sql`GRANT CONNECT ON DATABASE ${sql(database)} TO evidence_app, evidence_retention, evidence_audit`;
  return { database, owner: OWNER_ROLE };
}

// CLI: node packages/evidence-store/src/migrate.mjs bootstrap --database <name> | migrate | status
// Connection settings are the service's (database-config.mjs): the same PG* variables, the same TLS
// rule. Exit 0 done, 1 refused or failed, 2 usage. Output is one line and never a driver message.
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command === 'migrate' || command === 'status') return rest.length === 0 ? { command } : null;
  if (command === 'bootstrap' && rest.length === 2 && rest[0] === '--database')
    return { command, database: rest[1] };
  return null;
}

export const USAGE =
  'usage: migrate.mjs bootstrap --database <name> | migrate | status (connection from PG* variables)';

async function main(argv) {
  const args = parseArgs(argv);
  if (args === null) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const { connect } = await import('./database-config.mjs');
  let sql;
  try {
    sql = connect();
    if (args.command === 'bootstrap') {
      await bootstrap(sql, { database: args.database });
      process.stdout.write(`bootstrap done: database ${args.database}, owner ${OWNER_ROLE}\n`);
    } else if (args.command === 'migrate') {
      const { applied, current } = await migrate(sql);
      process.stdout.write(`migrate done: applied [${applied.join(', ')}], current ${current}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(await status(sql))}\n`);
    }
    return 0;
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : 'failed';
    process.stderr.write(`${args.command} refused: ${code}\n`);
    return 1;
  } finally {
    await sql?.end({ timeout: 5 });
  }
}

// No top-level await: main() imports database-config.mjs, which imports this module back, and a
// module still suspended in a top-level await cannot be imported - the CLI would never settle.
if (process.argv[1] === new URL(import.meta.url).pathname) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
