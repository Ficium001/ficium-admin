-- Exercises the team four-eyes migration (app_admin 0017 / portal_admin 0014): invite, groups,
-- reset, reactivation, never-about-yourself, never-your-own, last super admin, expiry, what the
-- backend role can reach, and the audit chain.
--
-- Run against a SCRATCH database only (it creates admins). From db/admin-db, for either database:
--   psql postgres://<operator>@localhost/app_admin -X -q -t -v db=app_admin -f tests/team_four_eyes.sql
-- Every line of output is "t" or "ok   refused: ..."; any error stops the run.
\set ON_ERROR_STOP 1
\set QUIET 1
SELECT :'db' || '_owner' AS owner_role, :'db' || '_api' AS api_role \gset
SET ROLE :owner_role;
SELECT iam.bootstrap_super_admin('kj@ficium.net', 'KJ') AS kj \gset
INSERT INTO iam.admin_user (email, display_name) VALUES ('pj@ficium.net', 'PJ') RETURNING id AS pj \gset
INSERT INTO iam.user_role (user_id, role_code) VALUES (:'pj', 'super_admin');
INSERT INTO iam.admin_user (email, display_name) VALUES ('op@ficium.net', 'OP') RETURNING id AS op \gset
INSERT INTO iam.user_role (user_id, role_code) VALUES (:'op', 'operations');
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
GRANT EXECUTE ON FUNCTION pg_temp.expect_error(text, text) TO PUBLIC;

-- Activate everyone (first sign-in binds the subject).
SET ROLE :api_role;
BEGIN; SELECT api.begin_session('sub-kj', 'kj@ficium.net', 'r0', NULL, 't') IS NOT NULL; COMMIT;
BEGIN; SELECT api.begin_session('sub-pj', 'pj@ficium.net', 'r0', NULL, 't') IS NOT NULL; COMMIT;
BEGIN; SELECT api.begin_session('sub-op', 'op@ficium.net', 'r0', NULL, 't') IS NOT NULL; COMMIT;

-- 1. The old one-person paths are closed to the backend.
BEGIN; SELECT api.begin_session('sub-kj', 'kj@ficium.net', 'r1', NULL, 't') IS NOT NULL;
SELECT pg_temp.expect_error($$SELECT api.iam_invite('x@ficium.net','X',ARRAY['read_only'],'one person invite')$$, 'permission denied');
ROLLBACK;

-- 2. KJ asks to invite Ana; KJ cannot approve it, OP (no iam.approve) cannot, PJ can.
BEGIN; SELECT api.begin_session('sub-kj', 'kj@ficium.net', 'r2', NULL, 't') IS NOT NULL;
SELECT (api.iam_change_request('invite', NULL,
  '{"email":"Ana@Ficium.net","display_name":"Ana","username":"ana","roles":["compliance"]}', 'Second approver for offers'))->>'id' AS inv \gset
SELECT pg_temp.expect_error($$SELECT api.iam_change_request('invite', NULL,
  '{"email":"ana@ficium.net","display_name":"Ana","username":"ana","roles":["compliance"]}', 'Second approver for offers')$$, 'already waiting');
SELECT pg_temp.expect_error($$SELECT api.iam_change_request('invite', NULL,
  '{"email":"pj@ficium.net","display_name":"Prakash","username":"pjx","roles":["compliance"]}', 'Second approver for offers')$$, 'already on the team');
SELECT pg_temp.expect_error($$SELECT api.iam_change_request('invite', NULL,
  '{"email":"z@ficium.net","display_name":"Zed","username":"zed","roles":["god"]}', 'Second approver for offers')$$, 'unknown or retired group');
