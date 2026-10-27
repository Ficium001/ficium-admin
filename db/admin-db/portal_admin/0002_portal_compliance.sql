-- 0002_portal_compliance.sql — institution-portal administration: compliance.
--
-- This database is the master for the ADMIN side of compliance only: who asked
-- for what, who approved it, and what portal-api answered. Bank data (banks,
-- documents, the compliance gate itself) stays in the Portal DB and is reached
-- ONLY through portal-api's signed /internal/admin/v1 endpoints. Nothing here
-- connects to another database.
--
-- Flow for a change (one admin-DB transaction around one HTTPS call):
--   *_prepare / *_approve  -> validated here, returns the command to send
--   backend calls portal-api /internal/admin/v1/commands (idempotent by command_id)
--   *_record_result        -> stores portal-api's answer
--   commit. If portal-api refuses or is down, the transaction rolls back and
--   nothing is recorded as done on either side.
SET LOCAL ROLE portal_admin_owner;
SET LOCAL search_path = pg_catalog;

CREATE SCHEMA compliance;

-- ------------------------------------------------------------ permissions
INSERT INTO iam.permission (code, description) VALUES
  ('compliance.read',    'View banks'' compliance status and documents'),
  ('compliance.review',  'Approve or reject a bank''s compliance document'),
  ('compliance.request', 'Ask for a compliance waiver to be granted or revoked'),
  ('compliance.approve', 'Approve or reject a waiver request (never your own)');

INSERT INTO iam.role_permission (role_code, permission_code) VALUES
  ('super_admin','compliance.read'), ('super_admin','compliance.review'),
  ('super_admin','compliance.request'), ('super_admin','compliance.approve'),
  ('compliance','compliance.read'), ('compliance','compliance.review'),
  ('compliance','compliance.request'), ('compliance','compliance.approve'),
  ('operations','compliance.read'), ('operations','compliance.request'),
  ('read_only','compliance.read');

