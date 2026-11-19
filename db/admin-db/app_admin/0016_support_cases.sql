-- 0016_support_cases.sql — complaints and support cases (KJ, 2026-11-19).
--
-- Every complaint, problem, question or piece of feedback from a borrower is a case: what they
-- said, how it arrived, who owns it, a timeline of what was done, and how it ended. Complaints
-- also record whether they were upheld, the redress given, and a cause category, because a bank
-- reviewing Ficium (and any regulator) asks for the complaints register and its trends.
--
-- Deadlines are Ficium's own service targets per kind (support.target), editable on the page and
-- copied onto each case when it is opened, so changing a target never moves an existing deadline.
-- Seeded defaults, not a regulation: complaints acknowledged within 2 days, answered within 15.
-- If Ficium is licensed, set these to the regulator's complaint-handling rules.
--
-- Cases hold names and contacts, so read_only does not get case.view. Resolving a COMPLAINT needs
-- case.resolve_complaint (super admin, compliance): deciding whether a complaint is upheld is a
-- compliance call. Every step is audited; the timeline is append-only.
SET LOCAL ROLE app_admin_owner;
SET LOCAL search_path = pg_catalog;

INSERT INTO iam.permission (code, description) VALUES
  ('case.view',              'See complaints and support cases'),
  ('case.manage',            'Open and work complaints and support cases, and set their targets'),
  ('case.resolve_complaint', 'Decide a complaint: upheld or not, and the redress');
INSERT INTO iam.role_permission (role_code, permission_code) VALUES
  ('super_admin', 'case.view'), ('compliance', 'case.view'), ('operations', 'case.view'),
  ('super_admin', 'case.manage'), ('compliance', 'case.manage'), ('operations', 'case.manage'),
  ('super_admin', 'case.resolve_complaint'), ('compliance', 'case.resolve_complaint');

CREATE SCHEMA support AUTHORIZATION app_admin_owner;
CREATE SEQUENCE support.ref_seq;

CREATE TABLE support.target (
  kind          text PRIMARY KEY CHECK (kind IN ('complaint','problem','question','feedback')),
  ack_hours     int NOT NULL CHECK (ack_hours BETWEEN 1 AND 720),
  resolve_days  int NOT NULL CHECK (resolve_days BETWEEN 1 AND 365),
  version       bigint NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by    uuid REFERENCES iam.admin_user(id)
);
INSERT INTO support.target (kind, ack_hours, resolve_days) VALUES
  ('complaint', 48, 15), ('problem', 24, 5), ('question', 48, 5), ('feedback', 72, 30);

CREATE TABLE support.case_item (
  id            uuid PRIMARY KEY DEFAULT util.uuid_v7(),
  ref           text NOT NULL UNIQUE DEFAULT 'CASE-' || lpad(nextval('support.ref_seq')::text, 4, '0'),
  kind          text NOT NULL CHECK (kind IN ('complaint','problem','question','feedback')),
  category      text NOT NULL CHECK (category IN ('kyc','request','bids','deal','account','app','fees','privacy','conduct','other')),
  subject       text NOT NULL CHECK (length(btrim(subject)) BETWEEN 5 AND 120),
  detail        text NOT NULL CHECK (length(btrim(detail)) BETWEEN 10 AND 4000),
  requester     text NOT NULL CHECK (length(btrim(requester)) BETWEEN 1 AND 120),
  contact       text NOT NULL CHECK (length(btrim(contact)) BETWEEN 1 AND 200),
  client_id     uuid,
  channel       text NOT NULL CHECK (channel IN ('email','app','phone','letter','in_person','social','other')),
  received_at   timestamptz NOT NULL,
  ack_due_at    timestamptz NOT NULL,
  resolve_due_on date NOT NULL,
  acknowledged_at timestamptz,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved','withdrawn')),
  outcome       text CHECK (outcome IS NULL OR length(outcome) BETWEEN 10 AND 4000),
  upheld        text CHECK (upheld IS NULL OR upheld IN ('upheld','partly','not_upheld')),
  redress       text CHECK (redress IS NULL OR length(redress) BETWEEN 1 AND 1000),
  referred_to   text CHECK (referred_to IS NULL OR length(referred_to) BETWEEN 3 AND 200),
  referred_at   timestamptz,
  resolved_at   timestamptz,
  resolved_by   uuid REFERENCES iam.admin_user(id),
  owner_id      uuid REFERENCES iam.admin_user(id),
  reopened      int NOT NULL DEFAULT 0,
  version       bigint NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by    uuid NOT NULL REFERENCES iam.admin_user(id),
  updated_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((status IN ('resolved','withdrawn')) = (resolved_at IS NOT NULL)),
  CHECK (status <> 'resolved' OR (outcome IS NOT NULL AND resolved_by IS NOT NULL)),
  CHECK (kind = 'complaint' OR (upheld IS NULL AND redress IS NULL)),
  CHECK (status <> 'resolved' OR kind <> 'complaint' OR upheld IS NOT NULL),
  CHECK ((referred_to IS NULL) = (referred_at IS NULL))
);
CREATE INDEX case_open ON support.case_item (resolve_due_on) WHERE resolved_at IS NULL;
CREATE INDEX case_recent ON support.case_item (created_at DESC);
CREATE INDEX case_client ON support.case_item (client_id) WHERE client_id IS NOT NULL;

