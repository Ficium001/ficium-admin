-- 0010_app_release.sql — mobile app release policy, admin side (KJ, 2026-11-16).
--
-- The iOS and Android apps carry their screens inside the installed binary, so old versions stay
-- in use after a new one ships. This is where Ficium decides which versions may still run.
-- Per platform:
--   latest_version  the version that is live in the store (recorded here when it goes live)
--   min_version     the lowest version allowed to run; anything older must update first
--   store_url       where the "Update now" button sends the user
--
-- Raising min_version locks out every customer on an older version, so every change is four-eyes:
-- one admin (release.request) asks with a reason, a DIFFERENT admin (release.approve) approves.
-- A request expires after 72 hours. The database refuses a minimum above the latest released
-- version: nobody can be told to update to something that is not in the store.
-- On approval the policy reaches the borrower app through the outbox (topic
-- app.release_policy_changed, one version per platform); the apps read it from there.
SET LOCAL ROLE app_admin_owner;
SET LOCAL search_path = pg_catalog;

INSERT INTO iam.permission (code, description) VALUES
  ('release.view',    'See the mobile app release policy and which app versions are in use'),
  ('release.request', 'Ask to change the mobile app release policy'),
  ('release.approve', 'Approve or reject a release policy change (never your own request)');
INSERT INTO iam.role_permission (role_code, permission_code) VALUES
  ('super_admin', 'release.view'), ('compliance', 'release.view'), ('operations', 'release.view'), ('read_only', 'release.view'),
  ('super_admin', 'release.request'), ('operations', 'release.request'),
  ('super_admin', 'release.approve'), ('compliance', 'release.approve');

CREATE SCHEMA release AUTHORIZATION app_admin_owner;

