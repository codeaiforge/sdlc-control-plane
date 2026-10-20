// Integration-test support (stack.md "Integration test harness"): a real PostgreSQL 16 server,
// reached through the standard PG* variables as a cluster administrator - locally the documented
// `docker run`, in CI the ci.yml service container. Used only by *.integration.mjs files, which
// the `test` target never picks up; the `integration` target runs them and FAILS when no server
// is configured or reachable. There is no skip: a skipped suite reads as coverage.
//
// Each test gets its own database, created from a template migrated once per process, and dropped
// when the test ends. The four roles are cluster objects shared by every test process, so their
// passwords are derived - HMAC-SHA256(admin password, role name) - and every concurrent process
// sets the same value: no race between processes, and no credential written anywhere.
//
// Test code may use sql.unsafe (ALTER ROLE ... PASSWORD takes no bound parameter); the adapter may
// not, and postgres-store.test.mjs holds it to that.

import { createHmac, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import postgres from 'postgres';
import { readDatabaseConfig } from './database-config.mjs';
import { CONNECT_ROLES, OWNER_ROLE, bootstrap, migrate } from './migrate.mjs';

export const ROLES = Object.freeze([OWNER_ROLE, ...CONNECT_ROLES]);
const READY_WITHIN_MS = 30000;
// Retried, not failed: concurrent test processes race on the cluster-wide role catalog.
const RACE_CODES = new Set(['42710', '23505', 'XX000', '40001', '40P01']);

export const MISSING_SERVER =
  'integration tests need PostgreSQL: set PGHOST/PGUSER/PGPASSWORD to a cluster administrator';

export function requireAdminEnv(env = process.env) {
  for (const name of ['PGHOST', 'PGUSER', 'PGPASSWORD'])
    if (typeof env[name] !== 'string' || env[name].length === 0) throw new Error(MISSING_SERVER);
  return {
    PGHOST: env.PGHOST,
    PGPORT: env.PGPORT ?? '5432',
    PGUSER: env.PGUSER,
    PGPASSWORD: env.PGPASSWORD,
    PGDATABASE: env.PGDATABASE ?? 'postgres',
    ...(env.PGSSLROOTCERT ? { PGSSLROOTCERT: env.PGSSLROOTCERT } : {}),
  };
}

export const rolePassword = (adminPassword, role) =>
  createHmac('sha256', adminPassword).update(role).digest('hex');

// The environment a process needs to log in as `role` on `database`: what a child service gets.
export function roleEnv(role, database, env = process.env) {
  const admin = requireAdminEnv(env);
  return {
    PGHOST: admin.PGHOST,
    PGPORT: admin.PGPORT,
    PGDATABASE: database,
    PGUSER: role,
    PGPASSWORD: rolePassword(admin.PGPASSWORD, role),
    ...(admin.PGSSLROOTCERT ? { PGSSLROOTCERT: admin.PGSSLROOTCERT } : {}),
  };
}

// A client with the service's configuration rules, for any role on any database.
export function clientFor(env, { max } = {}) {
  const { options } = readDatabaseConfig(env);
  return postgres({ ...options, ...(max ? { max } : {}) });
}

async function retryRaces(action) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      if (attempt >= 20 || !RACE_CODES.has(error?.code)) throw error;
      await delay(20 + Math.random() * 80);
    }
  }
}

let shared;

async function adminClient() {
  const env = requireAdminEnv();
  const sql = clientFor(env, { max: 4 });
  const deadline = Date.now() + READY_WITHIN_MS;
  for (;;) {
    try {
      await sql`SELECT 1`;
      return { sql, env };
    } catch (error) {
      if (Date.now() > deadline) {
        await sql.end({ timeout: 1 });
        throw new Error(`${MISSING_SERVER} (no answer from ${env.PGHOST}:${env.PGPORT})`, {
          cause: error,
        });
      }
      await delay(250);
    }
  }
}

