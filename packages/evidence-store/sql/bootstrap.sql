-- runs as: cluster admin
--
-- Stage one of two (ADR-0002 "A third role owns the schema"). Roles are cluster objects, so the
-- DDL role cannot create them itself: an administrator runs this once per cluster, through
-- `node packages/evidence-store/src/migrate.mjs bootstrap --database <name>`, which then creates
-- the database owned by evidence_owner, revokes everything on it from PUBLIC and grants CONNECT to
-- the three non-owner roles. Stage two (`migrate`) runs as evidence_owner and never as this.
--
-- Four roles, fixed names, created without passwords: the operator sets each one out of band
-- (ALTER ROLE ... PASSWORD), so no credential is ever written in this repository. Re-running is a
-- no-op: a role that already exists is left as it is, and the runner and the service refuse to
-- run as a role that turns out to be a superuser.
--
--   evidence_owner      owns every object; used only by `migrate`
--   evidence_app        the service: INSERT and SELECT on the envelope log, owns nothing
--   evidence_retention  redaction only: cannot read a payload (task 2.5's job runs as it)
--   evidence_audit      reads the two audit events; cannot read a payload

DO $bootstrap$
DECLARE
  name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['evidence_owner', 'evidence_app', 'evidence_retention', 'evidence_audit']
  LOOP
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = name) THEN
      EXECUTE pg_catalog.format(
        'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
        name
      );
    END IF;
  END LOOP;
END
$bootstrap$;
