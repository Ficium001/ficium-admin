-- 0003_kyc_policy_serialise.sql
-- Fix: two KYC changes to DIFFERENT checks committing concurrently could each
-- emit a snapshot that misses the other's change, and the App DB would keep
-- whichever version number was higher — silently dropping one change.
-- Policy changes now take a transaction-level lock before reading the
-- snapshot and drawing the version, so versions follow commit order and every
-- snapshot includes all earlier changes.
SET LOCAL ROLE app_admin_owner;
SET LOCAL search_path = pg_catalog;

CREATE OR REPLACE FUNCTION api.kyc_set_check(p_key text, p_enabled boolean, p_expected_version bigint, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('kyc.change'); old kyc.check_setting; c kyc.check_setting;
        r text := util.require_reason(p_reason); ev uuid; pv bigint;
BEGIN
  IF p_enabled IS NULL THEN RAISE EXCEPTION 'value is required' USING ERRCODE = '22023'; END IF;
  PERFORM pg_advisory_xact_lock(7461002);  -- one KYC policy change at a time
  SELECT * INTO old FROM kyc.check_setting WHERE check_key = p_key FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown KYC check: %', p_key USING ERRCODE = 'P0002'; END IF;
  UPDATE kyc.check_setting SET enabled = p_enabled, version = version + 1, updated_by = a
   WHERE check_key = p_key AND version = p_expected_version RETURNING * INTO c;
  IF NOT FOUND THEN RAISE EXCEPTION 'check changed since you opened it' USING ERRCODE = '40001'; END IF;
  ev := audit.record('kyc.check_changed', 'kyc_check', p_key, r,
                     jsonb_build_object('enabled', old.enabled), jsonb_build_object('enabled', c.enabled));
  pv := nextval('kyc.policy_version_seq');
  PERFORM outbox.enqueue('kyc.policy_changed', 'kyc_policy', 'global', pv,
                         jsonb_build_object('checks', kyc.snapshot(), 'version', pv), ev);
  RETURN to_jsonb(c);
END $$;
