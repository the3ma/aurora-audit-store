-- 0004_views: pre-aggregated read models for the facet pickers and the daily chart.
--
-- Why it looks like this:
-- * Facets (distinct scopes, entity types, actions, actor emails per tenant) and daily counts would be
--   full-tenant aggregates on every page load; they tolerate ~10 minutes of staleness, so they are
--   materialized and refreshed on a schedule.
-- * refresh_audit_views() is SECURITY DEFINER so the scheduler can run as audit_reader: REFRESH needs
--   ownership, and a scheduled function should not hold an owner credential. search_path is pinned so
--   a caller cannot shadow the objects the definer function references.
-- * Plain (non-CONCURRENT) REFRESH: the views are small and a short lock is cheaper than the diff
--   pass. The unique indexes still pin the grain and keep CONCURRENTLY available later.
-- * Days are bucketed in UTC so the chart does not depend on the session time zone.

CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_audit_facets AS
  SELECT DISTINCT e.tenant_id, f.facet, f.value
  FROM public.audit_event e
  CROSS JOIN LATERAL (
    VALUES
      ('scope'::text, e.scope::text),
      ('entity_type', e.entity_type),
      ('action', e.action),
      ('actor_email', e.actor_email)
  ) AS f (facet, value)
WITH DATA;

CREATE UNIQUE INDEX IF NOT EXISTS ux_mv_audit_facets
  ON public.mv_audit_facets (tenant_id, facet, value);

CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_audit_daily_counts AS
  SELECT
    e.tenant_id,
    e.scope,
    (e.occurred_at AT TIME ZONE 'UTC')::date AS day,
    e.action,
    count(*)::bigint AS events
  FROM public.audit_event e
  GROUP BY 1, 2, 3, 4
WITH DATA;

CREATE UNIQUE INDEX IF NOT EXISTS ux_mv_audit_daily_counts
  ON public.mv_audit_daily_counts (tenant_id, scope, day, action);

CREATE OR REPLACE FUNCTION public.refresh_audit_views()
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW public.mv_audit_facets;
  REFRESH MATERIALIZED VIEW public.mv_audit_daily_counts;
END
$$;

REVOKE ALL ON FUNCTION public.refresh_audit_views() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.refresh_audit_views() TO audit_reader;

REVOKE ALL ON TABLE public.mv_audit_facets, public.mv_audit_daily_counts FROM PUBLIC;
GRANT SELECT ON TABLE public.mv_audit_facets, public.mv_audit_daily_counts TO audit_writer, audit_reader;
