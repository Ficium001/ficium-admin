-- 0012_credentials.sql — register of keys and tokens, with their expiry dates (KJ, 2026-11-19).
--
-- On 2026-11-19 the borrower app's GitHub build token expired and every deploy started failing.
-- Nothing in Ficium knew that token had a date. This is where each key and token this site and the bank portal depends
-- on is listed: what it is for, where it is kept, who owns it, and when it must be replaced.
--
-- It records names, places and dates ONLY. The values stay in Doppler (or Railway, or GitHub
-- secrets), which remains the one place secrets live: the database refuses anything that looks
-- like a key, a token, a private key or a connection string with a password in it.
--
-- Due date = the expiry date, or last rotation + the rotation period, whichever comes first.
-- 14 days before it, the Services page and the Audit health banner turn amber; after it, red.
-- Adding, changing and retiring an entry needs credential.manage and a reason, and is audited.
-- One admin is enough: an entry changes no system, it only describes one.
SET LOCAL ROLE portal_admin_owner;
SET LOCAL search_path = pg_catalog;

INSERT INTO iam.permission (code, description) VALUES
  ('credential.view',   'See the register of keys and tokens: where each is kept and when it expires'),
  ('credential.manage', 'Add, update and retire entries in the register of keys and tokens');
INSERT INTO iam.role_permission (role_code, permission_code) VALUES
  ('super_admin', 'credential.view'), ('compliance', 'credential.view'), ('operations', 'credential.view'), ('read_only', 'credential.view'),
  ('super_admin', 'credential.manage'), ('operations', 'credential.manage');

CREATE SCHEMA credential AUTHORIZATION portal_admin_owner;

-- True when text looks like a secret VALUE rather than a description of one: well-known key
-- prefixes, a private key block, a JWT, a connection string with a password, or any unbroken run of
-- 40+ key-like characters. The register must never become a place where secrets are pasted.
CREATE FUNCTION credential._looks_secret(t text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT coalesce(t, '') ~ '(ghp_|gho_|ghs_|ghu_|ghr_|github_pat_|glpat-|sk-ant-|sk_live_|sk_test_|rk_live_|xox[abprs]-|AKIA[0-9A-Z]{12}|ASIA[0-9A-Z]{12}|AIza[0-9A-Za-z_-]{20}|-----BEGIN|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})'
      OR coalesce(t, '') ~* '[a-z][a-z0-9+.-]*://[^[:space:]/:@]+:[^[:space:]@]+@'
      OR coalesce(t, '') ~ '[A-Za-z0-9+/=_-]{40,}'
$$;

-- "Today" in Mauritius, where Ficium operates: a key due on the 20th is due all of the 20th.
CREATE FUNCTION credential._today() RETURNS date
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT (clock_timestamp() AT TIME ZONE 'Indian/Mauritius')::date
$$;

-- What each key is, where it is kept and when it must be replaced. NEVER the key itself.
CREATE TABLE credential.item (
  key               text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{2,59}$'),
  label             text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 100),
  kind              text NOT NULL CHECK (kind IN ('api_key','token','signing_key','password','certificate','account')),
  purpose           text NOT NULL CHECK (length(btrim(purpose)) BETWEEN 1 AND 400),
  env_names         text NOT NULL DEFAULT '' CHECK (length(env_names) <= 300 AND env_names ~ '^[A-Za-z0-9_ ,()/.-]*$'),
  stored_in         text NOT NULL CHECK (length(btrim(stored_in)) BETWEEN 1 AND 200),
  used_by           text NOT NULL CHECK (length(btrim(used_by)) BETWEEN 1 AND 200),
  owner             text NOT NULL DEFAULT '' CHECK (length(owner) <= 120),
  expires_on        date,                    -- the date the issuer will stop accepting it, when there is one
  rotated_on        date,                    -- when it was last replaced
  rotate_every_days int CHECK (rotate_every_days IS NULL OR rotate_every_days BETWEEN 7 AND 3650),
  note              text NOT NULL DEFAULT '' CHECK (length(note) <= 1000),
  retired_at        timestamptz,             -- no longer in use: kept for the record, never alarms
  version           bigint NOT NULL DEFAULT 0,
  updated_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by        uuid REFERENCES iam.admin_user(id),
  CHECK (NOT credential._looks_secret(label || ' ' || purpose || ' ' || stored_in || ' ' || used_by || ' ' || owner || ' ' || note))
);

