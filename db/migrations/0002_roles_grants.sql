-- 0002_roles_grants: the GRANT wall.
--
-- Why it looks like this:
-- * audit_writer may only INSERT and SELECT, audit_reader may only SELECT. UPDATE, DELETE and TRUNCATE
--   by either fail with 42501 before any trigger is consulted, so this wall holds even if the trigger
--   wall (0003) is disabled.
-- * The login roles are created WITHOUT a password, so a fresh cluster fails closed. The migrate
--   function sets their passwords from Secrets Manager inside the same transaction.
-- * PUBLIC gets nothing: no CREATE on schema public, no CONNECT/TEMP on the database, no table rights.
-- * The migrating role is granted SET (not INHERIT) on both roles so the immutability proofs can
--   impersonate them with SET LOCAL ROLE without the owner inheriting anything. On PostgreSQL 16 a
--   CREATEROLE role does not get SET on the roles it creates unless it asks for it.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'audit_writer') THEN
    CREATE ROLE audit_writer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'audit_reader') THEN
    CREATE ROLE audit_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
  END IF;
END
$$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO audit_writer, audit_reader;

DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO audit_writer, audit_reader', current_database());
  EXECUTE format('GRANT audit_writer, audit_reader TO %I WITH INHERIT FALSE, SET TRUE', current_user);
END
$$;

REVOKE ALL ON TABLE public.audit_event FROM PUBLIC, audit_writer, audit_reader;
GRANT SELECT, INSERT ON TABLE public.audit_event TO audit_writer;
GRANT SELECT ON TABLE public.audit_event TO audit_reader;
