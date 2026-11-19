-- 0012_schema_status.sql — which migrations this database has applied (KJ, 2026-11-19).
--
-- Four times a migration was merged but never applied, and the feature failed in production.
-- The admin site now compares this list with the migrations it was built with
-- (api/_lib/expected-migrations.ts) and raises it on the Services and Audit pages, and in the
-- hourly dispatcher's log as "ALERT ops health".
--
-- Returns file names and their SHA-256 only: no data. Needs no permission, because the hourly
-- dispatcher calls it without a staff session; only the backend roles may execute it.
SET LOCAL ROLE app_admin_owner;
SET LOCAL search_path = pg_catalog;

CREATE FUNCTION api.schema_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('version', version, 'checksum', checksum) ORDER BY version), '[]'::jsonb)
    FROM meta.schema_migration
$$;

REVOKE EXECUTE ON FUNCTION api.schema_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.schema_status() TO app_admin_api, app_admin_dispatcher;
