-- 0014_data_protection.sql — data protection requests and the retention schedule (KJ, 2026-11-19).
--
-- Under the Data Protection Act 2017 a borrower may ask for a copy of their data (s.37), for it to
-- be corrected, erased or restricted (s.39), object to its use (s.40), or ask about an automated
-- decision (s.38). The Data Protection Office's guidance: access within one month, the others
-- without undue delay. This is where each request is logged, given a deadline (one month from
-- receipt, for every kind, so nothing waits longer than the strictest rule), worked and closed,
-- with a timeline of what was done. Banks doing third-party risk reviews ask to see exactly this.
--
-- The retention schedule says how long each kind of data is kept, where, why, and how it is
-- deleted. Seeded with the rules the borrower app already enforces; the ones nobody has decided
-- are marked so, because "not decided" is the honest answer until someone decides.
--
-- Requests hold the requester's name and contact as given: that is personal data, so
-- dp.view is not given to read_only. Completing or refusing a request needs dp.close
-- (super admin, compliance): telling someone "no" under the Act is a compliance decision.
-- Every change is audited; the timeline is append-only.
SET LOCAL ROLE app_admin_owner;
SET LOCAL search_path = pg_catalog;

INSERT INTO iam.permission (code, description) VALUES
  ('dp.view',   'See data protection requests and the retention schedule'),
  ('dp.manage', 'Log and work data protection requests, and edit the retention schedule'),
  ('dp.close',  'Complete or refuse a data protection request');
INSERT INTO iam.role_permission (role_code, permission_code) VALUES
  ('super_admin', 'dp.view'), ('compliance', 'dp.view'), ('operations', 'dp.view'),
  ('super_admin', 'dp.manage'), ('compliance', 'dp.manage'), ('operations', 'dp.manage'),
  ('super_admin', 'dp.close'), ('compliance', 'dp.close');

CREATE SCHEMA dp AUTHORIZATION app_admin_owner;

CREATE FUNCTION dp._today() RETURNS date
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT (clock_timestamp() AT TIME ZONE 'Indian/Mauritius')::date
$$;

CREATE SEQUENCE dp.request_ref_seq;

CREATE TABLE dp.request (
  id            uuid PRIMARY KEY DEFAULT util.uuid_v7(),
  ref           text NOT NULL UNIQUE DEFAULT 'DP-' || lpad(nextval('dp.request_ref_seq')::text, 4, '0'),
  kind          text NOT NULL CHECK (kind IN ('access','correction','erasure','restriction','objection','automated_decision','withdraw_consent')),
  requester     text NOT NULL CHECK (length(btrim(requester)) BETWEEN 1 AND 120),
  contact       text NOT NULL CHECK (length(btrim(contact)) BETWEEN 1 AND 200),
  client_id     uuid,                              -- the borrower, when the request is from one
  channel       text NOT NULL CHECK (channel IN ('email','app','letter','phone','in_person','other')),
  summary       text NOT NULL CHECK (length(btrim(summary)) BETWEEN 10 AND 2000),
  received_on   date NOT NULL,
  due_on        date NOT NULL,
  status        text NOT NULL DEFAULT 'received'
                CHECK (status IN ('received','in_progress','completed','refused','withdrawn')),
  identity_verified_on date,
  identity_method text CHECK (identity_method IS NULL OR length(identity_method) BETWEEN 3 AND 200),
  owner_id      uuid REFERENCES iam.admin_user(id),
  outcome       text CHECK (outcome IS NULL OR length(outcome) BETWEEN 10 AND 2000),
  closed_on     date,
  closed_by     uuid REFERENCES iam.admin_user(id),
  version       bigint NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by    uuid NOT NULL REFERENCES iam.admin_user(id),
  updated_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (due_on = (received_on + interval '1 month')::date),
  CHECK ((status IN ('completed','refused','withdrawn')) = (closed_on IS NOT NULL)),
  CHECK (status NOT IN ('completed','refused') OR (outcome IS NOT NULL AND closed_by IS NOT NULL)),
  CHECK ((identity_verified_on IS NULL) = (identity_method IS NULL))
);
CREATE INDEX request_open ON dp.request (due_on) WHERE closed_on IS NULL;
CREATE INDEX request_recent ON dp.request (created_at DESC);

