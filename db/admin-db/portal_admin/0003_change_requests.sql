-- 0003_change_requests.sql — one four-eyes workflow for every portal change.
--
-- Each change the portal admin site can make to the portal is an "op" (the
-- same name portal-api uses on /internal/admin/v1/commands). governance.op
-- says which permission may ask for it and which may approve it. A request is
-- created by one admin and approved by a DIFFERENT admin; on approval this
-- returns the command for the backend to send to portal-api in the same
-- transaction, and *_record_result stores portal-api's answer. New modules add
-- rows to governance.op instead of new tables.
SET LOCAL ROLE portal_admin_owner;
SET LOCAL search_path = pg_catalog;

CREATE SCHEMA governance;

INSERT INTO iam.permission (code, description) VALUES
  ('institutions.read',    'View banks, their status and modules'),
  ('institutions.request', 'Ask for a bank to be approved, suspended or have its modules changed'),
  ('institutions.approve', 'Approve or reject a bank change (never your own)');

INSERT INTO iam.role_permission (role_code, permission_code) VALUES
  ('super_admin','institutions.read'), ('super_admin','institutions.request'), ('super_admin','institutions.approve'),
  ('compliance','institutions.read'),  ('compliance','institutions.approve'),
  ('operations','institutions.read'),  ('operations','institutions.request'),
  ('read_only','institutions.read');

CREATE TABLE governance.op (
  op                 text PRIMARY KEY CHECK (op ~ '^[a-z_]+\.[a-z_]+$'),
  request_permission text NOT NULL REFERENCES iam.permission(code),
  approve_permission text NOT NULL REFERENCES iam.permission(code),
  read_permission    text NOT NULL REFERENCES iam.permission(code),
  description        text NOT NULL
);

INSERT INTO governance.op (op, request_permission, approve_permission, read_permission, description) VALUES
  ('institution.approve', 'institutions.request', 'institutions.approve', 'institutions.read', 'Approve (or reinstate) a bank'),
  ('institution.suspend', 'institutions.request', 'institutions.approve', 'institutions.read', 'Suspend a bank'),
  ('entitlement.set',     'institutions.request', 'institutions.approve', 'institutions.read', 'Grant, change or suspend a bank''s module');

CREATE TABLE governance.change_request (
  id            uuid PRIMARY KEY DEFAULT util.uuid_v7(),   -- also the portal command_id
  op            text NOT NULL REFERENCES governance.op(op),
  target_key    text NOT NULL CHECK (length(target_key) BETWEEN 1 AND 200),
  target_label  text NOT NULL CHECK (length(btrim(target_label)) BETWEEN 1 AND 200),
  args          jsonb NOT NULL CHECK (jsonb_typeof(args) = 'object' AND pg_column_size(args) < 8000),
  reason        text NOT NULL,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','approved','rejected','cancelled')),
  maker_id      uuid NOT NULL REFERENCES iam.admin_user(id),
  checker_id    uuid REFERENCES iam.admin_user(id),
  decision_note text,
  decided_at    timestamptz,
  result        jsonb,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  version       bigint NOT NULL DEFAULT 1,
  CHECK (checker_id IS NULL OR checker_id <> maker_id),
  CHECK ((status = 'pending') = (decided_at IS NULL))
);
-- One open request per op and target: no racing approve/suspend of the same bank.
CREATE UNIQUE INDEX change_request_one_pending ON governance.change_request (op, target_key)
  WHERE status = 'pending';
CREATE INDEX change_request_status_idx ON governance.change_request (status, created_at DESC);

CREATE FUNCTION governance._json(r governance.change_request) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT to_jsonb(r) || jsonb_build_object(
    'maker_email',   (SELECT email FROM iam.admin_user WHERE id = r.maker_id),
    'checker_email', (SELECT email FROM iam.admin_user WHERE id = r.checker_id))
$$;

CREATE FUNCTION governance._lock(p_id uuid, p_expected_version bigint) RETURNS governance.change_request
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $$
DECLARE r governance.change_request;
BEGIN
  SELECT * INTO r FROM governance.change_request WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'change request not found' USING ERRCODE = 'P0002'; END IF;
  IF r.version <> p_expected_version THEN
    RAISE EXCEPTION 'change request changed since it was opened' USING ERRCODE = '40001';
  END IF;
  RETURN r;
END $$;

CREATE FUNCTION governance._op(p_op text) RETURNS governance.op
LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE o governance.op;
BEGIN
  SELECT * INTO o FROM governance.op WHERE op = p_op;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown change type' USING ERRCODE = '22023'; END IF;
  RETURN o;
END $$;

