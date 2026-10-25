-- 0001_platform.sql — shared admin platform baseline for database app_admin.
-- Generated from platform/0001_platform.sql.tmpl. Do not edit the copy.
-- Portable PostgreSQL 13+, no extensions. Runs inside one transaction.
--
-- Provides: util (ids, triggers, context), meta (migration ledger),
-- iam (admin users, RBAC, sessions), audit (append-only hash-chained log),
-- outbox (transactional events to other systems), api (the ONLY surface the
-- backend can call).
SET LOCAL ROLE app_admin_owner;
SET LOCAL search_path = pg_catalog;

-- ---------------------------------------------------------------- lockdown
REVOKE ALL ON DATABASE app_admin FROM PUBLIC;
GRANT CONNECT ON DATABASE app_admin TO app_admin_api, app_admin_dispatcher, app_admin_readonly;
GRANT CONNECT ON DATABASE app_admin TO SESSION_USER;  -- the migration operator
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE app_admin_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE SCHEMA meta;
CREATE SCHEMA util;
CREATE SCHEMA iam;
CREATE SCHEMA audit;
CREATE SCHEMA outbox;
CREATE SCHEMA api;

-- ------------------------------------------------------------------- meta
CREATE TABLE meta.schema_migration (
  version     text PRIMARY KEY,
  checksum    text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  applied_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  applied_by  text NOT NULL DEFAULT session_user
);

-- ------------------------------------------------------------------- util
-- Time-ordered UUIDv7 (index-friendly). Pure SQL so it runs on any PG13+.
CREATE FUNCTION util.uuid_v7() RETURNS uuid
LANGUAGE sql VOLATILE PARALLEL SAFE SET search_path = pg_catalog AS $$
  SELECT encode(
    set_bit(set_bit(
      overlay(uuid_send(gen_random_uuid())
              PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
              FROM 1 FOR 6),
    52, 1), 53, 1), 'hex')::uuid
$$;

CREATE FUNCTION util.touch() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN NEW.updated_at := clock_timestamp(); RETURN NEW; END $$;

CREATE FUNCTION util.append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION '%.% is append-only', TG_TABLE_SCHEMA, TG_TABLE_NAME USING ERRCODE = '42501';
END $$;

CREATE FUNCTION util.ctx(p_key text) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT nullif(current_setting('ficium.' || p_key, true), '')
$$;