CREATE TABLE support.event (
  id        uuid PRIMARY KEY DEFAULT util.uuid_v7(),
  case_id   uuid NOT NULL REFERENCES support.case_item(id),
  at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_id  uuid NOT NULL REFERENCES iam.admin_user(id),
  kind      text NOT NULL CHECK (kind IN ('opened','note','acknowledged','assigned','resolved','withdrawn','reopened','referred')),
  text      text NOT NULL CHECK (length(text) BETWEEN 1 AND 4000)
);
CREATE INDEX event_case ON support.event (case_id, at);

CREATE FUNCTION support._today() RETURNS date
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$ SELECT (clock_timestamp() AT TIME ZONE 'Indian/Mauritius')::date $$;

CREATE FUNCTION support._view(c support.case_item) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object(
    'id', c.id, 'ref', c.ref, 'kind', c.kind, 'category', c.category, 'subject', c.subject, 'detail', c.detail,
    'requester', c.requester, 'contact', c.contact, 'client_id', c.client_id, 'channel', c.channel,
    'received_at', c.received_at, 'ack_due_at', c.ack_due_at, 'resolve_due_on', c.resolve_due_on,
    'days_left', CASE WHEN c.resolved_at IS NULL THEN c.resolve_due_on - support._today() END,
    'ack_overdue', c.acknowledged_at IS NULL AND c.resolved_at IS NULL AND c.ack_due_at < clock_timestamp(),
    'acknowledged_at', c.acknowledged_at, 'status', c.status, 'outcome', c.outcome, 'upheld', c.upheld, 'redress', c.redress,
    'referred_to', c.referred_to, 'referred_at', c.referred_at, 'resolved_at', c.resolved_at, 'resolved_by', iam._email(c.resolved_by),
    'on_time', CASE WHEN c.resolved_at IS NOT NULL THEN (c.resolved_at AT TIME ZONE 'Indian/Mauritius')::date <= c.resolve_due_on END,
    'owner', iam._email(c.owner_id), 'mine', c.owner_id = iam.current_admin(), 'reopened', c.reopened, 'version', c.version,
    'events', coalesce((SELECT jsonb_agg(jsonb_build_object('at', e.at, 'by', iam._email(e.actor_id), 'kind', e.kind, 'text', e.text) ORDER BY e.at)
                          FROM support.event e WHERE e.case_id = c.id), '[]'::jsonb))
$$;