-- The date it must be replaced by: its expiry, or the end of its rotation period, whichever is first.
CREATE FUNCTION credential._due(i credential.item) RETURNS date
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT least(i.expires_on, i.rotated_on + i.rotate_every_days)
$$;

-- expired: past due. due_soon: within 14 days. no_date: nothing recorded to judge by. ok.
CREATE FUNCTION credential._state(i credential.item) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT CASE
    WHEN i.retired_at IS NOT NULL THEN 'retired'
    WHEN credential._due(i) IS NULL THEN 'no_date'
    WHEN credential._due(i) < credential._today() THEN 'expired'
    WHEN credential._due(i) <= credential._today() + 14 THEN 'due_soon'
    ELSE 'ok' END
$$;

CREATE FUNCTION credential._view(i credential.item) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object(
    'key', i.key, 'label', i.label, 'kind', i.kind, 'purpose', i.purpose, 'env_names', i.env_names,
    'stored_in', i.stored_in, 'used_by', i.used_by, 'owner', i.owner,
    'expires_on', i.expires_on, 'rotated_on', i.rotated_on, 'rotate_every_days', i.rotate_every_days,
    'due_on', credential._due(i), 'days_left', credential._due(i) - credential._today(),
    'state', credential._state(i), 'note', i.note, 'retired_at', i.retired_at,
    'version', i.version, 'updated_at', i.updated_at, 'updated_by', iam._email(i.updated_by))
$$;

CREATE FUNCTION credential._check(p_key text, p_label text, p_kind text, p_purpose text, p_env_names text,
  p_stored_in text, p_used_by text, p_owner text, p_expires_on date, p_rotated_on date, p_rotate_every_days int, p_note text)
RETURNS void LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
BEGIN
  IF p_key IS NULL OR p_key !~ '^[a-z][a-z0-9_]{2,59}$' THEN
    RAISE EXCEPTION 'the short name must be 3 to 60 lowercase letters, digits or _' USING ERRCODE = '22023';
  END IF;
  IF coalesce(p_kind, '') NOT IN ('api_key','token','signing_key','password','certificate','account') THEN
    RAISE EXCEPTION 'choose what kind of key this is' USING ERRCODE = '22023';
  END IF;
  IF length(btrim(coalesce(p_label, ''))) = 0 OR length(btrim(coalesce(p_purpose, ''))) = 0
     OR length(btrim(coalesce(p_stored_in, ''))) = 0 OR length(btrim(coalesce(p_used_by, ''))) = 0 THEN
    RAISE EXCEPTION 'name, purpose, where it is kept and what uses it are all required' USING ERRCODE = '22023';
  END IF;
  IF coalesce(p_env_names, '') !~ '^[A-Za-z0-9_ ,()/.-]*$' THEN
    RAISE EXCEPTION 'setting names may only contain letters, digits, _ and commas' USING ERRCODE = '22023';
  END IF;
  IF credential._looks_secret(concat_ws(' ', p_label, p_purpose, p_env_names, p_stored_in, p_used_by, p_owner, p_note)) THEN
    RAISE EXCEPTION 'this looks like a secret value. Record where it is kept, never the value itself' USING ERRCODE = '22023';
  END IF;
  IF p_rotated_on > credential._today() THEN
    RAISE EXCEPTION 'the last rotation cannot be in the future' USING ERRCODE = '22023';
  END IF;
  IF p_rotate_every_days IS NOT NULL AND p_rotate_every_days NOT BETWEEN 7 AND 3650 THEN
    RAISE EXCEPTION 'rotate every 7 to 3650 days, or leave it empty' USING ERRCODE = '22023';
  END IF;
END $$;

-- The whole page: entries in use (most urgent first) and retired ones.
CREATE FUNCTION api.credential_view() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE me uuid := iam.require('credential.view');
BEGIN
  RETURN jsonb_build_object(
    'actor', iam._email(me),
    'can_manage', iam.has_permission(me, 'credential.manage'),
    'today', credential._today(),
    'items', coalesce((SELECT jsonb_agg(credential._view(i)
        ORDER BY CASE credential._state(i) WHEN 'expired' THEN 0 WHEN 'due_soon' THEN 1 WHEN 'no_date' THEN 2 ELSE 3 END,
                 credential._due(i) NULLS LAST, i.label)
      FROM credential.item i WHERE i.retired_at IS NULL), '[]'::jsonb),
    'retired', coalesce((SELECT jsonb_agg(credential._view(i) ORDER BY i.retired_at DESC)
      FROM credential.item i WHERE i.retired_at IS NOT NULL), '[]'::jsonb));
END $$;

