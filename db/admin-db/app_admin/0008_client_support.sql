-- 0008_client_support.sql — borrower support, admin side (KJ, 2026-11-14).
--
-- Staff look a borrower up and can suspend or reinstate them. The borrower app owns the borrower
-- data (read over its signed API); this database owns who looked, who asked and who approved.
--   * Opening a borrower is recorded in the audit log first: if it can't be recorded, nothing is shown.
--   * Suspend / reinstate is four-eyes: one admin (client.access.request) asks with a reason, a
--     DIFFERENT admin (client.access.approve) approves. A request expires after 72 hours. On approval
--     the change reaches the borrower app through the outbox (topic client.access_changed, one
--     version per borrower), where suspension blocks sign-in, ends sessions and closes open requests.
SET LOCAL ROLE app_admin_owner;
SET LOCAL search_path = pg_catalog;

INSERT INTO iam.permission (code, description) VALUES
  ('client.lookup',          'Look up a borrower (support view: no documents, income or address)'),
  ('client.access.request',  'Ask to suspend or reinstate a borrower'),
  ('client.access.approve',  'Approve or reject a suspension or reinstatement (never your own request)');
INSERT INTO iam.role_permission (role_code, permission_code) VALUES
  ('super_admin', 'client.lookup'), ('compliance', 'client.lookup'), ('operations', 'client.lookup'),
  ('super_admin', 'client.access.request'), ('compliance', 'client.access.request'),
  ('super_admin', 'client.access.approve'), ('compliance', 'client.access.approve');

CREATE SCHEMA client AUTHORIZATION app_admin_owner;

CREATE TABLE client.access_request (
  id            uuid PRIMARY KEY DEFAULT util.uuid_v7(),
  client_id     uuid NOT NULL,                    -- the borrower app's clients.id
  action        text NOT NULL CHECK (action IN ('suspend', 'reinstate')),
  reason        text NOT NULL CHECK (length(reason) BETWEEN 10 AND 2000),
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','approved','rejected','withdrawn','expired')),
  maker_id      uuid NOT NULL REFERENCES iam.admin_user(id),
  checker_id    uuid REFERENCES iam.admin_user(id),
  decision_note text CHECK (decision_note IS NULL OR length(decision_note) <= 2000),
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at    timestamptz NOT NULL DEFAULT clock_timestamp() + interval '72 hours',
  decided_at    timestamptz,
  version       bigint NOT NULL DEFAULT 1,
  CHECK (checker_id IS NULL OR checker_id <> maker_id),
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK (status NOT IN ('approved','rejected') OR checker_id IS NOT NULL)
);
CREATE UNIQUE INDEX access_request_one_pending ON client.access_request (client_id) WHERE status = 'pending';
CREATE INDEX access_request_client ON client.access_request (client_id, created_at DESC);
CREATE INDEX access_request_recent ON client.access_request (created_at DESC);

CREATE FUNCTION client._view(d client.access_request) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object(
    'id', d.id, 'client_id', d.client_id, 'action', d.action, 'reason', d.reason,
    'status', CASE WHEN d.status = 'pending' AND d.expires_at <= clock_timestamp() THEN 'expired' ELSE d.status END,
    'maker', iam._email(d.maker_id), 'checker', iam._email(d.checker_id),
    'decision_note', d.decision_note, 'created_at', d.created_at, 'expires_at', d.expires_at,
    'decided_at', d.decided_at, 'version', d.version, 'mine', d.maker_id = iam.current_admin())
$$;

CREATE FUNCTION client._lock(p_id uuid, p_expected_version bigint) RETURNS client.access_request
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE d client.access_request;
BEGIN
  SELECT * INTO d FROM client.access_request WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown request' USING ERRCODE = 'P0002'; END IF;
  IF d.version <> p_expected_version THEN
    RAISE EXCEPTION 'request changed since you opened it' USING ERRCODE = '40001';
  END IF;
  IF d.status <> 'pending' THEN
    RAISE EXCEPTION 'this request is already %', d.status USING ERRCODE = '22023';
  END IF;
  RETURN d;
END $$;

