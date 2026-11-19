-- 0015_incidents.sql — incident register (KJ, 2026-11-19).
--
-- An outage, a security event, a failed change or a supplier failure is logged here: severity
-- (1 = service down or data exposed, 2 = a major feature broken for many, 3 = minor), when it
-- started and when Ficium noticed, an owner, an append-only timeline, the root cause, and the
-- follow-ups that stop it happening again. A bank's third-party risk review asks to see exactly
-- this, and the incident runbook (docs) refers to it.
--
-- Personal data. When an incident involves personal data, the Data Protection Act 2017 s.25
-- requires telling the Data Protection Commissioner without undue delay and, where feasible,
-- within 72 hours of becoming aware; s.26 requires telling the people affected when the risk to
-- them is high. The deadline runs from detected_at and shows on the page and the Audit banner
-- until the report is recorded, or compliance records why it is unlikely to put anyone at risk.
--
-- Closing needs incident.close (super admin, compliance), a resolved incident, a root cause,
-- every follow-up done, and the breach question answered. Every step is audited.
SET LOCAL ROLE app_admin_owner;
SET LOCAL search_path = pg_catalog;

INSERT INTO iam.permission (code, description) VALUES
  ('incident.view',   'See incidents, their timelines and follow-ups'),
  ('incident.manage', 'Open and update incidents, and add follow-ups'),
  ('incident.close',  'Close an incident after its review');
INSERT INTO iam.role_permission (role_code, permission_code) VALUES
  ('super_admin', 'incident.view'), ('compliance', 'incident.view'), ('operations', 'incident.view'), ('read_only', 'incident.view'),
  ('super_admin', 'incident.manage'), ('compliance', 'incident.manage'), ('operations', 'incident.manage'),
  ('super_admin', 'incident.close'), ('compliance', 'incident.close');

CREATE SCHEMA incident AUTHORIZATION app_admin_owner;
CREATE SEQUENCE incident.ref_seq;

CREATE TABLE incident.item (
  id            uuid PRIMARY KEY DEFAULT util.uuid_v7(),
  ref           text NOT NULL UNIQUE DEFAULT 'INC-' || lpad(nextval('incident.ref_seq')::text, 4, '0'),
  title         text NOT NULL CHECK (length(btrim(title)) BETWEEN 5 AND 120),
  severity      smallint NOT NULL CHECK (severity BETWEEN 1 AND 3),
  kind          text NOT NULL CHECK (kind IN ('outage','degraded','security','data','third_party','change','other')),
  service_key   text CHECK (service_key IS NULL OR service_key ~ '^[a-z][a-z0-9_]{2,59}$'),
  impact        text NOT NULL CHECK (length(btrim(impact)) BETWEEN 10 AND 2000),
  started_at    timestamptz NOT NULL,
  detected_at   timestamptz NOT NULL,          -- when Ficium became aware: the breach clock starts here
  mitigated_at  timestamptz,
  resolved_at   timestamptz,
  closed_at     timestamptz,
  status        text NOT NULL DEFAULT 'investigating' CHECK (status IN ('investigating','mitigated','resolved','closed')),
  personal_data boolean NOT NULL DEFAULT false, -- personal data lost, exposed, changed or unavailable
  breach_reported_at timestamptz,               -- notified to the Data Protection Commissioner (s.25)
  breach_not_reported text CHECK (breach_not_reported IS NULL OR length(breach_not_reported) BETWEEN 10 AND 2000),
  people_told_at timestamptz,                   -- the people affected were told (s.26)
  root_cause    text CHECK (root_cause IS NULL OR length(root_cause) BETWEEN 10 AND 4000),
  owner_id      uuid REFERENCES iam.admin_user(id),
  closed_by     uuid REFERENCES iam.admin_user(id),
  version       bigint NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by    uuid NOT NULL REFERENCES iam.admin_user(id),
  updated_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (detected_at >= started_at),
  CHECK (mitigated_at IS NULL OR mitigated_at >= started_at),
  CHECK (resolved_at IS NULL OR resolved_at >= started_at),
  CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
  CHECK (status NOT IN ('resolved','closed') OR resolved_at IS NOT NULL),
  CHECK (status <> 'closed' OR (root_cause IS NOT NULL AND closed_by IS NOT NULL)),
  CHECK (NOT (breach_reported_at IS NOT NULL AND breach_not_reported IS NOT NULL)),
  CHECK (personal_data OR (breach_reported_at IS NULL AND breach_not_reported IS NULL AND people_told_at IS NULL))
);
CREATE INDEX item_open ON incident.item (severity, detected_at) WHERE closed_at IS NULL;
CREATE INDEX item_recent ON incident.item (created_at DESC);