-- "1.4.2" only: three numeric parts, so two versions always compare the same way everywhere.
CREATE FUNCTION release._parts(p_version text) RETURNS int[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE WHEN p_version ~ '^[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}$'
              THEN string_to_array(p_version, '.')::int[] END
$$;

-- The store page for that platform, or empty until the listing exists. Nothing else: the apps
-- also refuse any other host, so the update button can never lead anywhere but the store.
CREATE FUNCTION release._store_url_ok(p_platform text, p_url text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT p_url = '' OR (length(p_url) <= 300 AND p_url !~ '[[:space:]]' AND CASE p_platform
    WHEN 'ios'     THEN p_url ~ '^https://apps\.apple\.com/[A-Za-z0-9/._?=&%-]+$'
    WHEN 'android' THEN p_url ~ '^https://play\.google\.com/store/apps/details\?id=[A-Za-z0-9._]+$'
    ELSE false END)
$$;

CREATE TABLE release.policy (
  platform       text PRIMARY KEY CHECK (platform IN ('ios', 'android')),
  latest_version text NOT NULL CHECK (release._parts(latest_version) IS NOT NULL),
  min_version    text NOT NULL CHECK (release._parts(min_version) IS NOT NULL),
  store_url      text NOT NULL DEFAULT '',
  version        bigint NOT NULL DEFAULT 0,   -- 0 = as seeded, never synced; each approval adds 1
  updated_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by     uuid REFERENCES iam.admin_user(id),
  CHECK (release._parts(min_version) <= release._parts(latest_version)),
  CHECK (release._store_url_ok(platform, store_url))
);
-- Same starting values as the borrower app's own seed, so both sides agree before the first change.
INSERT INTO release.policy (platform, latest_version, min_version, store_url) VALUES
  ('ios',     '1.0.0', '1.0.0', ''),
  ('android', '1.0.0', '1.0.0', 'https://play.google.com/store/apps/details?id=net.ficium.app');

CREATE TABLE release.change_request (
  id             uuid PRIMARY KEY DEFAULT util.uuid_v7(),
  platform       text NOT NULL REFERENCES release.policy(platform),
  latest_version text NOT NULL CHECK (release._parts(latest_version) IS NOT NULL),
  min_version    text NOT NULL CHECK (release._parts(min_version) IS NOT NULL),
  store_url      text NOT NULL,
  before         jsonb NOT NULL,              -- the policy when the request was made
  reason         text NOT NULL CHECK (length(reason) BETWEEN 10 AND 2000),
  status         text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','approved','rejected','withdrawn','expired')),
  maker_id       uuid NOT NULL REFERENCES iam.admin_user(id),
  checker_id     uuid REFERENCES iam.admin_user(id),
  decision_note  text CHECK (decision_note IS NULL OR length(decision_note) <= 2000),
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at     timestamptz NOT NULL DEFAULT clock_timestamp() + interval '72 hours',
  decided_at     timestamptz,
  version        bigint NOT NULL DEFAULT 1,
  CHECK (release._parts(min_version) <= release._parts(latest_version)),
  CHECK (release._store_url_ok(platform, store_url)),
  CHECK (checker_id IS NULL OR checker_id <> maker_id),
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK (status NOT IN ('approved','rejected') OR checker_id IS NOT NULL)
);
CREATE UNIQUE INDEX change_request_one_pending ON release.change_request (platform) WHERE status = 'pending';
CREATE INDEX change_request_recent ON release.change_request (created_at DESC);

CREATE FUNCTION release._policy_view(p release.policy) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object(
    'platform', p.platform, 'latest_version', p.latest_version, 'min_version', p.min_version,
    'store_url', p.store_url, 'version', p.version, 'updated_at', p.updated_at,
    'updated_by', iam._email(p.updated_by))
$$;

CREATE FUNCTION release._view(d release.change_request) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object(
    'id', d.id, 'platform', d.platform,
    'latest_version', d.latest_version, 'min_version', d.min_version, 'store_url', d.store_url,
    'before', d.before, 'reason', d.reason,
    'status', CASE WHEN d.status = 'pending' AND d.expires_at <= clock_timestamp() THEN 'expired' ELSE d.status END,
    'maker', iam._email(d.maker_id), 'checker', iam._email(d.checker_id),
    'decision_note', d.decision_note, 'created_at', d.created_at, 'expires_at', d.expires_at,
    'decided_at', d.decided_at, 'version', d.version, 'mine', d.maker_id = iam.current_admin())
$$;

CREATE FUNCTION release._lock(p_id uuid, p_expected_version bigint) RETURNS release.change_request
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE d release.change_request;
BEGIN
  SELECT * INTO d FROM release.change_request WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown request' USING ERRCODE = 'P0002'; END IF;
  IF d.version <> p_expected_version THEN
    RAISE EXCEPTION 'request changed since you opened it' USING ERRCODE = '40001';
  END IF;
  IF d.status <> 'pending' THEN
    RAISE EXCEPTION 'this request is already %', d.status USING ERRCODE = '22023';
  END IF;
  RETURN d;
END $$;

-- The whole page: current policy per platform, and the last 50 requests.
CREATE FUNCTION api.release_view() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE me uuid := iam.require('release.view');
BEGIN
  RETURN jsonb_build_object(
    'actor', iam._email(me),
    'can_request', iam.has_permission(me, 'release.request'),
    'can_approve', iam.has_permission(me, 'release.approve'),
    'policy', (SELECT jsonb_agg(release._policy_view(p) ORDER BY p.platform) FROM release.policy p),
    'requests', coalesce((SELECT jsonb_agg(release._view(d) ORDER BY d.created_at DESC)
                            FROM (SELECT * FROM release.change_request ORDER BY created_at DESC LIMIT 50) d), '[]'::jsonb));
END $$;

CREATE FUNCTION api.release_request(p_platform text, p_latest_version text, p_min_version text, p_store_url text, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('release.request'); r text := util.require_reason(p_reason);
        cur release.policy; url text := btrim(coalesce(p_store_url, '')); d release.change_request;
BEGIN
  SELECT * INTO cur FROM release.policy WHERE platform = p_platform FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'platform must be ios or android' USING ERRCODE = '22023'; END IF;
  IF release._parts(p_latest_version) IS NULL OR release._parts(p_min_version) IS NULL THEN
    RAISE EXCEPTION 'versions must look like 1.4.2' USING ERRCODE = '22023';
  END IF;
  IF release._parts(p_min_version) > release._parts(p_latest_version) THEN
    RAISE EXCEPTION 'the minimum version cannot be higher than the latest released version (%): customers would be told to update to a version that is not in the store', p_latest_version
      USING ERRCODE = '22023';
  END IF;
  IF NOT release._store_url_ok(p_platform, url) THEN
    RAISE EXCEPTION 'the store link must be this app''s % page, or empty', CASE p_platform WHEN 'ios' THEN 'App Store (https://apps.apple.com/...)' ELSE 'Google Play (https://play.google.com/store/apps/details?id=...)' END
      USING ERRCODE = '22023';
  END IF;
  IF cur.latest_version = p_latest_version AND cur.min_version = p_min_version AND cur.store_url = url THEN
    RAISE EXCEPTION 'nothing would change' USING ERRCODE = '22023';
  END IF;
  UPDATE release.change_request SET status = 'expired', decided_at = clock_timestamp(), version = version + 1
   WHERE platform = p_platform AND status = 'pending' AND expires_at <= clock_timestamp();
  IF EXISTS (SELECT 1 FROM release.change_request WHERE platform = p_platform AND status = 'pending') THEN
    RAISE EXCEPTION 'a change for this platform is already waiting for approval' USING ERRCODE = '22023';
  END IF;
  INSERT INTO release.change_request (platform, latest_version, min_version, store_url, before, reason, maker_id)
  VALUES (p_platform, p_latest_version, p_min_version, url,
          jsonb_build_object('latest_version', cur.latest_version, 'min_version', cur.min_version, 'store_url', cur.store_url),
          r, a)
  RETURNING * INTO d;
  PERFORM audit.record('release.change_requested', 'app_release', p_platform, r, d.before, to_jsonb(d));
  RETURN release._view(d);
END $$;

CREATE FUNCTION api.release_approve(p_id uuid, p_expected_version bigint, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('release.approve'); d release.change_request; p release.policy;
        note text := nullif(btrim(coalesce(p_note, '')), ''); ev uuid;
BEGIN
  IF length(note) > 2000 THEN RAISE EXCEPTION 'note is too long' USING ERRCODE = '22023'; END IF;
  d := release._lock(p_id, p_expected_version);
  IF d.maker_id = a THEN
    RAISE EXCEPTION 'four-eyes: you cannot approve your own request' USING ERRCODE = '42501';
  END IF;
  IF d.expires_at <= clock_timestamp() THEN
    UPDATE release.change_request
       SET status = 'expired', decided_at = clock_timestamp(), version = version + 1,
           decision_note = 'expired before approval'
     WHERE id = d.id RETURNING * INTO d;
    PERFORM audit.record('release.change_expired', 'app_release', d.platform, d.decision_note, NULL, to_jsonb(d));
    RETURN release._view(d);
  END IF;
  UPDATE release.change_request
     SET status = 'approved', checker_id = a, decision_note = note, decided_at = clock_timestamp(), version = version + 1
   WHERE id = d.id RETURNING * INTO d;
  -- Only one request per platform can be pending, so the policy cannot have moved under this one.
  UPDATE release.policy
     SET latest_version = d.latest_version, min_version = d.min_version, store_url = d.store_url,
         version = version + 1, updated_at = clock_timestamp(), updated_by = a
   WHERE platform = d.platform RETURNING * INTO p;
  ev := audit.record('release.change_approved', 'app_release', d.platform, d.reason, d.before, to_jsonb(d));
  PERFORM outbox.enqueue('app.release_policy_changed', 'app_release', d.platform, p.version,
    jsonb_build_object('platform', p.platform, 'latest_version', p.latest_version, 'min_version', p.min_version,
                       'store_url', p.store_url, 'version', p.version, 'request_id', d.id,
                       'requested_by', iam._email(d.maker_id), 'approved_by', iam._email(a),
                       'approved_at', d.decided_at), ev);
  RETURN release._view(d);
END $$;

CREATE FUNCTION api.release_reject(p_id uuid, p_expected_version bigint, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('release.approve'); r text := util.require_reason(p_note); d release.change_request;
BEGIN
  d := release._lock(p_id, p_expected_version);
  IF d.maker_id = a THEN
    RAISE EXCEPTION 'you made this request: withdraw it instead' USING ERRCODE = '42501';
  END IF;
  UPDATE release.change_request
     SET status = 'rejected', checker_id = a, decision_note = r, decided_at = clock_timestamp(), version = version + 1
   WHERE id = d.id RETURNING * INTO d;
  PERFORM audit.record('release.change_rejected', 'app_release', d.platform, r, NULL, to_jsonb(d));
  RETURN release._view(d);
END $$;

CREATE FUNCTION api.release_withdraw(p_id uuid, p_expected_version bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('release.request'); d release.change_request;
BEGIN
  d := release._lock(p_id, p_expected_version);
  IF d.maker_id <> a THEN
    RAISE EXCEPTION 'only the admin who asked can withdraw a request' USING ERRCODE = '42501';
  END IF;
  UPDATE release.change_request
     SET status = 'withdrawn', decided_at = clock_timestamp(), version = version + 1
   WHERE id = d.id RETURNING * INTO d;
  PERFORM audit.record('release.change_withdrawn', 'app_release', d.platform, NULL, NULL, to_jsonb(d));
  RETURN release._view(d);
END $$;

REVOKE ALL ON SCHEMA release FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA release, api FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.release_view(), api.release_request(text, text, text, text, text),
  api.release_approve(uuid, bigint, text), api.release_reject(uuid, bigint, text),
  api.release_withdraw(uuid, bigint) TO app_admin_api;
GRANT USAGE ON SCHEMA release TO app_admin_readonly;
GRANT SELECT ON release.policy, release.change_request TO app_admin_readonly;
