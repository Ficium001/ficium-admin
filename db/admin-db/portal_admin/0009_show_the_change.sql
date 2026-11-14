-- 0009_show_the_change.sql — four-eyes approvers see the change, not a label.
--
-- A request now carries what the record looked like in the portal when it was
-- asked for (`before`, read by the backend from portal-api, never from the
-- browser) and plain rows of what changes (`change`). At approval the backend
-- reads the portal again and calls api.change_request_confirm_unchanged before
-- sending the command: if the record moved, the approval is refused (and the
-- whole transaction rolls back), so nobody approves a change they did not see.
-- record_result refuses to record a described change that was never checked.
SET LOCAL ROLE portal_admin_owner;
SET LOCAL search_path = pg_catalog;

ALTER TABLE governance.change_request
  ADD COLUMN before jsonb CHECK (before IS NULL OR (jsonb_typeof(before) = 'object' AND pg_column_size(before) < 8000)),
  ADD COLUMN change jsonb CHECK (change IS NULL OR (jsonb_typeof(change) = 'object'
                                 AND jsonb_typeof(change->'rows') = 'array' AND pg_column_size(change) < 16000)),
  ADD COLUMN before_checked_at timestamptz,
  ADD CONSTRAINT change_request_described_together CHECK ((before IS NULL) = (change IS NULL));

CREATE FUNCTION api.change_request_create(p_op text, p_target_key text, p_target_label text,
  p_args jsonb, p_reason text, p_before jsonb, p_change jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE o governance.op := governance._op(p_op); a uuid; r governance.change_request;
        why text := util.require_reason(p_reason);
BEGIN
  a := iam.require(o.request_permission);
  PERFORM iam.portal_subject(a);
  IF p_before IS NULL OR p_change IS NULL THEN
    RAISE EXCEPTION 'a change request must say what changes' USING ERRCODE = '22023';
  END IF;
  BEGIN
    INSERT INTO governance.change_request (op, target_key, target_label, args, reason, maker_id, before, change)
    VALUES (p_op, p_target_key, btrim(p_target_label), coalesce(p_args, '{}'::jsonb), why, a, p_before, p_change)
    RETURNING * INTO r;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'the same change is already waiting for approval' USING ERRCODE = '22023';
  END;
  PERFORM audit.record(r.op || '.requested', 'change_request', r.id::text, why, NULL, to_jsonb(r));
  RETURN governance._json(r);
END $$;

-- The old 5-argument form can no longer open a request without the change.
CREATE OR REPLACE FUNCTION api.change_request_create(p_op text, p_target_key text, p_target_label text,
  p_args jsonb, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'a change request must say what changes' USING ERRCODE = '22023';
END $$;

-- Called after approve, before the command goes to portal-api, in the same transaction.
CREATE FUNCTION api.change_request_confirm_unchanged(p_id uuid, p_current jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.current_admin(); r governance.change_request;
BEGIN
  SELECT * INTO r FROM governance.change_request WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR r.status <> 'approved' OR r.checker_id IS DISTINCT FROM a OR r.result IS NOT NULL THEN
    RAISE EXCEPTION 'nothing to check for this request' USING ERRCODE = '22023';
  END IF;
  IF r.before IS NULL THEN RETURN; END IF;   -- asked for before 0009: nothing was frozen
  IF r.before IS DISTINCT FROM p_current THEN
    RAISE EXCEPTION 'CHANGED_SINCE_REQUEST: this record changed after the request was made. Reject it and ask again'
      USING ERRCODE = 'FC409';
  END IF;
  UPDATE governance.change_request SET before_checked_at = clock_timestamp() WHERE id = p_id;
END $$;

CREATE OR REPLACE FUNCTION api.change_request_record_result(p_id uuid, p_result jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.current_admin(); r governance.change_request;
BEGIN
  IF EXISTS (SELECT 1 FROM governance.change_request
              WHERE id = p_id AND before IS NOT NULL AND before_checked_at IS NULL) THEN
    RAISE EXCEPTION 'the change was not checked against the portal before it was applied' USING ERRCODE = '22023';
  END IF;
  UPDATE governance.change_request SET result = p_result, version = version + 1
   WHERE id = p_id AND status = 'approved' AND checker_id = a AND result IS NULL
  RETURNING * INTO r;
  IF NOT FOUND THEN RAISE EXCEPTION 'nothing to record for this request' USING ERRCODE = '22023'; END IF;
  PERFORM audit.record(r.op || '.applied', 'change_request', r.id::text, NULL, r.before, p_result);
  RETURN governance._json(r);
END $$;

REVOKE EXECUTE ON FUNCTION
  api.change_request_create(text, text, text, jsonb, text, jsonb, jsonb),
  api.change_request_confirm_unchanged(uuid, jsonb)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  api.change_request_create(text, text, text, jsonb, text, jsonb, jsonb),
  api.change_request_confirm_unchanged(uuid, jsonb)
  TO portal_admin_api;
