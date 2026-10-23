-- runs as: evidence_owner
--
-- Task 2.5. The trigger now also holds redaction to the retention window (ADR-0002 "Retention: 90
-- days from received_at"): a payload is redacted only once its envelope is older than 2160 hours
-- on the database's clock - 90 days of exactly 24 hours, whatever the session's TimeZone - for
-- every role, the owner and a superuser included. Before this, whoever held evidence_retention
-- could redact every live payload at once (threat model ABU-12). src/expire.mjs selects with the
-- same literal and strict `<`, inside the same statement, so a row it selects is never refused
-- here; expire.test.mjs pins the two literals together. Everything else is 0001's function,
-- unchanged: CREATE OR REPLACE keeps its owner and ACL; SECURITY DEFINER and the search path are
-- restated because REPLACE resets them.
--
-- A consequence: no payload can be removed early, for an erasure or a takedown, without a
-- reviewed migration.

CREATE OR REPLACE FUNCTION evidence.guard_envelope_update() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $guard$
DECLARE
  tombstone jsonb;
BEGIN
  -- 1. A tombstone is final: no redaction undone, none repeated, no identifier edited after it.
  IF OLD.evidence IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'evidence_envelope: a redacted envelope is never updated';
  END IF;
  -- 2. The only permitted update is a redaction: a payload is never rewritten.
  IF NEW.evidence IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'evidence_envelope: the only permitted update sets evidence to NULL';
  END IF;
  -- 3. The identity of the acceptance is kept whole; policy_id is the approving decision (NFR-6.1).
  IF (NEW.id, NEW.envelope_version, NEW.workspace_id, NEW.change_id, NEW.received_at, NEW.policy_id)
     IS DISTINCT FROM
     (OLD.id, OLD.envelope_version, OLD.workspace_id, OLD.change_id, OLD.received_at, OLD.policy_id)
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'evidence_envelope: a redaction keeps every identity column';
  END IF;
  -- 4. Only an envelope past the retention window. After 3, so received_at is OLD's.
  IF OLD.received_at >= statement_timestamp() - interval '2160 hours' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'evidence_envelope: a payload is redacted only once its retention window has passed';
  END IF;
  -- 5. ADR-0004: the seven identifiers stay; the four names become null and nothing else changes.
  IF OLD.submitted_by IS NULL THEN
    tombstone := NULL;
  ELSE
    tombstone := OLD.submitted_by
      || '{"ref":null,"event_name":null,"workflow_ref":null,"job_workflow_ref":null}'::jsonb;
  END IF;
  IF NEW.submitted_by IS DISTINCT FROM OLD.submitted_by
     AND NEW.submitted_by IS DISTINCT FROM tombstone THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'evidence_envelope: a redaction changes submitted_by only by nulling its four names';
  END IF;
  NEW.submitted_by := tombstone;
  -- 6. The database stamps the redaction; a supplied value is overwritten.
  NEW.redacted_at := statement_timestamp();
  -- 7. The audit event, naming the role that logged in.
  INSERT INTO evidence.evidence_redaction (envelope_id, redacted_at, redacted_by)
    VALUES (OLD.id, NEW.redacted_at, session_user);
  RETURN NEW;
END
$guard$;

-- The job's schema check (src/expire.mjs) reads what is applied, as the service's does.
GRANT SELECT ON evidence.schema_migrations TO evidence_retention;