SELECT pg_temp.expect_error(format($$SELECT api.iam_change_approve(%L, 1, NULL)$$, :'inv'), 'your own request');
COMMIT;
BEGIN; SELECT api.begin_session('sub-op', 'op@ficium.net', 'r3', NULL, 't') IS NOT NULL;
SELECT pg_temp.expect_error(format($$SELECT api.iam_change_approve(%L, 1, NULL)$$, :'inv'), 'permission denied: iam.approve');
SELECT pg_temp.expect_error($$SELECT api.iam_change_request('rename', NULL, '{}', 'trying without iam.manage')$$, 'permission denied: iam.manage');
ROLLBACK;
BEGIN; SELECT api.begin_session('sub-pj', 'pj@ficium.net', 'r4', NULL, 't') IS NOT NULL;
SELECT (api.iam_change_approve(:'inv', 1, 'ok'))->'apply'->>'kind' = 'provision';
SELECT (api.iam_change_record_result(:'inv', '{"status":"created","email_sent":true}'))->>'status' = 'approved';
SELECT (SELECT a->>'status' FROM jsonb_array_elements(api.iam_list()) a WHERE a->>'email' = 'ana@ficium.net') = 'invited';
COMMIT;

-- 3. Never approve a change about yourself.
BEGIN; SELECT api.begin_session('sub-kj', 'kj@ficium.net', 'r5', NULL, 't') IS NOT NULL;
SELECT (api.iam_change_request('rename', :'pj', '{"display_name":"Prakash Jeebun"}', 'Use his full name'))->>'id' AS ren \gset
SELECT pg_temp.expect_error(format($$SELECT api.iam_change_request('rename', %L, '{"display_name":"Kishan"}', 'Use my full name')$$, :'kj'), 'someone else must ask');
COMMIT;
BEGIN; SELECT api.begin_session('sub-pj', 'pj@ficium.net', 'r6', NULL, 't') IS NOT NULL;
SELECT pg_temp.expect_error(format($$SELECT api.iam_change_approve(%L, 1, NULL)$$, :'ren'), 'about yourself');
ROLLBACK;
BEGIN; SELECT api.begin_session('sub-kj', 'kj@ficium.net', 'r7', NULL, 't') IS NOT NULL;
SELECT (api.iam_change_cancel(:'ren', 1))->>'status' = 'cancelled';
COMMIT;

-- 4. Groups: super admin is locked; a custom group with iam.manage, given to OP.
BEGIN; SELECT api.begin_session('sub-kj', 'kj@ficium.net', 'r8', NULL, 't') IS NOT NULL;
SELECT pg_temp.expect_error($$SELECT api.iam_change_request('group_update', NULL,
  '{"code":"super_admin","label":"Super","description":"x","permissions":["iam.read"]}', 'Trim super admin powers')$$, 'cannot be edited');
COMMIT;
BEGIN; SELECT api.begin_session('sub-kj', 'kj@ficium.net', 'r8b', NULL, 't') IS NOT NULL;
SELECT (api.iam_change_request('group_create', NULL,
  '{"code":"team_lead","label":"Team lead","description":"Manages people","permissions":["iam.manage","iam.read"]}', 'People manager without approvals'))->>'id' AS grp \gset
COMMIT;
BEGIN; SELECT api.begin_session('sub-pj', 'pj@ficium.net', 'r9', NULL, 't') IS NOT NULL;
SELECT (api.iam_change_approve(:'grp', 1, NULL))->'apply' = 'null'::jsonb;
COMMIT;
BEGIN; SELECT api.begin_session('sub-kj', 'kj@ficium.net', 'r10', NULL, 't') IS NOT NULL;
SELECT pg_temp.expect_error($$SELECT api.iam_change_request('set_roles', '$$ || :'op' || $$', '{"roles":["operations"]}', 'nothing really changes')$$, 'nothing would change');
SELECT (api.iam_change_request('set_roles', :'op', '{"roles":["operations","team_lead"]}', 'OP leads the team now'))->>'id' AS sr \gset
COMMIT;
BEGIN; SELECT api.begin_session('sub-pj', 'pj@ficium.net', 'r11', NULL, 't') IS NOT NULL;
SELECT (api.iam_change_approve(:'sr', 1, NULL)) IS NOT NULL;
SELECT (SELECT g->'members' FROM jsonb_array_elements(api.iam_groups()->'groups') g WHERE g->>'code' = 'team_lead') @> jsonb_build_array(jsonb_build_object('id', :'op'));
COMMIT;

