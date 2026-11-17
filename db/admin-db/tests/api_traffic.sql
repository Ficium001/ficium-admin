-- Exercises 0011_api_traffic.sql end to end: pause is immediate, resume is four-eyes, the admin channel
-- is locked, permissions, expiry, versioning, the outbox event, the audit chain and the backend
-- role's lack of table access.
--
-- Run against a SCRATCH database only (it creates admins). From db/admin-db:
--   OPERATOR_URL=postgres://<operator>@localhost/postgres ./migrate.sh cluster
--   OPERATOR_URL=postgres://<operator>@localhost/postgres ./migrate.sh app_admin
--   psql postgres://<operator>@localhost/app_admin -X -q -t -f tests/api_traffic.sql
-- (The portal site's copy of this test is tests/api_traffic_portal.sql; run it against portal_admin.)
-- Every line of output is "t" or "ok   refused: ..."; any error stops the run.
\set ON_ERROR_STOP 1
\set QUIET 1
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

-- 1. KJ: the view, and what pausing is allowed to touch
BEGIN;
SELECT api.begin_session('sub-kj', 'kj@ficium.net', 'r1', '10.0.0.1', 'test') \gset s_
SELECT jsonb_array_length(api.traffic_view()->'channels') >= 5 AS "view lists the channels",
       (api.traffic_view()->>'can_control')::boolean AND (api.traffic_view()->>'can_approve')::boolean AS "kj can control and approve";
SELECT bool_and(c->>'state' = 'enabled' AND (c->>'version')::bigint = 0) AS "all start enabled at version 0"
  FROM jsonb_array_elements(api.traffic_view()->'channels') c;
SELECT pg_temp.expect_error($$SELECT api.traffic_pause('admin.channel', 0, 'try to cut the admin channel')$$, 'cannot be paused');
SELECT pg_temp.expect_error($$SELECT api.traffic_pause('no.such_channel', 0, 'there is no such channel')$$, 'unknown channel');
SELECT pg_temp.expect_error($$SELECT api.traffic_pause('kyc.aws_out', 0, 'short')$$, 'reason');
SELECT pg_temp.expect_error($$SELECT api.traffic_pause('kyc.aws_out', 5, 'stale version of the channel')$$, 'changed since');
SELECT pg_temp.expect_error($$SELECT api.traffic_resume_request('kyc.aws_out', 'resume a channel that is running')$$, 'not paused');
-- pause is immediate, by one admin
SELECT api.traffic_pause('kyc.aws_out', 0, 'AWS key may be exposed, stop face checks until rotated') AS paused \gset
SELECT (:'paused'::jsonb->'channel'->>'state') = 'paused' AND (:'paused'::jsonb->'policy'->>'version')::bigint = 1 AS "paused at once, version 1";
SELECT pg_temp.expect_error($$SELECT api.traffic_pause('kyc.aws_out', 1, 'pause it a second time')$$, 'already paused');
COMMIT;

-- 2. read-only: can see, cannot pause or ask
BEGIN;
SELECT api.begin_session('sub-ro', 'ro@ficium.net', 'r2', '10.0.0.3', 'test') \gset s_
SELECT NOT (api.traffic_view()->>'can_control')::boolean AND NOT (api.traffic_view()->>'can_approve')::boolean AS "read-only sees, cannot act";
SELECT pg_temp.expect_error($$SELECT api.traffic_pause('ai.advisor_out', 0, 'read only tries to pause')$$, 'permission');
SELECT pg_temp.expect_error($$SELECT api.traffic_resume_request('kyc.aws_out', 'read only tries to resume')$$, 'permission');
COMMIT;

-- 3. resume is four-eyes
BEGIN;
SELECT api.begin_session('sub-pj', 'pj@ficium.net', 'r3', '10.0.0.2', 'test') \gset s_
SELECT api.traffic_resume_request('kyc.aws_out', 'key rotated and tested in the sandbox')->>'id' AS req \gset
SELECT pg_temp.expect_error($$SELECT api.traffic_resume_request('kyc.aws_out', 'a second request for the same one')$$, 'already waiting');
SELECT pg_temp.expect_error(format($$SELECT api.traffic_resume_approve(%L, 1, null)$$, :'req'), 'four-eyes');
SELECT pg_temp.expect_error(format($$SELECT api.traffic_resume_reject(%L, 1, 'i made this one myself')$$, :'req'), 'withdraw it instead');
COMMIT;
BEGIN;
SELECT api.begin_session('sub-kj', 'kj@ficium.net', 'r4', '10.0.0.1', 'test') \gset s_
SELECT pg_temp.expect_error(format($$SELECT api.traffic_resume_approve(%L, 9, null)$$, :'req'), 'changed since');
SELECT api.traffic_resume_approve(:'req', 1, 'new key confirmed')->'request'->>'status' = 'approved' AS "approved by a different admin";
SELECT pg_temp.expect_error(format($$SELECT api.traffic_resume_approve(%L, 2, null)$$, :'req'), 'already approved');
COMMIT;
SET ROLE app_admin_owner;
SELECT state = 'enabled' AND version = 2 AND state_reason IS NULL AS "resumed, version 2" FROM traffic.channel WHERE key = 'kyc.aws_out';
SELECT count(*) = 2 AS "two outbox events (pause, resume)",
       bool_and(aggregate_type = 'api_channel' AND aggregate_id = 'kyc.aws_out') AS "events are for the channel",
       bool_and(aggregate_version = (payload->>'version')::bigint) AS "event versions match the policy"
  FROM outbox.event WHERE topic = 'api.channel_policy_changed';
RESET ROLE;

-- 4. reject, withdraw, and pausing again clears a waiting request
BEGIN;
SELECT api.begin_session('sub-pj', 'pj@ficium.net', 'r5', '10.0.0.2', 'test') \gset s_
SELECT api.traffic_pause('ai.advisor_out', 0, 'advisor answers look wrong, stop until reviewed') IS NOT NULL AS "second pause";
SELECT api.traffic_resume_request('ai.advisor_out', 'reviewed, answers are fine again')->>'id' AS req2 \gset
COMMIT;
BEGIN;
SELECT api.begin_session('sub-kj', 'kj@ficium.net', 'r6', '10.0.0.1', 'test') \gset s_
SELECT pg_temp.expect_error(format($$SELECT api.traffic_resume_withdraw(%L, 1)$$, :'req2'), 'only the admin who asked');
SELECT api.traffic_resume_reject(:'req2', 1, 'review not finished yet')->>'status' = 'rejected' AS "other admin rejects";
SELECT api.traffic_resume_request('ai.advisor_out', 'review finished this afternoon')->>'id' AS req3 \gset
SELECT api.traffic_resume_withdraw(:'req3', 1)->>'status' = 'withdrawn' AS "maker withdraws";
COMMIT;

-- 5. expiry: an old pending request cannot be approved, and does not block a new one
SET ROLE app_admin_owner;
BEGIN;
SELECT api.begin_session('sub-pj', 'pj@ficium.net', 'r8', '10.0.0.2', 'test') \gset s_
SELECT api.traffic_resume_request('ai.advisor_out', 'asking again after the weekend')->>'id' AS req4 \gset
COMMIT;
UPDATE traffic.resume_request SET expires_at = clock_timestamp() - interval '1 minute' WHERE id = :'req4';
RESET ROLE;
BEGIN;
SELECT api.begin_session('sub-kj', 'kj@ficium.net', 'r9', '10.0.0.1', 'test') \gset s_
SELECT api.traffic_resume_approve(:'req4', 1, null)->'request'->>'status' = 'expired' AS "expired request is not applied";
SELECT pg_temp.expect_error(format($$SELECT api.traffic_resume_approve(%L, 2, null)$$, :'req4'), 'already expired');
SELECT api.traffic_resume_request('ai.advisor_out', 'new request allowed after expiry')->>'status' = 'pending' AS "new request allowed after expiry";
COMMIT;
SET ROLE app_admin_owner;
SELECT state = 'paused' AND version = 1 AS "advisor still paused" FROM traffic.channel WHERE key = 'ai.advisor_out';
SELECT count(*) >= 6 AS "traffic audit events recorded" FROM audit.event WHERE action LIKE 'traffic.%';
SELECT (audit.verify_chain()).* \gx
RESET ROLE;

-- 6. the backend role can only call api.*: no table access
SET ROLE app_admin_api;
SELECT pg_temp.expect_error('SELECT * FROM traffic.channel', 'permission denied');
SELECT pg_temp.expect_error($$SELECT traffic._policy(c) FROM (SELECT 1) x, LATERAL (SELECT NULL::traffic.channel) c$$, 'permission denied');
RESET ROLE;