-- The ficium-auth user id of an admin, as portal-api knows it. Only ficium-auth
-- identities may act on the portal (a dev or Cloudflare identity cannot).
CREATE FUNCTION iam.portal_subject(p_admin uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE s text;
BEGIN
  SELECT auth_subject INTO s FROM iam.admin_user WHERE id = p_admin;
  IF s IS NULL OR s !~ '^ficium-auth:[0-9a-f-]{36}$' THEN
    RAISE EXCEPTION 'this admin is not signed in with a Ficium account' USING ERRCODE = '42501';
  END IF;
  RETURN substr(s, 13)::uuid;
END $$;

-- ---------------------------------------------------- waiver requests (4-eyes)
CREATE TABLE compliance.waiver_request (
  id               uuid PRIMARY KEY DEFAULT util.uuid_v7(),   -- also the portal command_id
  institution_id   uuid NOT NULL,
  institution_name text NOT NULL CHECK (length(btrim(institution_name)) BETWEEN 1 AND 200),
  action           text NOT NULL CHECK (action IN ('grant','revoke')),
  waived_until     timestamptz,
  reason           text NOT NULL,
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','approved','rejected','cancelled')),
  maker_id         uuid NOT NULL REFERENCES iam.admin_user(id),
  checker_id       uuid REFERENCES iam.admin_user(id),
  decision_note    text,
  decided_at       timestamptz,
  result           jsonb,
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  version          bigint NOT NULL DEFAULT 1,
  CHECK ((action = 'grant') = (waived_until IS NOT NULL)),
  CHECK (checker_id IS NULL OR checker_id <> maker_id),
  CHECK ((status = 'pending') = (decided_at IS NULL))
);
-- One open request per bank at a time: no racing grants and revokes.
CREATE UNIQUE INDEX waiver_request_one_pending ON compliance.waiver_request (institution_id)
  WHERE status = 'pending';
CREATE INDEX waiver_request_status_idx ON compliance.waiver_request (status, created_at DESC);

CREATE FUNCTION compliance._waiver_json(r compliance.waiver_request) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT to_jsonb(r) || jsonb_build_object(
    'maker_email',   (SELECT email FROM iam.admin_user WHERE id = r.maker_id),
    'checker_email', (SELECT email FROM iam.admin_user WHERE id = r.checker_id))
$$;

CREATE FUNCTION compliance._lock(p_id uuid, p_expected_version bigint) RETURNS compliance.waiver_request
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $$
DECLARE r compliance.waiver_request;
BEGIN
  SELECT * INTO r FROM compliance.waiver_request WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'waiver request not found' USING ERRCODE = 'P0002'; END IF;
  IF r.version <> p_expected_version THEN
    RAISE EXCEPTION 'waiver request changed since it was opened' USING ERRCODE = '40001';
  END IF;
  RETURN r;
END $$;

CREATE FUNCTION api.waiver_request_create(p_institution_id uuid, p_institution_name text,
  p_action text, p_waived_until timestamptz, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('compliance.request'); r compliance.waiver_request;
        why text := util.require_reason(p_reason);
BEGIN
  PERFORM iam.portal_subject(a);
  IF p_action NOT IN ('grant','revoke') THEN
    RAISE EXCEPTION 'action must be grant or revoke' USING ERRCODE = '22023';
  END IF;
  IF p_action = 'grant' AND (p_waived_until IS NULL OR p_waived_until <= clock_timestamp()
       OR p_waived_until > clock_timestamp() + interval '180 days') THEN
    RAISE EXCEPTION 'a waiver must end in the future and last at most 180 days' USING ERRCODE = '22023';
  END IF;
  BEGIN
    INSERT INTO compliance.waiver_request (institution_id, institution_name, action, waived_until, reason, maker_id)
    VALUES (p_institution_id, btrim(p_institution_name), p_action,
            CASE WHEN p_action = 'grant' THEN p_waived_until END, why, a)
    RETURNING * INTO r;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'this bank already has a waiver request waiting for approval' USING ERRCODE = '22023';
  END;
  PERFORM audit.record('waiver.requested', 'institution', p_institution_id::text, why, NULL, to_jsonb(r));
  RETURN compliance._waiver_json(r);
END $$;

CREATE FUNCTION api.waiver_request_list(p_status text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM iam.require('compliance.read');
  RETURN coalesce((
    SELECT jsonb_agg(compliance._waiver_json(r) ORDER BY r.created_at DESC)
      FROM (SELECT * FROM compliance.waiver_request
             WHERE p_status IS NULL OR status = p_status
             ORDER BY created_at DESC LIMIT 200) r), '[]'::jsonb);
END $$;

-- Approve: decided here, delivered by the backend in the same transaction.
CREATE FUNCTION api.waiver_request_approve(p_id uuid, p_expected_version bigint, p_note text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('compliance.approve'); old compliance.waiver_request;
        r compliance.waiver_request;
BEGIN
  PERFORM iam.portal_subject(a);
  old := compliance._lock(p_id, p_expected_version);
  IF old.status <> 'pending' THEN RAISE EXCEPTION 'only a pending request can be approved' USING ERRCODE = '22023'; END IF;
  IF old.maker_id = a THEN
    RAISE EXCEPTION 'four-eyes: you cannot approve your own request' USING ERRCODE = '42501';
  END IF;
  IF old.action = 'grant' AND old.waived_until <= clock_timestamp() THEN
    RAISE EXCEPTION 'the requested waiver end date has already passed' USING ERRCODE = '22023';
  END IF;
  UPDATE compliance.waiver_request
     SET status = 'approved', checker_id = a, decided_at = clock_timestamp(),
         decision_note = nullif(btrim(coalesce(p_note, '')), ''), version = version + 1
   WHERE id = p_id RETURNING * INTO r;
  PERFORM audit.record('waiver.approved', 'institution', r.institution_id::text, r.decision_note,
                       to_jsonb(old), to_jsonb(r));
  RETURN jsonb_build_object(
    'request', compliance._waiver_json(r),
    'command', jsonb_build_object(
      'op', 'waiver.' || r.action,
      'command_id', r.id,
      'maker_sub', iam.portal_subject(r.maker_id),
      'args', jsonb_strip_nulls(jsonb_build_object(
        'institution_id', r.institution_id, 'reason', r.reason, 'waived_until', r.waived_until))));
END $$;

CREATE FUNCTION api.waiver_request_record_result(p_id uuid, p_result jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('compliance.approve'); r compliance.waiver_request;
BEGIN
  UPDATE compliance.waiver_request SET result = p_result, version = version + 1
   WHERE id = p_id AND status = 'approved' AND checker_id = a AND result IS NULL
  RETURNING * INTO r;
  IF NOT FOUND THEN RAISE EXCEPTION 'nothing to record for this request' USING ERRCODE = '22023'; END IF;
  PERFORM audit.record('waiver.applied', 'institution', r.institution_id::text, NULL, NULL, p_result);
  RETURN compliance._waiver_json(r);
END $$;

CREATE FUNCTION api.waiver_request_reject(p_id uuid, p_expected_version bigint, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('compliance.approve'); old compliance.waiver_request;
        r compliance.waiver_request; why text := util.require_reason(p_note);
BEGIN
  old := compliance._lock(p_id, p_expected_version);
  IF old.status <> 'pending' THEN RAISE EXCEPTION 'only a pending request can be rejected' USING ERRCODE = '22023'; END IF;
  IF old.maker_id = a THEN
    RAISE EXCEPTION 'withdraw your own request instead of rejecting it' USING ERRCODE = '42501';
  END IF;
  UPDATE compliance.waiver_request
     SET status = 'rejected', checker_id = a, decided_at = clock_timestamp(), decision_note = why,
         version = version + 1
   WHERE id = p_id RETURNING * INTO r;
  PERFORM audit.record('waiver.rejected', 'institution', r.institution_id::text, why, to_jsonb(old), to_jsonb(r));
  RETURN compliance._waiver_json(r);
END $$;

CREATE FUNCTION api.waiver_request_cancel(p_id uuid, p_expected_version bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('compliance.request'); old compliance.waiver_request;
        r compliance.waiver_request;
BEGIN
  old := compliance._lock(p_id, p_expected_version);
  IF old.status <> 'pending' THEN RAISE EXCEPTION 'only a pending request can be withdrawn' USING ERRCODE = '22023'; END IF;
  IF old.maker_id <> a THEN RAISE EXCEPTION 'only the person who asked can withdraw it' USING ERRCODE = '42501'; END IF;
  UPDATE compliance.waiver_request
     SET status = 'cancelled', decided_at = clock_timestamp(), version = version + 1
   WHERE id = p_id RETURNING * INTO r;
  PERFORM audit.record('waiver.withdrawn', 'institution', r.institution_id::text, NULL, to_jsonb(old), to_jsonb(r));
  RETURN compliance._waiver_json(r);
END $$;

-- ------------------------------------------------- document reviews (1 person)
-- Reviewing a bank's upload is itself the check, so one reviewer decides.
CREATE TABLE compliance.document_review (
  command_id     uuid PRIMARY KEY DEFAULT util.uuid_v7(),
  doc_id         uuid NOT NULL,
  institution_id uuid NOT NULL,
  decision       text NOT NULL CHECK (decision IN ('approve','reject')),
  reason         text,
  expiry_date    date,
  reviewer_id    uuid NOT NULL REFERENCES iam.admin_user(id),
  result         jsonb,
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (decision = 'approve' OR length(btrim(coalesce(reason, ''))) >= 5)
);
CREATE INDEX document_review_doc_idx ON compliance.document_review (doc_id, created_at DESC);

CREATE FUNCTION api.document_review_prepare(p_doc_id uuid, p_institution_id uuid, p_decision text,
  p_reason text, p_expiry_date date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('compliance.review'); d compliance.document_review;
BEGIN
  IF p_decision NOT IN ('approve','reject') THEN
    RAISE EXCEPTION 'decision must be approve or reject' USING ERRCODE = '22023';
  END IF;
  IF p_decision = 'reject' AND length(btrim(coalesce(p_reason, ''))) < 5 THEN
    RAISE EXCEPTION 'say why the document is rejected' USING ERRCODE = '22023';
  END IF;
  INSERT INTO compliance.document_review (doc_id, institution_id, decision, reason, expiry_date, reviewer_id)
  VALUES (p_doc_id, p_institution_id, p_decision, nullif(btrim(coalesce(p_reason, '')), ''), p_expiry_date, a)
  RETURNING * INTO d;
  RETURN jsonb_build_object(
    'op', 'document.review', 'command_id', d.command_id, 'maker_sub', iam.portal_subject(a),
    'args', jsonb_strip_nulls(jsonb_build_object(
      'doc_id', d.doc_id, 'decision', d.decision, 'rejection_reason', d.reason,
      'expiry_date', d.expiry_date)));
END $$;

CREATE FUNCTION api.document_review_record_result(p_command_id uuid, p_result jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('compliance.review'); d compliance.document_review;
BEGIN
  UPDATE compliance.document_review SET result = p_result
   WHERE command_id = p_command_id AND reviewer_id = a AND result IS NULL
  RETURNING * INTO d;
  IF NOT FOUND THEN RAISE EXCEPTION 'nothing to record for this review' USING ERRCODE = '22023'; END IF;
  PERFORM audit.record('document.' || CASE d.decision WHEN 'approve' THEN 'approved' ELSE 'rejected' END,
                       'institution_doc', d.doc_id::text, d.reason, NULL,
                       to_jsonb(d) || jsonb_build_object('institution_id', d.institution_id));
END $$;

-- ------------------------------------------------------------- grants
REVOKE ALL ON ALL TABLES IN SCHEMA compliance FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA compliance, api FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION iam.portal_subject(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  api.waiver_request_create(uuid, text, text, timestamptz, text),
  api.waiver_request_list(text),
  api.waiver_request_approve(uuid, bigint, text),
  api.waiver_request_record_result(uuid, jsonb),
  api.waiver_request_reject(uuid, bigint, text),
  api.waiver_request_cancel(uuid, bigint),
  api.document_review_prepare(uuid, uuid, text, text, date),
  api.document_review_record_result(uuid, jsonb)
  TO portal_admin_api;
GRANT USAGE ON SCHEMA compliance TO portal_admin_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA compliance TO portal_admin_readonly;
