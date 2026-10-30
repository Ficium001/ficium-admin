-- 0005_ops_health.sql — audit chain verification for the portal admin site
-- (KJ, 2026-10-30). Same checker as app_admin 0006: incremental with a daily
-- full re-hash. This site has no hourly worker, so the check runs when staff
-- open the health view (at most once every 10 minutes); the result is shown
-- as an alert banner in the site.
SET LOCAL ROLE portal_admin_owner;
SET LOCAL search_path = pg_catalog;

CREATE SCHEMA ops;

-- Every chain verification, append-only. The head hash it records is also
-- written to the deployment's logs by the dispatcher: a copy outside this
-- database that a rewritten or truncated chain cannot match.
CREATE TABLE ops.chain_check (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  checked_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  mode          text NOT NULL CHECK (mode IN ('full','incremental')),
  from_pos      bigint NOT NULL,
  ok            boolean NOT NULL,
  checked       bigint NOT NULL,
  first_bad_pos bigint,
  head_pos      bigint,
  head_hash     text
);
CREATE INDEX chain_check_recent ON ops.chain_check (checked_at DESC);
CREATE TRIGGER chain_check_worm BEFORE UPDATE OR DELETE ON ops.chain_check
  FOR EACH ROW EXECUTE FUNCTION util.append_only();
CREATE TRIGGER chain_check_worm_trunc BEFORE TRUNCATE ON ops.chain_check
  FOR EACH STATEMENT EXECUTE FUNCTION util.append_only();

-- Full re-hash once a day (and whenever the last check failed); otherwise
-- only the rows added since the last good check, after confirming the row
-- that check ended on is still there with the same hash. Cost stays flat as
-- the log grows.
CREATE FUNCTION ops._verify_chain() RETURNS ops.chain_check
LANGUAGE plpgsql SET search_path = pg_catalog SET TimeZone = 'UTC' AS $$
DECLARE last ops.chain_check; lastfull timestamptz; v record; cur_hash text; maxpos bigint;
        v_mode text := 'full'; v_from bigint := 1; out ops.chain_check;
BEGIN
  SELECT * INTO last FROM ops.chain_check ORDER BY id DESC LIMIT 1;
  SELECT max(cc.checked_at) INTO lastfull FROM ops.chain_check cc WHERE cc.mode = 'full' AND cc.ok;
  SELECT max(chain_pos) INTO maxpos FROM audit.event;
  IF last.id IS NOT NULL AND last.ok AND last.head_pos IS NOT NULL
     AND lastfull > clock_timestamp() - interval '24 hours' THEN
    SELECT encode(hash, 'hex') INTO cur_hash FROM audit.event WHERE chain_pos = last.head_pos;
    IF cur_hash IS DISTINCT FROM last.head_hash OR coalesce(maxpos, 0) < last.head_pos THEN
      INSERT INTO ops.chain_check (mode, from_pos, ok, checked, first_bad_pos, head_pos, head_hash)
      VALUES ('incremental', last.head_pos, false, 0, last.head_pos, maxpos, NULL) RETURNING * INTO out;
      RETURN out;
    END IF;
    v_mode := 'incremental'; v_from := last.head_pos;  -- re-hash the anchor row too
  END IF;
  SELECT * INTO v FROM audit.verify_chain(v_from);
  INSERT INTO ops.chain_check (mode, from_pos, ok, checked, first_bad_pos, head_pos, head_hash)
  VALUES (v_mode, v_from, v.ok, v.checked, v.first_bad_pos,
          CASE WHEN v.ok THEN nullif(v_from + v.checked - 1, 0) END, CASE WHEN v.ok THEN v.head_hash END)
  RETURNING * INTO out;
  RETURN out;
END $$;

-- Counts and hashes only: no bank data.
CREATE FUNCTION ops._snapshot() RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE c ops.chain_check; alerts text[] := '{}'; w bigint; cr bigint;
BEGIN
  SELECT * INTO c FROM ops.chain_check ORDER BY id DESC LIMIT 1;
  SELECT count(*) INTO w FROM compliance.waiver_request WHERE status = 'pending';
  SELECT count(*) INTO cr FROM governance.change_request WHERE status = 'pending';
  IF c.id IS NULL THEN alerts := array_append(alerts, 'The audit log has never been verified');
  ELSIF NOT c.ok THEN alerts := array_append(alerts, format('The audit log failed verification at position %s', c.first_bad_pos));
  END IF;
  RETURN jsonb_build_object(
    'healthy', cardinality(alerts) = 0, 'alerts', to_jsonb(alerts), 'at', clock_timestamp(),
    'outbox', NULL,
    'chain', CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object(
               'ok', c.ok, 'mode', c.mode, 'checked', c.checked, 'first_bad_pos', c.first_bad_pos,
               'head_pos', c.head_pos, 'head_hash', c.head_hash, 'checked_at', c.checked_at) END,
    'waivers_pending', w, 'bank_changes_pending', cr);
END $$;

-- Staff (audit.read). Verifies first if the last check is over 10 minutes old.
CREATE FUNCTION api.ops_health_view() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM iam.require('audit.read');
  PERFORM pg_advisory_xact_lock(7461003);
  IF NOT EXISTS (SELECT 1 FROM ops.chain_check WHERE checked_at > clock_timestamp() - interval '10 minutes') THEN
    PERFORM ops._verify_chain();
  END IF;
  RETURN ops._snapshot();
END $$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA ops, api FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.ops_health_view() TO portal_admin_api;
GRANT USAGE ON SCHEMA ops TO portal_admin_readonly;
GRANT SELECT ON ops.chain_check TO portal_admin_readonly;
