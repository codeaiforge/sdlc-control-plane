// The PostgreSQL adapter (ADR-0002), written against store-conformance.mjs like the in-memory one
// and proven by postgres-store.integration.mjs on a real server. Three rules hold throughout:
//
// 1. Every value reaches SQL as a bound parameter of a tagged template. This file never builds
//    SQL text and never calls the driver's raw-text or identifier helpers; postgres-store.test.mjs
//    reads this file and fails if it does.
// 2. jsonb is bound as `${text}::text::jsonb`. Bound straight to a jsonb parameter, the driver
//    JSON-encodes a JS string a second time and the row holds a string scalar, not the object
//    (measured; the migration's jsonb_typeof CHECKs are the backstop).
// 3. Every driver call is awaited through run(): a rejection, or no answer within
//    STORE_QUERY_TIMEOUT_MS, becomes an EvidenceStoreFault - the control plane's fault, answered
//    503 by the seam - with the driver error kept as `cause` and never logged or answered.
//    Preconditions are checked synchronously, before any query: a TypeError for a record the
//    caller got wrong, an EvidenceStoreFault for an envelope option the control plane got wrong.

import {
  ENVELOPE_VERSION,
  EvidenceStoreFault,
  assertEnvelopeOptions,
  deepFreeze,
  idempotencyKey,
  project,
} from './evidence-store.mjs';
import { loadMigrations } from './migrate.mjs';

// A literal, reviewed like every other limit, never an environment variable. A frozen or
// partitioned server does not reject a query, it leaves it waiting (measured), and a request held
// open on it holds a connection and the caller's socket with it. The value sits well inside the
// seam's 30 s request timeout; a timed-out insert that commits later is answered 503 and its retry
// is a duplicate 202, which is consistent because intake is idempotent.
export const STORE_QUERY_TIMEOUT_MS = 5000;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Refusing to start is not a store fault: it is decided once, before the service listens, and the
// process exits with one fixed line naming the code. The message never carries a driver message.
export class StartupRefused extends Error {
  constructor(code, options) {
    super(`control plane refused to start: ${code}`, options);
    this.name = 'StartupRefused';
    this.code = code;
  }
}

async function run(query, what) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      // Fire and forget: in a partition the cancel request can hang too, and nothing waits on it.
      Promise.resolve()
        .then(() => query.cancel?.())
        .catch(() => {});
      reject(new EvidenceStoreFault(`evidence store did not answer ${what} in time`));
    }, STORE_QUERY_TIMEOUT_MS);
  });
  // The query's own rejection after a timeout has nobody waiting on it; swallowing it here keeps
  // it from surfacing as an unhandled rejection, which would terminate the process.
  const settled = Promise.resolve(query).catch((cause) => {
    throw new EvidenceStoreFault(`evidence store failed ${what}`, { cause });
  });
  settled.catch(() => {});
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// One row -> one envelope, in the port's key order, deep-frozen. Timestamps are read back as
// Date#toISOString(), the in-memory format, at millisecond precision.
function toEnvelope(row) {
  return deepFreeze({
    envelope_version: row.envelope_version,
    workspace_id: row.workspace_id,
    received_at: row.received_at.toISOString(),
    idempotency_key:
      row.workspace_id === null ? null : idempotencyKey(row.workspace_id, row.change_id),
    policy_id: row.policy_id,
    submitted_by: row.submitted_by,
    evidence: row.evidence,
    redacted_at: row.redacted_at === null ? null : row.redacted_at.toISOString(),
  });
}

