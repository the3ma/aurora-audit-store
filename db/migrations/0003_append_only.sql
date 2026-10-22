-- 0003_append_only: the trigger wall.
--
-- Why it looks like this:
-- * Grants do not bind the table owner. A BEFORE row trigger for UPDATE/DELETE and a BEFORE statement
--   trigger for TRUNCATE (row triggers never fire for TRUNCATE) stop every role, the owner included.
-- * SQLSTATE 23001 (restrict_violation) lets callers tell this wall apart from the grant wall (42501),
--   which is exactly what the deploy-time proofs assert.
-- * Disabling the triggers needs the owner and shows up in pg_trigger.tgenabled, which the proofs
--   check on every deploy.

CREATE OR REPLACE FUNCTION public.audit_event_deny_mutation()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'audit_event is append-only'
    USING ERRCODE = 'restrict_violation',
          DETAIL = format('%s on %I.%I is not permitted', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME);
END
$$;

REVOKE ALL ON FUNCTION public.audit_event_deny_mutation() FROM PUBLIC;

CREATE OR REPLACE TRIGGER audit_event_deny_update_delete
  BEFORE UPDATE OR DELETE ON public.audit_event
  FOR EACH ROW EXECUTE FUNCTION public.audit_event_deny_mutation();

CREATE OR REPLACE TRIGGER audit_event_deny_truncate
  BEFORE TRUNCATE ON public.audit_event
  FOR EACH STATEMENT EXECUTE FUNCTION public.audit_event_deny_mutation();
