-- 0010_api_traffic.sql — API traffic control for the institution portal, admin side (2026-11-17).
--
-- Every API call that comes into the bank portal or goes out of it belongs to a CHANNEL (the
-- borrower app's calls, the public API, bank webhooks, email, ...). This is where Ficium
-- decides which channels may carry traffic. portal-api records the traffic (see its
-- integration.api_traffic_* tables) and enforces the state set here; this site only shows it and changes it.
--
--   Pause   one admin (traffic.control) with a reason. Immediate: stopping traffic is the safe
--           direction, and in an incident minutes matter.
--   Resume  four-eyes. One admin (traffic.control) asks with a reason, a DIFFERENT admin
--           (traffic.approve) approves; 72 h expiry. Restoring traffic is the risky direction.
--   Locked  the admin channel itself (this site's own commands and reads) can never be paused: pausing
--           it would cut the only way to resume anything. The database refuses it.
--
-- A change reaches portal-api as a signed command (api_channel.set) inside the same admin-DB transaction,
-- like every other portal change: if portal-api refuses or is unreachable, nothing is recorded as done.
-- portal-api applies a version only if it is newer than what it holds, so a retry is always safe.
SET LOCAL ROLE portal_admin_owner;
SET LOCAL search_path = pg_catalog;

-- People are shown by email, never by internal id (app_admin has had this since its 0004).
CREATE OR REPLACE FUNCTION iam._email(p uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT email FROM iam.admin_user WHERE id = p
$$;

INSERT INTO iam.permission (code, description) VALUES
  ('traffic.view',    'See API traffic per channel: volume, errors, speed and whether it is paused'),
  ('traffic.control', 'Pause an API channel, or ask for a paused one to be resumed'),
  ('traffic.approve', 'Approve or reject resuming a paused API channel (never your own request)');
INSERT INTO iam.role_permission (role_code, permission_code) VALUES
  ('super_admin', 'traffic.view'), ('compliance', 'traffic.view'), ('operations', 'traffic.view'), ('read_only', 'traffic.view'),
  ('super_admin', 'traffic.control'), ('operations', 'traffic.control'),
  ('super_admin', 'traffic.approve'), ('compliance', 'traffic.approve');

CREATE SCHEMA traffic AUTHORIZATION portal_admin_owner;

CREATE TABLE traffic.channel (
  key         text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_.]{2,59}$'),
  direction   text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  label       text NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  peer        text NOT NULL CHECK (length(peer) BETWEEN 1 AND 80),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 400),
  pausable    boolean NOT NULL,
  lock_reason text CHECK (lock_reason IS NULL OR length(lock_reason) <= 300),
  state       text NOT NULL DEFAULT 'enabled' CHECK (state IN ('enabled', 'paused')),
  state_reason text CHECK (state_reason IS NULL OR length(state_reason) <= 2000),
  version     bigint NOT NULL DEFAULT 0,   -- 0 = as seeded, never synced; every state change adds 1
  updated_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by  uuid REFERENCES iam.admin_user(id),
  CHECK (pausable OR state = 'enabled'),
  CHECK (pausable = (lock_reason IS NULL))
);

INSERT INTO traffic.channel (key, direction, label, peer, description, pausable, lock_reason) VALUES
  ('integration.contract_in', 'inbound',  'Calls from the borrower app',  'Ficium borrower app',
     'Signed events, the bid-acceptance call and document uploads from the borrower app. While paused the app gets "unavailable" and retries later, so nothing is lost.', true, NULL),
  ('public.v1_in',            'inbound',  'Public API (bank API keys)',   'Bank systems',
     'Banks'' own systems calling /v1 with an API key. While paused every key is refused with "unavailable".', true, NULL),
  ('portal.web_in',           'inbound',  'Portal users',                 'Bank staff',
     'Bank staff using the portal. Shown for monitoring.', false,
     'Pausing it would lock every bank out of the portal. It is monitored only.'),
  ('admin.channel',           'inbound',  'Admin site',                   'Ficium portal admin',
     'This admin site''s own commands and reads (banks, compliance, commission, audit).', false,
     'This is how this site changes anything, including resuming a channel. It cannot be paused.'),
  ('integration.events_out',  'outbound', 'Events to the borrower app',   'Ficium borrower app',
     'Signed bid and decision events. While paused they wait in the outbox and are sent in order once resumed.', true, NULL),
  ('webhooks.out',            'outbound', 'Bank webhooks',                'Bank systems',
     'Signed notifications sent to the URLs banks registered. While paused nothing is sent and each delivery is recorded as held.', true, NULL),
  ('mail.out',                'outbound', 'Email',                        'Email provider',
     'Invitations, approvals and notifications sent by email. While paused they are not sent.', true, NULL);

CREATE TABLE traffic.resume_request (
  id            uuid PRIMARY KEY DEFAULT util.uuid_v7(),
  channel_key   text NOT NULL REFERENCES traffic.channel(key),
  before        jsonb NOT NULL,              -- the channel state when asked
  reason        text NOT NULL CHECK (length(reason) BETWEEN 10 AND 2000),
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn', 'expired')),
  maker_id      uuid NOT NULL REFERENCES iam.admin_user(id),
  checker_id    uuid REFERENCES iam.admin_user(id),
  decision_note text CHECK (decision_note IS NULL OR length(decision_note) <= 2000),
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at    timestamptz NOT NULL DEFAULT clock_timestamp() + interval '72 hours',
  decided_at    timestamptz,
  version       bigint NOT NULL DEFAULT 1,
  CHECK (checker_id IS NULL OR checker_id <> maker_id),
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK (status NOT IN ('approved', 'rejected') OR checker_id IS NOT NULL)
);
CREATE UNIQUE INDEX resume_request_one_pending ON traffic.resume_request (channel_key) WHERE status = 'pending';
CREATE INDEX resume_request_recent ON traffic.resume_request (created_at DESC);

CREATE FUNCTION traffic._channel_view(c traffic.channel) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object(
    'key', c.key, 'direction', c.direction, 'label', c.label, 'peer', c.peer, 'description', c.description,
    'pausable', c.pausable, 'lock_reason', c.lock_reason, 'state', c.state, 'state_reason', c.state_reason,
    'version', c.version, 'updated_at', c.updated_at, 'updated_by', iam._email(c.updated_by))
$$;

-- What the product receives and applies. No email, no free text beyond the reason.
CREATE FUNCTION traffic._policy(c traffic.channel) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('channel', c.key, 'state', c.state, 'version', c.version,
                            'reason', c.state_reason, 'changed_at', c.updated_at)
$$;

CREATE FUNCTION traffic._view(d traffic.resume_request) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object(
    'id', d.id, 'channel_key', d.channel_key, 'before', d.before, 'reason', d.reason,
    'status', CASE WHEN d.status = 'pending' AND d.expires_at <= clock_timestamp() THEN 'expired' ELSE d.status END,
    'maker', iam._email(d.maker_id), 'checker', iam._email(d.checker_id),
    'decision_note', d.decision_note, 'created_at', d.created_at, 'expires_at', d.expires_at,
    'decided_at', d.decided_at, 'version', d.version, 'mine', d.maker_id = iam.current_admin())
$$;

CREATE FUNCTION traffic._lock(p_id uuid, p_expected_version bigint) RETURNS traffic.resume_request
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE d traffic.resume_request;
BEGIN
  SELECT * INTO d FROM traffic.resume_request WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown request' USING ERRCODE = 'P0002'; END IF;
  IF d.version <> p_expected_version THEN
    RAISE EXCEPTION 'request changed since you opened it' USING ERRCODE = '40001';
  END IF;
  IF d.status <> 'pending' THEN
    RAISE EXCEPTION 'this request is already %', d.status USING ERRCODE = '22023';
  END IF;
  RETURN d;
END $$;

-- The whole page minus the live numbers: every channel and its state, and the last 50 resume requests.
CREATE FUNCTION api.traffic_view() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE me uuid := iam.require('traffic.view');
BEGIN
  RETURN jsonb_build_object(
    'actor', iam._email(me),
    'can_control', iam.has_permission(me, 'traffic.control'),
    'can_approve', iam.has_permission(me, 'traffic.approve'),
    'channels', (SELECT jsonb_agg(traffic._channel_view(c) ORDER BY c.direction DESC, c.key) FROM traffic.channel c),
    'requests', coalesce((SELECT jsonb_agg(traffic._view(d) ORDER BY d.created_at DESC)
                            FROM (SELECT * FROM traffic.resume_request ORDER BY created_at DESC LIMIT 50) d), '[]'::jsonb));
END $$;

-- Pause: immediate. Answers { channel, policy } so the caller can push it on at once if it wants to.
CREATE FUNCTION api.traffic_pause(p_key text, p_expected_version bigint, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('traffic.control'); r text := util.require_reason(p_reason);
        cur traffic.channel; c traffic.channel; ev uuid;
BEGIN
  SELECT * INTO cur FROM traffic.channel WHERE key = p_key FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown channel' USING ERRCODE = 'P0002'; END IF;
  IF NOT cur.pausable THEN
    RAISE EXCEPTION 'this channel cannot be paused: %', cur.lock_reason USING ERRCODE = '42501';
  END IF;
  IF cur.version <> p_expected_version THEN
    RAISE EXCEPTION 'channel changed since you opened it' USING ERRCODE = '40001';
  END IF;
  IF cur.state = 'paused' THEN RAISE EXCEPTION 'this channel is already paused' USING ERRCODE = '22023'; END IF;
  -- Anything waiting to resume this channel is moot once it is paused again.
  UPDATE traffic.resume_request SET status = 'withdrawn', decided_at = clock_timestamp(), version = version + 1
   WHERE channel_key = p_key AND status = 'pending';
  UPDATE traffic.channel
     SET state = 'paused', state_reason = r, version = version + 1, updated_at = clock_timestamp(), updated_by = a
   WHERE key = p_key RETURNING * INTO c;
  ev := audit.record('traffic.channel_paused', 'api_channel', c.key, r, traffic._channel_view(cur), traffic._channel_view(c));
  RETURN jsonb_build_object('channel', traffic._channel_view(c), 'policy', traffic._policy(c),
    'command', jsonb_build_object('op', 'api_channel.pause', 'command_id', util.uuid_v7(),
                                  'maker_sub', iam.portal_subject(a), 'args', traffic._policy(c)));
END $$;

CREATE FUNCTION api.traffic_resume_request(p_key text, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('traffic.control'); r text := util.require_reason(p_reason);
        cur traffic.channel; d traffic.resume_request;
BEGIN
  SELECT * INTO cur FROM traffic.channel WHERE key = p_key FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown channel' USING ERRCODE = 'P0002'; END IF;
  IF cur.state <> 'paused' THEN RAISE EXCEPTION 'this channel is not paused' USING ERRCODE = '22023'; END IF;
  UPDATE traffic.resume_request SET status = 'expired', decided_at = clock_timestamp(), version = version + 1
   WHERE channel_key = p_key AND status = 'pending' AND expires_at <= clock_timestamp();
  IF EXISTS (SELECT 1 FROM traffic.resume_request WHERE channel_key = p_key AND status = 'pending') THEN
    RAISE EXCEPTION 'a request to resume this channel is already waiting for approval' USING ERRCODE = '22023';
  END IF;
  INSERT INTO traffic.resume_request (channel_key, before, reason, maker_id)
  VALUES (p_key, traffic._channel_view(cur), r, a) RETURNING * INTO d;
  PERFORM audit.record('traffic.resume_requested', 'api_channel', p_key, r, d.before, to_jsonb(d));
  RETURN traffic._view(d);
END $$;

CREATE FUNCTION api.traffic_resume_approve(p_id uuid, p_expected_version bigint, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('traffic.approve'); d traffic.resume_request; cur traffic.channel; c traffic.channel;
        note text := nullif(btrim(coalesce(p_note, '')), ''); ev uuid;
BEGIN
  IF length(note) > 2000 THEN RAISE EXCEPTION 'note is too long' USING ERRCODE = '22023'; END IF;
  d := traffic._lock(p_id, p_expected_version);
  IF d.maker_id = a THEN
    RAISE EXCEPTION 'four-eyes: you cannot approve your own request' USING ERRCODE = '42501';
  END IF;
  IF d.expires_at <= clock_timestamp() THEN
    UPDATE traffic.resume_request
       SET status = 'expired', decided_at = clock_timestamp(), version = version + 1,
           decision_note = 'expired before approval'
     WHERE id = d.id RETURNING * INTO d;
    PERFORM audit.record('traffic.resume_expired', 'api_channel', d.channel_key, d.decision_note, NULL, to_jsonb(d));
    RETURN jsonb_build_object('request', traffic._view(d), 'policy', NULL, 'command', NULL);
  END IF;
  SELECT * INTO cur FROM traffic.channel WHERE key = d.channel_key FOR UPDATE;
  IF cur.state <> 'paused' THEN RAISE EXCEPTION 'this channel is no longer paused' USING ERRCODE = '22023'; END IF;
  UPDATE traffic.resume_request
     SET status = 'approved', checker_id = a, decision_note = note, decided_at = clock_timestamp(), version = version + 1
   WHERE id = d.id RETURNING * INTO d;
  UPDATE traffic.channel
     SET state = 'enabled', state_reason = NULL, version = version + 1, updated_at = clock_timestamp(), updated_by = a
   WHERE key = d.channel_key RETURNING * INTO c;
  ev := audit.record('traffic.channel_resumed', 'api_channel', c.key, d.reason, traffic._channel_view(cur), traffic._channel_view(c));
  -- command_id is the request id, so a retried approval is a no-op in portal-api. The maker is the person
  -- who asked: portal-api refuses it if they are also the one approving (four-eyes, checked on both sides).
  RETURN jsonb_build_object('request', traffic._view(d), 'policy', traffic._policy(c),
    'command', jsonb_build_object('op', 'api_channel.resume', 'command_id', d.id,
                                  'maker_sub', iam.portal_subject(d.maker_id), 'args', traffic._policy(c)));
END $$;

CREATE FUNCTION api.traffic_resume_reject(p_id uuid, p_expected_version bigint, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('traffic.approve'); r text := util.require_reason(p_note); d traffic.resume_request;
BEGIN
  d := traffic._lock(p_id, p_expected_version);
  IF d.maker_id = a THEN
    RAISE EXCEPTION 'you made this request: withdraw it instead' USING ERRCODE = '42501';
  END IF;
  UPDATE traffic.resume_request
     SET status = 'rejected', checker_id = a, decision_note = r, decided_at = clock_timestamp(), version = version + 1
   WHERE id = d.id RETURNING * INTO d;
  PERFORM audit.record('traffic.resume_rejected', 'api_channel', d.channel_key, r, NULL, to_jsonb(d));
  RETURN traffic._view(d);
END $$;

CREATE FUNCTION api.traffic_resume_withdraw(p_id uuid, p_expected_version bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('traffic.control'); d traffic.resume_request;
BEGIN
  d := traffic._lock(p_id, p_expected_version);
  IF d.maker_id <> a THEN
    RAISE EXCEPTION 'only the admin who asked can withdraw a request' USING ERRCODE = '42501';
  END IF;
  UPDATE traffic.resume_request
     SET status = 'withdrawn', decided_at = clock_timestamp(), version = version + 1
   WHERE id = d.id RETURNING * INTO d;
  PERFORM audit.record('traffic.resume_withdrawn', 'api_channel', d.channel_key, NULL, NULL, to_jsonb(d));
  RETURN traffic._view(d);
END $$;

REVOKE ALL ON SCHEMA traffic FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA traffic, api FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.traffic_view(), api.traffic_pause(text, bigint, text),
  api.traffic_resume_request(text, text), api.traffic_resume_approve(uuid, bigint, text),
  api.traffic_resume_reject(uuid, bigint, text), api.traffic_resume_withdraw(uuid, bigint) TO portal_admin_api;
GRANT USAGE ON SCHEMA traffic TO portal_admin_readonly;
GRANT SELECT ON traffic.channel, traffic.resume_request TO portal_admin_readonly;
