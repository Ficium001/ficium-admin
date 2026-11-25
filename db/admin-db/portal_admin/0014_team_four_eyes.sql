-- team_four_eyes — complete staff onboarding, same standard as the bank portal's user module.
--
-- Generated into app_admin/0017_team_four_eyes.sql and portal_admin/0014_team_four_eyes.sql by
-- scripts/gen-team-migration.mjs (portal_admin = database name). Both admin DBs get identical logic.
--
-- * Four-eyes on every change that GRANTS or RESTORES access: invite, role/group change,
--   reactivation, sign-in reset, rename, and creating/changing/retiring a group. One admin asks
--   (iam.manage), a DIFFERENT admin approves (iam.approve), and never a change about themselves.
--   Requests expire after 7 days. The approval is the moment the change happens.
-- * Removing access stays immediate (suspend / disable): cutting someone off must not wait.
-- * Groups: roles get a label and become editable (except super_admin). Custom groups can be
--   created with any set of permissions, and retired once nobody is in them.
-- * Never lose the last active super admin.
-- * Identity (username, MFA, last sign-in) stays in ficium-auth; this DB never copies it.
-- * The old single-person api.iam_invite / api.iam_set_roles are no longer callable by the backend.
SET LOCAL ROLE portal_admin_owner;
SET LOCAL search_path = pg_catalog;

INSERT INTO iam.permission (code, description) VALUES
  ('iam.approve', 'Approve or reject a team change (never your own, never one about yourself)');
INSERT INTO iam.role_permission (role_code, permission_code) VALUES ('super_admin', 'iam.approve');

-- ------------------------------------------------------------------ groups
ALTER TABLE iam.role
  ADD COLUMN label      text,
  ADD COLUMN is_system  boolean NOT NULL DEFAULT true,
  ADD COLUMN created_by uuid REFERENCES iam.admin_user(id),
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN retired_at timestamptz;
UPDATE iam.role SET label = CASE code
  WHEN 'super_admin' THEN 'Super admin' WHEN 'compliance' THEN 'Compliance'
  WHEN 'operations'  THEN 'Operations'  WHEN 'read_only'  THEN 'Read only'
  ELSE initcap(replace(code, '_', ' ')) END;
ALTER TABLE iam.role ALTER COLUMN label SET NOT NULL,
  ADD CONSTRAINT role_label_len CHECK (length(btrim(label)) BETWEEN 2 AND 60),
  ADD CONSTRAINT role_description_len CHECK (length(btrim(description)) BETWEEN 1 AND 300);

-- ------------------------------------------------------------------ change queue
CREATE TABLE iam.change (
  id            uuid PRIMARY KEY DEFAULT util.uuid_v7(),
  op            text NOT NULL CHECK (op IN ('invite','set_roles','reactivate','reset_login','rename',
                                            'group_create','group_update','group_retire')),
  target_user   uuid REFERENCES iam.admin_user(id),
  target_key    text NOT NULL CHECK (length(target_key) BETWEEN 1 AND 320),
  target_label  text NOT NULL CHECK (length(btrim(target_label)) BETWEEN 1 AND 400),
  args          jsonb NOT NULL CHECK (jsonb_typeof(args) = 'object' AND pg_column_size(args) < 8000),
  before        jsonb,
  reason        text NOT NULL,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','approved','rejected','cancelled','expired')),
  maker_id      uuid NOT NULL REFERENCES iam.admin_user(id),
  checker_id    uuid REFERENCES iam.admin_user(id),
  decision_note text,
  decided_at    timestamptz,
  result        jsonb,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at    timestamptz NOT NULL DEFAULT clock_timestamp() + interval '7 days',
  version       bigint NOT NULL DEFAULT 1,
  CHECK (checker_id IS NULL OR checker_id <> maker_id),
  CHECK ((status = 'pending') = (decided_at IS NULL))
);
-- One open request per kind and person/group: no racing two role changes for the same admin.
CREATE UNIQUE INDEX change_one_pending ON iam.change (op, target_key) WHERE status = 'pending';
CREATE INDEX change_status_idx ON iam.change (status, created_at DESC);

