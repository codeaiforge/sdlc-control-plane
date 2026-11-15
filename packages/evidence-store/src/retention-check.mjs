// The retention check (task 2.3; ADR-0002 "Retention: 90 days from received_at", which hands the
// check of its retention to 2.3). It reports what it finds about retention and changes nothing:
// whether the guard trigger 0002 installs is in force on the envelope log; how many payloads are
// still held more than OVERDUE_GRACE past the window, which is how a run of expire that did not
// happen, failed, or skipped a locked row shows (2.5 SEC-1); the age of the oldest payload still
// held; and how many redactions have no audit row, or came earlier than the window, which only an
// owner or a superuser bypassing the trigger can make (2.5 SEC-2).
//
// It runs as evidence_audit and as nothing else, with that role's grants unchanged: every column
// but the payload, and the redaction table. Every count comes from one REPEATABLE READ READ ONLY
// transaction, so from one snapshot and one instant. It prints counts and hours, never an id, a
// change_id, a workspace_id, a row's timestamp or a driver message, and it says on every run what
// it cannot see. "No violation found" is what it found, not a statement that the store complies.
// Nothing schedules it; the deployment's scheduler runs it after expire (README "Retention").
// statement_timeout bounds every statement on the server, not the client's wait: a frozen or
// partitioned server can hold the run, and the scheduler's own timeout bounds the process, as it
// does expire's.

import { StartupRefused, connect } from './database-config.mjs';
import { RETENTION_WINDOW } from './expire.mjs';
import { loadMigrations } from './migrate.mjs';

export const AUDIT_ROLE = 'evidence_audit';
// Reviewed literals, never configuration. With expire run daily a payload is normally up to a day
// past the window; 48 hours flags one missed run within two days without alarming between runs.
export const OVERDUE_GRACE = '48 hours';
// Bounds every statement on the server. The redaction anti-join reads every tombstone, which is
// kept forever (RR-4); a store that outgrows this is reported timed-out, never as a clean run.
export const CHECK_STATEMENT_TIMEOUT_MS = 30000;
const GUARD_TRIGGER = 'evidence_envelope_guard';
const GUARD_FUNCTION = 'evidence.guard_envelope_update()';

// The kinds a run can find, in the order the last line names them.
export const VIOLATIONS = Object.freeze([
  'guard-absent',
  'guard-replaced',
  'guard-disabled',
  'overdue-payload',
  'unaudited-redaction',
  'early-redaction',
]);

// A scheduler tells "found something" (1) from "checked nothing" (3). expire's 1 is a refusal;
// this command's 1 is a finding, so its refusal cannot reuse it.
export const EXIT = Object.freeze({ none: 0, found: 1, usage: 2, refused: 3 });

const REFUSAL_CODES = new Set([
  'config-invalid',
  'database-unreachable',
  'role-unsafe',
  'not-audit',
  'schema-mismatch',
  'timed-out',
  'failed',
]);

export const USAGE =
  'usage: retention-check.mjs (no arguments; connection from PG* variables, as evidence_audit)';

const CEILING =
  'cannot see deleted rows, redacted bytes still in dead tuples, WAL or backups, or any value ' +
  'the owner or a superuser rewrote, received_at included';

// A refusal is a decision with a fixed code, never a driver message: the CLI prints the code.
export class RetentionCheckRefused extends Error {
  constructor(code) {
    super(code);
    this.name = 'RetentionCheckRefused';
    this.code = code;
  }
}

// The reader is meant to read and nothing more. Refused, as role-unsafe, a superuser, a role with
// CREATEROLE, CREATEDB, REPLICATION or BYPASSRLS, or a member of any role (a NOINHERIT member can
// still SET ROLE to it); as not-audit, any session that did not log in as, and is not running as,
// evidence_audit. The same rule and query as expire.mjs's assertRetentionRole, written beside it
// so the job does not change. This is the first statement a run sends. An error the server
// answered - one carrying a five-character SQLSTATE, such as 57014 under a role-level
// statement_timeout or 53300 - maps as any other by refusalCode(); every other failure here is
// the connection's - a wrong password, a refused or failed TLS handshake, a server that does not
// answer - and is reported as database-unreachable, as the service reports those alike.
export async function assertAuditRole(sql) {
  let role;
  try {
    [role] = await sql`
      SELECT current_user AS name, session_user AS session, r.rolsuper AS superuser,
             r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls AS attributes,
             EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid) AS member
        FROM pg_catalog.pg_roles r
       WHERE r.rolname = current_user`;
  } catch (error) {
    const sqlstate = typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code);
    throw new RetentionCheckRefused(sqlstate ? refusalCode(error) : 'database-unreachable');
  }
  if (role === undefined || role.superuser || role.attributes || role.member)
    throw new RetentionCheckRefused('role-unsafe');
  if (role.name !== AUDIT_ROLE || role.session !== AUDIT_ROLE)
    throw new RetentionCheckRefused('not-audit');
}

