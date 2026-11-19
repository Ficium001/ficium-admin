-- Exercises the incident register (app_admin 0015 / portal_admin 0013): opening, the timeline,
-- the 72-hour breach clock, compliance-only decisions, the closing rules, alerts, the audit chain,
-- and what the backend role can reach.
--
-- Run against a SCRATCH database only (it creates admins). From db/admin-db, for either database:
--   psql postgres://<operator>@localhost/app_admin -X -q -t -v db=app_admin -f tests/incidents.sql
-- Every line of output is "t" or "ok   refused: ..."; any error stops the run.
\set ON_ERROR_STOP 1
\set QUIET 1
SELECT :'db' || '_owner' AS owner_role, :'db' || '_api' AS api_role \gset
SET ROLE :owner_role;
SELECT iam.bootstrap_super_admin('kj@ficium.net', 'KJ') AS kj \gset
INSERT INTO iam.admin_user (email, display_name) VALUES ('op@ficium.net', 'OP') RETURNING id AS op \gset
INSERT INTO iam.user_role (user_id, role_code) VALUES (:'op', 'operations');
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

-- 1. operations opens an outage; validation
BEGIN;
SELECT api.begin_session('sub-op', 'op@ficium.net', 'r1', '10.0.0.2', 'test') \gset s_
SELECT api.incident_open('Borrower app deploys failing', 2, 'change', 'deploy_borrower_app',
  'No new borrower app version can ship; production runs the last good build', now() - interval '2 days', now() - interval '1 hour', false) AS inc \gset
SELECT (:'inc'::jsonb->>'ref') = 'INC-0001' AS "first reference", (:'inc'::jsonb->>'status') = 'investigating' AS "starts investigating",
       (:'inc'::jsonb->>'breach_due_at') IS NULL AS "no breach clock without personal data";
SELECT :'inc'::jsonb->>'id' AS id \gset
SELECT pg_temp.expect_error($$SELECT api.incident_open('Bad', 2, 'outage', null, 'impact text here', now(), now(), false)$$, 'not valid');
SELECT pg_temp.expect_error($$SELECT api.incident_open('Noticed before it started', 2, 'outage', null, 'impact text here', now(), now() - interval '1 hour', false)$$, 'before it started');
SELECT pg_temp.expect_error($$SELECT api.incident_open('From the future', 2, 'outage', null, 'impact text here', now() + interval '1 day', now() + interval '1 day', false)$$, 'future');
-- 2. the timeline and the order of things
SELECT pg_temp.expect_error(format($$SELECT api.incident_act(%L, 1, 'close', 'too early to close', null, null, null, null, null)$$, :'id'), 'incident.close');
SELECT (api.incident_act(:'id', 1, 'update', 'Build log: GitHub token rejected', null, null, null, null, null)->>'version') = '2' AS "update added";
SELECT (api.incident_act(:'id', 2, 'mitigated', 'Production confirmed on the last good build', null, null, null, null, null)->>'status') = 'mitigated' AS "mitigated";
SELECT (api.incident_act(:'id', 3, 'resolved', 'New fine-grained token in Doppler; redeployed', null, null, null, null, null)->>'status') = 'resolved' AS "resolved";
SELECT (api.incident_act(:'id', 4, 'follow_up', 'Record every token expiry under Keys and tokens', null, null, 'KJ', current_date + 7, null)->'follow_ups'->0->>'owner') = 'KJ' AS "follow-up added";
SELECT api.incident_act(:'id', 5, 'root_cause', 'The GitHub token used by Vercel builds expired with no warning', null, null, null, null, null)->'follow_ups'->0->>'id' AS fu \gset
SELECT pg_temp.expect_error(format($$SELECT api.incident_act(%L, 5, 'update', 'stale', null, null, null, null, null)$$, :'id'), 'changed since');
COMMIT;