-- What was done, in order. Append-only: no UPDATE or DELETE is granted or performed.
CREATE TABLE dp.event (
  id          uuid PRIMARY KEY DEFAULT util.uuid_v7(),
  request_id  uuid NOT NULL REFERENCES dp.request(id),
  at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_id    uuid NOT NULL REFERENCES iam.admin_user(id),
  kind        text NOT NULL CHECK (kind IN ('logged','note','identity','started','assigned','completed','refused','withdrawn')),
  text        text NOT NULL CHECK (length(text) BETWEEN 1 AND 2000)
);
CREATE INDEX event_request ON dp.event (request_id, at);

CREATE TABLE dp.retention (
  key         text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{2,59}$'),
  data        text NOT NULL CHECK (length(btrim(data)) BETWEEN 1 AND 200),
  where_kept  text NOT NULL CHECK (length(btrim(where_kept)) BETWEEN 1 AND 200),
  kept_for    text NOT NULL CHECK (length(btrim(kept_for)) BETWEEN 1 AND 200),
  basis       text NOT NULL CHECK (length(btrim(basis)) BETWEEN 1 AND 400),
  how_deleted text NOT NULL CHECK (length(btrim(how_deleted)) BETWEEN 1 AND 400),
  decided     boolean NOT NULL,                  -- false: nobody has set the period yet
  enforced    boolean NOT NULL,                  -- true: the system deletes it by itself
  sort_order  int NOT NULL DEFAULT 100,
  version     bigint NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by  uuid REFERENCES iam.admin_user(id)
);

INSERT INTO dp.retention (key, data, where_kept, kept_for, basis, how_deleted, decided, enforced, sort_order) VALUES
  ('regulated_after_closure', 'Identity checks, requests, accepted deals and their documents after an account is closed',
   'Borrower app database and document vault', 'The years set in ACCOUNT_CLOSURE_RETENTION_YEARS (at least 7); closing an account is switched off until it is set',
   'Anti-money laundering record keeping (FIAMLA): records must be kept at least 7 years', 'Not yet automated: nothing deletes these when the period ends',
   true, false, 10),
  ('personal_on_closure', 'Personal data not needed for regulated records (profile, contacts, preferences)',
   'Borrower app database', 'Until the borrower closes the account', 'Needed only to provide the service',
   'Deleted when the account is closed (close_account)', true, true, 20),
  ('vault_documents', 'Documents borrowers upload to their vault', 'Borrower app document vault',
   'Not decided: each document has a retain_until date, but no policy sets it', 'Not decided',
   'Not decided', false, false, 30),
  ('app_error_reports', 'Error reports from the phone apps (scrubbed of emails, tokens and long numbers)', 'Borrower app database',
   '35 days', 'Fixing faults in the apps', 'Deleted daily after 35 days (app-error-report-purge), and on account closure', true, true, 40),
  ('api_traffic_counts', 'API traffic counts per channel and hour (no personal data)', 'Borrower app database',
   '35 days', 'Running and securing the service', 'Deleted daily after 35 days (api-traffic-purge)', true, true, 50),
  ('admin_audit_log', 'Who did what in the admin sites, and why', 'Admin databases (app_admin, portal_admin)',
   'Not decided: kept indefinitely today', 'Accountability and regulatory evidence', 'Never deleted today: the log is a hash chain',
   false, false, 60),
  ('dp_requests', 'Data protection requests and what was done about them (this page)', 'Admin database (app_admin)',
   'Not decided: kept indefinitely today', 'Evidence that requests were handled as the Act requires', 'Never deleted today',
   false, false, 70);