// The guard as the catalog holds it. 'O' fires in the default mode and 'A' always; 'D' is
// disabled, and 'R' fires only under session_replication_role = replica, so neither holds for an
// ordinary session. `bundled` is the trigger exactly as 0001 creates it: the bundled function,
// tgtype exactly 19 (ROW | BEFORE | UPDATE), no WHEN clause, no UPDATE OF column list and no
// arguments - a trigger recreated WHEN (false) or UPDATE OF one column never fires on the update
// it exists to refuse. `bundled_body` is the function's source compared whole with the body the
// last bundled migration installs, so a function that predates 0002 or was replaced reads
// replaced. Both say what the catalog holds at this snapshot, never what an owner did between
// runs or what a rewritten value was: the ceiling line says so.
function guardState(trigger) {
  if (trigger === undefined) return 'absent';
  if (trigger.bundled !== true || trigger.bundled_body !== true) return 'replaced';
  if (trigger.enabled !== 'O' && trigger.enabled !== 'A') return 'disabled';
  return 'enabled';
}

// The guard function's body as the last bundled migration that defines it installs it: the text
// between its dollar quotes, which is what pg_proc.prosrc holds. Read from the files the build
// bundles, as the schema check reads their checksums; a migration this cannot read is a defect.
export function bundledGuardBody(migrations = loadMigrations()) {
  const definition = `FUNCTION ${GUARD_FUNCTION}`;
  const text = migrations.filter((migration) => migration.text.includes(definition)).at(-1)?.text;
  const body =
    text && /\bAS (\$[A-Za-z_]*\$)([\s\S]*?)\1/.exec(text.slice(text.indexOf(definition)));
  if (!body) throw new RetentionCheckRefused('failed');
  return body[2];
}

// A count or an hour is a non-negative integer; anything else is a defect, never printed.
function whole(value) {
  if (!Number.isInteger(value) || value < 0) throw new RetentionCheckRefused('failed');
  return value;
}

export async function retentionCheck(sql, { guardBody = bundledGuardBody() } = {}) {
  await assertAuditRole(sql);
  const facts = await sql.begin('isolation level repeatable read read only', async (tx) => {
    // SET LOCAL takes no bound parameter; set_config(..., true) is its transaction-scoped form.
    await tx`SELECT pg_catalog.set_config('statement_timeout', ${String(CHECK_STATEMENT_TIMEOUT_MS)}, true)`;
    const [{ present }] = await tx`
      SELECT pg_catalog.to_regclass('evidence.evidence_envelope') IS NOT NULL
         AND pg_catalog.to_regclass('evidence.evidence_redaction') IS NOT NULL AS present`;
    if (!present) throw new RetentionCheckRefused('schema-mismatch');
    const [trigger] = await tx`
      SELECT t.tgenabled AS enabled,
             t.tgfoid = pg_catalog.to_regprocedure(${GUARD_FUNCTION})
               AND t.tgtype = 19 AND t.tgqual IS NULL
               AND t.tgattr = ''::pg_catalog.int2vector AND t.tgnargs = 0 AS bundled,
             p.prosrc = ${guardBody} AS bundled_body
        FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
       WHERE t.tgrelid = pg_catalog.to_regclass('evidence.evidence_envelope')
         AND t.tgname = ${GUARD_TRIGGER} AND NOT t.tgisinternal`;
    // The pairing CHECK holds a payload exactly while redacted_at is null. The snapshot is taken
    // at the first statement, after BEGIN's transaction_timestamp(), so a payload committed
    // between the two is younger than the clock; its age reads 0, never -1. Floored per row,
    // inside the aggregate: greatest() ignores a null, so outside it no payload would read 0.
    const [held] = await tx`
      SELECT count(*) FILTER (WHERE received_at < pg_catalog.transaction_timestamp()
                                    - ${RETENTION_WINDOW}::interval
                                    - ${OVERDUE_GRACE}::interval)::integer AS overdue,
             floor(max(greatest(0, extract(epoch FROM pg_catalog.transaction_timestamp()
                                                      - received_at))) / 3600)::integer
               AS oldest_hours
        FROM evidence.evidence_envelope WHERE redacted_at IS NULL`;
    // On the foreign key, never on ids: nothing here counts ids, ranges or gaps (2.2 F-4).
    const [{ unaudited }] = await tx`
      SELECT count(*)::integer AS unaudited FROM evidence.evidence_envelope e
       WHERE e.redacted_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM evidence.evidence_redaction r WHERE r.envelope_id = e.id)`;
    // The trigger refuses received_at >= ts - window, so a legal redaction is strictly later.
    const [{ early }] = await tx`
      SELECT count(*)::integer AS early FROM evidence.evidence_envelope
       WHERE redacted_at IS NOT NULL AND redacted_at - received_at <= ${RETENTION_WINDOW}::interval`;
    return { trigger, held, unaudited, early };
  });
  const guard = guardState(facts.trigger);
  const result = {
    guard,
    overdue: whole(facts.held.overdue),
    oldestHeldHours: facts.held.oldest_hours === null ? null : whole(facts.held.oldest_hours),
    unaudited: whole(facts.unaudited),
    early: whole(facts.early),
  };
  const found = new Set();
  if (guard !== 'enabled') found.add(`guard-${guard}`);
  if (result.overdue > 0) found.add('overdue-payload');
  if (result.unaudited > 0) found.add('unaudited-redaction');
  if (result.early > 0) found.add('early-redaction');
  return { ...result, violations: VIOLATIONS.filter((kind) => found.has(kind)) };
}