-- Gate for the search screen (results come from the borrower app).
CREATE FUNCTION api.client_lookup_access(p_query_kind text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE me uuid := iam.require('client.lookup');
BEGIN
  -- The search terms are personal data: record that a search happened and its kind, not the text.
  PERFORM audit.record('client.searched', 'client', NULL, NULL, NULL,
                       jsonb_build_object('query_kind', left(coalesce(p_query_kind, ''), 20)));
  RETURN jsonb_build_object('actor', iam._email(me),
    'can_request', iam.has_permission(me, 'client.access.request'), 'can_approve', iam.has_permission(me, 'client.access.approve'));
END $$;

-- Opening a borrower is recorded before anything is shown. Returns this site's requests for them.
CREATE FUNCTION api.client_viewed(p_client uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE me uuid := iam.require('client.lookup');
BEGIN
  PERFORM audit.record('client.viewed', 'client', p_client::text, NULL, NULL, NULL);
  RETURN jsonb_build_object(
    'actor', iam._email(me),
    'can_request', iam.has_permission(me, 'client.access.request'), 'can_approve', iam.has_permission(me, 'client.access.approve'),
    'requests', coalesce((SELECT jsonb_agg(client._view(d) ORDER BY d.created_at DESC)
                            FROM client.access_request d WHERE d.client_id = p_client), '[]'::jsonb));
END $$;

-- Requests waiting for a second admin, newest first.
CREATE FUNCTION api.client_access_pending() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM iam.require('client.lookup');
  RETURN coalesce((SELECT jsonb_agg(client._view(d) ORDER BY d.created_at DESC)
                     FROM client.access_request d
                    WHERE d.status = 'pending' AND d.expires_at > clock_timestamp()), '[]'::jsonb);
END $$;

-- p_currently_suspended comes from the borrower app read the backend just made, so a request
-- that would change nothing (suspend a suspended borrower) is refused up front.
CREATE FUNCTION api.client_access_request(p_client uuid, p_action text, p_reason text, p_currently_suspended boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('client.access.request'); r text := util.require_reason(p_reason); d client.access_request;
BEGIN
  IF p_action NOT IN ('suspend', 'reinstate') THEN
    RAISE EXCEPTION 'action must be suspend or reinstate' USING ERRCODE = '22023';
  END IF;
  IF p_currently_suspended IS NULL THEN RAISE EXCEPTION 'current state is required' USING ERRCODE = '22023'; END IF;
  IF (p_action = 'suspend') = p_currently_suspended THEN
    RAISE EXCEPTION 'this borrower is already %', CASE WHEN p_currently_suspended THEN 'suspended' ELSE 'active' END
      USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('client_access:' || p_client::text, 0));
  UPDATE client.access_request SET status = 'expired', decided_at = clock_timestamp(), version = version + 1
   WHERE client_id = p_client AND status = 'pending' AND expires_at <= clock_timestamp();
  IF EXISTS (SELECT 1 FROM client.access_request WHERE client_id = p_client AND status = 'pending') THEN
    RAISE EXCEPTION 'a request for this borrower is already waiting for approval' USING ERRCODE = '22023';
  END IF;
  INSERT INTO client.access_request (client_id, action, reason, maker_id)
  VALUES (p_client, p_action, r, a) RETURNING * INTO d;
  PERFORM audit.record('client.access_requested', 'client', p_client::text, r, NULL, to_jsonb(d));
  RETURN client._view(d);
END $$;

CREATE FUNCTION api.client_access_approve(p_id uuid, p_expected_version bigint, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('client.access.approve'); d client.access_request;
        note text := nullif(btrim(coalesce(p_note, '')), ''); ev uuid; v bigint;
BEGIN
  IF length(note) > 2000 THEN RAISE EXCEPTION 'note is too long' USING ERRCODE = '22023'; END IF;
  d := client._lock(p_id, p_expected_version);
  IF d.maker_id = a THEN
    RAISE EXCEPTION 'four-eyes: you cannot approve your own request' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('client_access:' || d.client_id::text, 0));
  IF d.expires_at <= clock_timestamp() THEN
    UPDATE client.access_request
       SET status = 'expired', decided_at = clock_timestamp(), version = version + 1,
           decision_note = 'expired before approval'
     WHERE id = d.id RETURNING * INTO d;
    PERFORM audit.record('client.access_expired', 'client', d.client_id::text, d.decision_note, NULL, to_jsonb(d));
    RETURN client._view(d);
  END IF;
  UPDATE client.access_request
     SET status = 'approved', checker_id = a, decision_note = note, decided_at = clock_timestamp(), version = version + 1
   WHERE id = d.id RETURNING * INTO d;
  -- One version per borrower: the borrower app applies them strictly in order.
  SELECT count(*) INTO v FROM client.access_request WHERE client_id = d.client_id AND status = 'approved';
  ev := audit.record('client.access_approved', 'client', d.client_id::text, d.reason, NULL, to_jsonb(d));
  PERFORM outbox.enqueue('client.access_changed', 'client', d.client_id::text, v,
    jsonb_build_object('client_id', d.client_id, 'suspended', d.action = 'suspend', 'reason', d.reason,
                       'version', v, 'request_id', d.id,
                       'requested_by', iam._email(d.maker_id), 'approved_by', iam._email(a),
                       'approved_by_id', a, 'approved_at', d.decided_at), ev);
  RETURN client._view(d);
END $$;

CREATE FUNCTION api.client_access_reject(p_id uuid, p_expected_version bigint, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('client.access.approve'); r text := util.require_reason(p_note); d client.access_request;
BEGIN
  d := client._lock(p_id, p_expected_version);
  IF d.maker_id = a THEN
    RAISE EXCEPTION 'you made this request: withdraw it instead' USING ERRCODE = '42501';
  END IF;
  UPDATE client.access_request
     SET status = 'rejected', checker_id = a, decision_note = r, decided_at = clock_timestamp(), version = version + 1
   WHERE id = d.id RETURNING * INTO d;
  PERFORM audit.record('client.access_rejected', 'client', d.client_id::text, r, NULL, to_jsonb(d));
  RETURN client._view(d);
END $$;

CREATE FUNCTION api.client_access_withdraw(p_id uuid, p_expected_version bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('client.access.request'); d client.access_request;
BEGIN
  d := client._lock(p_id, p_expected_version);
  IF d.maker_id <> a THEN
    RAISE EXCEPTION 'only the admin who asked can withdraw a request' USING ERRCODE = '42501';
  END IF;
  UPDATE client.access_request
     SET status = 'withdrawn', decided_at = clock_timestamp(), version = version + 1
   WHERE id = d.id RETURNING * INTO d;
  PERFORM audit.record('client.access_withdrawn', 'client', d.client_id::text, NULL, NULL, to_jsonb(d));
  RETURN client._view(d);
END $$;

REVOKE ALL ON SCHEMA client FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA client, api FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.client_lookup_access(text), api.client_viewed(uuid), api.client_access_pending(),
  api.client_access_request(uuid, text, text, boolean), api.client_access_approve(uuid, bigint, text),
  api.client_access_reject(uuid, bigint, text), api.client_access_withdraw(uuid, bigint) TO app_admin_api;
GRANT USAGE ON SCHEMA client TO app_admin_readonly;
GRANT SELECT ON client.access_request TO app_admin_readonly;