const uniqueName = (prefix) =>
  `${prefix}_${process.pid}_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;

// Once per process: roles (bootstrap.sql through the real runner), their derived passwords, and a
// template database migrated by the real runner as evidence_owner.
async function harness() {
  shared ??= (async () => {
    const { sql: admin, env } = await adminClient();
    const template = uniqueName('evidence_tpl');
    await retryRaces(() => bootstrap(admin, { database: template }));
    for (const role of ROLES)
      await retryRaces(() =>
        admin.unsafe(`ALTER ROLE ${role} PASSWORD '${rolePassword(env.PGPASSWORD, role)}'`),
      );
    const owner = clientFor(roleEnv(OWNER_ROLE, template), { max: 1 });
    try {
      await migrate(owner);
    } finally {
      await owner.end({ timeout: 5 });
    }
    // CREATE DATABASE ... TEMPLATE needs the template to have no sessions; creations are queued.
    let queue = Promise.resolve();
    const serial = (action) => {
      const run = queue.then(action);
      queue = run.catch(() => {});
      return run;
    };
    return { admin, env, template, serial };
  })();
  return shared;
}

async function grantDatabase(admin, name) {
  await admin`REVOKE ALL ON DATABASE ${admin(name)} FROM PUBLIC`;
  await admin`GRANT CONNECT ON DATABASE ${admin(name)} TO evidence_app, evidence_retention, evidence_audit`;
}

function testDatabase(h, name) {
  const clients = [];
  const connectAs = (role, { max = 2 } = {}) => {
    const sql = clientFor(roleEnv(role, name), { max });
    clients.push(sql);
    return sql;
  };
  // A superuser connection to this database, for setup the roles are not allowed to do.
  const admin = clientFor({ ...h.env, PGDATABASE: name }, { max: 2 });
  clients.push(admin);
  let audit;
  let retention;
  return {
    name,
    admin,
    connectAs,
    env: (role) => roleEnv(role, name),
    // The redaction the conformance suite asks for, done the way the durable store allows it:
    // evidence_audit finds the row (retention cannot read workspace_id or change_id), then
    // evidence_retention nulls the payload and the trigger does the rest.
    async redact({ workspace_id, change_id }) {
      audit ??= connectAs('evidence_audit', { max: 1 });
      retention ??= connectAs('evidence_retention', { max: 1 });
      const [row] = await audit`
        SELECT id FROM evidence.evidence_envelope
         WHERE workspace_id = ${workspace_id} AND change_id = ${change_id} AND redacted_at IS NULL`;
      if (row === undefined) return false;
      const result = await retention`
        UPDATE evidence.evidence_envelope SET evidence = NULL
         WHERE id = ${row.id} AND redacted_at IS NULL`;
      return result.count === 1;
    },
    revokeConnect: (role) =>
      h.admin`REVOKE CONNECT ON DATABASE ${h.admin(name)} FROM ${h.admin(role)}`,
    grantConnect: (role) => h.admin`GRANT CONNECT ON DATABASE ${h.admin(name)} TO ${h.admin(role)}`,
    // Waits (up to 5 s) for each backend to exit; without the timeout the call returns while the
    // backend is still dying, and the next statement races it.
    terminate: (role) => h.admin`
      SELECT pg_catalog.pg_terminate_backend(pid, 5000) FROM pg_catalog.pg_stat_activity
       WHERE datname = ${name} AND usename = ${role}`,
    async dispose() {
      await Promise.all(clients.map((sql) => sql.end({ timeout: 1 }).catch(() => {})));
      await h.admin`DROP DATABASE IF EXISTS ${h.admin(name)} WITH (FORCE)`;
    },
  };
}

// A fresh database holding the current schema, owned by evidence_owner, CONNECT for the three
// other roles. Callers dispose it (the conformance factory hands `dispose` to the suite).
export async function createTestDatabase() {
  const h = await harness();
  const name = uniqueName('evidence_t');
  await h.serial(
    () =>
      h.admin`CREATE DATABASE ${h.admin(name)} TEMPLATE ${h.admin(h.template)} OWNER evidence_owner`,
  );
  await grantDatabase(h.admin, name);
  return testDatabase(h, name);
}

// A bootstrapped database with no schema at all, for the migration runner's own tests.
export async function createEmptyDatabase() {
  const h = await harness();
  const name = uniqueName('evidence_e');
  await bootstrap(h.admin, { database: name });
  return testDatabase(h, name);
}

export async function adminEnv() {
  return (await harness()).env;
}

export async function closeHarness() {
  if (!shared) return;
  const h = await shared;
  shared = undefined;
  await h.admin`DROP DATABASE IF EXISTS ${h.admin(h.template)} WITH (FORCE)`.catch(() => {});
  await h.admin.end({ timeout: 5 });
}
