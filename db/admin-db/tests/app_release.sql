-- Exercises 0010_app_release.sql end to end: validation, four-eyes, expiry, permissions, the
-- outbox event, the audit chain and the backend role's lack of table access.
--
-- Run against a SCRATCH database only (it creates admins). From db/admin-db:
--   OPERATOR_URL=postgres://<operator>@localhost/postgres ./migrate.sh cluster
--   OPERATOR_URL=postgres://<operator>@localhost/postgres ./migrate.sh app_admin
--   psql postgres://<operator>@localhost/app_admin -X -q -t -f tests/app_release.sql
-- Every line of output is "t" or "ok   refused: ..."; any error stops the run.
\set ON_ERROR_STOP 1
\set QUIET 1
-- two admins (owner-side setup), one read-only
SET ROLE app_admin_owner;
SELECT iam.bootstrap_super_admin('kj@ficium.net', 'KJ') AS kj \gset
INSERT INTO iam.admin_user (email, display_name) VALUES ('pj@ficium.net', 'PJ') RETURNING id AS pj \gset
INSERT INTO iam.user_role (user_id, role_code) VALUES (:'pj', 'super_admin');
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

-- 1. KJ: view + invalid requests are refused
BEGIN;
SELECT api.begin_session('sub-kj', 'kj@ficium.net', 'r1', '10.0.0.1', 'test') \gset s_
SELECT (api.release_view()->'policy'->0->>'platform') = 'android' AS "view lists android first", jsonb_array_length(api.release_view()->'policy') = 2 AS "two platforms";
SELECT pg_temp.expect_error($$SELECT api.release_request('android','1.1.0','1.2.0','https://play.google.com/store/apps/details?id=net.ficium.app','raise minimum above latest')$$, 'cannot be higher');
SELECT pg_temp.expect_error($$SELECT api.release_request('android','1.1','1.1','','bad version format here')$$, 'look like');
SELECT pg_temp.expect_error($$SELECT api.release_request('android','1.1.0','1.0.0','https://evil.example/x','phishing link attempt')$$, 'store link');
SELECT pg_temp.expect_error($$SELECT api.release_request('ios','1.1.0','1.0.0','https://play.google.com/store/apps/details?id=net.ficium.app','wrong store for platform')$$, 'store link');
SELECT pg_temp.expect_error($$SELECT api.release_request('ios','1.1.0','1.0.0','https://apps.apple.com.evil.example/app','lookalike host attempt')$$, 'store link');
SELECT pg_temp.expect_error($$SELECT api.release_request('windows','1.1.0','1.0.0','','unknown platform here')$$, 'ios or android');
SELECT pg_temp.expect_error($$SELECT api.release_request('ios','1.0.0','1.0.0','','nothing changes here')$$, 'nothing would change');
SELECT pg_temp.expect_error($$SELECT api.release_request('ios','1.1.0','1.0.0','','short')$$, 'reason');
-- numeric, not text, comparison: 1.10.0 > 1.9.0
SELECT api.release_request('android','1.10.0','1.9.0','https://play.google.com/store/apps/details?id=net.ficium.app','1.10.0 is live; 1.8 and older have the session bug')->>'id' AS req \gset
SELECT pg_temp.expect_error($$SELECT api.release_request('android','1.11.0','1.9.0','https://play.google.com/store/apps/details?id=net.ficium.app','second request while one is pending')$$, 'already waiting');
SELECT pg_temp.expect_error(format($$SELECT api.release_approve(%L, 1, null)$$, :'req'), 'four-eyes');
COMMIT;

-- 2. read-only: can view, cannot ask or approve
BEGIN;
SELECT api.begin_session('sub-ro', 'ro@ficium.net', 'r2', '10.0.0.3', 'test') \gset s_
SELECT (api.release_view()->>'can_request')::boolean = false AND (api.release_view()->>'can_approve')::boolean = false AS "read-only sees, cannot act";
SELECT pg_temp.expect_error($$SELECT api.release_request('ios','1.1.0','1.0.0','','read only tries to ask')$$, 'permission');
SELECT pg_temp.expect_error(format($$SELECT api.release_approve(%L, 1, null)$$, :'req'), 'permission');
COMMIT;

