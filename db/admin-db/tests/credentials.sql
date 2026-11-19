-- Exercises the register of keys and tokens (app_admin 0013 / portal_admin 0012) end to end:
-- seeds, the "never a secret value" guard, due dates and states, optimistic locking, retiring,
-- permissions, alerts, the audit chain and the backend role's lack of table access.
--
-- Run against a SCRATCH database only (it creates admins). From db/admin-db, for either database:
--   OPERATOR_URL=postgres://<operator>@localhost/postgres ./migrate.sh cluster
--   OPERATOR_URL=postgres://<operator>@localhost/postgres ./migrate.sh app_admin
--   psql postgres://<operator>@localhost/app_admin -X -q -t -v db=app_admin -f tests/credentials.sql
--   (and the same with portal_admin)
-- Every line of output is "t" or "ok   refused: ..."; any error stops the run.
\set ON_ERROR_STOP 1
\set QUIET 1
SELECT :'db' || '_owner' AS owner_role, :'db' || '_api' AS api_role \gset
SET ROLE :owner_role;
SELECT iam.bootstrap_super_admin('kj@ficium.net', 'KJ') AS kj \gset
INSERT INTO iam.admin_user (email, display_name) VALUES ('ro@ficium.net', 'RO') RETURNING id AS ro \gset
INSERT INTO iam.user_role (user_id, role_code) VALUES (:'ro', 'read_only');
RESET ROLE;

