-- 0008_invite_admin.sql — a first admin for an existing bank that has none.
--
-- After the 2026-11-12 test-data reset, MCB kept its configuration but has no
-- members, so nobody can sign in to it and its own admin cannot invite anyone.
-- institution.invite_admin (portal-api) creates an unusable institution_admin
-- login + primary-admin member ONLY when the bank has no active primary admin;
-- ficium-auth then emails the set-password link. Four-eyes, same people as
-- approving a bank. One op row on the existing change_request workflow.
SET LOCAL ROLE portal_admin_owner;
SET LOCAL search_path = pg_catalog;

INSERT INTO governance.op (op, request_permission, approve_permission, read_permission, description) VALUES
  ('institution.invite_admin', 'institutions.request', 'institutions.approve', 'institutions.read',
   'Invite a first administrator to a bank that has none');
