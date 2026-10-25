-- 0000_roles.sql — cluster-level roles for the Ficium admin databases.
-- Portable PostgreSQL 16+. Run once per cluster as the operator role
-- (Neon: neondb_owner; elsewhere: any role with CREATEROLE).
--
-- Every role here is NOLOGIN. Login roles (with passwords) are created by a
-- human in the provider console / secret manager and then granted ONE of the
-- *_api / *_dispatcher / *_readonly roles. Passwords never live in this repo.
--
--   <db>_owner       owns every object in <db>; nobody logs in as it
--   <db>_api         admin backend: EXECUTE on api.* only, zero table access
--   <db>_dispatcher  outbox worker: EXECUTE on api.outbox_* only
--   <db>_readonly    support/reporting: SELECT only
DO $$
DECLARE d text; r text;
BEGIN
  FOREACH d IN ARRAY ARRAY['app_admin','portal_admin'] LOOP
    FOREACH r IN ARRAY ARRAY['owner','api','dispatcher','readonly'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = d || '_' || r) THEN
        EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT', d || '_' || r);
      END IF;
    END LOOP;
  END LOOP;
END $$;

-- Operator may assume the owner role to run migrations.
GRANT app_admin_owner    TO CURRENT_USER WITH SET TRUE, INHERIT FALSE;
GRANT portal_admin_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE;