export function createPostgresEvidenceStore({ sql, requireWorkspace = false } = {}) {
  if (typeof sql !== 'function') throw new TypeError('createPostgresEvidenceStore needs a client');

  function append(
    record,
    { workspace_id = null, received_at, policy_id = null, submitted_by = null } = {},
  ) {
    if (!isObject(record)) throw new TypeError('evidence record must be an object');
    const { text, value } = project(record);
    if (typeof value.change_id !== 'string' || value.change_id.length === 0)
      throw new TypeError('evidence record must carry a non-empty string change_id');
    assertEnvelopeOptions({ workspace_id, policy_id, submitted_by });
    // ADR-0002: in production configuration a null workspace_id must never be stored. The
    // service always constructs this adapter with requireWorkspace (database-config.mjs); the
    // conformance suite does not, so the port's null branch is still tested.
    if (requireWorkspace && workspace_id === null)
      throw new EvidenceStoreFault('workspace_id is required by this store');
    // received_at is the database's clock: the column default stamps every row, and the service
    // role holds no INSERT on the column (0001-evidence-envelope.sql). The port's option is the
    // in-memory adapter's injected clock; a caller passing one here gets a fault, not a row whose
    // retention clock it chose.
    if (received_at !== undefined && received_at !== null)
      throw new EvidenceStoreFault('received_at is stamped by the database in this store');
    const submitter = submitted_by === null ? null : JSON.stringify(submitted_by);
    const changeId = value.change_id;
    return appendRows({ text, workspace_id, changeId, policy_id, submitter });
  }

  // Two statements, never one. The INSERT's unique index decides the race; a SELECT folded into
  // the same statement would read the statement's snapshot and could miss the row a racing insert
  // just committed (measured design). Nothing is ever read before the INSERT, so there is no
  // select-then-insert path: uniqueness is the server's.
  async function appendRows({ text, workspace_id, changeId, policy_id, submitter }) {
    const inserted = await run(
      sql`
        INSERT INTO evidence.evidence_envelope
          (envelope_version, workspace_id, change_id, policy_id, submitted_by, evidence)
        VALUES (
          ${ENVELOPE_VERSION}, ${workspace_id}, ${changeId}, ${policy_id},
          ${submitter}::text::jsonb, ${text}::text::jsonb
        )
        ON CONFLICT ON CONSTRAINT evidence_envelope_idempotency DO NOTHING
        RETURNING envelope_version, workspace_id, change_id, received_at, policy_id,
                  submitted_by, evidence, redacted_at`,
      'an append',
    );
    if (inserted.length === 1) {
      const envelope = toEnvelope(inserted[0]);
      return { outcome: 'appended', key: envelope.idempotency_key, envelope };
    }
    // The key exists. jsonb equality ignores key order (AC-15); a redacted row has no body to
    // disagree with, so a replay of it is a duplicate on the key alone (AC-8). The first record
    // and its submitter stand either way.
    const [stored] = await run(
      sql`
        SELECT envelope_version, workspace_id, change_id, received_at, policy_id, submitted_by,
               evidence, redacted_at,
               (evidence IS NULL OR evidence = ${text}::text::jsonb) AS same
          FROM evidence.evidence_envelope
         WHERE workspace_id = ${workspace_id} AND change_id = ${changeId}`,
      'a replay lookup',
    );
    // Unreachable under READ COMMITTED after DO NOTHING; refused rather than guessed if it is not.
    if (stored === undefined) throw new EvidenceStoreFault('evidence store lost a conflicting row');
    const envelope = toEnvelope(stored);
    return {
      outcome: stored.same ? 'duplicate' : 'conflict',
      key: envelope.idempotency_key,
      envelope,
    };
  }

  function list({ workspace_id } = {}) {
    if (workspace_id === undefined)
      return run(
        sql`
          SELECT envelope_version, workspace_id, change_id, received_at, policy_id, submitted_by,
                 evidence, redacted_at
            FROM evidence.evidence_envelope ORDER BY id`,
        'a read',
      ).then((rows) => rows.map(toEnvelope));
    if (typeof workspace_id !== 'string')
      throw new TypeError('list workspace_id filter must be a string');
    return run(
      sql`
        SELECT envelope_version, workspace_id, change_id, received_at, policy_id, submitted_by,
               evidence, redacted_at
          FROM evidence.evidence_envelope WHERE workspace_id = ${workspace_id} ORDER BY id`,
      'a read',
    ).then((rows) => rows.map(toEnvelope));
  }

  function listRecords() {
    return run(
      sql`SELECT evidence FROM evidence.evidence_envelope WHERE evidence IS NOT NULL ORDER BY id`,
      'a read',
    ).then((rows) => rows.map((row) => deepFreeze(row.evidence)));
  }

  return { append, list, listRecords };
}