CREATE FUNCTION api.change_request_create(p_op text, p_target_key text, p_target_label text,
  p_args jsonb, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE o governance.op := governance._op(p_op); a uuid; r governance.change_request;
        why text := util.require_reason(p_reason);
BEGIN
  a := iam.require(o.request_permission);
  PERFORM iam.portal_subject(a);
  BEGIN
    INSERT INTO governance.change_request (op, target_key, target_label, args, reason, maker_id)
    VALUES (p_op, p_target_key, btrim(p_target_label), coalesce(p_args, '{}'::jsonb), why, a)
    RETURNING * INTO r;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'the same change is already waiting for approval' USING ERRCODE = '22023';
  END;
  PERFORM audit.record(r.op || '.requested', 'change_request', r.id::text, why, NULL, to_jsonb(r));
  RETURN governance._json(r);
END $$;

-- Only requests whose op the caller may read, ask for or approve.
CREATE FUNCTION api.change_request_list(p_status text DEFAULT NULL, p_op_prefix text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.current_admin();
BEGIN
  RETURN coalesce((
    SELECT jsonb_agg(governance._json(r) ORDER BY r.created_at DESC)
      FROM (SELECT c.* FROM governance.change_request c JOIN governance.op o ON o.op = c.op
             WHERE (p_status IS NULL OR c.status = p_status)
               AND (p_op_prefix IS NULL OR c.op LIKE p_op_prefix || '%')
               AND (iam.has_permission(a, o.read_permission) OR iam.has_permission(a, o.request_permission)
                    OR iam.has_permission(a, o.approve_permission))
             ORDER BY c.created_at DESC LIMIT 200) r), '[]'::jsonb);
END $$;

CREATE FUNCTION api.change_request_approve(p_id uuid, p_expected_version bigint, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE old governance.change_request; r governance.change_request; o governance.op; a uuid;
BEGIN
  old := governance._lock(p_id, p_expected_version);
  o := governance._op(old.op);
  a := iam.require(o.approve_permission);
  PERFORM iam.portal_subject(a);
  IF old.status <> 'pending' THEN RAISE EXCEPTION 'only a pending request can be approved' USING ERRCODE = '22023'; END IF;
  IF old.maker_id = a THEN
    RAISE EXCEPTION 'four-eyes: you cannot approve your own request' USING ERRCODE = '42501';
  END IF;
  UPDATE governance.change_request
     SET status = 'approved', checker_id = a, decided_at = clock_timestamp(),
         decision_note = nullif(btrim(coalesce(p_note, '')), ''), version = version + 1
   WHERE id = p_id RETURNING * INTO r;
  PERFORM audit.record(r.op || '.approved', 'change_request', r.id::text, r.decision_note, to_jsonb(old), to_jsonb(r));
  RETURN jsonb_build_object(
    'request', governance._json(r),
    'command', jsonb_build_object('op', r.op, 'command_id', r.id,
                                  'maker_sub', iam.portal_subject(r.maker_id), 'args', r.args));
END $$;

CREATE FUNCTION api.change_request_record_result(p_id uuid, p_result jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.current_admin(); r governance.change_request;
BEGIN
  UPDATE governance.change_request SET result = p_result, version = version + 1
   WHERE id = p_id AND status = 'approved' AND checker_id = a AND result IS NULL
  RETURNING * INTO r;
  IF NOT FOUND THEN RAISE EXCEPTION 'nothing to record for this request' USING ERRCODE = '22023'; END IF;
  PERFORM audit.record(r.op || '.applied', 'change_request', r.id::text, NULL, NULL, p_result);
  RETURN governance._json(r);
END $$;

CREATE FUNCTION api.change_request_reject(p_id uuid, p_expected_version bigint, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE old governance.change_request; r governance.change_request; a uuid;
        why text := util.require_reason(p_note);
BEGIN
  old := governance._lock(p_id, p_expected_version);
  a := iam.require((governance._op(old.op)).approve_permission);
  IF old.status <> 'pending' THEN RAISE EXCEPTION 'only a pending request can be rejected' USING ERRCODE = '22023'; END IF;
  IF old.maker_id = a THEN
    RAISE EXCEPTION 'withdraw your own request instead of rejecting it' USING ERRCODE = '42501';
  END IF;
  UPDATE governance.change_request
     SET status = 'rejected', checker_id = a, decided_at = clock_timestamp(), decision_note = why,
         version = version + 1
   WHERE id = p_id RETURNING * INTO r;
  PERFORM audit.record(r.op || '.rejected', 'change_request', r.id::text, why, to_jsonb(old), to_jsonb(r));
  RETURN governance._json(r);
END $$;

CREATE FUNCTION api.change_request_cancel(p_id uuid, p_expected_version bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE old governance.change_request; r governance.change_request; a uuid := iam.current_admin();
BEGIN
  old := governance._lock(p_id, p_expected_version);
  IF old.status <> 'pending' THEN RAISE EXCEPTION 'only a pending request can be withdrawn' USING ERRCODE = '22023'; END IF;
  IF old.maker_id <> a THEN RAISE EXCEPTION 'only the person who asked can withdraw it' USING ERRCODE = '42501'; END IF;
  UPDATE governance.change_request
     SET status = 'cancelled', decided_at = clock_timestamp(), version = version + 1
   WHERE id = p_id RETURNING * INTO r;
  PERFORM audit.record(r.op || '.withdrawn', 'change_request', r.id::text, NULL, to_jsonb(old), to_jsonb(r));
  RETURN governance._json(r);
END $$;

-- ------------------------------------------------------------- grants
REVOKE ALL ON ALL TABLES IN SCHEMA governance FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA governance, api FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  api.change_request_create(text, text, text, jsonb, text),
  api.change_request_list(text, text),
  api.change_request_approve(uuid, bigint, text),
  api.change_request_record_result(uuid, jsonb),
  api.change_request_reject(uuid, bigint, text),
  api.change_request_cancel(uuid, bigint)
  TO portal_admin_api;
GRANT USAGE ON SCHEMA governance TO portal_admin_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA governance TO portal_admin_readonly;