-- What happened, in order. Append-only.
CREATE TABLE incident.event (
  id          uuid PRIMARY KEY DEFAULT util.uuid_v7(),
  incident_id uuid NOT NULL REFERENCES incident.item(id),
  at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_id    uuid NOT NULL REFERENCES iam.admin_user(id),
  kind        text NOT NULL CHECK (kind IN ('opened','update','mitigated','resolved','closed','breach','severity','assigned','follow_up')),
  text        text NOT NULL CHECK (length(text) BETWEEN 1 AND 4000)
);
CREATE INDEX event_incident ON incident.event (incident_id, at);

-- Follow-ups: what must change so it does not happen again. An incident closes only when all are done.
CREATE TABLE incident.follow_up (
  id          uuid PRIMARY KEY DEFAULT util.uuid_v7(),
  incident_id uuid NOT NULL REFERENCES incident.item(id),
  text        text NOT NULL CHECK (length(btrim(text)) BETWEEN 5 AND 500),
  owner       text NOT NULL DEFAULT '' CHECK (length(owner) <= 120),
  due_on      date,
  done_at     timestamptz,
  done_by     uuid REFERENCES iam.admin_user(id),
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by  uuid NOT NULL REFERENCES iam.admin_user(id),
  CHECK ((done_at IS NULL) = (done_by IS NULL))
);
CREATE INDEX follow_up_incident ON incident.follow_up (incident_id);

-- When the Commissioner must be told: 72 hours after becoming aware, while personal data is
-- involved and nobody has either reported it or recorded why it need not be.
CREATE FUNCTION incident._breach_due(i incident.item) RETURNS timestamptz
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT CASE WHEN i.personal_data AND i.breach_reported_at IS NULL AND i.breach_not_reported IS NULL
              THEN i.detected_at + interval '72 hours' END
$$;

CREATE FUNCTION incident._view(i incident.item) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object(
    'id', i.id, 'ref', i.ref, 'title', i.title, 'severity', i.severity, 'kind', i.kind, 'service_key', i.service_key,
    'impact', i.impact, 'started_at', i.started_at, 'detected_at', i.detected_at, 'mitigated_at', i.mitigated_at,
    'resolved_at', i.resolved_at, 'closed_at', i.closed_at, 'status', i.status,
    'personal_data', i.personal_data, 'breach_reported_at', i.breach_reported_at, 'breach_not_reported', i.breach_not_reported,
    'people_told_at', i.people_told_at, 'breach_due_at', incident._breach_due(i), 'root_cause', i.root_cause,
    'owner', iam._email(i.owner_id), 'mine', i.owner_id = iam.current_admin(), 'closed_by', iam._email(i.closed_by),
    'created_by', iam._email(i.created_by), 'version', i.version,
    'events', coalesce((SELECT jsonb_agg(jsonb_build_object('at', e.at, 'by', iam._email(e.actor_id), 'kind', e.kind, 'text', e.text) ORDER BY e.at)
                          FROM incident.event e WHERE e.incident_id = i.id), '[]'::jsonb),
    'follow_ups', coalesce((SELECT jsonb_agg(jsonb_build_object('id', f.id, 'text', f.text, 'owner', f.owner, 'due_on', f.due_on,
                              'done_at', f.done_at, 'done_by', iam._email(f.done_by)) ORDER BY f.created_at)
                          FROM incident.follow_up f WHERE f.incident_id = i.id), '[]'::jsonb))
