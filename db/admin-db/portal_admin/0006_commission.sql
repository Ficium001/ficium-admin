-- 0006_commission.sql — Ficium's commission schedule, set from this site.
--
-- The schedule itself lives in the Portal DB (billing.commission_rule, portal-api
-- db/058), next to the bookings it prices; this database only holds the
-- four-eyes requests and their audit, like every other portal change. Two ops on
-- the existing change_request workflow; no new tables.
--   commission.set  set a rate for a scope (bank / product / both / all) from a date
--   commission.end  stop a bank/product override from a date (falls back to the
--                   next broader rule; the platform default can't be ended)
SET LOCAL ROLE portal_admin_owner;
SET LOCAL search_path = pg_catalog;

INSERT INTO iam.permission (code, description) VALUES
  ('commission.read',    'View the commission schedule and its history'),
  ('commission.request', 'Ask for a commission rate to be set or ended'),
  ('commission.approve', 'Approve or reject a commission change (never your own)');

INSERT INTO iam.role_permission (role_code, permission_code) VALUES
  ('super_admin','commission.read'), ('super_admin','commission.request'), ('super_admin','commission.approve'),
  ('compliance','commission.read'),  ('compliance','commission.approve'),
  ('operations','commission.read'),  ('operations','commission.request'),
  ('read_only','commission.read');

INSERT INTO governance.op (op, request_permission, approve_permission, read_permission, description) VALUES
  ('commission.set', 'commission.request', 'commission.approve', 'commission.read', 'Set a commission rate for a bank and/or product from a date'),
  ('commission.end', 'commission.request', 'commission.approve', 'commission.read', 'End a commission override from a date');