CREATE FUNCTION dp._view(r dp.request) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object(
    'id', r.id, 'ref', r.ref, 'kind', r.kind, 'requester', r.requester, 'contact', r.contact, 'client_id', r.client_id,
    'channel', r.channel, 'summary', r.summary, 'received_on', r.received_on, 'due_on', r.due_on,
    'days_left', CASE WHEN r.closed_on IS NULL THEN r.due_on - dp._today() END,
    'status', r.status, 'identity_verified_on', r.identity_verified_on, 'identity_method', r.identity_method,
    'owner', iam._email(r.owner_id), 'mine', r.owner_id = iam.current_admin(),
    'outcome', r.outcome, 'closed_on', r.closed_on, 'closed_by', iam._email(r.closed_by),
    'version', r.version, 'created_by', iam._email(r.created_by),
    'events', coalesce((SELECT jsonb_agg(jsonb_build_object('at', e.at, 'by', iam._email(e.actor_id), 'kind', e.kind, 'text', e.text) ORDER BY e.at)
                          FROM dp.event e WHERE e.request_id = r.id), '[]'::jsonb))
$$;

CREATE FUNCTION dp._retention_view(t dp.retention) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('key', t.key, 'data', t.data, 'where_kept', t.where_kept, 'kept_for', t.kept_for,
    'basis', t.basis, 'how_deleted', t.how_deleted, 'decided', t.decided, 'enforced', t.enforced,
    'version', t.version, 'updated_at', t.updated_at, 'updated_by', iam._email(t.updated_by))
$$;

-- The whole page: open requests by deadline, the last 50 closed, and the retention schedule.
CREATE FUNCTION api.dp_view() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE me uuid := iam.require('dp.view');
BEGIN
  RETURN jsonb_build_object(
    'actor', iam._email(me), 'today', dp._today(),
    'can_manage', iam.has_permission(me, 'dp.manage'), 'can_close', iam.has_permission(me, 'dp.close'),
    'open', coalesce((SELECT jsonb_agg(dp._view(r) ORDER BY r.due_on, r.created_at) FROM dp.request r WHERE r.closed_on IS NULL), '[]'::jsonb),
    'closed', coalesce((SELECT jsonb_agg(dp._view(r) ORDER BY r.closed_on DESC, r.created_at DESC)
                          FROM (SELECT * FROM dp.request WHERE closed_on IS NOT NULL ORDER BY closed_on DESC, created_at DESC LIMIT 50) r), '[]'::jsonb),
    'retention', (SELECT jsonb_agg(dp._retention_view(t) ORDER BY t.sort_order, t.key) FROM dp.retention t));
END $$;

