-- 0007_applications.sql — institution applications, reviewed and provisioned from this site.
--
-- KJ (2026-11-13): an institution no longer registers itself in the portal; it
-- APPLIES (portal-api db/060, institution.access_request). The application lives
-- in the Portal DB; this database holds who reviewed it and the four-eyes
-- provisioning request, with their audit, like every other portal change.
--
--   access_request.review   one person: in_review | info_requested | approved | rejected
--                           (the review is the check; nothing is created)
--   institution.provision   four-eyes op on the existing change_request workflow:
--                           after the contract, creates the bank and its first admin
--                           login in portal-api; the invite is then emailed by ficium-auth
SET LOCAL ROLE portal_admin_owner;
SET LOCAL search_path = pg_catalog;

CREATE SCHEMA applications;

INSERT INTO iam.permission (code, description) VALUES
  ('applications.read',   'View institution applications'),
  ('applications.review', 'Move an application to review, ask for information, approve or reject it');

INSERT INTO iam.role_permission (role_code, permission_code) VALUES
  ('super_admin','applications.read'), ('super_admin','applications.review'),
  ('compliance','applications.read'),  ('compliance','applications.review'),
  ('operations','applications.read'),  ('operations','applications.review'),
  ('read_only','applications.read');

-- Provisioning creates a bank: same people as approving a bank, never the person who asked.
INSERT INTO governance.op (op, request_permission, approve_permission, read_permission, description) VALUES
  ('institution.provision', 'institutions.request', 'institutions.approve', 'applications.read',
   'Create a bank and its first admin from an approved application (after the contract)');

-- ------------------------------------------------------ reviews (1 person)
CREATE TABLE applications.review (
  command_id   uuid PRIMARY KEY DEFAULT util.uuid_v7(),
  request_id   uuid NOT NULL,
  reference    text NOT NULL CHECK (length(btrim(reference)) BETWEEN 1 AND 40),
  decision     text NOT NULL CHECK (decision IN ('in_review','info_requested','approved','rejected')),
  note         text CHECK (length(note) <= 500),
  reviewer_id  uuid NOT NULL REFERENCES iam.admin_user(id),
  result       jsonb,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (decision NOT IN ('info_requested','rejected') OR length(btrim(coalesce(note, ''))) >= 10)
);
CREATE INDEX review_request_idx ON applications.review (request_id, created_at DESC);

CREATE FUNCTION api.application_review_prepare(p_request_id uuid, p_reference text,
  p_decision text, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('applications.review'); d applications.review;
BEGIN
  IF p_decision NOT IN ('in_review','info_requested','approved','rejected') THEN
    RAISE EXCEPTION 'decision must be in_review, info_requested, approved or rejected' USING ERRCODE = '22023';
  END IF;
  IF p_decision IN ('info_requested','rejected') AND length(btrim(coalesce(p_note, ''))) < 10 THEN
    RAISE EXCEPTION 'say why, in at least 10 characters' USING ERRCODE = '22023';
  END IF;
  INSERT INTO applications.review (request_id, reference, decision, note, reviewer_id)
  VALUES (p_request_id, btrim(p_reference), p_decision, nullif(btrim(coalesce(p_note, '')), ''), a)
  RETURNING * INTO d;
  RETURN jsonb_build_object(
    'op', 'access_request.review', 'command_id', d.command_id, 'maker_sub', iam.portal_subject(a),
    'args', jsonb_strip_nulls(jsonb_build_object(
      'request_id', d.request_id, 'status', d.decision, 'note', d.note)));
END $$;

CREATE FUNCTION api.application_review_record_result(p_command_id uuid, p_result jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('applications.review'); d applications.review;
BEGIN
  UPDATE applications.review SET result = p_result
   WHERE command_id = p_command_id AND reviewer_id = a AND result IS NULL
  RETURNING * INTO d;
  IF NOT FOUND THEN RAISE EXCEPTION 'nothing to record for this review' USING ERRCODE = '22023'; END IF;
  PERFORM audit.record('access_request.' || d.decision, 'access_request', d.request_id::text,
                       d.note, NULL, to_jsonb(d));
END $$;

-- ------------------------------------------------------------- grants
REVOKE ALL ON ALL TABLES IN SCHEMA applications FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION api.application_review_prepare(uuid, text, text, text),
                           api.application_review_record_result(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  api.application_review_prepare(uuid, text, text, text),
  api.application_review_record_result(uuid, jsonb)
  TO portal_admin_api;
GRANT USAGE ON SCHEMA applications TO portal_admin_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA applications TO portal_admin_readonly;
