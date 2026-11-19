-- Exercises app_admin 0016_support_cases.sql: opening with targets copied onto the case,
-- acknowledging, compliance-only complaint decisions, redress rules, reopening, referral,
-- targets, the complaints register, permissions, audit chain and role reach.
--
-- Run against a SCRATCH database only (it creates admins). From db/admin-db:
--   psql postgres://<operator>@localhost/app_admin -X -q -t -f tests/support_cases.sql
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

-- 1. operations opens a complaint: targets copied onto it
BEGIN;
SELECT api.begin_session('sub-op', 'op@ficium.net', 'r1', '10.0.0.2', 'test') \gset s_
SELECT api.case_open('complaint', 'bids', 'No bids after five days', 'Posted a home loan request, nothing came in and nobody explained why',
  'A. Borrower', 'a@example.com', '00000000-0000-0000-0000-0000000000aa', 'email', TIMESTAMPTZ '2026-11-18 10:00+04') AS c \gset
SELECT (:'c'::jsonb->>'ref') = 'CASE-0001' AS "first reference", (:'c'::jsonb->>'resolve_due_on') = '2026-12-03' AS "answer due in 15 days",
       (:'c'::jsonb->>'ack_due_at')::timestamptz = TIMESTAMPTZ '2026-11-20 10:00+04' AS "acknowledge within 48 h";
SELECT :'c'::jsonb->>'id' AS id \gset
SELECT pg_temp.expect_error($$SELECT api.case_open('rant', 'bids', 'Subject here', 'details long enough', 'X', 'x@example.com', null, 'email', now())$$, 'kind of case');
SELECT pg_temp.expect_error($$SELECT api.case_open('question', 'weather', 'Subject here', 'details long enough', 'X', 'x@example.com', null, 'email', now())$$, 'not valid');
SELECT pg_temp.expect_error($$SELECT api.case_open('question', 'app', 'Subject here', 'details long enough', 'X', 'x@example.com', null, 'email', now() + interval '1 day')$$, 'future');
SELECT (api.case_act(:'id', 1, 'acknowledge', 'Emailed: we are looking into it', null, null, null)->>'status') = 'acknowledged' AS "acknowledged";
SELECT pg_temp.expect_error(format($$SELECT api.case_act(%L, 2, 'resolve', 'Explained the bidding window', 'not_upheld', null, null)$$, :'id'), 'case.resolve_complaint');
-- a question operations can resolve
SELECT api.case_open('question', 'app', 'How do I relist?', 'Asked how to relist an expired request', 'B. Person', '+230 5000 0000', null, 'phone', now())->>'id' AS q \gset
SELECT pg_temp.expect_error(format($$SELECT api.case_act(%L, 1, 'resolve', 'Explained relisting from Requests', 'upheld', null, null)$$, :'q'), 'only complaints');
SELECT x->>'status' = 'resolved' AND (x->>'on_time')::boolean AS "question resolved on time"
  FROM (SELECT api.case_act(:'q', 1, 'resolve', 'Explained relisting from Requests', null, null, null) AS x) t;
SELECT pg_temp.expect_error(format($$SELECT api.case_act(%L, 2, 'acknowledge', 'late ack', null, null, null)$$, :'q'), 'is resolved');
COMMIT;

-- 2. read-only cannot see cases
BEGIN;
SELECT api.begin_session('sub-ro', 'ro@ficium.net', 'r2', '10.0.0.3', 'test') \gset s_
SELECT pg_temp.expect_error('SELECT api.case_view()', 'permission');
COMMIT;

-- 3. KJ decides the complaint: upheld needs redress; reopen; refer
BEGIN;
SELECT api.begin_session('sub-kj', 'kj@ficium.net', 'r3', '10.0.0.1', 'test') \gset s_
SELECT pg_temp.expect_error(format($$SELECT api.case_act(%L, 2, 'resolve', 'We should have told them', 'upheld', null, null)$$, :'id'), 'redress');
SELECT pg_temp.expect_error(format($$SELECT api.case_act(%L, 2, 'resolve', 'We should have told them', 'maybe', null, null)$$, :'id'), 'upheld');
SELECT x->>'upheld' = 'partly' AND x->>'redress' = 'Apology, and a note now shows when no bank has bid' AS "decided with redress"
  FROM (SELECT api.case_act(:'id', 2, 'resolve', 'Banks could not bid in that window; we should have said so', 'partly',
          'Apology, and a note now shows when no bank has bid', null) AS x) t;
COMMIT;

BEGIN;
SELECT api.begin_session('sub-kj', 'kj@ficium.net', 'r4', '10.0.0.1', 'test') \gset s_
SELECT (api.case_act(:'id', 3, 'referred', 'Financial Services Commission', null, null, now())->>'referred_to') = 'Financial Services Commission' AS "referred after resolving";
SELECT x->>'status' = 'acknowledged' AND x->>'upheld' IS NULL AND (x->>'reopened')::int = 1 AS "reopened keeps the acknowledgement, clears the decision"
  FROM (SELECT api.case_act(:'id', 4, 'reopen', 'Borrower replied: still no bids on the relisted request', null, null, null) AS x) t;
SELECT (api.case_act(:'id', 5, 'resolve', 'Two banks have now bid; borrower satisfied', 'not_upheld', null, null)->>'status') = 'resolved' AS "resolved again";
-- the register
SELECT (v->'complaints_12m'->>'received')::int = 1 AND (v->'complaints_12m'->>'not_upheld')::int = 1 AND (v->'complaints_12m'->>'referred')::int = 1
       AND (v->'complaints_12m'->'by_category'->>'bids')::int = 1 AS "complaints register counts"
  FROM (SELECT api.case_view() AS v) t;
-- targets: changing one never moves an existing deadline
SELECT pg_temp.expect_error($$SELECT api.case_target_save('complaint', 0, 0, 15, 'zero hours is not a target')$$, 'acknowledge within');
SELECT (api.case_target_save('complaint', 0, 24, 10, 'Tighter targets agreed with compliance')->>'resolve_days')::int = 10 AS "target changed";
SELECT (api.case_view()->'closed'->0->>'resolve_due_on') = '2026-12-03' OR (api.case_view()->'closed'->1->>'resolve_due_on') = '2026-12-03' AS "existing deadline unchanged";
COMMIT;

-- 4. audit, append-only, role reach
SET ROLE app_admin_owner;
SELECT count(*) = 9 AS "every successful change audited" FROM audit.event WHERE action LIKE 'case.%';
SELECT (audit.verify_chain()).ok AS "audit chain verifies";
RESET ROLE;
SET ROLE app_admin_api;
SELECT pg_temp.expect_error('SELECT * FROM support.case_item', 'permission denied');
SELECT pg_temp.expect_error('DELETE FROM support.event', 'permission denied');
RESET ROLE;
SET ROLE app_admin_readonly;
SELECT count(*) = 2 AS "reporting sees the register's shape" FROM (SELECT ref, kind, category, upheld FROM support.case_item) t;
SELECT pg_temp.expect_error('SELECT detail FROM support.case_item', 'permission denied');
RESET ROLE;
