-- 0007_kyc_review.sql — KYC review queue, admin side (KJ, 2026-10-30).
--
-- Borrower submissions the automated checks flag (pending_review) are decided
-- here by a person with kyc.review. This database is the master for the
-- decision and its audit; the decision reaches the borrower app through the
-- outbox (topic kyc.case_decided, version 1: one decision per submission).
-- Decisions are append-only. Every time a reviewer opens a case (identity
-- documents, personal data) that access is recorded in the audit log first:
-- if it can't be recorded, the case is not shown.
SET LOCAL ROLE app_admin_owner;
SET LOCAL search_path = pg_catalog;

INSERT INTO iam.permission (code, description) VALUES
  ('kyc.review', 'Open flagged KYC cases (identity documents) and decide them');
INSERT INTO iam.role_permission (role_code, permission_code) VALUES
  ('super_admin', 'kyc.review'), ('compliance', 'kyc.review');

CREATE TABLE kyc.case_decision (
  submission_id uuid PRIMARY KEY,                 -- the borrower app's kyc_submissions.id
  client_id     uuid NOT NULL,
  decision      text NOT NULL CHECK (decision IN ('verified', 'rejected')),
  reason        text NOT NULL CHECK (length(reason) BETWEEN 10 AND 2000),
  reviewer_id   uuid NOT NULL REFERENCES iam.admin_user(id),
  decided_at    timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX case_decision_recent ON kyc.case_decision (decided_at DESC);
CREATE TRIGGER case_decision_worm BEFORE UPDATE OR DELETE ON kyc.case_decision
  FOR EACH ROW EXECUTE FUNCTION util.append_only();
CREATE TRIGGER case_decision_worm_trunc BEFORE TRUNCATE ON kyc.case_decision
  FOR EACH STATEMENT EXECUTE FUNCTION util.append_only();

CREATE FUNCTION kyc._decision_view(d kyc.case_decision) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT CASE WHEN d.submission_id IS NULL THEN NULL ELSE jsonb_build_object(
    'submission_id', d.submission_id, 'decision', d.decision, 'reason', d.reason,
    'reviewer', iam._email(d.reviewer_id), 'decided_at', d.decided_at) END
$$;

-- Gate for list views (the list itself comes from the borrower app).
CREATE FUNCTION api.kyc_review_access() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE me uuid := iam.require('kyc.review');
BEGIN
  RETURN jsonb_build_object('actor', iam._email(me));
END $$;

-- Decisions already taken here, for the given submissions.
CREATE FUNCTION api.kyc_case_decisions(p_submissions uuid[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM iam.require('kyc.review');
  RETURN coalesce((SELECT jsonb_object_agg(d.submission_id, kyc._decision_view(d))
                     FROM kyc.case_decision d WHERE d.submission_id = ANY (p_submissions)), '{}');
END $$;

-- Opening a case is recorded before anything is shown.
CREATE FUNCTION api.kyc_case_viewed(p_submission uuid, p_client uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE me uuid := iam.require('kyc.review'); d kyc.case_decision;
BEGIN
  PERFORM audit.record('kyc.case_viewed', 'kyc_submission', p_submission::text, NULL, NULL,
                       jsonb_build_object('client_id', p_client));
  SELECT * INTO d FROM kyc.case_decision WHERE submission_id = p_submission;
  RETURN jsonb_build_object('actor', iam._email(me), 'decision', kyc._decision_view(d));
END $$;

CREATE FUNCTION api.kyc_case_decide(p_submission uuid, p_client uuid, p_decision text, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE me uuid := iam.require('kyc.review'); r text := util.require_reason(p_reason);
        d kyc.case_decision; ev uuid;
BEGIN
  IF p_decision NOT IN ('verified', 'rejected') THEN
    RAISE EXCEPTION 'decision must be verified or rejected' USING ERRCODE = '22023';
  END IF;
  INSERT INTO kyc.case_decision (submission_id, client_id, decision, reason, reviewer_id)
  VALUES (p_submission, p_client, p_decision, r, me)
  ON CONFLICT (submission_id) DO NOTHING RETURNING * INTO d;
  IF d.submission_id IS NULL THEN
    RAISE EXCEPTION 'this case has already been decided' USING ERRCODE = '23505';
  END IF;
  ev := audit.record('kyc.case_decided', 'kyc_submission', p_submission::text, r, NULL, to_jsonb(d));
  PERFORM outbox.enqueue('kyc.case_decided', 'kyc_submission', p_submission::text, 1,
    jsonb_build_object('submission_id', p_submission, 'decision', p_decision, 'reason', r,
                       'reviewer', iam._email(me), 'decided_at', d.decided_at), ev);
  RETURN kyc._decision_view(d);
END $$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA kyc, api FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.kyc_review_access(), api.kyc_case_decisions(uuid[]),
  api.kyc_case_viewed(uuid, uuid), api.kyc_case_decide(uuid, uuid, text, text) TO app_admin_api;
GRANT SELECT ON kyc.case_decision TO app_admin_readonly;