// D-16. The service's database role is meant to append and read, and nothing more. Checked once at
// startup, on the live connection, against the server's own catalog. Refused, as role-unsafe:
// - a role attribute beyond LOGIN: SUPERUSER, CREATEROLE, CREATEDB, REPLICATION or BYPASSRLS;
// - membership of any other role. Privilege checks below do not count a NOINHERIT role's
//   memberships, yet the role can still SET ROLE to any of them - to evidence_owner, say, and
//   disable the trigger (measured on 16.15) - so a member of anything is refused outright;
// - ownership of this database, the evidence schema, or any table, sequence or function in it;
// - UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER on the envelope log, any write on
//   evidence_redaction, or INSERT on the two columns the database stamps, received_at and
//   redacted_at;
// - and a role that cannot insert a payload and read the log back.
// What it reads is the catalog at startup: a grant made while the service runs is seen at the
// next start, and a cluster superuser or evidence_owner can still change anything (stack.md
// "Access control").
export async function assertServiceRole(sql, { requireTls = true } = {}) {
  const [role] = await sql`
    SELECT r.rolsuper AS superuser,
           r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls AS attributes,
           EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid) AS member,
           pg_catalog.to_regclass('evidence.evidence_envelope') IS NOT NULL
             AND pg_catalog.to_regclass('evidence.evidence_redaction') IS NOT NULL AS schema_present,
           EXISTS (SELECT 1 FROM pg_catalog.pg_database d
                    WHERE d.datname = pg_catalog.current_database() AND d.datdba = r.oid)
             OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n
                         WHERE n.nspname = 'evidence' AND n.nspowner = r.oid)
             OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                         WHERE n.nspname = 'evidence' AND c.relowner = r.oid)
             OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                          JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
                         WHERE n.nspname = 'evidence' AND p.proowner = r.oid) AS owns,
           COALESCE((SELECT s.ssl FROM pg_catalog.pg_stat_ssl s
                      WHERE s.pid = pg_catalog.pg_backend_pid()), false) AS ssl
      FROM pg_catalog.pg_roles r
     WHERE r.rolname = current_user`;
  if (role === undefined || !role.schema_present) throw new StartupRefused('schema-mismatch');
  if (role.superuser || role.attributes || role.member || role.owns)
    throw new StartupRefused('role-unsafe');
  const [privileges] = await sql`
    SELECT pg_catalog.has_any_column_privilege('evidence.evidence_envelope', 'UPDATE')
             OR pg_catalog.has_table_privilege('evidence.evidence_envelope',
                                               'UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
             OR pg_catalog.has_any_column_privilege('evidence.evidence_redaction', 'INSERT, UPDATE')
             OR pg_catalog.has_table_privilege('evidence.evidence_redaction',
                                               'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
             OR pg_catalog.has_column_privilege('evidence.evidence_envelope', 'received_at', 'INSERT')
             OR pg_catalog.has_column_privilege('evidence.evidence_envelope', 'redacted_at', 'INSERT')
             AS rewrites,
           pg_catalog.has_column_privilege('evidence.evidence_envelope', 'evidence', 'INSERT')
             AND pg_catalog.has_table_privilege('evidence.evidence_envelope', 'SELECT') AS appends`;
  if (privileges.rewrites || !privileges.appends) throw new StartupRefused('role-unsafe');
  if (requireTls && !role.ssl) throw new StartupRefused('tls-not-negotiated');
}

// D-16. What is applied must be exactly what this build bundles, version for version and byte
// for byte by checksum. The service never migrates; a database behind or ahead of it is refused.
export async function assertSchemaCurrent(sql, { migrations = loadMigrations() } = {}) {
  const [{ present }] = await sql`
    SELECT pg_catalog.to_regclass('evidence.schema_migrations') IS NOT NULL AS present`;
  if (!present) throw new StartupRefused('schema-mismatch');
  const applied =
    await sql`SELECT version, checksum FROM evidence.schema_migrations ORDER BY version`;
  const expected = migrations.map(({ version, checksum }) => `${version}:${checksum}`);
  const actual = applied.map(({ version, checksum }) => `${version}:${checksum}`);
  if (expected.length !== actual.length || expected.some((entry, i) => entry !== actual[i]))
    throw new StartupRefused('schema-mismatch');
}