CREATE FUNCTION iam._roles_of(p_user uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT coalesce(jsonb_agg(role_code ORDER BY role_code), '[]') FROM iam.user_role WHERE user_id = p_user
$$;

CREATE FUNCTION iam._perms_of_role(p_role text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT coalesce(jsonb_agg(permission_code ORDER BY permission_code), '[]') FROM iam.role_permission WHERE role_code = p_role
$$;

CREATE FUNCTION iam._text_array(p jsonb, p_what text) RETURNS text[]
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE v text[];
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'array' THEN RAISE EXCEPTION '% must be a list', p_what USING ERRCODE = '22023'; END IF;
  SELECT coalesce(array_agg(DISTINCT x ORDER BY x), '{}') INTO v FROM jsonb_array_elements_text(p) x;
  RETURN v;
END $$;

-- Roles a person may be given: exist and not retired; at least one.
CREATE FUNCTION iam._check_roles(p_roles text[]) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE bad text;
BEGIN
  IF coalesce(cardinality(p_roles), 0) = 0 THEN RAISE EXCEPTION 'pick at least one group' USING ERRCODE = '22023'; END IF;
  SELECT x INTO bad FROM unnest(p_roles) x
   WHERE NOT EXISTS (SELECT 1 FROM iam.role r WHERE r.code = x AND r.retired_at IS NULL) LIMIT 1;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'unknown or retired group: %', bad USING ERRCODE = '22023'; END IF;
END $$;

CREATE FUNCTION iam._check_perms(p_perms text[]) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE bad text;
BEGIN
  IF coalesce(cardinality(p_perms), 0) = 0 THEN RAISE EXCEPTION 'a group needs at least one permission' USING ERRCODE = '22023'; END IF;
  SELECT x INTO bad FROM unnest(p_perms) x WHERE NOT EXISTS (SELECT 1 FROM iam.permission p WHERE p.code = x) LIMIT 1;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'unknown permission: %', bad USING ERRCODE = '22023'; END IF;
END $$;

-- Refuses a change that would leave no ACTIVE super admin.
CREATE FUNCTION iam._keep_a_super_admin(p_user uuid) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM iam.user_role ur JOIN iam.admin_user u ON u.id = ur.user_id
                  WHERE ur.role_code = 'super_admin' AND u.status = 'active' AND u.id <> p_user) THEN
    RAISE EXCEPTION 'that would leave no active super admin' USING ERRCODE = '22023';
  END IF;
END $$;

CREATE FUNCTION iam._change_json(c iam.change) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT to_jsonb(c) || jsonb_build_object(
    'status', CASE WHEN c.status = 'pending' AND c.expires_at < clock_timestamp() THEN 'expired' ELSE c.status END,
    'maker_email',   (SELECT email FROM iam.admin_user WHERE id = c.maker_id),
    'maker_name',    (SELECT display_name FROM iam.admin_user WHERE id = c.maker_id),
    'checker_email', (SELECT email FROM iam.admin_user WHERE id = c.checker_id))
$$;

-- ------------------------------------------------------------------ reads
CREATE FUNCTION api.iam_me() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.current_admin();
BEGIN
  RETURN jsonb_build_object('admin_id', a,
    'permissions', coalesce((SELECT jsonb_agg(DISTINCT rp.permission_code ORDER BY rp.permission_code)
                               FROM iam.user_role ur JOIN iam.role_permission rp ON rp.role_code = ur.role_code
                              WHERE ur.user_id = a), '[]'));
END $$;

CREATE OR REPLACE FUNCTION api.iam_list() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM iam.require('iam.read');
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id', u.id, 'email', u.email, 'display_name', u.display_name, 'status', u.status,
      'version', u.version, 'created_at', u.created_at,
      'created_by', (SELECT email FROM iam.admin_user c WHERE c.id = u.created_by),
      'last_seen_at', (SELECT max(s.started_at) FROM iam.session_log s WHERE s.admin_id = u.id),
      'roles', iam._roles_of(u.id))
    ORDER BY u.created_at) FROM iam.admin_user u), '[]');
