-- 0005_iam_invite_resend.sql — permission-checked, audited re-send of a staff invite.
-- Returns the admin's current status so the caller only re-sends to someone still 'invited'.
SET LOCAL ROLE app_admin_owner;
SET LOCAL search_path = pg_catalog;

CREATE FUNCTION api.iam_invite_resend(p_email text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('iam.manage'); u iam.admin_user;
BEGIN
  SELECT * INTO u FROM iam.admin_user WHERE lower(email) = lower(btrim(p_email));
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown admin' USING ERRCODE = 'P0002'; END IF;
  IF u.status <> 'invited' THEN RAISE EXCEPTION 'they have already activated their account' USING ERRCODE = '22023'; END IF;
  PERFORM audit.record('iam.invite_resent', 'admin_user', u.id::text, NULL, NULL, jsonb_build_object('email', u.email));
  RETURN u.status;
END $$;
REVOKE EXECUTE ON FUNCTION api.iam_invite_resend(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.iam_invite_resend(text) TO app_admin_api;
