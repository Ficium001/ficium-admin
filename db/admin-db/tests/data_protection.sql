-- Exercises app_admin 0014_data_protection.sql: logging, deadlines, identity before work,
-- compliance-only closing, optimistic locking, the timeline, retention edits, permissions,
-- the audit chain, and what the backend and read-only roles can reach.
--
-- Run against a SCRATCH database only (it creates admins). From db/admin-db:
--   OPERATOR_URL=postgres://<operator>@localhost/postgres ./migrate.sh cluster
--   OPERATOR_URL=postgres://<operator>@localhost/postgres ./migrate.sh app_admin
--   psql postgres://<operator>@localhost/app_admin -X -q -t -f tests/data_protection.sql
-- Every line of output is "t" or "ok   refused: ..."; any error stops the run.
\set ON_ERROR_STOP 1
\set QUIET 1
SET ROLE app_admin_owner;
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

-- 1. operations logs a request; deadline is one month from receipt
BEGIN;
SELECT api.begin_session('sub-op', 'op@ficium.net', 'r1', '10.0.0.2', 'test') \gset s_
SELECT api.dp_log('access', 'A. Borrower', 'a.borrower@example.com', '00000000-0000-0000-0000-0000000000aa', 'email',
  'Asked for a copy of all data held about them', DATE '2026-11-03') AS req \gset
SELECT (:'req'::jsonb->>'ref') = 'DP-0001' AS "first reference", (:'req'::jsonb->>'due_on') = '2026-12-03' AS "due one month after receipt",
       (:'req'::jsonb->>'owner') = 'op@ficium.net' AS "logger owns it", jsonb_array_length(:'req'::jsonb->'events') = 1 AS "logged in the timeline";
SELECT :'req'::jsonb->>'id' AS id \gset
SELECT pg_temp.expect_error($$SELECT api.dp_log('access', 'X', 'x@example.com', null, 'email', 'future dated request', current_date + 5)$$, 'future');
SELECT pg_temp.expect_error($$SELECT api.dp_log('gossip', 'X', 'x@example.com', null, 'email', 'unknown kind of request', current_date)$$, 'not valid');
SELECT pg_temp.expect_error($$SELECT api.dp_log('access', 'X', 'x@example.com', null, 'email', 'short', current_date)$$, 'not valid');
-- 2. no work before identity is checked; operations cannot close
SELECT pg_temp.expect_error(format($$SELECT api.dp_act(%L, 1, 'start', null, null)$$, :'id'), 'identity');
SELECT (api.dp_act(:'id', 1, 'verify_identity', 'Video call against NIC on file', DATE '2026-11-04')->>'identity_verified_on') = '2026-11-04' AS "identity recorded";
SELECT pg_temp.expect_error(format($$SELECT api.dp_act(%L, 1, 'note', 'stale', null)$$, :'id'), 'changed since');
SELECT (api.dp_act(:'id', 2, 'start', null, null)->>'status') = 'in_progress' AS "started after identity";
SELECT (api.dp_act(:'id', 3, 'note', 'Export generated from the borrower app', null)->>'version') = '4' AS "note added";
SELECT pg_temp.expect_error(format($$SELECT api.dp_act(%L, 4, 'complete', 'Sent the export by email', null)$$, :'id'), 'dp.close');
COMMIT;

-- 3. read-only sees nothing of requests
BEGIN;
SELECT api.begin_session('sub-ro', 'ro@ficium.net', 'r2', '10.0.0.3', 'test') \gset s_
SELECT pg_temp.expect_error('SELECT api.dp_view()', 'permission');
COMMIT;

-- 4. KJ (super admin) completes it; it cannot change afterwards
BEGIN;
SELECT api.begin_session('sub-kj', 'kj@ficium.net', 'r3', '10.0.0.1', 'test') \gset s_
SELECT pg_temp.expect_error(format($$SELECT api.dp_act(%L, 4, 'complete', 'short', null)$$, :'id'), 'outcome');
SELECT x->>'status' = 'completed' AND x->>'closed_by' = 'kj@ficium.net' AND jsonb_array_length(x->'events') = 5 AS "completed with outcome and timeline"
  FROM (SELECT api.dp_act(:'id', 4, 'complete', 'Sent the full export by email on 18 Nov, encrypted', null) AS x) t;
SELECT pg_temp.expect_error(format($$SELECT api.dp_act(%L, 5, 'note', 'late note', null)$$, :'id'), 'already completed');
SELECT jsonb_array_length(api.dp_view()->'open') = 0 AND jsonb_array_length(api.dp_view()->'closed') = 1 AS "listed as closed";
-- withdrawal and refusal
SELECT api.dp_log('erasure', 'B. Person', '+230 5000 0000', null, 'phone', 'Asked to delete everything about them', current_date)->>'id' AS id2 \gset
SELECT (api.dp_act(:'id2', 1, 'withdraw', 'Called back: wants to keep the account open', null)->>'status') = 'withdrawn' AS "withdrawn";
SELECT api.dp_log('erasure', 'C. Person', 'c@example.com', null, 'email', 'Asked to delete their KYC documents', current_date)->>'id' AS id3 \gset
SELECT (api.dp_act(:'id3', 1, 'refuse', 'KYC records must be kept 7 years under FIAMLA; explained by email', null)->>'status') = 'refused' AS "refused with reason";
-- retention schedule
SELECT jsonb_array_length(api.dp_view()->'retention') = 7 AS "seven retention entries seeded",
       (SELECT count(*) FROM jsonb_array_elements(api.dp_view()->'retention') e WHERE NOT (e->>'decided')::boolean) = 3 AS "three not decided";
SELECT (api.dp_retention_save('vault_documents', 0, 'Documents borrowers upload to their vault', 'Borrower app document vault', '7 years after account closure',
  'Same as regulated records', 'Deleted with regulated records', true, false, 'Decided with compliance on 19 Nov')->>'decided')::boolean AS "retention decided";
SELECT pg_temp.expect_error($$SELECT api.dp_retention_save('vault_documents', 0, 'x', 'x', 'x', 'x', 'x', true, true, 'stale version save')$$, 'changed since');
SELECT pg_temp.expect_error($$SELECT api.dp_retention_save('new_one', null, '', 'x', 'x', 'x', 'x', true, true, 'empty data field')$$, 'required');
COMMIT;

-- 5. audit chain, append-only timeline, role reach
SET ROLE app_admin_owner;
SELECT count(*) >= 10 AS "changes audited" FROM audit.event WHERE action LIKE 'dp.%';
SELECT (audit.verify_chain()).ok AS "audit chain verifies";
RESET ROLE;
SET ROLE app_admin_api;
SELECT pg_temp.expect_error('SELECT * FROM dp.request', 'permission denied');
SELECT pg_temp.expect_error('UPDATE dp.event SET text = $$x$$', 'permission denied');
RESET ROLE;
SET ROLE app_admin_readonly;
SELECT count(*) = 3 AS "read-only reporting sees counts" FROM (SELECT id, ref, status FROM dp.request) t;
SELECT pg_temp.expect_error('SELECT requester FROM dp.request', 'permission denied');
RESET ROLE;