-- Open cases by deadline; the last 50 resolved; targets; and the complaints register for 12 months.
CREATE FUNCTION api.case_view() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE me uuid := iam.require('case.view');
BEGIN
  RETURN jsonb_build_object(
    'actor', iam._email(me), 'now', clock_timestamp(), 'today', support._today(),
    'can_manage', iam.has_permission(me, 'case.manage'), 'can_resolve_complaint', iam.has_permission(me, 'case.resolve_complaint'),
    'open', coalesce((SELECT jsonb_agg(support._view(c) ORDER BY (c.kind = 'complaint') DESC, c.resolve_due_on, c.received_at)
                        FROM support.case_item c WHERE c.resolved_at IS NULL), '[]'::jsonb),
    'closed', coalesce((SELECT jsonb_agg(support._view(c) ORDER BY c.resolved_at DESC)
                          FROM (SELECT * FROM support.case_item WHERE resolved_at IS NOT NULL ORDER BY resolved_at DESC LIMIT 50) c), '[]'::jsonb),
    'targets', (SELECT jsonb_agg(jsonb_build_object('kind', t.kind, 'ack_hours', t.ack_hours, 'resolve_days', t.resolve_days, 'version', t.version,
                  'updated_by', iam._email(t.updated_by), 'updated_at', t.updated_at) ORDER BY array_position(ARRAY['complaint','problem','question','feedback'], t.kind))
                FROM support.target t),
    'complaints_12m', (SELECT jsonb_build_object(
        'received', count(*), 'resolved', count(*) FILTER (WHERE c.status = 'resolved'),
        'on_time', count(*) FILTER (WHERE c.status = 'resolved' AND (c.resolved_at AT TIME ZONE 'Indian/Mauritius')::date <= c.resolve_due_on),
        'upheld', count(*) FILTER (WHERE c.upheld = 'upheld'), 'partly', count(*) FILTER (WHERE c.upheld = 'partly'),
        'not_upheld', count(*) FILTER (WHERE c.upheld = 'not_upheld'), 'referred', count(*) FILTER (WHERE c.referred_at IS NOT NULL),
        'by_category', coalesce((SELECT jsonb_object_agg(category, n) FROM (SELECT category, count(*) AS n FROM support.case_item
                          WHERE kind = 'complaint' AND received_at >= clock_timestamp() - interval '12 months' GROUP BY category) g), '{}'::jsonb))
      FROM support.case_item c WHERE c.kind = 'complaint' AND c.received_at >= clock_timestamp() - interval '12 months'));
END $$;