END $$;

CREATE FUNCTION api.iam_groups() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM iam.require('iam.read');
  RETURN jsonb_build_object(
    'groups', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'code', r.code, 'label', r.label, 'description', r.description, 'is_system', r.is_system,
        'locked', r.code = 'super_admin', 'retired', r.retired_at IS NOT NULL,
        'permissions', iam._perms_of_role(r.code),
        'members', coalesce((SELECT jsonb_agg(jsonb_build_object('id', u.id, 'display_name', u.display_name, 'status', u.status)
                                              ORDER BY u.display_name)
                               FROM iam.user_role ur JOIN iam.admin_user u ON u.id = ur.user_id
                              WHERE ur.role_code = r.code AND u.status <> 'disabled'), '[]'))
      ORDER BY r.is_system DESC, r.created_at, r.code) FROM iam.role r), '[]'),
    'permissions', coalesce((SELECT jsonb_agg(jsonb_build_object('code', p.code, 'description', p.description)
                                     ORDER BY p.code) FROM iam.permission p), '[]'));
END $$;

CREATE FUNCTION api.iam_change_list(p_status text DEFAULT 'pending') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM iam.require('iam.read');
  RETURN coalesce((SELECT jsonb_agg(iam._change_json(c) ORDER BY c.created_at DESC)
    FROM (SELECT * FROM iam.change
           WHERE p_status IS NULL
              OR (p_status = 'pending' AND status = 'pending' AND expires_at >= clock_timestamp())
              OR (p_status <> 'pending' AND status = p_status)
           ORDER BY created_at DESC LIMIT 200) c), '[]');
END $$;

