-- 0004_require_permission.sql — let an endpoint check a permission before it
-- asks portal-api for data. Reads that live in the portal (banks, groups, the
-- portal audit trail) have no admin-DB function of their own to enforce the
-- permission, so the endpoint calls this first; it raises if the signed-in
-- admin lacks the permission (or has no session).
SET LOCAL ROLE portal_admin_owner;
SET LOCAL search_path = pg_catalog;

CREATE FUNCTION api.require_permission(p_perm text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM iam.require(p_perm);
  RETURN true;
END $$;

REVOKE EXECUTE ON FUNCTION api.require_permission(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.require_permission(text) TO portal_admin_api;
