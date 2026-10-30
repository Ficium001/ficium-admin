-- 0006_controls.sql — three control fixes (KJ, 2026-10-30).
--
-- 1. Safety settings are fixed by policy. platform.maker_checker_on and
--    platform.kyc_required can no longer be changed through api.config_set by
--    anyone; a CHECK pins both to true, so turning either off needs a reviewed
--    migration, not one admin.
-- 2. Turning a KYC check OFF is four-eyes. One admin (kyc.change) asks, a
--    different admin (kyc.approve) approves, then it applies. Turning a check
--    ON stays immediate: it only makes verification stricter. A request
--    expires after 72 hours, or as soon as the check changes in between.
-- 3. Ops health. The outbox and the audit chain are checked by the hourly
--    dispatcher (api.ops_health_check) and shown to staff (api.ops_health_view).
--    Dead letters, a stuck queue or a broken chain become alerts instead of
--    staying silent.
SET LOCAL ROLE app_admin_owner;
SET LOCAL search_path = pg_catalog;

-- ============================================================ 1. settings
ALTER TABLE config.setting ADD COLUMN locked boolean NOT NULL DEFAULT false;
UPDATE config.setting SET locked = true WHERE key IN ('platform.maker_checker_on', 'platform.kyc_required');
ALTER TABLE config.setting
  ADD CONSTRAINT setting_safety_controls_on
  CHECK (key NOT IN ('platform.maker_checker_on', 'platform.kyc_required') OR (value = 'true'::jsonb AND locked));

