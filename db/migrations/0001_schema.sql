-- 0001_schema: the audit_event table and its read-path indexes.
--
-- Why it looks like this:
-- * event_row_id is an identity column used for ordering ties and digest ranges. Identity values are
--   not transactional, so gaps are expected and harmless; nothing may assume the sequence is dense.
-- * event_id is the writer's idempotency key. Its unique index is the ON CONFLICT arbiter for both the
--   API and the backfill, so the table is unusable without it.
-- * changes is real jsonb (an opaque string in the old design) and must be an array.
-- * Every read path is "one tenant, newest first", so each index leads with tenant_id and ends with
--   occurred_at DESC (plus event_row_id where the keyset cursor needs a total order).
-- * Indexes are built here only while the table is empty. On a populated table a plain CREATE INDEX
--   would block writes for the whole build inside the migration transaction, so we warn and leave
--   CREATE INDEX CONCURRENTLY to the runbook - except the event_id index, whose absence is fatal.

DO $$
BEGIN
  IF to_regtype('public.audit_scope') IS NULL THEN
    CREATE TYPE public.audit_scope AS ENUM ('accounts', 'billing', 'catalog', 'orders', 'settings', 'security');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.audit_event (
  event_row_id  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id      UUID        NOT NULL,
  tenant_id     TEXT        NOT NULL,
  project_id    TEXT,
  scope         public.audit_scope NOT NULL,
  entity_type   TEXT        NOT NULL,
  entity_id     TEXT        NOT NULL,
  entity_label  TEXT        NOT NULL,
  action        TEXT        NOT NULL,
  actor_id      TEXT        NOT NULL,
  actor_email   TEXT        NOT NULL,
  occurred_at   TIMESTAMPTZ NOT NULL,
  changes       JSONB       NOT NULL DEFAULT '[]'::jsonb,
  comment       TEXT,
  source        TEXT        NOT NULL DEFAULT 'live',
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT audit_event_changes_is_array CHECK (jsonb_typeof(changes) = 'array'),
  CONSTRAINT audit_event_source_valid     CHECK (source IN ('live', 'backfill'))
);

COMMENT ON TABLE public.audit_event IS
  'Append-only audit log. UPDATE/DELETE/TRUNCATE are denied by grants and by trigger. Retention: 7 years.';

DO $$
DECLARE
  populated boolean;
  missing text;
BEGIN
  SELECT EXISTS (SELECT 1 FROM public.audit_event) INTO populated;

  IF NOT populated THEN
    CREATE UNIQUE INDEX IF NOT EXISTS ux_audit_event_event_id
      ON public.audit_event (event_id);
    CREATE INDEX IF NOT EXISTS ix_audit_event_tenant_time
      ON public.audit_event (tenant_id, occurred_at DESC, event_row_id DESC);
    CREATE INDEX IF NOT EXISTS ix_audit_event_tenant_scope_time
      ON public.audit_event (tenant_id, scope, occurred_at DESC, event_row_id DESC);
    CREATE INDEX IF NOT EXISTS ix_audit_event_tenant_actor_time
      ON public.audit_event (tenant_id, actor_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS ix_audit_event_tenant_entity_time
      ON public.audit_event (tenant_id, entity_type, entity_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS ix_audit_event_tenant_project_time
      ON public.audit_event (tenant_id, project_id, occurred_at DESC)
      WHERE project_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS ix_audit_event_time
      ON public.audit_event (occurred_at DESC, event_row_id DESC);
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    WHERE i.indexrelid = to_regclass('public.ux_audit_event_event_id')
      AND i.indisunique
      AND i.indisvalid
  ) THEN
    RAISE EXCEPTION 'audit_event is populated but ux_audit_event_event_id is missing or invalid'
      USING ERRCODE = 'object_not_in_prerequisite_state',
            HINT = 'ON CONFLICT (event_id) needs it as arbiter (42P10 otherwise). Build it with CREATE UNIQUE INDEX CONCURRENTLY per the runbook, then re-run the migration.';
  END IF;

  FOR missing IN
    SELECT n.name
    FROM unnest(ARRAY[
      'ix_audit_event_tenant_time',
      'ix_audit_event_tenant_scope_time',
      'ix_audit_event_tenant_actor_time',
      'ix_audit_event_tenant_entity_time',
      'ix_audit_event_tenant_project_time',
      'ix_audit_event_time'
    ]) AS n (name)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_index i
      WHERE i.indexrelid = to_regclass('public.' || n.name)
        AND i.indisvalid
    )
  LOOP
    RAISE WARNING 'audit_event is populated and index % is missing or invalid; build it with CREATE INDEX CONCURRENTLY (runbook)', missing;
  END LOOP;
END
$$;