CREATE FUNCTION util.require_reason(p_reason text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
BEGIN
  IF length(coalesce(btrim(p_reason), '')) NOT BETWEEN 10 AND 2000 THEN
    RAISE EXCEPTION 'a reason of 10 to 2000 characters is required' USING ERRCODE = '22023';
  END IF;
  RETURN btrim(p_reason);
END $$;

-- -------------------------------------------------------------------- iam
CREATE TABLE iam.permission (
  code        text PRIMARY KEY CHECK (code ~ '^[a-z_]+(\.[a-z_]+)+$'),
  description text NOT NULL
);

CREATE TABLE iam.role (
  code        text PRIMARY KEY CHECK (code ~ '^[a-z_]+$'),
  description text NOT NULL
);

CREATE TABLE iam.role_permission (
  role_code       text NOT NULL REFERENCES iam.role(code) ON DELETE CASCADE,
  permission_code text NOT NULL REFERENCES iam.permission(code) ON DELETE CASCADE,
  PRIMARY KEY (role_code, permission_code)
);

-- Identity is owned by ficium-auth. auth_subject = the ficium-auth `sub`.
-- An admin is invited by email; the subject is bound on first sign-in.
CREATE TABLE iam.admin_user (
  id            uuid PRIMARY KEY DEFAULT util.uuid_v7(),
  auth_subject  text UNIQUE CHECK (auth_subject IS NULL OR length(auth_subject) BETWEEN 1 AND 255),
  email         text NOT NULL CHECK (length(email) <= 320 AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  display_name  text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
  status        text NOT NULL DEFAULT 'invited'
                CHECK (status IN ('invited','active','suspended','disabled')),
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by    uuid REFERENCES iam.admin_user(id),
  updated_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  version       bigint NOT NULL DEFAULT 1,
  CHECK (status = 'invited' OR auth_subject IS NOT NULL)
);
CREATE UNIQUE INDEX admin_user_email_uq ON iam.admin_user (lower(email));
CREATE TRIGGER admin_user_touch BEFORE UPDATE ON iam.admin_user
  FOR EACH ROW EXECUTE FUNCTION util.touch();

CREATE TABLE iam.user_role (
  user_id     uuid NOT NULL REFERENCES iam.admin_user(id) ON DELETE CASCADE,
  role_code   text NOT NULL REFERENCES iam.role(code),
  granted_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  granted_by  uuid REFERENCES iam.admin_user(id),
  PRIMARY KEY (user_id, role_code)
);
CREATE INDEX user_role_role_idx ON iam.user_role (role_code);

-- One row per backend request. Binds the acting admin to THIS transaction,
-- so a context value cannot be replayed across transactions or connections.
CREATE TABLE iam.session_log (
  id          uuid PRIMARY KEY DEFAULT util.uuid_v7(),
  admin_id    uuid NOT NULL REFERENCES iam.admin_user(id),
  xact_id     bigint NOT NULL,
  request_id  text CHECK (length(request_id) <= 128),
  source_ip   inet,
  user_agent  text CHECK (length(user_agent) <= 512),
  started_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX session_log_admin_idx ON iam.session_log (admin_id, started_at DESC);
CREATE INDEX session_log_started_brin ON iam.session_log USING brin (started_at);
CREATE TRIGGER session_log_worm BEFORE UPDATE OR DELETE ON iam.session_log
  FOR EACH ROW EXECUTE FUNCTION util.append_only();
CREATE TRIGGER session_log_worm_trunc BEFORE TRUNCATE ON iam.session_log
  FOR EACH STATEMENT EXECUTE FUNCTION util.append_only();

CREATE FUNCTION iam.current_session() RETURNS iam.session_log
LANGUAGE sql VOLATILE SET search_path = pg_catalog AS $$
  SELECT s.* FROM iam.session_log s
  WHERE s.id = util.ctx('session_id')::uuid AND s.xact_id = txid_current()
$$;

CREATE FUNCTION iam.current_admin() RETURNS uuid
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $$
DECLARE v uuid;
BEGIN
  v := (iam.current_session()).admin_id;
  IF v IS NULL THEN
    RAISE EXCEPTION 'no admin session in this transaction (call api.begin_session first)' USING ERRCODE = '28000';
  END IF;
  RETURN v;
END $$;

CREATE FUNCTION iam.has_permission(p_user uuid, p_perm text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1 FROM iam.admin_user u
    JOIN iam.user_role ur       ON ur.user_id = u.id
    JOIN iam.role_permission rp ON rp.role_code = ur.role_code
    WHERE u.id = p_user AND u.status = 'active' AND rp.permission_code = p_perm)
$$;

CREATE FUNCTION iam.require(p_perm text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $$
DECLARE v uuid := iam.current_admin();
BEGIN
  IF NOT iam.has_permission(v, p_perm) THEN
    RAISE EXCEPTION 'permission denied: %', p_perm USING ERRCODE = '42501';
  END IF;
  RETURN v;
END $$;

INSERT INTO iam.role (code, description) VALUES
  ('super_admin', 'Full platform administration'),
  ('compliance',  'Approvals, publication, KYC policy, audit review'),
  ('operations',  'Day-to-day content and configuration preparation'),
  ('read_only',   'View only');

INSERT INTO iam.permission (code, description) VALUES
  ('iam.manage', 'Invite admins, change their roles and status'),
  ('iam.read',   'View admins and their roles'),
  ('audit.read', 'Read the audit log');

INSERT INTO iam.role_permission (role_code, permission_code) VALUES
  ('super_admin','iam.manage'), ('super_admin','iam.read'), ('super_admin','audit.read'),
  ('compliance','iam.read'),    ('compliance','audit.read'),
  ('read_only','iam.read');

-- ------------------------------------------------------------------ audit
CREATE TABLE audit.event (
  id            uuid PRIMARY KEY DEFAULT util.uuid_v7(),
  chain_pos     bigint NOT NULL UNIQUE,
  occurred_at   timestamptz NOT NULL,
  actor_type    text NOT NULL CHECK (actor_type IN ('admin','system')),
  actor_id      uuid REFERENCES iam.admin_user(id),
  session_id    uuid REFERENCES iam.session_log(id),
  request_id    text,
  source_ip     inet,
  action        text NOT NULL CHECK (action ~ '^[a-z_]+(\.[a-z_]+)+$'),
  resource_type text NOT NULL CHECK (resource_type ~ '^[a-z_]+$'),
  resource_id   text,
  reason        text CHECK (length(reason) <= 2000),
  before        jsonb,
  after         jsonb,
  prev_hash     bytea,
  hash          bytea NOT NULL,
  CHECK (actor_type <> 'admin' OR actor_id IS NOT NULL)
);
CREATE INDEX audit_event_occurred_brin ON audit.event USING brin (occurred_at);
CREATE INDEX audit_event_resource_idx  ON audit.event (resource_type, resource_id, chain_pos DESC);
CREATE INDEX audit_event_actor_idx     ON audit.event (actor_id, chain_pos DESC) WHERE actor_id IS NOT NULL;

-- Canonical form that is hashed. UTC pinned so the hash is reproducible.
CREATE FUNCTION audit._canonical(e audit.event) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog SET TimeZone = 'UTC' AS $$
  SELECT coalesce(encode(e.prev_hash, 'hex'), 'GENESIS') || '|' ||
         (to_jsonb(e) - 'hash' - 'prev_hash')::text
$$;

CREATE FUNCTION audit._chain() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog SET TimeZone = 'UTC' AS $$
DECLARE prev record;
BEGIN
  PERFORM pg_advisory_xact_lock(7461001);  -- serialise the chain head
  SELECT chain_pos, hash INTO prev FROM audit.event ORDER BY chain_pos DESC LIMIT 1;
  NEW.chain_pos   := coalesce(prev.chain_pos, 0) + 1;
  NEW.prev_hash   := prev.hash;
  NEW.occurred_at := clock_timestamp();
  NEW.hash        := sha256(convert_to(audit._canonical(NEW), 'UTF8'));
  RETURN NEW;
END $$;

CREATE TRIGGER audit_event_chain BEFORE INSERT ON audit.event
  FOR EACH ROW EXECUTE FUNCTION audit._chain();
CREATE TRIGGER audit_event_worm BEFORE UPDATE OR DELETE ON audit.event
  FOR EACH ROW EXECUTE FUNCTION util.append_only();
CREATE TRIGGER audit_event_worm_trunc BEFORE TRUNCATE ON audit.event
  FOR EACH STATEMENT EXECUTE FUNCTION util.append_only();

CREATE FUNCTION audit.record(
  p_action text, p_resource_type text, p_resource_id text,
  p_reason text, p_before jsonb, p_after jsonb) RETURNS uuid
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $$
DECLARE s iam.session_log := iam.current_session(); v uuid;
BEGIN
  INSERT INTO audit.event (actor_type, actor_id, session_id, request_id, source_ip,
                           action, resource_type, resource_id, reason, before, after)
  VALUES (CASE WHEN s.id IS NULL THEN 'system' ELSE 'admin' END,
          s.admin_id, s.id, s.request_id, s.source_ip,
          p_action, p_resource_type, p_resource_id, p_reason, p_before, p_after)
  RETURNING id INTO v;
  RETURN v;
END $$;

-- Recomputes every hash from p_from. Any edit, insertion or gap shows up.
-- (Tail truncation needs an external anchor: see README.)
CREATE FUNCTION audit.verify_chain(p_from bigint DEFAULT 1)
RETURNS TABLE (ok boolean, checked bigint, first_bad_pos bigint, head_hash text)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog SET TimeZone = 'UTC' AS $$
DECLARE e audit.event; prev bytea; n bigint := 0; expect bigint := p_from;
BEGIN
  IF p_from > 1 THEN SELECT a.hash INTO prev FROM audit.event a WHERE a.chain_pos = p_from - 1; END IF;
  FOR e IN SELECT * FROM audit.event a WHERE a.chain_pos >= p_from ORDER BY a.chain_pos LOOP
    IF e.chain_pos <> expect OR e.prev_hash IS DISTINCT FROM prev
       OR e.hash <> sha256(convert_to(audit._canonical(e), 'UTF8')) THEN
      RETURN QUERY SELECT false, n, e.chain_pos, encode(prev, 'hex'); RETURN;
    END IF;
    prev := e.hash; n := n + 1; expect := expect + 1;
  END LOOP;
  RETURN QUERY SELECT true, n, NULL::bigint, encode(prev, 'hex');
END $$;

-- ----------------------------------------------------------------- outbox
-- Written in the SAME transaction as the state change, so a change and its
-- event commit or roll back together. Payloads are full-state snapshots with
-- a monotonic aggregate_version: consumers apply only if newer (idempotent,
-- order-independent).
CREATE TABLE outbox.event (
  id                uuid PRIMARY KEY DEFAULT util.uuid_v7(),
  topic             text NOT NULL CHECK (topic ~ '^[a-z_]+(\.[a-z_]+)+$'),
  aggregate_type    text NOT NULL,
  aggregate_id      text NOT NULL,
  aggregate_version bigint NOT NULL,
  payload           jsonb NOT NULL,
  audit_event_id    uuid REFERENCES audit.event(id),
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  available_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempts          integer NOT NULL DEFAULT 0,
  lease_until       timestamptz,
  last_error        text,
  dispatched_at     timestamptz,
  failed_at         timestamptz,
  UNIQUE (aggregate_type, aggregate_id, aggregate_version, topic)
);
CREATE INDEX outbox_pending_idx ON outbox.event (available_at, id)
  WHERE dispatched_at IS NULL AND failed_at IS NULL;

CREATE FUNCTION outbox.enqueue(p_topic text, p_aggregate_type text, p_aggregate_id text,
  p_aggregate_version bigint, p_payload jsonb, p_audit_event_id uuid) RETURNS uuid
LANGUAGE sql VOLATILE SET search_path = pg_catalog AS $$
  INSERT INTO outbox.event (topic, aggregate_type, aggregate_id, aggregate_version, payload, audit_event_id)
  VALUES (p_topic, p_aggregate_type, p_aggregate_id, p_aggregate_version, p_payload, p_audit_event_id)
  RETURNING id
$$;

-- -------------------------------------------------------------------- api
-- Call first in every backend transaction, with claims from a ficium-auth
-- token the backend has ALREADY verified. Returns who the admin is and what
-- they may do. Context is bound to this transaction only.
CREATE FUNCTION api.begin_session(p_auth_subject text, p_email text, p_request_id text,
  p_source_ip inet, p_user_agent text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE u iam.admin_user; sid uuid; activated boolean := false;
BEGIN
  IF coalesce(btrim(p_auth_subject), '') = '' THEN
    RAISE EXCEPTION 'auth subject is required' USING ERRCODE = '28000';
  END IF;
  SELECT * INTO u FROM iam.admin_user WHERE auth_subject = p_auth_subject;
  IF NOT FOUND THEN
    UPDATE iam.admin_user
       SET auth_subject = p_auth_subject, status = 'active', version = version + 1
     WHERE status = 'invited' AND auth_subject IS NULL
       AND lower(email) = lower(btrim(coalesce(p_email, '')))
    RETURNING * INTO u;
    IF NOT FOUND THEN RAISE EXCEPTION 'not an admin' USING ERRCODE = '28000'; END IF;
    activated := true;
  END IF;
  IF u.status <> 'active' THEN
    RAISE EXCEPTION 'admin account is %', u.status USING ERRCODE = '28000';
  END IF;

  INSERT INTO iam.session_log (admin_id, xact_id, request_id, source_ip, user_agent)
  VALUES (u.id, txid_current(), left(p_request_id, 128), p_source_ip, left(p_user_agent, 512))
  RETURNING id INTO sid;
  PERFORM set_config('ficium.session_id', sid::text, true);

  IF activated THEN
    PERFORM audit.record('iam.admin_activated', 'admin_user', u.id::text, NULL, NULL,
                         jsonb_build_object('email', u.email, 'auth_subject', u.auth_subject));
  END IF;

  RETURN jsonb_build_object(
    'admin_id', u.id, 'email', u.email, 'display_name', u.display_name,
    'roles', coalesce((SELECT jsonb_agg(role_code ORDER BY role_code) FROM iam.user_role WHERE user_id = u.id), '[]'),
    'permissions', coalesce((SELECT jsonb_agg(DISTINCT rp.permission_code)
                             FROM iam.user_role ur JOIN iam.role_permission rp ON rp.role_code = ur.role_code
                             WHERE ur.user_id = u.id), '[]'));
END $$;

CREATE FUNCTION api.iam_list() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM iam.require('iam.read');
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id', u.id, 'email', u.email, 'display_name', u.display_name, 'status', u.status,
      'version', u.version, 'created_at', u.created_at,
      'roles', coalesce((SELECT jsonb_agg(role_code ORDER BY role_code) FROM iam.user_role r WHERE r.user_id = u.id), '[]'))
    ORDER BY u.created_at) FROM iam.admin_user u), '[]');
END $$;

CREATE FUNCTION api.iam_invite(p_email text, p_display_name text, p_roles text[], p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('iam.manage'); u iam.admin_user; r text := util.require_reason(p_reason);
BEGIN
  IF coalesce(cardinality(p_roles), 0) = 0 THEN RAISE EXCEPTION 'at least one role is required' USING ERRCODE = '22023'; END IF;
  INSERT INTO iam.admin_user (email, display_name, created_by)
  VALUES (lower(btrim(p_email)), btrim(p_display_name), a) RETURNING * INTO u;
  INSERT INTO iam.user_role (user_id, role_code, granted_by) SELECT u.id, x, a FROM unnest(p_roles) x;
  PERFORM audit.record('iam.admin_invited', 'admin_user', u.id::text, r, NULL,
                       to_jsonb(u) || jsonb_build_object('roles', to_jsonb(p_roles)));
  RETURN to_jsonb(u);
END $$;

CREATE FUNCTION api.iam_set_roles(p_user uuid, p_roles text[], p_expected_version bigint, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('iam.manage'); u iam.admin_user; before_roles jsonb; r text := util.require_reason(p_reason);
BEGIN
  IF p_user = a THEN RAISE EXCEPTION 'you cannot change your own roles' USING ERRCODE = '42501'; END IF;
  IF coalesce(cardinality(p_roles), 0) = 0 THEN RAISE EXCEPTION 'at least one role is required' USING ERRCODE = '22023'; END IF;
  UPDATE iam.admin_user SET version = version + 1 WHERE id = p_user AND version = p_expected_version RETURNING * INTO u;
  IF NOT FOUND THEN RAISE EXCEPTION 'admin changed since you opened it, or does not exist' USING ERRCODE = '40001'; END IF;
  SELECT coalesce(jsonb_agg(role_code ORDER BY role_code), '[]') INTO before_roles FROM iam.user_role WHERE user_id = p_user;
  DELETE FROM iam.user_role WHERE user_id = p_user AND role_code <> ALL (p_roles);
  INSERT INTO iam.user_role (user_id, role_code, granted_by) SELECT p_user, x, a FROM unnest(p_roles) x
  ON CONFLICT DO NOTHING;
  PERFORM audit.record('iam.roles_changed', 'admin_user', p_user::text, r,
                       jsonb_build_object('roles', before_roles), jsonb_build_object('roles', to_jsonb(p_roles)));
  RETURN to_jsonb(u);
END $$;

CREATE FUNCTION api.iam_set_status(p_user uuid, p_status text, p_expected_version bigint, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('iam.manage'); old iam.admin_user; u iam.admin_user; r text := util.require_reason(p_reason);
BEGIN
  IF p_user = a THEN RAISE EXCEPTION 'you cannot change your own status' USING ERRCODE = '42501'; END IF;
  IF p_status NOT IN ('active','suspended','disabled') THEN RAISE EXCEPTION 'invalid status' USING ERRCODE = '22023'; END IF;
  SELECT * INTO old FROM iam.admin_user WHERE id = p_user FOR UPDATE;
  IF old.status = 'invited' AND p_status = 'active' THEN
    RAISE EXCEPTION 'an invited admin activates on first sign-in' USING ERRCODE = '22023';
  END IF;
  UPDATE iam.admin_user SET status = p_status, version = version + 1
   WHERE id = p_user AND version = p_expected_version RETURNING * INTO u;
  IF NOT FOUND THEN RAISE EXCEPTION 'admin changed since you opened it, or does not exist' USING ERRCODE = '40001'; END IF;
  PERFORM audit.record('iam.status_changed', 'admin_user', p_user::text, r,
                       jsonb_build_object('status', old.status), jsonb_build_object('status', u.status));
  RETURN to_jsonb(u);
END $$;

CREATE FUNCTION api.audit_search(p_resource_type text DEFAULT NULL, p_resource_id text DEFAULT NULL,
  p_actor uuid DEFAULT NULL, p_before_pos bigint DEFAULT NULL, p_limit integer DEFAULT 50)
RETURNS SETOF audit.event
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM iam.require('audit.read');
  RETURN QUERY
    SELECT * FROM audit.event e
    WHERE (p_resource_type IS NULL OR e.resource_type = p_resource_type)
      AND (p_resource_id   IS NULL OR e.resource_id   = p_resource_id)
      AND (p_actor         IS NULL OR e.actor_id      = p_actor)
      AND (p_before_pos    IS NULL OR e.chain_pos     < p_before_pos)
    ORDER BY e.chain_pos DESC
    LIMIT least(greatest(coalesce(p_limit, 50), 1), 500);
END $$;

-- Outbox worker surface.
CREATE FUNCTION api.outbox_claim(p_limit integer DEFAULT 50, p_lease_seconds integer DEFAULT 60)
RETURNS SETOF outbox.event
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  UPDATE outbox.event e
     SET lease_until = clock_timestamp() + make_interval(secs => least(greatest(p_lease_seconds, 5), 600)),
         attempts = e.attempts + 1
   WHERE e.id IN (SELECT o.id FROM outbox.event o
                  WHERE o.dispatched_at IS NULL AND o.failed_at IS NULL
                    AND o.available_at <= clock_timestamp()
                    AND (o.lease_until IS NULL OR o.lease_until < clock_timestamp())
                  ORDER BY o.available_at, o.id
                  LIMIT least(greatest(p_limit, 1), 500)
                  FOR UPDATE SKIP LOCKED)
  RETURNING e.*
$$;

CREATE FUNCTION api.outbox_ack(p_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  UPDATE outbox.event SET dispatched_at = clock_timestamp(), lease_until = NULL, last_error = NULL
   WHERE id = p_id AND dispatched_at IS NULL
$$;

-- Exponential backoff, capped at 1h; dead-letters after 12 attempts.
CREATE FUNCTION api.outbox_nack(p_id uuid, p_error text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  UPDATE outbox.event
     SET lease_until = NULL, last_error = left(p_error, 2000),
         available_at = clock_timestamp() + make_interval(secs => least(power(2, attempts)::int, 3600)),
         failed_at = CASE WHEN attempts >= 12 THEN clock_timestamp() END
   WHERE id = p_id AND dispatched_at IS NULL
$$;

-- Operator-only bootstrap of the first super admin. Refuses once one exists.
CREATE FUNCTION iam.bootstrap_super_admin(p_email text, p_display_name text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM iam.user_role WHERE role_code = 'super_admin') THEN
    RAISE EXCEPTION 'a super admin already exists; use api.iam_invite' USING ERRCODE = '42501';
  END IF;
  INSERT INTO iam.admin_user (email, display_name) VALUES (lower(btrim(p_email)), btrim(p_display_name)) RETURNING id INTO v;
  INSERT INTO iam.user_role (user_id, role_code) VALUES (v, 'super_admin');
  PERFORM audit.record('iam.bootstrap', 'admin_user', v::text, 'initial super admin created by operator', NULL,
                       jsonb_build_object('email', lower(btrim(p_email))));
  RETURN v;
END $$;

-- ----------------------------------------------------------------- grants
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA util, iam, audit, outbox, api FROM PUBLIC;
GRANT USAGE ON SCHEMA api TO app_admin_api, app_admin_dispatcher;
GRANT EXECUTE ON FUNCTION
  api.begin_session(text, text, text, inet, text),
  api.iam_list(), api.iam_invite(text, text, text[], text),
  api.iam_set_roles(uuid, text[], bigint, text), api.iam_set_status(uuid, text, bigint, text),
  api.audit_search(text, text, uuid, bigint, integer)
  TO app_admin_api;
GRANT EXECUTE ON FUNCTION
  api.outbox_claim(integer, integer), api.outbox_ack(uuid), api.outbox_nack(uuid, text)
  TO app_admin_dispatcher;

GRANT USAGE ON SCHEMA meta, iam, audit, outbox TO app_admin_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA meta, iam, audit, outbox TO app_admin_readonly;
GRANT EXECUTE ON FUNCTION audit.verify_chain(bigint), audit._canonical(audit.event) TO app_admin_readonly;