-- 3. read-only can look, not act
BEGIN;
SELECT api.begin_session('sub-ro', 'ro@ficium.net', 'r2', '10.0.0.3', 'test') \gset s_
SELECT jsonb_array_length(api.incident_view()->'open') = 1 AND NOT (api.incident_view()->>'can_manage')::boolean AS "read-only sees, cannot act";
SELECT pg_temp.expect_error(format($$SELECT api.incident_act(%L, 6, 'update', 'read only update', null, null, null, null, null)$$, :'id'), 'permission');
COMMIT;

-- 4. KJ closes it only once every follow-up is done
BEGIN;
SELECT api.begin_session('sub-kj', 'kj@ficium.net', 'r3', '10.0.0.1', 'test') \gset s_
SELECT pg_temp.expect_error(format($$SELECT api.incident_act(%L, 6, 'close', 'closing summary here', null, null, null, null, null)$$, :'id'), 'follow-up');
SELECT (api.incident_act(:'id', 6, 'follow_up_done', null, null, null, null, null, :'fu')->'follow_ups'->0->>'done_by') = 'kj@ficium.net' AS "follow-up done";
SELECT x->>'status' = 'closed' AND x->>'closed_by' = 'kj@ficium.net' AS "closed"
  FROM (SELECT api.incident_act(:'id', 7, 'close', 'Token expiries are now tracked; deploys show on Services', null, null, null, null, null) AS x) t;
SELECT pg_temp.expect_error(format($$SELECT api.incident_act(%L, 8, 'update', 'after close', null, null, null, null, null)$$, :'id'), 'closed');

-- 5. a personal-data breach: the 72-hour clock, compliance decides, closing needs the answer
SELECT api.incident_open('Export sent to the wrong borrower', 1, 'data', null, 'One borrower received another borrower''s statement by email',
  now() - interval '3 hours', now() - interval '2 hours', false)->>'id' AS b \gset
SELECT (x->>'breach_due_at') IS NOT NULL AND (x->>'personal_data')::boolean AS "breach clock starts"
  FROM (SELECT api.incident_act(:'b', 1, 'personal_data', 'Name, account balance and address of one borrower', null, null, null, null, null) AS x) t;
SELECT jsonb_array_length(api.incident_alerts()->'breach_due') = 1 AND jsonb_array_length(api.incident_alerts()->'open_major') = 1 AS "alerts show the breach and the sev 1";
SELECT pg_temp.expect_error(format($$SELECT api.incident_act(%L, 2, 'breach_reported', 'DPO ref 123', now() + interval '1 day', null, null, null, null)$$, :'b'), 'when the Commissioner');
SELECT (api.incident_act(:'b', 2, 'breach_reported', 'Emailed the DPO, ref DPO/2026/123', now(), null, null, null, null)->>'breach_due_at') IS NULL AS "reported stops the clock";
SELECT jsonb_array_length(api.incident_alerts()->'breach_due') = 0 AS "no breach alert once reported";
COMMIT;

-- 6. operations cannot decide a breach is not reportable
BEGIN;
SELECT api.begin_session('sub-op', 'op@ficium.net', 'r4', '10.0.0.2', 'test') \gset s_
SELECT api.incident_open('Laptop with a staff list lost', 3, 'security', null, 'A staff list with work emails may be exposed',
  now() - interval '1 hour', now() - interval '1 hour', true)->>'id' AS c \gset
SELECT pg_temp.expect_error(format($$SELECT api.incident_act(%L, 1, 'breach_not_reported', 'encrypted disk, no risk', null, null, null, null, null)$$, :'c'), 'incident.close');
COMMIT;

-- 7. audit chain, append-only, role reach
SET ROLE :owner_role;
SELECT count(*) = 12 AS "every successful change audited, refusals not" FROM audit.event WHERE action LIKE 'incident.%';
SELECT (audit.verify_chain()).ok AS "audit chain verifies";
RESET ROLE;
SET ROLE :api_role;
SELECT pg_temp.expect_error('SELECT * FROM incident.item', 'permission denied');
SELECT pg_temp.expect_error('DELETE FROM incident.event', 'permission denied');
RESET ROLE;
