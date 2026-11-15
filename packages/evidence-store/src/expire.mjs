// The retention expiry job (ADR-0002 "Retention: 90 days from received_at", task 2.5). It redacts
// the payload of every envelope received more than RETENTION_WINDOW ago and removes nothing else:
// its one statement sets evidence to NULL, and the trigger (0002-retention-window.sql) nulls the
// four submitted_by names, stamps redacted_at and writes the evidence_redaction row. The trigger
// also refuses a redaction of any younger envelope, for every role, so the job is a caller the
// database constrains, not the control.
//
// It runs as evidence_retention and as nothing else, and only against the schema it bundles. Work
// is done in batches, each its own transaction under its own statement timeout, so a first run
// over a large backlog never holds one long transaction. Concurrent runs are safe without an
// advisory lock, which evidence_app could take and hold (2.2 security assessment, I-1): each batch
// locks the rows it picks and skips rows another run holds, and a row already redacted is never
// selected. Nothing schedules it; the deployment's scheduler runs it (README "Running the
// service").

import { connect } from './database-config.mjs';
import { StartupRefused, assertSchemaCurrent } from './postgres-store.mjs';

export const RETENTION_ROLE = 'evidence_retention';
// ADR-0002's 90 days as 90 x 24 hours: a calendar '90 days' follows the session's TimeZone across
// a daylight-saving change (measured). The trigger in 0002 holds the same literal, and
// expire.test.mjs fails if the two differ.
export const RETENTION_WINDOW = '2160 hours';
// Reviewed literals, never configuration; tests may only shrink them. The timeout bounds each
// batch statement on the server, waiting for a lock included.
export const BATCH_SIZE = 1000;
export const BATCH_STATEMENT_TIMEOUT_MS = 30000;

// A refusal is a decision with a fixed code, never a driver message: the CLI prints the code.
export class ExpiryRefused extends Error {
  constructor(code) {
    super(code);
    this.name = 'ExpiryRefused';
    this.code = code;
  }
}

// The job's role is meant to find old rows by id and null their payload, and nothing more. Refused,
// as role-unsafe, a superuser (the trigger would still hold it to the window, but nothing else
// would), a role with CREATEROLE, CREATEDB, REPLICATION or BYPASSRLS (as the service's startup
// check refuses), or a member of any role (a NOINHERIT member can still SET ROLE to it); as
// not-retention, any session that did not log in as, and is not running as, evidence_retention.
// It runs under the database's default search path, which the owner sets (ALTER DATABASE), so each
// comparison names pg_catalog's operator: an owner's `=` earlier in that path would otherwise hide
// a membership (as retention-check.mjs's assertAuditRole; 2.3 review B2-2, follow-up A).
export async function assertRetentionRole(sql) {
  const [role] = await sql`
    SELECT current_user AS name, session_user AS session, r.rolsuper AS superuser,
           r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls AS attributes,
           EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m
                    WHERE m.member OPERATOR(pg_catalog.=) r.oid) AS member
      FROM pg_catalog.pg_roles r
     WHERE r.rolname OPERATOR(pg_catalog.=) current_user`;
  if (role === undefined || role.superuser || role.attributes || role.member)
    throw new ExpiryRefused('role-unsafe');
  if (role.name !== RETENTION_ROLE || role.session !== RETENTION_ROLE)
    throw new ExpiryRefused('not-retention');
}

// What is applied must be exactly what this build bundles, as the service requires: a job that
// does not know the trigger it runs under is how a retention job silently does the wrong thing.
// A database still at 0001 grants evidence_retention no SELECT on schema_migrations, and that
// refusal (42501) is the same answer.
export async function assertRetentionSchema(sql) {
  try {
    await assertSchemaCurrent(sql);
  } catch (error) {
    if (error instanceof StartupRefused || error?.code === '42501')
      throw new ExpiryRefused('schema-mismatch');
    throw error;
  }
}

function assertBound(name, value, max) {
  if (!Number.isInteger(value) || value < 1 || value > max)
    throw new TypeError(`${name} must be an integer from 1 to ${max}`);
}

// Role check, schema check, then batches until one redacts nothing. Each batch reads the live ids
// through 0002's partial index, so it never walks the tombstones. The subselect and the trigger
// read the same statement_timestamp(), so a row selected here (`<`) is never one the trigger
// refuses (`>=`). The outer `redacted_at IS NULL` repeats the subselect's so that no reading of the
// statement can reach a tombstone, which the trigger would refuse. Each batch pins its search path
// first, as the trigger pins its own: under the owner's default an operator or a function earlier
// in the path would answer the selection, and a run would redact nothing and report success (2.3
// follow-up A, measured). A failed batch rolls back alone; batches already committed stay, and a
// re-run continues from them.
export async function expire(
  sql,
  { batchSize = BATCH_SIZE, statementTimeoutMs = BATCH_STATEMENT_TIMEOUT_MS } = {},
) {
  assertBound('batchSize', batchSize, BATCH_SIZE);
  assertBound('statementTimeoutMs', statementTimeoutMs, BATCH_STATEMENT_TIMEOUT_MS);
  await assertRetentionRole(sql);
  await assertRetentionSchema(sql);
  let redacted = 0;
  let batches = 0;
  for (;;) {
    const count = await sql.begin(async (tx) => {
      // SET LOCAL takes no bound parameter; set_config(..., true) is its transaction-scoped form.
      await tx`
        SELECT pg_catalog.set_config('statement_timeout', ${String(statementTimeoutMs)}, true),
               pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`;
      const result = await tx`
        UPDATE evidence.evidence_envelope SET evidence = NULL
         WHERE id IN (SELECT id FROM evidence.evidence_envelope
                       WHERE redacted_at IS NULL
                         AND received_at < statement_timestamp() - ${RETENTION_WINDOW}::interval
                       ORDER BY id
                       LIMIT ${batchSize}
                       FOR UPDATE SKIP LOCKED)
           AND redacted_at IS NULL`;
      return result.count;
    });
    if (count === 0) return { redacted, batches };
    redacted += count;
    batches += 1;
  }
}

// CLI: node packages/evidence-store/src/expire.mjs, no arguments. Connection settings are the
// service's (database-config.mjs): the same PG* variables, the same TLS rule. Exit 0 done, 1
// refused or failed, 2 usage. Output is one line, a count or a code, never a driver message, a
// row value or an id. statement_timeout is the server's: in a network partition the client can
// still wait, and the scheduler's own timeout bounds the process.
export function parseArgs(argv) {
  return argv.length === 0 ? {} : null;
}

export const USAGE =
  'usage: expire.mjs (no arguments; connection from PG* variables, as evidence_retention)';

async function main(argv) {
  if (parseArgs(argv) === null) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  let sql;
  try {
    sql = connect();
    const { redacted } = await expire(sql);
    process.stdout.write(`expire done: redacted ${redacted}\n`);
    return 0;
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : 'failed';
    process.stderr.write(`expire refused: ${code}\n`);
    return 1;
  } finally {
    await sql?.end({ timeout: 5 });
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