-- 3. PJ approves: policy changes, one outbox event with matching version
BEGIN;
SELECT api.begin_session('sub-pj', 'pj@ficium.net', 'r3', '10.0.0.2', 'test') \gset s_
SELECT pg_temp.expect_error(format($$SELECT api.release_approve(%L, 7, null)$$, :'req'), 'changed since');
SELECT api.release_approve(:'req', 1, 'checked the store')->>'status' = 'approved' AS "approved by a different admin";
SELECT pg_temp.expect_error(format($$SELECT api.release_approve(%L, 2, null)$$, :'req'), 'already approved');
COMMIT;
SET ROLE app_admin_owner;
SELECT min_version = '1.9.0' AND latest_version = '1.10.0' AND version = 1 AS "policy applied, version 1" FROM release.policy WHERE platform = 'android';
SELECT count(*) = 1 AS "one outbox event", bool_and(aggregate_type = 'app_release' AND aggregate_id = 'android' AND aggregate_version = 1 AND (payload->>'version')::bigint = 1 AND payload->>'min_version' = '1.9.0' AND payload->>'approved_by' = 'pj@ficium.net') AS "event carries the policy"
  FROM outbox.event WHERE topic = 'app.release_policy_changed';
SELECT version = 0 AS "ios untouched" FROM release.policy WHERE platform = 'ios';
SELECT count(*) AS release_audit_events FROM audit.event WHERE action LIKE 'release.%';
RESET ROLE;

-- 4. reject / withdraw
BEGIN;
SELECT api.begin_session('sub-pj', 'pj@ficium.net', 'r4', '10.0.0.2', 'test') \gset s_
SELECT api.release_request('ios','1.0.0','1.0.0','https://apps.apple.com/app/id1234567890','listing is live, add the App Store link')->>'id' AS req2 \gset
SELECT pg_temp.expect_error(format($$SELECT api.release_reject(%L, 1, 'i made this one myself')$$, :'req2'), 'withdraw it instead');
SELECT api.release_withdraw(:'req2', 1)->>'status' = 'withdrawn' AS "maker withdraws";
SELECT api.release_request('ios','1.0.0','1.0.0','https://apps.apple.com/app/id1234567890','listing is live, add the App Store link')->>'id' AS req3 \gset
COMMIT;
BEGIN;
SELECT api.begin_session('sub-kj', 'kj@ficium.net', 'r5', '10.0.0.1', 'test') \gset s_
SELECT pg_temp.expect_error(format($$SELECT api.release_withdraw(%L, 1)$$, :'req3'), 'only the admin who asked');
SELECT api.release_reject(:'req3', 1, 'wrong app id in the link')->>'status' = 'rejected' AS "other admin rejects";
COMMIT;

-- 5. expiry: an old pending request cannot be approved, and does not block a new one
SET ROLE app_admin_owner;
BEGIN;
SELECT api.begin_session('sub-pj', 'pj@ficium.net', 'r6', '10.0.0.2', 'test') \gset s_
SELECT api.release_request('ios','1.1.0','1.0.0','','1.1.0 went live on the App Store today')->>'id' AS req4 \gset
COMMIT;
UPDATE release.change_request SET expires_at = clock_timestamp() - interval '1 minute' WHERE id = :'req4';
RESET ROLE;
BEGIN;
SELECT api.begin_session('sub-kj', 'kj@ficium.net', 'r7', '10.0.0.1', 'test') \gset s_
SELECT api.release_approve(:'req4', 1, null)->>'status' = 'expired' AS "expired request is not applied";
SELECT api.release_request('ios','1.1.0','1.0.0','','1.1.0 went live on the App Store today')->>'status' = 'pending' AS "new request allowed after expiry";
COMMIT;
SET ROLE app_admin_owner;
SELECT version = 0 AND latest_version = '1.0.0' AS "ios still unchanged" FROM release.policy WHERE platform = 'ios';
SELECT (audit.verify_chain()).* \gx
RESET ROLE;

-- 6. the backend role can only call api.*: no table access
SET ROLE app_admin_api;
SELECT pg_temp.expect_error('SELECT * FROM release.policy', 'permission denied');
SELECT pg_temp.expect_error($$SELECT release._parts('1.0.0')$$, 'permission denied');
RESET ROLE;
