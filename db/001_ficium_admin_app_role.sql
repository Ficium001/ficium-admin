-- APPLIED to the App DB (wixfhjlsjkiwfvqewvmt) on 2026-10-06 as migration ficium_admin_app_role.
-- Role is NOLOGIN until deploy. Verified (rolled back): can read settings + history,
-- can change a check only via admin.set_kyc_check; direct UPDATE and history DELETE denied;
-- short reasons refused.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ficium_admin_app') THEN
    CREATE ROLE ficium_admin_app NOLOGIN NOINHERIT NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;
ALTER ROLE ficium_admin_app SET statement_timeout = '5s';
GRANT USAGE ON SCHEMA public, admin TO ficium_admin_app;
GRANT SELECT ON public.kyc_settings TO ficium_admin_app;
GRANT SELECT ON admin.kyc_settings_change TO ficium_admin_app;
GRANT EXECUTE ON FUNCTION admin.set_kyc_check(text, boolean, text, text) TO ficium_admin_app;
-- + SELECT policies for the role on both tables where RLS is enabled.