CREATE OR REPLACE FUNCTION pg_temp.expect_error(p_sql text, p_like text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RAISE EXCEPTION 'EXPECTED FAILURE but succeeded: %', p_sql;
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM LIKE 'EXPECTED FAILURE%' THEN RAISE; END IF;
  IF SQLERRM NOT ILIKE '%' || p_like || '%' THEN RAISE EXCEPTION 'wrong error for %: %', p_sql, SQLERRM; END IF;
  RETURN 'ok   refused: ' || SQLERRM;
END $$;

-- 1. seeded entries all start with no date, and alerts say so
BEGIN;
SELECT api.begin_session('sub-kj', 'kj@ficium.net', 'r1', '10.0.0.1', 'test') \gset s_
SELECT jsonb_array_length(api.credential_view()->'items') >= 10 AS "seeded entries listed",
       NOT EXISTS (SELECT 1 FROM jsonb_array_elements(api.credential_view()->'items') e WHERE e->>'state' <> 'no_date') AS "all start with no date",
       (api.credential_view()->>'can_manage')::boolean AS "super admin can manage";
SELECT (api.credential_alerts()->>'no_date')::int = (api.credential_alerts()->>'tracked')::int AS "alerts count missing dates",
       jsonb_array_length(api.credential_alerts()->'expired') = 0 AS "nothing expired yet";
COMMIT;

-- 2. the register refuses secret values, wherever they are pasted
BEGIN;
SELECT api.begin_session('sub-kj', 'kj@ficium.net', 'r2', '10.0.0.1', 'test') \gset s_
SELECT pg_temp.expect_error($$SELECT api.credential_save('leak_one', null, 'GitHub token', 'token', 'gh' || 'p_' || repeat('x', 36), '', 'Doppler', 'CI', '', null, null, null, '', 'recording a new token')$$, 'secret value');
SELECT pg_temp.expect_error($$SELECT api.credential_save('leak_two', null, 'DB', 'password', 'login', '', 'Doppler', 'API', '', null, null, null, 'postgres://app' || ':' || 'pw' || '@db.example/app', 'recording a new login')$$, 'secret value');
SELECT pg_temp.expect_error($$SELECT api.credential_save('leak_three', null, 'Key', 'signing_key', 'signs', '', 'Doppler', 'API', '', null, null, null, repeat('Qk', 24), 'recording a new key')$$, 'secret value');
SELECT pg_temp.expect_error($$SELECT api.credential_save('leak_four', null, 'JWT', 'token', 'eyJ' || repeat('a', 12) || '.' || 'eyJ' || repeat('b', 12), '', 'Doppler', 'API', '', null, null, null, '', 'recording a new token')$$, 'secret value');
SELECT pg_temp.expect_error($$SELECT api.credential_save('leak_five', null, 'Key', 'api_key', 'x', 'A=B; rm', 'Doppler', 'API', '', null, null, null, '', 'recording a new key')$$, 'setting names');
SELECT pg_temp.expect_error($$SELECT api.credential_save('Bad Key', null, 'Key', 'api_key', 'x', '', 'Doppler', 'API', '', null, null, null, '', 'recording a new key')$$, 'short name');
SELECT pg_temp.expect_error($$SELECT api.credential_save('fine_key', null, 'Key', 'api_key', 'x', '', 'Doppler', 'API', '', null, null, null, '', 'short')$$, 'reason');
SELECT pg_temp.expect_error($$SELECT api.credential_save('fine_key', null, 'Key', 'api_key', 'x', '', 'Doppler', 'API', '', null, current_date + 30, null, '', 'rotation in the future')$$, 'future');
SELECT pg_temp.expect_error($$SELECT api.credential_save('fine_key', null, 'Key', 'mystery', 'x', '', 'Doppler', 'API', '', null, null, null, '', 'unknown kind of key')$$, 'kind');
COMMIT;

-- 3. due dates and states: expiry, rotation period, whichever is first
BEGIN;
SELECT api.begin_session('sub-kj', 'kj@ficium.net', 'r3', '10.0.0.1', 'test') \gset s_
SELECT api.credential_save('t_expired', null, 'Expired token', 'token', 'test', 'T_ONE', 'Doppler', 'CI', 'KJ',
  credential_today - 1, null, null, '', 'test entry already expired')->>'state' = 'expired' AS "past expiry is expired"
  FROM (SELECT (clock_timestamp() AT TIME ZONE 'Indian/Mauritius')::date AS credential_today) t;
SELECT api.credential_save('t_soon', null, 'Soon token', 'token', 'test', 'T_TWO', 'Doppler', 'CI', 'KJ',
  d + 10, null, null, '', 'test entry due in ten days')->>'state' = 'due_soon' AS "expiry in 10 days is due soon"
  FROM (SELECT (clock_timestamp() AT TIME ZONE 'Indian/Mauritius')::date AS d) t;
SELECT x->>'state' = 'due_soon' AND (x->>'due_on')::date = d + 5 AS "rotation period earlier than expiry wins"
  FROM (SELECT api.credential_save('t_rotate', null, 'Rotated key', 'signing_key', 'test', '', 'Doppler', 'API', '',
          d + 200, d - 85, 90, '', 'test entry rotated 85 days ago') AS x, d
          FROM (SELECT (clock_timestamp() AT TIME ZONE 'Indian/Mauritius')::date AS d) t) s;
SELECT api.credential_save('t_ok', null, 'Fine key', 'api_key', 'test', '', 'Doppler', 'API', '',
  d + 90, null, null, '', 'test entry with time left')->>'state' = 'ok' AS "90 days left is ok"
  FROM (SELECT (clock_timestamp() AT TIME ZONE 'Indian/Mauritius')::date AS d) t;
SELECT pg_temp.expect_error($$SELECT api.credential_save('t_ok', null, 'Again', 'api_key', 'test', '', 'Doppler', 'API', '', null, null, null, '', 'adding the same key twice')$$, 'already exists');
SELECT jsonb_array_length(api.credential_alerts()->'expired') = 1 AND jsonb_array_length(api.credential_alerts()->'due_soon') = 2 AS "alerts list expired and due soon",
       api.credential_view()->'items'->0->>'key' = 't_expired' AS "most urgent listed first";
COMMIT;

-- 4. update with the version the editor saw; retire
BEGIN;
SELECT api.begin_session('sub-kj', 'kj@ficium.net', 'r4', '10.0.0.1', 'test') \gset s_
SELECT pg_temp.expect_error($$SELECT api.credential_save('t_expired', 7, 'Expired token', 'token', 'test', 'T_ONE', 'Doppler', 'CI', 'KJ', null, null, null, '', 'stale version update')$$, 'changed since');
SELECT x->>'state' = 'ok' AND (x->>'version')::int = 2 AS "replaced token is ok again"
  FROM (SELECT api.credential_save('t_expired', 1, 'Expired token', 'token', 'test', 'T_ONE', 'Doppler', 'CI', 'KJ',
          d + 90, d, null, '', 'replaced with a new 90 day token') AS x
          FROM (SELECT (clock_timestamp() AT TIME ZONE 'Indian/Mauritius')::date AS d) t) s;
SELECT api.credential_retire('t_soon', 1, 'no longer used by anything')->>'state' = 'retired' AS "retired";
SELECT jsonb_array_length(api.credential_alerts()->'due_soon') = 1 AS "retired entry no longer alarms",
       jsonb_array_length(api.credential_view()->'retired') = 1 AS "retired entry kept for the record";
SELECT pg_temp.expect_error($$SELECT api.credential_save('t_soon', 2, 'Soon', 'token', 'test', '', 'Doppler', 'CI', '', null, null, null, '', 'editing a retired entry')$$, 'retired');
COMMIT;

-- 5. read-only: sees the register, cannot change it
BEGIN;
SELECT api.begin_session('sub-ro', 'ro@ficium.net', 'r5', '10.0.0.3', 'test') \gset s_
SELECT NOT (api.credential_view()->>'can_manage')::boolean AS "read-only sees, cannot manage";
SELECT pg_temp.expect_error($$SELECT api.credential_save('ro_key', null, 'Key', 'api_key', 'x', '', 'Doppler', 'API', '', null, null, null, '', 'read only tries to add')$$, 'permission');
SELECT pg_temp.expect_error($$SELECT api.credential_retire('t_ok', 1, 'read only tries to retire')$$, 'permission');
COMMIT;

-- 6. every change is in the audit chain, and the chain still verifies
SET ROLE :owner_role;
SELECT count(*) = 6 AS "six changes audited" FROM audit.event WHERE action LIKE 'credential.%';
SELECT (audit.verify_chain()).ok AS "audit chain verifies";
-- the table itself refuses a secret even past the api functions
SELECT pg_temp.expect_error($$INSERT INTO credential.item (key, label, kind, purpose, stored_in, used_by, note) VALUES ('raw', 'x', 'token', 'x', 'x', 'x', 'github' || '_pat_' || repeat('1', 30))$$, 'check constraint');
RESET ROLE;

-- 7. the backend role can only call api.*: no table access
SET ROLE :api_role;
SELECT pg_temp.expect_error('SELECT * FROM credential.item', 'permission denied');
SELECT pg_temp.expect_error($$SELECT credential._today()$$, 'permission denied');
RESET ROLE;