-- Adds an entry (p_expected_version NULL) or updates one (the version the editor saw).
CREATE FUNCTION api.credential_save(p_key text, p_expected_version bigint, p_label text, p_kind text, p_purpose text,
  p_env_names text, p_stored_in text, p_used_by text, p_owner text, p_expires_on date, p_rotated_on date,
  p_rotate_every_days int, p_note text, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('credential.manage'); r text := util.require_reason(p_reason);
        cur credential.item; d credential.item;
BEGIN
  PERFORM credential._check(p_key, p_label, p_kind, p_purpose, p_env_names, p_stored_in, p_used_by, p_owner,
                            p_expires_on, p_rotated_on, p_rotate_every_days, p_note);
  SELECT * INTO cur FROM credential.item WHERE key = p_key FOR UPDATE;
  IF p_expected_version IS NULL THEN
    IF FOUND THEN RAISE EXCEPTION 'an entry with this short name already exists' USING ERRCODE = '23505'; END IF;
    INSERT INTO credential.item (key, label, kind, purpose, env_names, stored_in, used_by, owner,
                                 expires_on, rotated_on, rotate_every_days, note, version, updated_by)
    VALUES (p_key, btrim(p_label), p_kind, btrim(p_purpose), btrim(coalesce(p_env_names, '')), btrim(p_stored_in),
            btrim(p_used_by), btrim(coalesce(p_owner, '')), p_expires_on, p_rotated_on, p_rotate_every_days,
            btrim(coalesce(p_note, '')), 1, a)
    RETURNING * INTO d;
    PERFORM audit.record('credential.added', 'credential', d.key, r, NULL, credential._view(d));
    RETURN credential._view(d);
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown entry' USING ERRCODE = 'P0002'; END IF;
  IF cur.version <> p_expected_version THEN
    RAISE EXCEPTION 'this entry changed since you opened it' USING ERRCODE = '40001';
  END IF;
  IF cur.retired_at IS NOT NULL THEN RAISE EXCEPTION 'this entry is retired' USING ERRCODE = '22023'; END IF;
  UPDATE credential.item SET
    label = btrim(p_label), kind = p_kind, purpose = btrim(p_purpose), env_names = btrim(coalesce(p_env_names, '')),
    stored_in = btrim(p_stored_in), used_by = btrim(p_used_by), owner = btrim(coalesce(p_owner, '')),
    expires_on = p_expires_on, rotated_on = p_rotated_on, rotate_every_days = p_rotate_every_days,
    note = btrim(coalesce(p_note, '')), version = version + 1, updated_at = clock_timestamp(), updated_by = a
   WHERE key = p_key RETURNING * INTO d;
  PERFORM audit.record('credential.updated', 'credential', d.key, r, credential._view(cur), credential._view(d));
  RETURN credential._view(d);
END $$;

CREATE FUNCTION api.credential_retire(p_key text, p_expected_version bigint, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('credential.manage'); r text := util.require_reason(p_reason);
        cur credential.item; d credential.item;
BEGIN
  SELECT * INTO cur FROM credential.item WHERE key = p_key FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown entry' USING ERRCODE = 'P0002'; END IF;
  IF cur.version <> p_expected_version THEN
    RAISE EXCEPTION 'this entry changed since you opened it' USING ERRCODE = '40001';
  END IF;
  IF cur.retired_at IS NOT NULL THEN RAISE EXCEPTION 'this entry is already retired' USING ERRCODE = '22023'; END IF;
  UPDATE credential.item SET retired_at = clock_timestamp(), version = version + 1,
         updated_at = clock_timestamp(), updated_by = a
   WHERE key = p_key RETURNING * INTO d;
  PERFORM audit.record('credential.retired', 'credential', d.key, r, credential._view(cur), credential._view(d));
  RETURN credential._view(d);
END $$;

-- For the Services row, the Audit health banner. Names and dates only, never
-- anything secret, so it needs no staff permission; only the backend roles may execute it.
CREATE FUNCTION api.credential_alerts() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object(
    'today', credential._today(),
    'expired',  coalesce(jsonb_agg(jsonb_build_object('label', i.label, 'due_on', credential._due(i)) ORDER BY credential._due(i))
                  FILTER (WHERE credential._state(i) = 'expired'), '[]'::jsonb),
    'due_soon', coalesce(jsonb_agg(jsonb_build_object('label', i.label, 'due_on', credential._due(i)) ORDER BY credential._due(i))
                  FILTER (WHERE credential._state(i) = 'due_soon'), '[]'::jsonb),
    'no_date',  count(*) FILTER (WHERE credential._state(i) = 'no_date'),
    'tracked',  count(*))
  FROM credential.item i WHERE i.retired_at IS NULL
$$;

-- Every key the code reads, with where it is kept. No dates: nobody has recorded them yet, so each
-- starts as "No date recorded". Version 0 = as seeded.
INSERT INTO credential.item (key, label, kind, purpose, env_names, stored_in, used_by, rotate_every_days, note) VALUES
  ('portal_db_login', 'Portal database login', 'password', 'The portal API''s login to the portal database.', 'DATABASE_URL', 'Railway (ficium-portal-api)', 'Portal API', 365, 'The password sits inside the connection string.'),
  ('portal_app_db_login', 'Borrower database login for the portal', 'password', 'The portal API''s login to the borrower app database.', 'APP_DATABASE_URL', 'Railway (ficium-portal-api)', 'Portal API', 365, ''),
  ('portal_ci_db_logins', 'Database logins for portal checks', 'password', 'Let the portal API''s scheduled checks reach the portal and borrower databases.', 'PORTAL_DB_DSN, APP_DB_DSN', 'GitHub Actions secrets (ficium-portal-api)', 'Portal API checks', 365, ''),
  ('portal_integration_keys', 'Portal and borrower app signing keys', 'signing_key', 'Sign and check the events and the bid-acceptance call between the bank portal and the borrower app.', 'B2I_SIGNING_KEY, I2B_SIGNING_KEY, ACCEPT_SIGNING_KEY', 'Railway (ficium-portal-api)', 'Portal API and the borrower app', 365, 'Pairs with the borrower app''s INTEGRATION keys. Verify lists take two keys, so add the new one before removing the old. Also listed on the app admin site.'),
  ('app_service_secret', 'Portal and borrower app service secret', 'password', 'Lets the portal API call the borrower app''s service endpoints.', 'APP_SERVICE_SECRET', 'Railway (ficium-portal-api) and Doppler (borrower app)', 'Portal API and borrower app', 365, 'The same value in both places: change both together. Also listed on the app admin site.'),
  ('admin_portal_signing_key', 'Admin channel signing key', 'signing_key', 'Signs every read and command this site sends to the portal API.', 'ADMIN_PORTAL_SIGNING_KEY', 'Doppler, synced to Vercel (portal admin), and Railway (ficium-portal-api)', 'This site and the portal API', 365, 'The same value in both places: change both together.'),
  ('portal_admin_db_login', 'Admin database login', 'password', 'This site''s login to its own database (portal_admin).', 'ADMIN_DB_API_URL', 'Doppler, synced to Vercel (portal admin)', 'This site', 365, 'The password sits inside the connection string. Reset the role in Neon, then update Doppler.'),
  ('auth_signing_key', 'Sign-in token signing key', 'signing_key', 'Signs every staff and user sign-in token. Every Ficium site checks tokens against its public half.', 'JWT_PRIVATE_KEY, JWT_PUBLIC_KEY', 'Railway (ficium-auth)', 'Sign-in service, checked by every site', 365, 'Does not expire. To rotate without signing everyone out, keep the old public key published for 8 hours. Also listed on the app admin site.'),
  ('auth_service_logins', 'Sign-in service database and cache passwords', 'password', 'The sign-in service''s logins to its own database and to Redis.', 'DB_URL, REDIS_URL, REDIS_PASSWORD', 'Railway (ficium-auth)', 'Sign-in service', 365, 'Also listed on the app admin site.'),
  ('github_status_token', 'GitHub deploy status token', 'token', 'Lets the Services page read whether each latest production deploy succeeded.', 'GITHUB_STATUS_TOKEN', 'Doppler, synced to Vercel (both admin sites)', 'Services page on both admin sites', NULL, 'Fine-grained token, owner Ficium001, deploy repositories only, Commit statuses read-only. GitHub sets an expiry date when it is made: record it here. Also listed on the app admin site.');

REVOKE ALL ON SCHEMA credential FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA credential FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION api.credential_view(), api.credential_save(text, bigint, text, text, text, text, text, text, text, date, date, int, text, text),
  api.credential_retire(text, bigint, text), api.credential_alerts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.credential_view(), api.credential_save(text, bigint, text, text, text, text, text, text, text, date, date, int, text, text),
  api.credential_retire(text, bigint, text), api.credential_alerts() TO portal_admin_api;
GRANT USAGE ON SCHEMA credential TO portal_admin_readonly;
GRANT SELECT ON credential.item TO portal_admin_readonly;