CREATE FUNCTION api.case_open(p_kind text, p_category text, p_subject text, p_detail text, p_requester text, p_contact text,
  p_client_id uuid, p_channel text, p_received_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('case.manage'); t support.target; c support.case_item;
BEGIN
  SELECT * INTO t FROM support.target WHERE kind = p_kind;
  IF NOT FOUND THEN RAISE EXCEPTION 'choose what kind of case this is' USING ERRCODE = '22023'; END IF;
  IF p_received_at IS NULL OR p_received_at > clock_timestamp() + interval '5 minutes' OR p_received_at < clock_timestamp() - interval '1 year' THEN
    RAISE EXCEPTION 'when it was received must be within the last year, and not in the future' USING ERRCODE = '22023';
  END IF;
  INSERT INTO support.case_item (kind, category, subject, detail, requester, contact, client_id, channel, received_at,
                                 ack_due_at, resolve_due_on, owner_id, created_by)
  VALUES (p_kind, p_category, btrim(p_subject), btrim(p_detail), btrim(p_requester), btrim(p_contact), p_client_id, p_channel, p_received_at,
          p_received_at + make_interval(hours => t.ack_hours),
          (p_received_at AT TIME ZONE 'Indian/Mauritius')::date + t.resolve_days, a, a)
  RETURNING * INTO c;
  INSERT INTO support.event (case_id, actor_id, kind, text) VALUES (c.id, a, 'opened',
    'Opened. Acknowledge by ' || to_char(c.ack_due_at AT TIME ZONE 'Indian/Mauritius', 'DD Mon HH24:MI') || ', answer by ' || to_char(c.resolve_due_on, 'DD Mon YYYY') || '.');
  PERFORM audit.record('case.opened', 'support_case', c.ref, c.subject, NULL,
    jsonb_build_object('ref', c.ref, 'kind', c.kind, 'category', c.category, 'channel', c.channel, 'client_id', c.client_id,
                       'received_at', c.received_at, 'resolve_due_on', c.resolve_due_on));
  RETURN support._view(c);
EXCEPTION WHEN check_violation THEN
  RAISE EXCEPTION 'one of the fields is not valid: a category, a subject of 5 to 120 characters, details of at least 10, a name, a contact and a channel are required'
    USING ERRCODE = '22023';
END $$;

-- note | acknowledge (text = what was said) | take | resolve (text = outcome; upheld + redress for complaints)
-- | withdraw (text) | reopen (text, within 30 days of resolving) | referred (text = to whom, at = when)
CREATE FUNCTION api.case_act(p_id uuid, p_expected_version bigint, p_action text, p_text text, p_upheld text, p_redress text, p_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('case.manage'); c support.case_item; t text := nullif(btrim(coalesce(p_text, '')), '');
        r text := nullif(btrim(coalesce(p_redress, '')), ''); now_ timestamptz := clock_timestamp(); before jsonb;
BEGIN
  SELECT * INTO c FROM support.case_item WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown case' USING ERRCODE = 'P0002'; END IF;
  IF c.version <> p_expected_version THEN RAISE EXCEPTION 'case changed since you opened it' USING ERRCODE = '40001'; END IF;
  IF t IS NOT NULL AND length(t) > 4000 THEN RAISE EXCEPTION 'that text is too long' USING ERRCODE = '22023'; END IF;
  IF c.resolved_at IS NOT NULL AND p_action NOT IN ('reopen', 'referred', 'note') THEN
    RAISE EXCEPTION 'this case is %', c.status USING ERRCODE = '22023';
  END IF;
  before := jsonb_build_object('status', c.status, 'owner', iam._email(c.owner_id), 'upheld', c.upheld);

  IF p_action = 'note' THEN
    IF t IS NULL THEN RAISE EXCEPTION 'write the note' USING ERRCODE = '22023'; END IF;
    INSERT INTO support.event (case_id, actor_id, kind, text) VALUES (c.id, a, 'note', t);
  ELSIF p_action = 'acknowledge' THEN
    IF c.acknowledged_at IS NOT NULL THEN RAISE EXCEPTION 'already acknowledged' USING ERRCODE = '22023'; END IF;
    IF t IS NULL OR length(t) < 5 THEN RAISE EXCEPTION 'say how it was acknowledged' USING ERRCODE = '22023'; END IF;
    UPDATE support.case_item SET acknowledged_at = now_, status = 'acknowledged' WHERE id = c.id;
    INSERT INTO support.event (case_id, actor_id, kind, text) VALUES (c.id, a, 'acknowledged', t);
  ELSIF p_action = 'take' THEN
    UPDATE support.case_item SET owner_id = a WHERE id = c.id;
    INSERT INTO support.event (case_id, actor_id, kind, text) VALUES (c.id, a, 'assigned', 'Took over this case.');
  ELSIF p_action = 'resolve' THEN
    IF t IS NULL OR length(t) < 10 THEN RAISE EXCEPTION 'describe the answer given in at least 10 characters' USING ERRCODE = '22023'; END IF;
    IF c.kind = 'complaint' THEN
      IF NOT iam.has_permission(a, 'case.resolve_complaint') THEN
        RAISE EXCEPTION 'permission denied: case.resolve_complaint (only compliance can decide a complaint)' USING ERRCODE = '42501';
      END IF;
      IF coalesce(p_upheld, '') NOT IN ('upheld', 'partly', 'not_upheld') THEN
        RAISE EXCEPTION 'say whether the complaint is upheld, partly upheld or not upheld' USING ERRCODE = '22023';
      END IF;
      IF p_upheld IN ('upheld', 'partly') AND r IS NULL THEN
        RAISE EXCEPTION 'an upheld complaint needs the redress given (an apology counts: say so)' USING ERRCODE = '22023';
      END IF;
    ELSIF p_upheld IS NOT NULL OR r IS NOT NULL THEN
      RAISE EXCEPTION 'only complaints are upheld or not' USING ERRCODE = '22023';
    END IF;
    IF r IS NOT NULL AND length(r) > 1000 THEN RAISE EXCEPTION 'the redress is too long' USING ERRCODE = '22023'; END IF;
    UPDATE support.case_item SET status = 'resolved', outcome = t, upheld = p_upheld, redress = r, resolved_at = now_, resolved_by = a,
           acknowledged_at = coalesce(acknowledged_at, now_) WHERE id = c.id;
    INSERT INTO support.event (case_id, actor_id, kind, text) VALUES (c.id, a, 'resolved',
      t || CASE WHEN p_upheld IS NOT NULL THEN ' (' || replace(p_upheld, '_', ' ') || coalesce('; redress: ' || r, '') || ')' ELSE '' END);
  ELSIF p_action = 'withdraw' THEN
    IF t IS NULL OR length(t) < 10 THEN RAISE EXCEPTION 'say how the person withdrew it' USING ERRCODE = '22023'; END IF;
    UPDATE support.case_item SET status = 'withdrawn', resolved_at = now_ WHERE id = c.id;
    INSERT INTO support.event (case_id, actor_id, kind, text) VALUES (c.id, a, 'withdrawn', t);
  ELSIF p_action = 'reopen' THEN
    IF c.resolved_at IS NULL THEN RAISE EXCEPTION 'this case is still open' USING ERRCODE = '22023'; END IF;
    IF c.resolved_at < now_ - interval '30 days' THEN RAISE EXCEPTION 'resolved over 30 days ago: open a new case instead' USING ERRCODE = '22023'; END IF;
    IF t IS NULL OR length(t) < 10 THEN RAISE EXCEPTION 'say why it is reopened' USING ERRCODE = '22023'; END IF;
    UPDATE support.case_item SET status = CASE WHEN acknowledged_at IS NULL THEN 'open' ELSE 'acknowledged' END,
           outcome = NULL, upheld = NULL, redress = NULL, resolved_at = NULL, resolved_by = NULL, reopened = reopened + 1 WHERE id = c.id;
    INSERT INTO support.event (case_id, actor_id, kind, text) VALUES (c.id, a, 'reopened', t);
  ELSIF p_action = 'referred' THEN
    IF c.kind <> 'complaint' THEN RAISE EXCEPTION 'only complaints are referred onwards' USING ERRCODE = '22023'; END IF;
    IF t IS NULL OR length(t) NOT BETWEEN 3 AND 200 THEN RAISE EXCEPTION 'say who it was referred to' USING ERRCODE = '22023'; END IF;
    IF p_at IS NULL OR p_at > now_ + interval '5 minutes' THEN RAISE EXCEPTION 'give when it was referred' USING ERRCODE = '22023'; END IF;
    UPDATE support.case_item SET referred_to = t, referred_at = p_at WHERE id = c.id;
    INSERT INTO support.event (case_id, actor_id, kind, text) VALUES (c.id, a, 'referred', 'Referred to ' || t);
  ELSE
    RAISE EXCEPTION 'unknown action' USING ERRCODE = '22023';
  END IF;

  UPDATE support.case_item SET version = version + 1, updated_at = now_ WHERE id = c.id RETURNING * INTO c;
  PERFORM audit.record('case.' || p_action, 'support_case', c.ref, t, before,
    jsonb_build_object('status', c.status, 'owner', iam._email(c.owner_id), 'upheld', c.upheld, 'referred_to', c.referred_to));
  RETURN support._view(c);
END $$;

CREATE FUNCTION api.case_target_save(p_kind text, p_expected_version bigint, p_ack_hours int, p_resolve_days int, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('case.manage'); r text := util.require_reason(p_reason); cur support.target; d support.target;
BEGIN
  SELECT * INTO cur FROM support.target WHERE kind = p_kind FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown kind' USING ERRCODE = 'P0002'; END IF;
  IF cur.version <> p_expected_version THEN RAISE EXCEPTION 'this target changed since you opened it' USING ERRCODE = '40001'; END IF;
  IF p_ack_hours IS NULL OR p_ack_hours NOT BETWEEN 1 AND 720 OR p_resolve_days IS NULL OR p_resolve_days NOT BETWEEN 1 AND 365 THEN
    RAISE EXCEPTION 'acknowledge within 1 to 720 hours, answer within 1 to 365 days' USING ERRCODE = '22023';
  END IF;
  UPDATE support.target SET ack_hours = p_ack_hours, resolve_days = p_resolve_days, version = version + 1,
         updated_at = clock_timestamp(), updated_by = a WHERE kind = p_kind RETURNING * INTO d;
  PERFORM audit.record('case.target_changed', 'support_target', d.kind, r,
    jsonb_build_object('ack_hours', cur.ack_hours, 'resolve_days', cur.resolve_days),
    jsonb_build_object('ack_hours', d.ack_hours, 'resolve_days', d.resolve_days));
  RETURN jsonb_build_object('kind', d.kind, 'ack_hours', d.ack_hours, 'resolve_days', d.resolve_days, 'version', d.version);
END $$;

REVOKE ALL ON SCHEMA support FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA support FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION api.case_view(), api.case_open(text, text, text, text, text, text, uuid, text, timestamptz),
  api.case_act(uuid, bigint, text, text, text, text, timestamptz), api.case_target_save(text, bigint, int, int, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.case_view(), api.case_open(text, text, text, text, text, text, uuid, text, timestamptz),
  api.case_act(uuid, bigint, text, text, text, text, timestamptz), api.case_target_save(text, bigint, int, int, text) TO app_admin_api;
-- Read-only reporting: the register's shape and trends, never who complained or what they said.
GRANT USAGE ON SCHEMA support TO app_admin_readonly;
GRANT SELECT ON support.target TO app_admin_readonly;
GRANT SELECT (id, ref, kind, category, channel, received_at, ack_due_at, resolve_due_on, acknowledged_at, status, upheld,
  referred_at, resolved_at, reopened, created_at) ON support.case_item TO app_admin_readonly;