-- 5. Reset needs an activated admin and comes back as a command for ficium-auth.
BEGIN; SELECT api.begin_session('sub-kj', 'kj@ficium.net', 'r12', NULL, 't') IS NOT NULL;
SELECT (SELECT id FROM jsonb_to_recordset(api.iam_list()) AS x(id uuid, email text) WHERE email = 'ana@ficium.net') AS ana \gset
SELECT pg_temp.expect_error(format($$SELECT api.iam_change_request('reset_login', %L, '{}', 'Lost her phone today')$$, :'ana'), 're-send the invitation');
SELECT (api.iam_change_request('reset_login', :'op', '{"reset_mfa":true}', 'Lost his phone today'))->>'id' AS rs \gset
COMMIT;
BEGIN; SELECT api.begin_session('sub-pj', 'pj@ficium.net', 'r13', NULL, 't') IS NOT NULL;
SELECT (api.iam_change_approve(:'rs', 1, NULL))->'apply' @> '{"kind":"reset","email":"op@ficium.net","reset_mfa":true}';
COMMIT;

-- 6. Removal is immediate; reactivation is four-eyes; the last active super admin stays.
BEGIN; SELECT api.begin_session('sub-kj', 'kj@ficium.net', 'r14', NULL, 't') IS NOT NULL;
SELECT (SELECT version FROM jsonb_to_recordset(api.iam_list()) AS x(id uuid, version bigint) WHERE id = :'pj') AS pjv \gset
SELECT (api.iam_set_status(:'pj', 'suspended', :pjv, 'Laptop stolen, cut off now'))->>'status' = 'suspended';
SELECT pg_temp.expect_error(format($$SELECT api.iam_set_status(%L, 'active', %s, 'Found the laptop again')$$, :'pj', :pjv + 1), 'second admin');
SELECT (api.iam_change_request('reactivate', :'pj', '{}', 'Laptop found and wiped'))->>'op' = 'reactivate';
COMMIT;
BEGIN; SELECT api.begin_session('sub-op', 'op@ficium.net', 'r15', NULL, 't') IS NOT NULL;
SELECT (SELECT version FROM jsonb_to_recordset(api.iam_list()) AS x(id uuid, version bigint) WHERE id = :'kj') AS kjv \gset
SELECT pg_temp.expect_error(format($$SELECT api.iam_set_status(%L, 'disabled', %s, 'Take over the whole team')$$, :'kj', :kjv), 'no active super admin');
ROLLBACK;

-- 7. Expired requests cannot be approved and stop blocking a new one.
SET ROLE :owner_role;
UPDATE iam.change SET expires_at = clock_timestamp() - interval '1 minute' WHERE op = 'reactivate' AND status = 'pending';
SET ROLE :api_role;
BEGIN; SELECT api.begin_session('sub-kj', 'kj@ficium.net', 'r16', NULL, 't') IS NOT NULL;
SELECT jsonb_array_length(api.iam_change_list('pending')) = 0;
SELECT (api.iam_change_request('reactivate', :'pj', '{}', 'Laptop found and wiped'))->>'status' = 'pending';
COMMIT;

-- 8. Retire: built-ins never, custom only when empty.
BEGIN; SELECT api.begin_session('sub-kj', 'kj@ficium.net', 'r17', NULL, 't') IS NOT NULL;
SELECT pg_temp.expect_error($$SELECT api.iam_change_request('group_retire', NULL, '{"code":"operations"}', 'Not needed any more')$$, 'built-in');
SELECT pg_temp.expect_error($$SELECT api.iam_change_request('group_retire', NULL, '{"code":"team_lead"}', 'Not needed any more')$$, 'move everyone out');
COMMIT;

-- 9. No table access for the backend; audit chain intact.
SELECT pg_temp.expect_error($$SELECT * FROM iam.change$$, 'permission denied');
RESET ROLE;
SELECT bool_and(ok) FROM audit.verify_chain();
SELECT count(*) >= 8 FROM audit.event WHERE action LIKE 'iam.%.approved' OR action LIKE 'iam.%.requested';