$$;

CREATE FUNCTION api.incident_view() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE me uuid := iam.require('incident.view');
BEGIN
  RETURN jsonb_build_object(
    'actor', iam._email(me), 'now', clock_timestamp(),
    'can_manage', iam.has_permission(me, 'incident.manage'), 'can_close', iam.has_permission(me, 'incident.close'),
    'open', coalesce((SELECT jsonb_agg(incident._view(i) ORDER BY i.severity, i.detected_at) FROM incident.item i WHERE i.closed_at IS NULL), '[]'::jsonb),
    'closed', coalesce((SELECT jsonb_agg(incident._view(i) ORDER BY i.closed_at DESC)
                          FROM (SELECT * FROM incident.item WHERE closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT 50) i), '[]'::jsonb));
END $$;

CREATE FUNCTION api.incident_open(p_title text, p_severity int, p_kind text, p_service_key text, p_impact text,
  p_started_at timestamptz, p_detected_at timestamptz, p_personal_data boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('incident.manage'); i incident.item; now_ timestamptz := clock_timestamp();
BEGIN
  IF p_started_at IS NULL OR p_detected_at IS NULL OR p_started_at > now_ + interval '5 minutes' OR p_detected_at > now_ + interval '5 minutes' THEN
    RAISE EXCEPTION 'when it started and when it was noticed are required, and cannot be in the future' USING ERRCODE = '22023';
  END IF;
  IF p_detected_at < p_started_at THEN RAISE EXCEPTION 'it cannot have been noticed before it started' USING ERRCODE = '22023'; END IF;
  INSERT INTO incident.item (title, severity, kind, service_key, impact, started_at, detected_at, personal_data, owner_id, created_by)
  VALUES (btrim(p_title), p_severity, p_kind, nullif(btrim(coalesce(p_service_key, '')), ''), btrim(p_impact), p_started_at, p_detected_at,
          coalesce(p_personal_data, false), a, a)
  RETURNING * INTO i;
  INSERT INTO incident.event (incident_id, actor_id, kind, text) VALUES (i.id, a, 'opened', 'Opened: ' || i.title);
  PERFORM audit.record('incident.opened', 'incident', i.ref, i.impact, NULL,
    jsonb_build_object('ref', i.ref, 'severity', i.severity, 'kind', i.kind, 'service_key', i.service_key, 'personal_data', i.personal_data,
                       'started_at', i.started_at, 'detected_at', i.detected_at));
  RETURN incident._view(i);
EXCEPTION WHEN check_violation THEN
  RAISE EXCEPTION 'one of the fields is not valid: a title of 5 to 120 characters, severity 1 to 3, a kind, and an impact of at least 10 characters are required'
    USING ERRCODE = '22023';
END $$;

-- One entry point for working an incident.
--   update (text) | severity (p_number 1-3, text why) | take | mitigated (text) | resolved (text)
--   personal_data (text why) | breach_reported (p_at, text reference) | breach_not_reported (text why)
--   people_told (p_at, text how) | root_cause (text) | follow_up (text, p_owner, p_date)
--   follow_up_done (p_follow_up) | close (text summary)
CREATE FUNCTION api.incident_act(p_id uuid, p_expected_version bigint, p_action text, p_text text,
  p_at timestamptz, p_number int, p_owner text, p_date date, p_follow_up uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('incident.manage'); i incident.item; t text := nullif(btrim(coalesce(p_text, '')), '');
        now_ timestamptz := clock_timestamp(); before jsonb; open_fu int;
BEGIN
  SELECT * INTO i FROM incident.item WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown incident' USING ERRCODE = 'P0002'; END IF;
  IF i.version <> p_expected_version THEN RAISE EXCEPTION 'incident changed since you opened it' USING ERRCODE = '40001'; END IF;
  IF i.closed_at IS NOT NULL THEN RAISE EXCEPTION 'this incident is closed' USING ERRCODE = '22023'; END IF;
  IF t IS NOT NULL AND length(t) > 4000 THEN RAISE EXCEPTION 'that text is too long' USING ERRCODE = '22023'; END IF;
  before := jsonb_build_object('status', i.status, 'severity', i.severity, 'personal_data', i.personal_data,
    'breach_reported_at', i.breach_reported_at, 'owner', iam._email(i.owner_id));

  IF p_action = 'update' THEN
    IF t IS NULL THEN RAISE EXCEPTION 'write the update' USING ERRCODE = '22023'; END IF;
    INSERT INTO incident.event (incident_id, actor_id, kind, text) VALUES (i.id, a, 'update', t);
  ELSIF p_action = 'severity' THEN
    IF p_number IS NULL OR p_number NOT BETWEEN 1 AND 3 THEN RAISE EXCEPTION 'severity is 1, 2 or 3' USING ERRCODE = '22023'; END IF;
    IF t IS NULL OR length(t) < 10 THEN RAISE EXCEPTION 'say why the severity changed' USING ERRCODE = '22023'; END IF;
    UPDATE incident.item SET severity = p_number WHERE id = i.id;
    INSERT INTO incident.event (incident_id, actor_id, kind, text) VALUES (i.id, a, 'severity', 'Severity ' || i.severity || ' → ' || p_number || ': ' || t);
  ELSIF p_action = 'take' THEN
    UPDATE incident.item SET owner_id = a WHERE id = i.id;
    INSERT INTO incident.event (incident_id, actor_id, kind, text) VALUES (i.id, a, 'assigned', 'Took over this incident.');
  ELSIF p_action = 'mitigated' THEN
    IF i.status <> 'investigating' THEN RAISE EXCEPTION 'this incident is already %', i.status USING ERRCODE = '22023'; END IF;
    IF t IS NULL OR length(t) < 10 THEN RAISE EXCEPTION 'say what stopped the harm' USING ERRCODE = '22023'; END IF;
    UPDATE incident.item SET status = 'mitigated', mitigated_at = now_ WHERE id = i.id;
    INSERT INTO incident.event (incident_id, actor_id, kind, text) VALUES (i.id, a, 'mitigated', t);
  ELSIF p_action = 'resolved' THEN
    IF i.status NOT IN ('investigating', 'mitigated') THEN RAISE EXCEPTION 'this incident is already %', i.status USING ERRCODE = '22023'; END IF;
    IF t IS NULL OR length(t) < 10 THEN RAISE EXCEPTION 'say what fixed it' USING ERRCODE = '22023'; END IF;
    UPDATE incident.item SET status = 'resolved', resolved_at = now_, mitigated_at = coalesce(mitigated_at, now_) WHERE id = i.id;
    INSERT INTO incident.event (incident_id, actor_id, kind, text) VALUES (i.id, a, 'resolved', t);
  ELSIF p_action = 'personal_data' THEN
    IF i.personal_data THEN RAISE EXCEPTION 'already marked as involving personal data' USING ERRCODE = '22023'; END IF;
    IF t IS NULL OR length(t) < 10 THEN RAISE EXCEPTION 'say what personal data is involved' USING ERRCODE = '22023'; END IF;
    UPDATE incident.item SET personal_data = true WHERE id = i.id;
    INSERT INTO incident.event (incident_id, actor_id, kind, text) VALUES (i.id, a, 'breach',
      'Personal data involved: ' || t || ' The Commissioner must be told by ' || to_char((i.detected_at + interval '72 hours') AT TIME ZONE 'Indian/Mauritius', 'DD Mon HH24:MI') || ' (Mauritius time), unless it is unlikely to put anyone at risk.');
  ELSIF p_action = 'breach_reported' THEN
    IF NOT i.personal_data THEN RAISE EXCEPTION 'mark the incident as involving personal data first' USING ERRCODE = '22023'; END IF;
    IF p_at IS NULL OR p_at > now_ + interval '5 minutes' OR p_at < i.detected_at - interval '1 day' THEN
      RAISE EXCEPTION 'give when the Commissioner was told' USING ERRCODE = '22023';
    END IF;
    IF t IS NULL OR length(t) < 5 THEN RAISE EXCEPTION 'give the reference or how it was sent' USING ERRCODE = '22023'; END IF;
    UPDATE incident.item SET breach_reported_at = p_at, breach_not_reported = NULL WHERE id = i.id;
    INSERT INTO incident.event (incident_id, actor_id, kind, text) VALUES (i.id, a, 'breach',
      'Reported to the Data Protection Commissioner: ' || t ||
      CASE WHEN p_at > i.detected_at + interval '72 hours' THEN ' (after the 72 hours: the reasons for the delay must go with it)' ELSE '' END);
  ELSIF p_action = 'breach_not_reported' THEN
    IF NOT i.personal_data THEN RAISE EXCEPTION 'this incident does not involve personal data' USING ERRCODE = '22023'; END IF;
    IF NOT iam.has_permission(a, 'incident.close') THEN
      RAISE EXCEPTION 'permission denied: incident.close (only compliance can decide a breach need not be reported)' USING ERRCODE = '42501';
    END IF;
    IF t IS NULL OR length(t) < 10 THEN RAISE EXCEPTION 'say why it is unlikely to put anyone at risk' USING ERRCODE = '22023'; END IF;
    UPDATE incident.item SET breach_not_reported = t, breach_reported_at = NULL WHERE id = i.id;
    INSERT INTO incident.event (incident_id, actor_id, kind, text) VALUES (i.id, a, 'breach', 'Decided not to report to the Commissioner: ' || t);
  ELSIF p_action = 'people_told' THEN
    IF NOT i.personal_data THEN RAISE EXCEPTION 'this incident does not involve personal data' USING ERRCODE = '22023'; END IF;
    IF p_at IS NULL OR p_at > now_ + interval '5 minutes' THEN RAISE EXCEPTION 'give when the people affected were told' USING ERRCODE = '22023'; END IF;
    IF t IS NULL OR length(t) < 5 THEN RAISE EXCEPTION 'say how they were told' USING ERRCODE = '22023'; END IF;
    UPDATE incident.item SET people_told_at = p_at WHERE id = i.id;
    INSERT INTO incident.event (incident_id, actor_id, kind, text) VALUES (i.id, a, 'breach', 'People affected told: ' || t);
  ELSIF p_action = 'root_cause' THEN
    IF t IS NULL OR length(t) < 10 THEN RAISE EXCEPTION 'describe the root cause in at least 10 characters' USING ERRCODE = '22023'; END IF;
    UPDATE incident.item SET root_cause = t WHERE id = i.id;
    INSERT INTO incident.event (incident_id, actor_id, kind, text) VALUES (i.id, a, 'update', 'Root cause: ' || t);
  ELSIF p_action = 'follow_up' THEN
    IF t IS NULL OR length(t) NOT BETWEEN 5 AND 500 THEN RAISE EXCEPTION 'describe the follow-up in 5 to 500 characters' USING ERRCODE = '22023'; END IF;
    IF length(coalesce(p_owner, '')) > 120 THEN RAISE EXCEPTION 'the owner is too long' USING ERRCODE = '22023'; END IF;
    INSERT INTO incident.follow_up (incident_id, text, owner, due_on, created_by) VALUES (i.id, t, btrim(coalesce(p_owner, '')), p_date, a);
    INSERT INTO incident.event (incident_id, actor_id, kind, text) VALUES (i.id, a, 'follow_up', 'Follow-up added: ' || t);
  ELSIF p_action = 'follow_up_done' THEN
    UPDATE incident.follow_up SET done_at = now_, done_by = a WHERE id = p_follow_up AND incident_id = i.id AND done_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'unknown or already done follow-up' USING ERRCODE = '22023'; END IF;
    INSERT INTO incident.event (incident_id, actor_id, kind, text)
    SELECT i.id, a, 'follow_up', 'Follow-up done: ' || f.text FROM incident.follow_up f WHERE f.id = p_follow_up;
  ELSIF p_action = 'close' THEN
    IF NOT iam.has_permission(a, 'incident.close') THEN
      RAISE EXCEPTION 'permission denied: incident.close (only compliance can close an incident)' USING ERRCODE = '42501';
    END IF;
    IF i.status <> 'resolved' THEN RAISE EXCEPTION 'resolve it first' USING ERRCODE = '22023'; END IF;
    IF i.root_cause IS NULL THEN RAISE EXCEPTION 'record the root cause first' USING ERRCODE = '22023'; END IF;
    SELECT count(*) INTO open_fu FROM incident.follow_up WHERE incident_id = i.id AND done_at IS NULL;
    IF open_fu > 0 THEN RAISE EXCEPTION '% follow-up(s) still open: finish them first', open_fu USING ERRCODE = '22023'; END IF;
    IF i.personal_data AND i.breach_reported_at IS NULL AND i.breach_not_reported IS NULL THEN
      RAISE EXCEPTION 'personal data was involved: record the report to the Commissioner, or why it was not needed, first' USING ERRCODE = '22023';
    END IF;
    IF t IS NULL OR length(t) < 10 THEN RAISE EXCEPTION 'write a closing summary of at least 10 characters' USING ERRCODE = '22023'; END IF;
    UPDATE incident.item SET status = 'closed', closed_at = now_, closed_by = a WHERE id = i.id;
    INSERT INTO incident.event (incident_id, actor_id, kind, text) VALUES (i.id, a, 'closed', t);
  ELSE
    RAISE EXCEPTION 'unknown action' USING ERRCODE = '22023';
  END IF;

  UPDATE incident.item SET version = version + 1, updated_at = now_ WHERE id = i.id RETURNING * INTO i;
  PERFORM audit.record('incident.' || p_action, 'incident', i.ref, t, before,
    jsonb_build_object('status', i.status, 'severity', i.severity, 'personal_data', i.personal_data,
      'breach_reported_at', i.breach_reported_at, 'owner', iam._email(i.owner_id)));
  RETURN incident._view(i);
END $$;

-- For the Audit health banner and the hourly dispatcher's log. Refs, severities and deadlines only, so no staff
-- permission is needed; only the backend roles may execute it.
CREATE FUNCTION api.incident_alerts() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object(
    'open_major', coalesce(jsonb_agg(jsonb_build_object('ref', i.ref, 'severity', i.severity, 'title', i.title) ORDER BY i.severity, i.detected_at)
                    FILTER (WHERE i.severity <= 2), '[]'::jsonb),
    'breach_due', coalesce(jsonb_agg(jsonb_build_object('ref', i.ref, 'due_at', incident._breach_due(i)) ORDER BY incident._breach_due(i))
                    FILTER (WHERE incident._breach_due(i) IS NOT NULL), '[]'::jsonb),
    'open', count(*))
  FROM incident.item i WHERE i.closed_at IS NULL
$$;

REVOKE ALL ON SCHEMA incident FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA incident FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION api.incident_view(), api.incident_open(text, int, text, text, text, timestamptz, timestamptz, boolean),
  api.incident_act(uuid, bigint, text, text, timestamptz, int, text, date, uuid), api.incident_alerts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.incident_view(), api.incident_open(text, int, text, text, text, timestamptz, timestamptz, boolean),
  api.incident_act(uuid, bigint, text, text, timestamptz, int, text, date, uuid), api.incident_alerts() TO app_admin_api;
GRANT EXECUTE ON FUNCTION api.incident_alerts() TO app_admin_dispatcher;
GRANT USAGE ON SCHEMA incident TO app_admin_readonly;
GRANT SELECT ON incident.item, incident.event, incident.follow_up TO app_admin_readonly;