-- ------------------------------------------------------------------ ask
CREATE FUNCTION api.iam_change_request(p_op text, p_target uuid, p_args jsonb, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('iam.manage'); why text := util.require_reason(p_reason);
        u iam.admin_user; r iam.role; args jsonb := coalesce(p_args, '{}'::jsonb);
        key text; lbl text; before jsonb; clean jsonb; v_roles text[]; v_perms text[];
        v_email text; v_name text; v_user text; v_code text; v_desc text; c iam.change;
BEGIN
  IF jsonb_typeof(args) <> 'object' THEN RAISE EXCEPTION 'args must be an object' USING ERRCODE = '22023'; END IF;
  IF p_op IN ('set_roles','reactivate','reset_login','rename') THEN
    SELECT * INTO u FROM iam.admin_user WHERE id = p_target;
    IF NOT FOUND THEN RAISE EXCEPTION 'unknown admin' USING ERRCODE = 'P0002'; END IF;
    IF u.id = a THEN RAISE EXCEPTION 'someone else must ask for changes to you' USING ERRCODE = '42501'; END IF;
    key := u.id::text; lbl := u.display_name || ' <' || u.email || '>';
  END IF;

  CASE p_op
  WHEN 'invite' THEN
    v_email := lower(btrim(coalesce(args->>'email', '')));
    v_name  := btrim(coalesce(args->>'display_name', ''));
    v_user  := lower(btrim(coalesce(args->>'username', '')));
    v_roles := iam._text_array(args->'roles', 'groups');
    IF v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' OR length(v_email) > 254 THEN RAISE EXCEPTION 'enter a valid email' USING ERRCODE = '22023'; END IF;
    IF length(v_name) NOT BETWEEN 2 AND 120 THEN RAISE EXCEPTION 'enter their name' USING ERRCODE = '22023'; END IF;
    IF v_user !~ '^[a-z0-9][a-z0-9._-]{2,39}$' THEN RAISE EXCEPTION 'username: 3-40 letters, digits, dot, dash or underscore' USING ERRCODE = '22023'; END IF;
    PERFORM iam._check_roles(v_roles);
    IF EXISTS (SELECT 1 FROM iam.admin_user WHERE lower(email) = v_email) THEN
      RAISE EXCEPTION 'that email is already on the team' USING ERRCODE = '23505';
    END IF;
    key := v_email; lbl := v_name || ' <' || v_email || '>';
    clean := jsonb_build_object('email', v_email, 'display_name', v_name, 'username', v_user, 'roles', to_jsonb(v_roles));
  WHEN 'set_roles' THEN
    v_roles := iam._text_array(args->'roles', 'groups');
    PERFORM iam._check_roles(v_roles);
    IF u.status = 'disabled' THEN RAISE EXCEPTION 'they are disabled; reactivate them first' USING ERRCODE = '22023'; END IF;
    before := jsonb_build_object('roles', iam._roles_of(u.id));
    IF before->'roles' = to_jsonb(v_roles) THEN RAISE EXCEPTION 'nothing would change' USING ERRCODE = '22023'; END IF;
    clean := jsonb_build_object('roles', to_jsonb(v_roles), 'version', u.version);
  WHEN 'reactivate' THEN
    IF u.status NOT IN ('suspended','disabled') THEN RAISE EXCEPTION 'only a suspended or disabled admin can be reactivated' USING ERRCODE = '22023'; END IF;
    before := jsonb_build_object('status', u.status);
    clean := jsonb_build_object('version', u.version);
  WHEN 'reset_login' THEN
    IF u.status = 'invited' THEN RAISE EXCEPTION 'they haven''t signed in yet: re-send the invitation instead' USING ERRCODE = '22023'; END IF;
    IF u.status = 'disabled' THEN RAISE EXCEPTION 'they are disabled' USING ERRCODE = '22023'; END IF;
    clean := jsonb_build_object('email', u.email, 'reset_mfa', coalesce((args->>'reset_mfa')::boolean, false));
  WHEN 'rename' THEN
    v_name := btrim(coalesce(args->>'display_name', ''));
    IF length(v_name) NOT BETWEEN 2 AND 120 THEN RAISE EXCEPTION 'enter their name' USING ERRCODE = '22023'; END IF;
    IF v_name = u.display_name THEN RAISE EXCEPTION 'nothing would change' USING ERRCODE = '22023'; END IF;
    before := jsonb_build_object('display_name', u.display_name);
    clean := jsonb_build_object('display_name', v_name, 'version', u.version);
  WHEN 'group_create', 'group_update' THEN
    v_code  := lower(btrim(coalesce(args->>'code', '')));
    v_name  := btrim(coalesce(args->>'label', ''));
    v_desc  := btrim(coalesce(args->>'description', ''));
    v_perms := iam._text_array(args->'permissions', 'permissions');
    IF length(v_name) NOT BETWEEN 2 AND 60 THEN RAISE EXCEPTION 'give the group a name of 2-60 characters' USING ERRCODE = '22023'; END IF;
    IF length(v_desc) NOT BETWEEN 1 AND 300 THEN RAISE EXCEPTION 'say what the group is for (up to 300 characters)' USING ERRCODE = '22023'; END IF;
    PERFORM iam._check_perms(v_perms);
    IF p_op = 'group_create' THEN
      IF v_code !~ '^[a-z][a-z_]{2,39}$' THEN RAISE EXCEPTION 'group key: 3-40 lowercase letters or underscores' USING ERRCODE = '22023'; END IF;
      IF EXISTS (SELECT 1 FROM iam.role WHERE code = v_code) THEN RAISE EXCEPTION 'that group key is taken' USING ERRCODE = '23505'; END IF;
    ELSE
      SELECT * INTO r FROM iam.role WHERE code = v_code;
      IF NOT FOUND THEN RAISE EXCEPTION 'unknown group' USING ERRCODE = 'P0002'; END IF;
      IF r.code = 'super_admin' THEN RAISE EXCEPTION 'super admin cannot be edited here' USING ERRCODE = '42501'; END IF;
      IF r.retired_at IS NOT NULL THEN RAISE EXCEPTION 'that group is retired' USING ERRCODE = '22023'; END IF;
      before := jsonb_build_object('label', r.label, 'description', r.description, 'permissions', iam._perms_of_role(r.code));
      IF before = jsonb_build_object('label', v_name, 'description', v_desc, 'permissions', to_jsonb(v_perms)) THEN
        RAISE EXCEPTION 'nothing would change' USING ERRCODE = '22023';
      END IF;
    END IF;
    key := v_code; lbl := v_name;
    clean := jsonb_build_object('code', v_code, 'label', v_name, 'description', v_desc, 'permissions', to_jsonb(v_perms));
  WHEN 'group_retire' THEN
    v_code := lower(btrim(coalesce(args->>'code', '')));
    SELECT * INTO r FROM iam.role WHERE code = v_code;
    IF NOT FOUND THEN RAISE EXCEPTION 'unknown group' USING ERRCODE = 'P0002'; END IF;
    IF r.is_system THEN RAISE EXCEPTION 'built-in groups cannot be retired' USING ERRCODE = '42501'; END IF;
    IF r.retired_at IS NOT NULL THEN RAISE EXCEPTION 'that group is already retired' USING ERRCODE = '22023'; END IF;
    IF EXISTS (SELECT 1 FROM iam.user_role WHERE role_code = r.code) THEN
      RAISE EXCEPTION 'move everyone out of the group first' USING ERRCODE = '22023';
    END IF;
    key := r.code; lbl := r.label;
    before := jsonb_build_object('permissions', iam._perms_of_role(r.code));
    clean := jsonb_build_object('code', r.code);
  ELSE
    RAISE EXCEPTION 'unknown change type' USING ERRCODE = '22023';
  END CASE;

  -- An expired request no longer blocks asking again.
  UPDATE iam.change SET status = 'expired', decided_at = clock_timestamp(), version = version + 1
   WHERE op = p_op AND target_key = key AND status = 'pending' AND expires_at < clock_timestamp();
  BEGIN
    INSERT INTO iam.change (op, target_user, target_key, target_label, args, before, reason, maker_id)
    VALUES (p_op, CASE WHEN p_op IN ('set_roles','reactivate','reset_login','rename') THEN u.id END,
            key, lbl, clean, before, why, a)
    RETURNING * INTO c;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'the same change is already waiting for approval' USING ERRCODE = '22023';
  END;
  PERFORM audit.record('iam.' || c.op || '.requested', 'iam_change', c.id::text, why, c.before, c.args);
  RETURN iam._change_json(c);
END $$;

-- ------------------------------------------------------------------ decide
CREATE FUNCTION iam._lock_change(p_id uuid, p_expected_version bigint) RETURNS iam.change
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $$
DECLARE c iam.change;
BEGIN
  SELECT * INTO c FROM iam.change WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'request not found' USING ERRCODE = 'P0002'; END IF;
  IF c.version <> p_expected_version THEN RAISE EXCEPTION 'request changed since it was opened' USING ERRCODE = '40001'; END IF;
  IF c.status <> 'pending' THEN RAISE EXCEPTION 'this request is already %', c.status USING ERRCODE = '22023'; END IF;
  RETURN c;
END $$;

-- The approval IS the change. Returns {change, apply}: apply tells the backend what ficium-auth
-- must do in the SAME transaction (create the login / reset the sign-in); if that fails the
-- backend rolls back and the request stays pending.
CREATE FUNCTION api.iam_change_approve(p_id uuid, p_expected_version bigint, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('iam.approve'); old iam.change := iam._lock_change(p_id, p_expected_version);
        c iam.change; u iam.admin_user; v_roles text[]; v_perms text[]; apply jsonb := NULL; nid uuid;
BEGIN
  IF old.maker_id = a THEN RAISE EXCEPTION 'four-eyes: you cannot approve your own request' USING ERRCODE = '42501'; END IF;
  IF old.target_user = a THEN RAISE EXCEPTION 'four-eyes: you cannot approve a change about yourself' USING ERRCODE = '42501'; END IF;
  IF old.expires_at < clock_timestamp() THEN RAISE EXCEPTION 'this request expired: ask again' USING ERRCODE = '22023'; END IF;

  IF old.target_user IS NOT NULL THEN
    SELECT * INTO u FROM iam.admin_user WHERE id = old.target_user FOR UPDATE;
    IF old.args ? 'version' AND u.version <> (old.args->>'version')::bigint THEN
      RAISE EXCEPTION 'this admin changed since the request was made: reject it and ask again' USING ERRCODE = '40001';
    END IF;
  END IF;

  CASE old.op
  WHEN 'invite' THEN
    IF EXISTS (SELECT 1 FROM iam.admin_user WHERE lower(email) = old.args->>'email') THEN
      RAISE EXCEPTION 'that email is already on the team' USING ERRCODE = '23505';
    END IF;
    v_roles := iam._text_array(old.args->'roles', 'groups');
    PERFORM iam._check_roles(v_roles);
    INSERT INTO iam.admin_user (email, display_name, created_by)
    VALUES (old.args->>'email', old.args->>'display_name', old.maker_id) RETURNING id INTO nid;
    INSERT INTO iam.user_role (user_id, role_code, granted_by) SELECT nid, x, a FROM unnest(v_roles) x;
    apply := jsonb_build_object('kind', 'provision', 'email', old.args->>'email', 'username', old.args->>'username', 'admin_id', nid);
  WHEN 'set_roles' THEN
    v_roles := iam._text_array(old.args->'roles', 'groups');
    PERFORM iam._check_roles(v_roles);
    IF u.status = 'disabled' THEN RAISE EXCEPTION 'they are disabled' USING ERRCODE = '22023'; END IF;
    IF NOT ('super_admin' = ANY (v_roles)) AND EXISTS (SELECT 1 FROM iam.user_role WHERE user_id = u.id AND role_code = 'super_admin') THEN
      PERFORM iam._keep_a_super_admin(u.id);
    END IF;
    DELETE FROM iam.user_role WHERE user_id = u.id AND role_code <> ALL (v_roles);
    INSERT INTO iam.user_role (user_id, role_code, granted_by) SELECT u.id, x, a FROM unnest(v_roles) x ON CONFLICT DO NOTHING;
    UPDATE iam.admin_user SET version = version + 1 WHERE id = u.id;
  WHEN 'reactivate' THEN
    IF u.status NOT IN ('suspended','disabled') THEN RAISE EXCEPTION 'they are not suspended or disabled any more' USING ERRCODE = '22023'; END IF;
    UPDATE iam.admin_user SET status = CASE WHEN auth_subject IS NULL THEN 'invited' ELSE 'active' END, version = version + 1 WHERE id = u.id;
  WHEN 'reset_login' THEN
    IF u.status NOT IN ('active','suspended') THEN RAISE EXCEPTION 'they cannot be reset now (%)', u.status USING ERRCODE = '22023'; END IF;
    UPDATE iam.admin_user SET version = version + 1 WHERE id = u.id;
    apply := jsonb_build_object('kind', 'reset', 'email', u.email, 'reset_mfa', coalesce((old.args->>'reset_mfa')::boolean, false));
  WHEN 'rename' THEN
    UPDATE iam.admin_user SET display_name = old.args->>'display_name', version = version + 1 WHERE id = u.id;
  WHEN 'group_create' THEN
    IF EXISTS (SELECT 1 FROM iam.role WHERE code = old.args->>'code') THEN RAISE EXCEPTION 'that group key is taken' USING ERRCODE = '23505'; END IF;
    v_perms := iam._text_array(old.args->'permissions', 'permissions');
    PERFORM iam._check_perms(v_perms);
    INSERT INTO iam.role (code, label, description, is_system, created_by)
    VALUES (old.args->>'code', old.args->>'label', old.args->>'description', false, old.maker_id);
    INSERT INTO iam.role_permission (role_code, permission_code) SELECT old.args->>'code', x FROM unnest(v_perms) x;
  WHEN 'group_update' THEN
    IF jsonb_build_object('label', (SELECT label FROM iam.role WHERE code = old.target_key),
                          'description', (SELECT description FROM iam.role WHERE code = old.target_key),
                          'permissions', iam._perms_of_role(old.target_key)) IS DISTINCT FROM old.before THEN
      RAISE EXCEPTION 'this group changed since the request was made: reject it and ask again' USING ERRCODE = '40001';
    END IF;
    v_perms := iam._text_array(old.args->'permissions', 'permissions');
    PERFORM iam._check_perms(v_perms);
    UPDATE iam.role SET label = old.args->>'label', description = old.args->>'description' WHERE code = old.target_key;
    DELETE FROM iam.role_permission WHERE role_code = old.target_key AND permission_code <> ALL (v_perms);
    INSERT INTO iam.role_permission (role_code, permission_code) SELECT old.target_key, x FROM unnest(v_perms) x ON CONFLICT DO NOTHING;
  WHEN 'group_retire' THEN
    IF EXISTS (SELECT 1 FROM iam.user_role WHERE role_code = old.target_key) THEN
      RAISE EXCEPTION 'someone was added to the group since: move them out first' USING ERRCODE = '22023';
    END IF;
    DELETE FROM iam.role_permission WHERE role_code = old.target_key;
    UPDATE iam.role SET retired_at = clock_timestamp() WHERE code = old.target_key;
  END CASE;

  UPDATE iam.change SET status = 'approved', checker_id = a, decided_at = clock_timestamp(),
         decision_note = nullif(btrim(coalesce(p_note, '')), ''), version = version + 1,
         result = CASE WHEN apply IS NULL THEN '{"applied":true}'::jsonb END
   WHERE id = old.id RETURNING * INTO c;
  PERFORM audit.record('iam.' || c.op || '.approved', 'iam_change', c.id::text, c.decision_note, c.before, c.args);
  RETURN jsonb_build_object('change', iam._change_json(c), 'apply', apply);
END $$;

-- What ficium-auth answered (created / existing / reset, email sent or not). Approver only, once.
CREATE FUNCTION api.iam_change_record_result(p_id uuid, p_result jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.current_admin(); c iam.change;
BEGIN
  UPDATE iam.change SET result = p_result, version = version + 1
   WHERE id = p_id AND status = 'approved' AND checker_id = a AND result IS NULL
  RETURNING * INTO c;
  IF NOT FOUND THEN RAISE EXCEPTION 'nothing to record for this request' USING ERRCODE = '22023'; END IF;
  PERFORM audit.record('iam.' || c.op || '.applied', 'iam_change', c.id::text, NULL, NULL, p_result);
  RETURN iam._change_json(c);
END $$;

CREATE FUNCTION api.iam_change_reject(p_id uuid, p_expected_version bigint, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('iam.approve'); old iam.change := iam._lock_change(p_id, p_expected_version);
        why text := util.require_reason(p_note); c iam.change;
BEGIN
  IF old.maker_id = a THEN RAISE EXCEPTION 'withdraw your own request instead of rejecting it' USING ERRCODE = '42501'; END IF;
  UPDATE iam.change SET status = 'rejected', checker_id = a, decided_at = clock_timestamp(), decision_note = why,
         version = version + 1 WHERE id = old.id RETURNING * INTO c;
  PERFORM audit.record('iam.' || c.op || '.rejected', 'iam_change', c.id::text, why, NULL, NULL);
  RETURN iam._change_json(c);
END $$;

CREATE FUNCTION api.iam_change_cancel(p_id uuid, p_expected_version bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.current_admin(); old iam.change := iam._lock_change(p_id, p_expected_version); c iam.change;
BEGIN
  IF old.maker_id <> a THEN RAISE EXCEPTION 'only the person who asked can withdraw it' USING ERRCODE = '42501'; END IF;
  UPDATE iam.change SET status = 'cancelled', decided_at = clock_timestamp(), version = version + 1
   WHERE id = old.id RETURNING * INTO c;
  PERFORM audit.record('iam.' || c.op || '.withdrawn', 'iam_change', c.id::text, NULL, NULL, NULL);
  RETURN iam._change_json(c);
END $$;

-- ------------------------------------------------------------------ immediate removal
-- Suspend / disable stay one-person and immediate. Reactivation now goes through the queue.
CREATE OR REPLACE FUNCTION api.iam_set_status(p_user uuid, p_status text, p_expected_version bigint, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('iam.manage'); old iam.admin_user; u iam.admin_user; r text := util.require_reason(p_reason);
BEGIN
  IF p_user = a THEN RAISE EXCEPTION 'you cannot change your own status' USING ERRCODE = '42501'; END IF;
  IF p_status = 'active' THEN
    RAISE EXCEPTION 'reactivating needs a second admin: ask for it instead' USING ERRCODE = '22023';
  END IF;
  IF p_status NOT IN ('suspended','disabled') THEN RAISE EXCEPTION 'invalid status' USING ERRCODE = '22023'; END IF;
  SELECT * INTO old FROM iam.admin_user WHERE id = p_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown admin' USING ERRCODE = 'P0002'; END IF;
  IF old.status = 'active' AND EXISTS (SELECT 1 FROM iam.user_role WHERE user_id = p_user AND role_code = 'super_admin') THEN
    PERFORM iam._keep_a_super_admin(p_user);
  END IF;
  UPDATE iam.admin_user SET status = p_status, version = version + 1
   WHERE id = p_user AND version = p_expected_version RETURNING * INTO u;
  IF NOT FOUND THEN RAISE EXCEPTION 'admin changed since you opened it, or does not exist' USING ERRCODE = '40001'; END IF;
  -- Anything still waiting about them is moot once they are cut off.
  UPDATE iam.change SET status = 'cancelled', decided_at = clock_timestamp(), version = version + 1,
         decision_note = 'cancelled: admin was ' || p_status
   WHERE target_user = p_user AND status = 'pending' AND op <> 'reactivate';
  PERFORM audit.record('iam.status_changed', 'admin_user', p_user::text, r,
                       jsonb_build_object('status', old.status), jsonb_build_object('status', u.status));
  RETURN to_jsonb(u);
END $$;

-- ------------------------------------------------------------------ grants
REVOKE ALL ON iam.change FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION api.iam_invite(text, text, text[], text),
                           api.iam_set_roles(uuid, text[], bigint, text) FROM portal_admin_api;
REVOKE EXECUTE ON FUNCTION
  iam._roles_of(uuid), iam._perms_of_role(text), iam._text_array(jsonb, text), iam._check_roles(text[]),
  iam._check_perms(text[]), iam._keep_a_super_admin(uuid), iam._change_json(iam.change),
  iam._lock_change(uuid, bigint),
  api.iam_me(), api.iam_groups(), api.iam_change_list(text), api.iam_change_request(text, uuid, jsonb, text),
  api.iam_change_approve(uuid, bigint, text), api.iam_change_record_result(uuid, jsonb),
  api.iam_change_reject(uuid, bigint, text), api.iam_change_cancel(uuid, bigint)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  api.iam_me(), api.iam_groups(), api.iam_change_list(text), api.iam_change_request(text, uuid, jsonb, text),
  api.iam_change_approve(uuid, bigint, text), api.iam_change_record_result(uuid, jsonb),
  api.iam_change_reject(uuid, bigint, text), api.iam_change_cancel(uuid, bigint)
  TO portal_admin_api;
GRANT SELECT ON iam.change TO portal_admin_readonly;
