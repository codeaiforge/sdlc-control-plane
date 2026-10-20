-- runs as: evidence_audit
--
-- ADR-0002's two audit events, as the queries an auditor runs (AC-10). There is no HTTP surface
-- for them (RR-5). src/database-roles.integration.mjs reads this file and runs each query below as
-- evidence_audit against a real server, so the documented queries are the tested ones.
--
-- Each query is introduced by a `-- name: <name>` line and takes positional parameters, bound by
-- the client (psql: \bind, or a driver's parameters) - never spliced into the text. Ranges are
-- half-open: [$from, $until). Neither query reads the payload column, which evidence_audit cannot.

-- name: envelopes-appended
-- An envelope was appended: the envelopes workspace $1 had accepted in [$2, $3), oldest first.
SELECT id, envelope_version, workspace_id, change_id, received_at, policy_id, submitted_by,
       redacted_at
  FROM evidence.evidence_envelope
 WHERE workspace_id = $1
   AND received_at >= $2::timestamptz
   AND received_at < $3::timestamptz
 ORDER BY received_at, id;

-- name: payloads-redacted
-- A payload was redacted: every redaction in [$1, $2), with the identity of the envelope it hit.
SELECT r.id AS redaction_id, r.redacted_at, r.redacted_by, e.id AS envelope_id, e.workspace_id,
       e.change_id, e.received_at, e.policy_id
  FROM evidence.evidence_redaction AS r
  JOIN evidence.evidence_envelope AS e ON e.id = r.envelope_id
 WHERE r.redacted_at >= $1::timestamptz
   AND r.redacted_at < $2::timestamptz
 ORDER BY r.redacted_at, r.id;