CREATE FUNCTION api.dp_log(p_kind text, p_requester text, p_contact text, p_client_id uuid, p_channel text,
  p_summary text, p_received_on date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('dp.manage'); r dp.request;
BEGIN
  IF p_received_on IS NULL OR p_received_on > dp._today() THEN
    RAISE EXCEPTION 'the date it was received cannot be in the future' USING ERRCODE = '22023';
  END IF;
  IF p_received_on < dp._today() - 365 THEN
    RAISE EXCEPTION 'a request received over a year ago cannot be logged here: record it with compliance' USING ERRCODE = '22023';
  END IF;
  INSERT INTO dp.request (kind, requester, contact, client_id, channel, summary, received_on, due_on, owner_id, created_by)
  VALUES (p_kind, btrim(p_requester), btrim(p_contact), p_client_id, p_channel, btrim(p_summary), p_received_on,
          (p_received_on + interval '1 month')::date, a, a)
  RETURNING * INTO r;
  INSERT INTO dp.event (request_id, actor_id, kind, text) VALUES (r.id, a, 'logged', 'Logged. Due ' || to_char(r.due_on, 'DD Mon YYYY') || '.');
  PERFORM audit.record('dp.request_logged', 'dp_request', r.ref, r.summary, NULL,
    jsonb_build_object('ref', r.ref, 'kind', r.kind, 'channel', r.channel, 'received_on', r.received_on, 'due_on', r.due_on, 'client_id', r.client_id));
  RETURN dp._view(r);
EXCEPTION WHEN check_violation THEN
  RAISE EXCEPTION 'one of the fields is not valid: kind, channel, a name, a contact and a summary of at least 10 characters are required'
    USING ERRCODE = '22023';
END $$;

-- One entry point for working a request. p_text is the note, the identity method, or the outcome.
--   note | verify_identity (p_text = how, p_date = when) | start | take | complete | refuse | withdraw
CREATE FUNCTION api.dp_act(p_id uuid, p_expected_version bigint, p_action text, p_text text, p_date date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('dp.manage'); r dp.request; t text := nullif(btrim(coalesce(p_text, '')), '');
        before jsonb;
BEGIN
  SELECT * INTO r FROM dp.request WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown request' USING ERRCODE = 'P0002'; END IF;
  IF r.version <> p_expected_version THEN RAISE EXCEPTION 'request changed since you opened it' USING ERRCODE = '40001'; END IF;
  IF r.closed_on IS NOT NULL THEN RAISE EXCEPTION 'this request is already %', r.status USING ERRCODE = '22023'; END IF;
  before := jsonb_build_object('status', r.status, 'owner', iam._email(r.owner_id), 'identity_verified_on', r.identity_verified_on);

  IF p_action = 'note' THEN
    IF t IS NULL OR length(t) > 2000 THEN RAISE EXCEPTION 'write a note of up to 2000 characters' USING ERRCODE = '22023'; END IF;
    INSERT INTO dp.event (request_id, actor_id, kind, text) VALUES (r.id, a, 'note', t);
  ELSIF p_action = 'verify_identity' THEN
    IF t IS NULL OR length(t) NOT BETWEEN 3 AND 200 THEN RAISE EXCEPTION 'say how identity was checked' USING ERRCODE = '22023'; END IF;
    IF p_date IS NULL OR p_date > dp._today() OR p_date < r.received_on - 30 THEN
      RAISE EXCEPTION 'the date identity was checked must be on or before today' USING ERRCODE = '22023';
    END IF;
    UPDATE dp.request SET identity_verified_on = p_date, identity_method = t WHERE id = r.id;
    INSERT INTO dp.event (request_id, actor_id, kind, text) VALUES (r.id, a, 'identity', 'Identity checked: ' || t);
  ELSIF p_action = 'start' THEN
    IF r.status <> 'received' THEN RAISE EXCEPTION 'this request is already in progress' USING ERRCODE = '22023'; END IF;
    IF r.identity_verified_on IS NULL AND r.kind <> 'withdraw_consent' THEN
      RAISE EXCEPTION 'check the requester''s identity first: personal data must only go to the person it is about' USING ERRCODE = '22023';
    END IF;
    UPDATE dp.request SET status = 'in_progress' WHERE id = r.id;
    INSERT INTO dp.event (request_id, actor_id, kind, text) VALUES (r.id, a, 'started', coalesce(t, 'Work started.'));
  ELSIF p_action = 'take' THEN
    UPDATE dp.request SET owner_id = a WHERE id = r.id;
    INSERT INTO dp.event (request_id, actor_id, kind, text) VALUES (r.id, a, 'assigned', 'Took over this request.');
  ELSIF p_action IN ('complete', 'refuse') THEN
    IF NOT iam.has_permission(a, 'dp.close') THEN
      RAISE EXCEPTION 'permission denied: dp.close (only compliance can complete or refuse a request)' USING ERRCODE = '42501';
    END IF;
    IF t IS NULL OR length(t) NOT BETWEEN 10 AND 2000 THEN
      RAISE EXCEPTION 'describe the outcome in 10 to 2000 characters: what was sent, changed or deleted, or why it was refused' USING ERRCODE = '22023';
    END IF;
    IF p_action = 'complete' AND r.identity_verified_on IS NULL AND r.kind <> 'withdraw_consent' THEN
      RAISE EXCEPTION 'record the identity check before completing' USING ERRCODE = '22023';
    END IF;
    UPDATE dp.request SET status = CASE p_action WHEN 'complete' THEN 'completed' ELSE 'refused' END,
           outcome = t, closed_on = dp._today(), closed_by = a WHERE id = r.id;
    INSERT INTO dp.event (request_id, actor_id, kind, text)
    VALUES (r.id, a, CASE p_action WHEN 'complete' THEN 'completed' ELSE 'refused' END, t);
  ELSIF p_action = 'withdraw' THEN
    IF t IS NULL OR length(t) NOT BETWEEN 10 AND 2000 THEN RAISE EXCEPTION 'say how the requester withdrew it' USING ERRCODE = '22023'; END IF;
    UPDATE dp.request SET status = 'withdrawn', closed_on = dp._today() WHERE id = r.id;
    INSERT INTO dp.event (request_id, actor_id, kind, text) VALUES (r.id, a, 'withdrawn', t);
  ELSE
    RAISE EXCEPTION 'unknown action' USING ERRCODE = '22023';
  END IF;

  UPDATE dp.request SET version = version + 1, updated_at = clock_timestamp() WHERE id = r.id RETURNING * INTO r;
  PERFORM audit.record('dp.request_' || p_action, 'dp_request', r.ref,
    CASE WHEN p_action IN ('note', 'complete', 'refuse', 'withdraw', 'verify_identity') THEN t END, before,
    jsonb_build_object('status', r.status, 'owner', iam._email(r.owner_id), 'identity_verified_on', r.identity_verified_on, 'closed_on', r.closed_on));
  RETURN dp._view(r);
END $$;

CREATE FUNCTION api.dp_retention_save(p_key text, p_expected_version bigint, p_data text, p_where_kept text, p_kept_for text,
  p_basis text, p_how_deleted text, p_decided boolean, p_enforced boolean, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('dp.manage'); r text := util.require_reason(p_reason); cur dp.retention; d dp.retention;
BEGIN
  IF p_decided IS NULL OR p_enforced IS NULL THEN RAISE EXCEPTION 'say whether it is decided and enforced' USING ERRCODE = '22023'; END IF;
  SELECT * INTO cur FROM dp.retention WHERE key = p_key FOR UPDATE;
  IF p_expected_version IS NULL THEN
    IF FOUND THEN RAISE EXCEPTION 'an entry with this short name already exists' USING ERRCODE = '23505'; END IF;
    INSERT INTO dp.retention (key, data, where_kept, kept_for, basis, how_deleted, decided, enforced, version, updated_by)
    VALUES (p_key, btrim(p_data), btrim(p_where_kept), btrim(p_kept_for), btrim(p_basis), btrim(p_how_deleted), p_decided, p_enforced, 1, a)
    RETURNING * INTO d;
    PERFORM audit.record('dp.retention_added', 'dp_retention', d.key, r, NULL, dp._retention_view(d));
    RETURN dp._retention_view(d);
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown entry' USING ERRCODE = 'P0002'; END IF;
  IF cur.version <> p_expected_version THEN RAISE EXCEPTION 'this entry changed since you opened it' USING ERRCODE = '40001'; END IF;
  UPDATE dp.retention SET data = btrim(p_data), where_kept = btrim(p_where_kept), kept_for = btrim(p_kept_for), basis = btrim(p_basis),
         how_deleted = btrim(p_how_deleted), decided = p_decided, enforced = p_enforced,
         version = version + 1, updated_at = clock_timestamp(), updated_by = a
   WHERE key = p_key RETURNING * INTO d;
  PERFORM audit.record('dp.retention_updated', 'dp_retention', d.key, r, dp._retention_view(cur), dp._retention_view(d));
  RETURN dp._retention_view(d);
EXCEPTION WHEN check_violation THEN
  RAISE EXCEPTION 'every field is required and must be short: data, where kept, kept for, basis and how deleted' USING ERRCODE = '22023';
END $$;

REVOKE ALL ON SCHEMA dp FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA dp FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION api.dp_view(), api.dp_log(text, text, text, uuid, text, text, date),
  api.dp_act(uuid, bigint, text, text, date),
  api.dp_retention_save(text, bigint, text, text, text, text, text, boolean, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.dp_view(), api.dp_log(text, text, text, uuid, text, text, date),
  api.dp_act(uuid, bigint, text, text, date),
  api.dp_retention_save(text, bigint, text, text, text, text, text, boolean, boolean, text) TO app_admin_api;
-- Read-only reporting sees the schedule and the counts, not who asked.
GRANT USAGE ON SCHEMA dp TO app_admin_readonly;
GRANT SELECT ON dp.retention TO app_admin_readonly;
GRANT SELECT (id, ref, kind, channel, received_on, due_on, status, identity_verified_on, closed_on, created_at) ON dp.request TO app_admin_readonly;
