-- runs as: evidence_owner
--
-- ADR-0002's append-only envelope log, ADR-0004's submitted_by, and the trigger that is the one
-- deliberate exception to append-only. The runner (src/migrate.mjs) applies this file in one
-- transaction with its schema_migrations row, after creating the evidence schema and that table;
-- it refuses to run as anything but evidence_owner, and refuses a superuser.
--
-- Every security property below is proven against a real PostgreSQL 16 server, logged in as each
-- role, by src/database-roles.integration.mjs. Edit nothing here without running it.

-- The log. One row per accepted submission; nothing is ever deleted: no role holds DELETE or
-- TRUNCATE on it, and evidence_redaction's foreign key is ON DELETE RESTRICT. received_at is the
-- database's clock, never the submitter's and never the service's: the service holds no INSERT
-- on it, so the column default stamps every row. There is no idempotency_key column (it is
-- derived from the pair on read) and no digest of the payload (one would outlive a redacted body
-- and become an offline oracle for it).
CREATE TABLE evidence.evidence_envelope (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  envelope_version text NOT NULL,
  workspace_id text,
  change_id text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  policy_id text,
  -- A structural backstop: a JSON string bound as jsonb is stored as a string scalar (measured
  -- under postgres.js), which only a type check notices.
  submitted_by jsonb CHECK (submitted_by IS NULL OR jsonb_typeof(submitted_by) = 'object'),
  evidence jsonb CHECK (evidence IS NULL OR jsonb_typeof(evidence) = 'object'),
  redacted_at timestamptz,
  -- The idempotency claim, decided by the server under concurrency. NULLS DISTINCT: a null
  -- workspace_id claims no uniqueness (ADR-0002); the service never writes one (requireWorkspace).
  CONSTRAINT evidence_envelope_idempotency UNIQUE NULLS DISTINCT (workspace_id, change_id),
  -- A payload and a redaction time never coexist, and neither is ever absent together. With the
  -- service's INSERT grant, which omits received_at and redacted_at, this means the service can
  -- only ever insert a row that carries a payload.
  CONSTRAINT evidence_envelope_redaction_pair CHECK ((evidence IS NULL) = (redacted_at IS NOT NULL))
);

-- The 90-day retention clock (task 2.5) and the audit range query both read received_at.
CREATE INDEX evidence_envelope_received_at ON evidence.evidence_envelope (received_at);

-- The second audit event: a payload was redacted. Written by the trigger and by nothing else.
CREATE TABLE evidence.evidence_redaction (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  envelope_id bigint NOT NULL REFERENCES evidence.evidence_envelope (id) ON DELETE RESTRICT,
  redacted_at timestamptz NOT NULL,
  redacted_by text NOT NULL
);

-- The control (ADR-0002 "The control is a BEFORE UPDATE trigger", ADR-0004 "Retention"). The only
-- UPDATE it lets through is a redaction: the payload goes to NULL, the seven submitted_by
-- identifiers and every identity column stay, the four submitted_by names become null - set here,
-- so no statement can keep them - and redacted_at is the database's clock, so it cannot be
-- backdated. A tombstone is never updated again, so tombstones are kept indefinitely (Gate 2
-- finding 1, RR-4).
--
-- SECURITY DEFINER, owned by evidence_owner, so it can write evidence_redaction while the role
-- that redacts holds no INSERT there and cannot forge a redaction row. redacted_by is therefore
-- session_user, the role that logged in, not current_user, which is the definer here. The search
-- path is pinned and every name qualified, so no object a caller creates can stand in for one.
CREATE FUNCTION evidence.guard_envelope_update() RETURNS trigger
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
  -- 4. ADR-0004: the seven identifiers stay; the four names become null and nothing else changes.
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
  -- 5. The database stamps the redaction; a supplied value is overwritten.
  NEW.redacted_at := statement_timestamp();
  -- 6. The audit event, naming the role that logged in.
  INSERT INTO evidence.evidence_redaction (envelope_id, redacted_at, redacted_by)
    VALUES (OLD.id, NEW.redacted_at, session_user);
  RETURN NEW;
END
$guard$;

REVOKE ALL ON FUNCTION evidence.guard_envelope_update() FROM PUBLIC;

CREATE TRIGGER evidence_envelope_guard
  BEFORE UPDATE ON evidence.evidence_envelope
  FOR EACH ROW EXECUTE FUNCTION evidence.guard_envelope_update();

-- Grants (stack.md "Access control"; MIT-15, MIT-16). Nothing for PUBLIC; no role but the owner
-- can create anything; column lists keep the payload away from the two roles that do not need it.
GRANT USAGE ON SCHEMA evidence TO evidence_app, evidence_retention, evidence_audit;

-- The service: append and read. It owns nothing, so it cannot ALTER, DROP or disable the trigger.
-- INSERT names its columns, and the two timestamps are not among them. Without redacted_at the
-- service cannot write a row that arrives already redacted: the pairing CHECK alone does not stop
-- that - a NULL payload with a redaction time satisfies it (measured) - and such a row would turn
-- every later replay into a duplicate with no evidence_redaction row behind it. Without
-- received_at it cannot choose a row's retention clock: a future-dated row would never expire and
-- a back-dated one would expire at once (task 2.5 selects on received_at).
GRANT SELECT ON evidence.evidence_envelope TO evidence_app;
GRANT INSERT (envelope_version, workspace_id, change_id, policy_id, submitted_by, evidence)
  ON evidence.evidence_envelope TO evidence_app;
GRANT SELECT ON evidence.schema_migrations TO evidence_app;

-- Redaction: find rows by id and age, null the payload. It never reads a payload.
GRANT SELECT (id, received_at, redacted_at) ON evidence.evidence_envelope TO evidence_retention;
GRANT UPDATE (evidence, submitted_by, redacted_at) ON evidence.evidence_envelope TO evidence_retention;

-- Audit: both events, every column except the payload.
GRANT SELECT (id, envelope_version, workspace_id, change_id, received_at, policy_id, submitted_by,
              redacted_at)
  ON evidence.evidence_envelope TO evidence_audit;
GRANT SELECT ON evidence.evidence_redaction TO evidence_audit;

-- The owner gives up what nobody needs, so taking it back is an explicit, catalogued act that the
-- grants snapshot test catches. It keeps UPDATE on the envelope: the foreign-key check behind
-- every redaction locks the envelope row FOR KEY SHARE, which needs it (measured).
REVOKE DELETE, TRUNCATE ON evidence.evidence_envelope FROM evidence_owner;
REVOKE UPDATE, DELETE, TRUNCATE ON evidence.evidence_redaction FROM evidence_owner;