// Every line every time, in a fixed order. A guard that is not enabled is always a violation, so
// "no violation found" is never printed while it is not in force.
export function formatReport({ guard, overdue, oldestHeldHours, unaudited, early, violations }) {
  const prefix = 'retention-check:';
  const oldest = oldestHeldHours === null ? 'none held' : `${whole(oldestHeldHours)} hours`;
  if (!['enabled', 'disabled', 'absent', 'replaced'].includes(guard))
    throw new RetentionCheckRefused('failed');
  if (!violations.every((kind) => VIOLATIONS.includes(kind)))
    throw new RetentionCheckRefused('failed');
  return [
    `${prefix} guard trigger ${GUARD_TRIGGER}: ${guard}`,
    `${prefix} payloads held past ${RETENTION_WINDOW} + ${OVERDUE_GRACE} grace: ${whole(overdue)} found`,
    `${prefix} oldest payload still held: ${oldest}`,
    `${prefix} redacted envelopes with no audit row: ${whole(unaudited)} found`,
    `${prefix} redactions earlier than ${RETENTION_WINDOW} after receipt: ${whole(early)} found`,
    `${prefix} ${CEILING}`,
    violations.length === 0
      ? `${prefix} no violation found`
      : `${prefix} violation found: ${violations.join(', ')}`,
  ];
}

// Error -> refusal code, by class and SQLSTATE, never by message.
export function refusalCode(error) {
  if (error instanceof RetentionCheckRefused || error instanceof StartupRefused)
    return REFUSAL_CODES.has(error.code) ? error.code : 'failed';
  const code = error?.code;
  if (code === '57014') return 'timed-out';
  if (code === '42501' || code === '42P01') return 'schema-mismatch';
  if (typeof code === 'string' && (/^(08|28)/.test(code) || /^E[A-Z]+$/.test(code)))
    return 'database-unreachable';
  return 'failed';
}

// CLI: node packages/evidence-store/src/retention-check.mjs, no arguments. Connection settings
// are the service's (database-config.mjs): the same PG* variables, the same TLS rule. Exit 0 no
// violation found, 1 violation found, 2 usage, 3 refused or failed - nothing was checked.
export function parseArgs(argv) {
  return argv.length === 0 ? {} : null;
}

async function main(argv) {
  if (parseArgs(argv) === null) {
    process.stderr.write(`${USAGE}\n`);
    return EXIT.usage;
  }
  let sql;
  try {
    sql = connect();
    const result = await retentionCheck(sql);
    // Formatted whole before a byte is written, so a refusal never follows a partial report.
    const lines = formatReport(result);
    process.stdout.write(lines.map((line) => `${line}\n`).join(''));
    return result.violations.length === 0 ? EXIT.none : EXIT.found;
  } catch (error) {
    process.stderr.write(`retention-check refused: ${refusalCode(error)}\n`);
    return EXIT.refused;
  } finally {
    await sql?.end({ timeout: 5 }).catch(() => {});
  }
}

// A run that did not finish is never read as one that found something (1) or nothing (0). Node
// exits 1 on an uncaught exception or an unhandled rejection - an EPIPE on stdout once the
// scheduler's pipe is closed, a driver error emitted after end() - and 0 when the event loop drains
// with main() unsettled. Both read 3: exitCode is set before main() starts, and an exception or a
// rejection writes the fixed line and exits at once.
export function refuseUnfinished(proc = process) {
  proc.exitCode = EXIT.refused;
  const refuse = () => {
    try {
      proc.stderr.write('retention-check refused: failed\n');
    } catch {
      // The exit status still says it.
    }
    proc.exit(EXIT.refused);
  };
  proc.on('uncaughtException', refuse);
  proc.on('unhandledRejection', refuse);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  refuseUnfinished();
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