CREATE OR REPLACE FUNCTION api.config_set(p_key text, p_value jsonb, p_expected_version bigint, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('config.change'); old config.setting; s config.setting;
        r text := util.require_reason(p_reason); ev uuid;
BEGIN
  SELECT * INTO old FROM config.setting WHERE key = p_key FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown setting %', p_key USING ERRCODE = 'P0002'; END IF;
  IF old.locked THEN
    RAISE EXCEPTION 'setting % is fixed by policy and can only change through a reviewed migration', p_key
      USING ERRCODE = '42501';
  END IF;
  UPDATE config.setting SET value = p_value, version = version + 1, updated_by = a
   WHERE key = p_key AND version = p_expected_version RETURNING * INTO s;
  IF NOT FOUND THEN RAISE EXCEPTION 'setting changed since you opened it' USING ERRCODE = '40001'; END IF;
  ev := audit.record('config.setting_changed', 'setting', p_key, r,
                     jsonb_build_object('value', old.value), jsonb_build_object('value', s.value));
  PERFORM outbox.enqueue('config.setting_changed', 'setting', p_key, s.version,
                         jsonb_build_object('key', s.key, 'value', s.value, 'version', s.version), ev);
  RETURN to_jsonb(s);
END $$;

-- ============================================================ 2. KYC four-eyes
INSERT INTO iam.permission (code, description) VALUES
  ('kyc.approve', 'Approve or reject turning a KYC check off (never your own request)');
INSERT INTO iam.role_permission (role_code, permission_code) VALUES
  ('super_admin', 'kyc.approve'), ('compliance', 'kyc.approve');

CREATE TABLE kyc.disable_request (
  id            uuid PRIMARY KEY DEFAULT util.uuid_v7(),
  check_key     text NOT NULL REFERENCES kyc.check_setting(check_key),
  base_version  bigint NOT NULL,                 -- the check's version when asked
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
CREATE UNIQUE INDEX disable_request_one_pending ON kyc.disable_request (check_key) WHERE status = 'pending';
CREATE INDEX disable_request_recent ON kyc.disable_request (created_at DESC);

-- The one place a check's value changes. Callers hold the KYC policy lock.
CREATE FUNCTION kyc._apply(p_key text, p_enabled boolean, p_expected_version bigint, p_reason text,
                           p_actor uuid, p_extra jsonb) RETURNS kyc.check_setting
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE old kyc.check_setting; c kyc.check_setting; ev uuid; pv bigint;
BEGIN
  SELECT * INTO old FROM kyc.check_setting WHERE check_key = p_key FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown KYC check: %', p_key USING ERRCODE = 'P0002'; END IF;
  UPDATE kyc.check_setting SET enabled = p_enabled, version = version + 1, updated_by = p_actor
   WHERE check_key = p_key AND version = p_expected_version RETURNING * INTO c;
  IF NOT FOUND THEN RAISE EXCEPTION 'check changed since you opened it' USING ERRCODE = '40001'; END IF;
  ev := audit.record('kyc.check_changed', 'kyc_check', p_key, p_reason,
                     jsonb_build_object('enabled', old.enabled),
                     jsonb_build_object('enabled', c.enabled) || coalesce(p_extra, '{}'::jsonb));
  pv := nextval('kyc.policy_version_seq');
  PERFORM outbox.enqueue('kyc.policy_changed', 'kyc_policy', 'global', pv,
                         jsonb_build_object('checks', kyc.snapshot(), 'version', pv), ev);
  RETURN c;
END $$;

-- Turning ON: immediate. Turning OFF: refused here, use kyc_disable_request.
CREATE OR REPLACE FUNCTION api.kyc_set_check(p_key text, p_enabled boolean, p_expected_version bigint, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('kyc.change'); r text := util.require_reason(p_reason); cur kyc.check_setting;
BEGIN
  IF p_enabled IS NULL THEN RAISE EXCEPTION 'value is required' USING ERRCODE = '22023'; END IF;
  PERFORM pg_advisory_xact_lock(7461002);  -- one KYC policy change at a time
  SELECT * INTO cur FROM kyc.check_setting WHERE check_key = p_key;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown KYC check: %', p_key USING ERRCODE = 'P0002'; END IF;
  IF NOT p_enabled AND cur.enabled THEN
    RAISE EXCEPTION 'turning a KYC check off needs a second admin: request it, then another admin approves'
      USING ERRCODE = '42501';
  END IF;
  RETURN to_jsonb(kyc._apply(p_key, p_enabled, p_expected_version, r, a, NULL));
END $$;

CREATE FUNCTION kyc._request_view(d kyc.disable_request) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object(
    'id', d.id, 'check_key', d.check_key, 'reason', d.reason,
    'status', CASE WHEN d.status = 'pending' AND d.expires_at <= clock_timestamp() THEN 'expired' ELSE d.status END,
    'maker', iam._email(d.maker_id), 'checker', iam._email(d.checker_id),
    'decision_note', d.decision_note, 'created_at', d.created_at, 'expires_at', d.expires_at,
    'decided_at', d.decided_at, 'version', d.version,
    'mine', d.maker_id = iam.current_admin())
$$;

CREATE FUNCTION kyc._lock_request(p_id uuid, p_expected_version bigint) RETURNS kyc.disable_request
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE d kyc.disable_request;
BEGIN
  SELECT * INTO d FROM kyc.disable_request WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown request' USING ERRCODE = 'P0002'; END IF;
  IF d.version <> p_expected_version THEN
    RAISE EXCEPTION 'request changed since you opened it' USING ERRCODE = '40001';
  END IF;
  IF d.status <> 'pending' THEN
    RAISE EXCEPTION 'this request is already %', d.status USING ERRCODE = '22023';
  END IF;
  RETURN d;
END $$;

CREATE FUNCTION api.kyc_disable_request(p_key text, p_expected_version bigint, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('kyc.change'); r text := util.require_reason(p_reason);
        c kyc.check_setting; d kyc.disable_request;
BEGIN
  PERFORM pg_advisory_xact_lock(7461002);
  SELECT * INTO c FROM kyc.check_setting WHERE check_key = p_key FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown KYC check: %', p_key USING ERRCODE = 'P0002'; END IF;
  IF c.version <> p_expected_version THEN RAISE EXCEPTION 'check changed since you opened it' USING ERRCODE = '40001'; END IF;
  IF NOT c.enabled THEN RAISE EXCEPTION 'this check is already off' USING ERRCODE = '22023'; END IF;
  -- An old request that ran out of time no longer blocks a new one.
  UPDATE kyc.disable_request SET status = 'expired', decided_at = clock_timestamp(), version = version + 1
   WHERE check_key = p_key AND status = 'pending' AND expires_at <= clock_timestamp();
  IF EXISTS (SELECT 1 FROM kyc.disable_request WHERE check_key = p_key AND status = 'pending') THEN
    RAISE EXCEPTION 'a request to turn this check off is already waiting for approval' USING ERRCODE = '22023';
  END IF;
  INSERT INTO kyc.disable_request (check_key, base_version, reason, maker_id)
  VALUES (p_key, c.version, r, a) RETURNING * INTO d;
  PERFORM audit.record('kyc.disable_requested', 'kyc_check', p_key, r, NULL, to_jsonb(d));
  RETURN kyc._request_view(d);
END $$;

-- Four-eyes. If the request ran out of time or the check changed since it
-- was made, it is closed as expired (and that is recorded) instead of applied.
CREATE FUNCTION api.kyc_disable_approve(p_id uuid, p_expected_version bigint, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('kyc.approve'); d kyc.disable_request; c kyc.check_setting;
        note text := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  IF length(note) > 2000 THEN RAISE EXCEPTION 'note is too long' USING ERRCODE = '22023'; END IF;
  PERFORM pg_advisory_xact_lock(7461002);
  d := kyc._lock_request(p_id, p_expected_version);
  IF d.maker_id = a THEN
    RAISE EXCEPTION 'four-eyes: you cannot approve your own request' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO c FROM kyc.check_setting WHERE check_key = d.check_key FOR UPDATE;
  IF d.expires_at <= clock_timestamp() OR c.version <> d.base_version OR NOT c.enabled THEN
    UPDATE kyc.disable_request
       SET status = 'expired', decided_at = clock_timestamp(), version = version + 1,
           decision_note = CASE WHEN d.expires_at <= clock_timestamp() THEN 'expired before approval'
                                ELSE 'the check changed after this request was made' END
     WHERE id = d.id RETURNING * INTO d;
    PERFORM audit.record('kyc.disable_expired', 'kyc_check', d.check_key, d.decision_note, NULL, to_jsonb(d));
    RETURN kyc._request_view(d);
  END IF;
  PERFORM kyc._apply(d.check_key, false, d.base_version, d.reason, a,
                     jsonb_build_object('request_id', d.id, 'requested_by', iam._email(d.maker_id)));
  UPDATE kyc.disable_request
     SET status = 'approved', checker_id = a, decision_note = note, decided_at = clock_timestamp(), version = version + 1
   WHERE id = d.id RETURNING * INTO d;
  PERFORM audit.record('kyc.disable_approved', 'kyc_check', d.check_key, note, NULL, to_jsonb(d));
  RETURN kyc._request_view(d);
END $$;

CREATE FUNCTION api.kyc_disable_reject(p_id uuid, p_expected_version bigint, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('kyc.approve'); r text := util.require_reason(p_note); d kyc.disable_request;
BEGIN
  d := kyc._lock_request(p_id, p_expected_version);
  IF d.maker_id = a THEN
    RAISE EXCEPTION 'you made this request: withdraw it instead' USING ERRCODE = '42501';
  END IF;
  UPDATE kyc.disable_request
     SET status = 'rejected', checker_id = a, decision_note = r, decided_at = clock_timestamp(), version = version + 1
   WHERE id = d.id RETURNING * INTO d;
  PERFORM audit.record('kyc.disable_rejected', 'kyc_check', d.check_key, r, NULL, to_jsonb(d));
  RETURN kyc._request_view(d);
END $$;

CREATE FUNCTION api.kyc_disable_withdraw(p_id uuid, p_expected_version bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('kyc.change'); d kyc.disable_request;
BEGIN
  d := kyc._lock_request(p_id, p_expected_version);
  IF d.maker_id <> a THEN
    RAISE EXCEPTION 'only the person who asked can withdraw a request' USING ERRCODE = '42501';
  END IF;
  UPDATE kyc.disable_request SET status = 'withdrawn', decided_at = clock_timestamp(), version = version + 1
   WHERE id = d.id RETURNING * INTO d;
  PERFORM audit.record('kyc.disable_withdrawn', 'kyc_check', d.check_key, NULL, NULL, to_jsonb(d));
  RETURN kyc._request_view(d);
END $$;

CREATE OR REPLACE FUNCTION api.kyc_view(p_history_limit integer DEFAULT 100) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE me uuid := iam.require('kyc.read');
BEGIN
  RETURN jsonb_build_object(
    'actor', iam._email(me),
    'can', jsonb_build_object('change', iam.has_permission(me, 'kyc.change'),
                              'approve', iam.has_permission(me, 'kyc.approve')),
    'settings', (SELECT jsonb_object_agg(check_key, enabled) || jsonb_build_object('updated_at', max(updated_at))
                 FROM kyc.check_setting),
    'versions', (SELECT jsonb_object_agg(check_key, version) FROM kyc.check_setting),
    'requests', coalesce((SELECT jsonb_agg(kyc._request_view(d) ORDER BY d.created_at DESC)
      FROM (SELECT * FROM kyc.disable_request
            WHERE status = 'pending' OR decided_at > clock_timestamp() - interval '30 days'
            ORDER BY created_at DESC LIMIT 50) d), '[]'),
    'history', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id', e.chain_pos, 'changed_at', e.occurred_at, 'check_key', e.resource_id,
        'old_value', (e.before->>'enabled')::boolean, 'new_value', (e.after->>'enabled')::boolean,
        'actor', coalesce(iam._email(e.actor_id), 'system'), 'reason', e.reason,
        'requested_by', e.after->>'requested_by') ORDER BY e.chain_pos DESC)
      FROM (SELECT * FROM audit.event WHERE action = 'kyc.check_changed'
            ORDER BY chain_pos DESC LIMIT least(greatest(coalesce(p_history_limit, 100), 1), 500)) e), '[]'));
END $$;

-- ============================================================ 3. ops health
CREATE SCHEMA ops;

-- Every chain verification, append-only. The head hash it records is also
-- written to the deployment's logs by the dispatcher: a copy outside this
-- database that a rewritten or truncated chain cannot match.
CREATE TABLE ops.chain_check (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  checked_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  mode          text NOT NULL CHECK (mode IN ('full','incremental')),
  from_pos      bigint NOT NULL,
  ok            boolean NOT NULL,
  checked       bigint NOT NULL,
  first_bad_pos bigint,
  head_pos      bigint,
  head_hash     text
);
CREATE INDEX chain_check_recent ON ops.chain_check (checked_at DESC);
CREATE TRIGGER chain_check_worm BEFORE UPDATE OR DELETE ON ops.chain_check
  FOR EACH ROW EXECUTE FUNCTION util.append_only();
CREATE TRIGGER chain_check_worm_trunc BEFORE TRUNCATE ON ops.chain_check
  FOR EACH STATEMENT EXECUTE FUNCTION util.append_only();

-- Full re-hash once a day (and whenever the last check failed); otherwise
-- only the rows added since the last good check, after confirming the row
-- that check ended on is still there with the same hash. Cost stays flat as
-- the log grows.
CREATE FUNCTION ops._verify_chain() RETURNS ops.chain_check
LANGUAGE plpgsql SET search_path = pg_catalog SET TimeZone = 'UTC' AS $$
DECLARE last ops.chain_check; lastfull timestamptz; v record; cur_hash text; maxpos bigint;
        v_mode text := 'full'; v_from bigint := 1; out ops.chain_check;
BEGIN
  SELECT * INTO last FROM ops.chain_check ORDER BY id DESC LIMIT 1;
  SELECT max(cc.checked_at) INTO lastfull FROM ops.chain_check cc WHERE cc.mode = 'full' AND cc.ok;
  SELECT max(chain_pos) INTO maxpos FROM audit.event;
  IF last.id IS NOT NULL AND last.ok AND last.head_pos IS NOT NULL
     AND lastfull > clock_timestamp() - interval '24 hours' THEN
    SELECT encode(hash, 'hex') INTO cur_hash FROM audit.event WHERE chain_pos = last.head_pos;
    IF cur_hash IS DISTINCT FROM last.head_hash OR coalesce(maxpos, 0) < last.head_pos THEN
      INSERT INTO ops.chain_check (mode, from_pos, ok, checked, first_bad_pos, head_pos, head_hash)
      VALUES ('incremental', last.head_pos, false, 0, last.head_pos, maxpos, NULL) RETURNING * INTO out;
      RETURN out;
    END IF;
    v_mode := 'incremental'; v_from := last.head_pos;  -- re-hash the anchor row too
  END IF;
  SELECT * INTO v FROM audit.verify_chain(v_from);
  INSERT INTO ops.chain_check (mode, from_pos, ok, checked, first_bad_pos, head_pos, head_hash)
  VALUES (v_mode, v_from, v.ok, v.checked, v.first_bad_pos,
          CASE WHEN v.ok THEN nullif(v_from + v.checked - 1, 0) END, CASE WHEN v.ok THEN v.head_hash END)
  RETURNING * INTO out;
  RETURN out;
END $$;

-- Counts and hashes only: no payloads, no personal data.
CREATE FUNCTION ops._snapshot() RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE c ops.chain_check; o record; k bigint; alerts text[] := '{}';
BEGIN
  SELECT * INTO c FROM ops.chain_check ORDER BY id DESC LIMIT 1;
  SELECT count(*) FILTER (WHERE dispatched_at IS NULL AND failed_at IS NULL) AS pending,
         count(*) FILTER (WHERE failed_at IS NOT NULL) AS dead,
         extract(epoch FROM clock_timestamp() - min(created_at) FILTER (WHERE dispatched_at IS NULL AND failed_at IS NULL))::bigint AS oldest_pending_s,
         max(dispatched_at) AS last_dispatched_at
    INTO o FROM outbox.event;
  SELECT count(*) INTO k FROM kyc.disable_request WHERE status = 'pending' AND expires_at > clock_timestamp();

  IF c.id IS NULL THEN alerts := array_append(alerts, 'The audit log has never been verified');
  ELSIF NOT c.ok THEN alerts := array_append(alerts, format('The audit log failed verification at position %s', c.first_bad_pos));
  ELSIF c.checked_at < clock_timestamp() - interval '26 hours' THEN alerts := array_append(alerts, 'The audit log has not been verified for over a day');
  END IF;
  IF o.dead > 0 THEN alerts := array_append(alerts, format('%s change(s) could not be delivered to the borrower app after 12 tries', o.dead)); END IF;
  IF o.oldest_pending_s > 7200 THEN alerts := array_append(alerts, format('A change has waited %s hours to reach the borrower app', o.oldest_pending_s / 3600)); END IF;

  RETURN jsonb_build_object(
    'healthy', cardinality(alerts) = 0, 'alerts', to_jsonb(alerts), 'at', clock_timestamp(),
    'outbox', jsonb_build_object('pending', o.pending, 'dead', o.dead, 'oldest_pending_s', o.oldest_pending_s,
                                 'last_dispatched_at', o.last_dispatched_at),
    'chain', CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object(
               'ok', c.ok, 'mode', c.mode, 'checked', c.checked, 'first_bad_pos', c.first_bad_pos,
               'head_pos', c.head_pos, 'head_hash', c.head_hash, 'checked_at', c.checked_at) END,
    'kyc_requests_pending', k);
END $$;

-- Dispatcher (hourly): verify, then report.
CREATE FUNCTION api.ops_health_check() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(7461003);  -- one verification at a time
  PERFORM ops._verify_chain();
  RETURN ops._snapshot();
END $$;

-- Staff (audit.read): the latest state; no verification on a page view.
CREATE FUNCTION api.ops_health_view() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM iam.require('audit.read');
  RETURN ops._snapshot();
END $$;

-- ============================================================ grants
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA kyc, ops, api FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  api.kyc_disable_request(text, bigint, text), api.kyc_disable_approve(uuid, bigint, text),
  api.kyc_disable_reject(uuid, bigint, text), api.kyc_disable_withdraw(uuid, bigint),
  api.ops_health_view()
  TO app_admin_api;
GRANT EXECUTE ON FUNCTION api.ops_health_check() TO app_admin_dispatcher;
GRANT USAGE ON SCHEMA ops TO app_admin_readonly;
GRANT SELECT ON kyc.disable_request, ops.chain_check TO app_admin_readonly;
