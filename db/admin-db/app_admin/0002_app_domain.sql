-- 0002_app_domain.sql — borrower-app administration domain.
-- Master state for platform settings, KYC check policy and marketplace
-- offers. Nothing here is read by the borrower app directly: every change
-- that the app must see is emitted to outbox.event and applied to the App DB
-- by the dispatcher (full-state snapshots, versioned, idempotent).
SET LOCAL ROLE app_admin_owner;
SET LOCAL search_path = pg_catalog;

CREATE SCHEMA ref;
CREATE SCHEMA config;
CREATE SCHEMA kyc;
CREATE SCHEMA offers;

-- --------------------------------------------------------- permissions
INSERT INTO iam.permission (code, description) VALUES
  ('config.read',    'View platform settings'),
  ('config.change',  'Change platform settings'),
  ('kyc.read',       'View KYC check policy'),
  ('kyc.change',     'Turn KYC checks on or off'),
  ('offer.read',     'View marketplace offers'),
  ('offer.edit',     'Create, edit and re-verify offers'),
  ('offer.approve',  'Approve offers (checker)'),
  ('offer.publish',  'Publish approved offers to the app'),
  ('offer.withdraw', 'Withdraw offers from the app');

INSERT INTO iam.role_permission (role_code, permission_code)
SELECT 'super_admin', code FROM iam.permission
 WHERE code IN ('config.read','config.change','kyc.read','kyc.change','offer.read','offer.edit',
                'offer.approve','offer.publish','offer.withdraw')
UNION ALL SELECT 'compliance', x FROM unnest(ARRAY['config.read','kyc.read','kyc.change','offer.read',
                'offer.approve','offer.publish','offer.withdraw']) x
UNION ALL SELECT 'operations', x FROM unnest(ARRAY['config.read','kyc.read','offer.read','offer.edit']) x
UNION ALL SELECT 'read_only',  x FROM unnest(ARRAY['config.read','kyc.read','offer.read']) x;

-- ---------------------------------------------------------------- ref
-- Mirrors App DB enum public.product_type. Adding a value = one INSERT here
-- plus the enum value on the App DB (the apply step rejects unknown values).
CREATE TABLE ref.product_type (
  code     text PRIMARY KEY CHECK (code ~ '^[a-z_]+$'),
  category text NOT NULL CHECK (category IN ('borrow','save','invest'))
);
INSERT INTO ref.product_type (code, category) VALUES
  ('sme_loan','borrow'), ('personal_loan','borrow'), ('mortgage','borrow'), ('credit_card','borrow'),
  ('leasing','borrow'), ('overdraft','borrow'), ('business_loan','borrow'),
  ('fixed_deposit','save'), ('savings_account','save'), ('business_account','save'), ('savings_plan','save'),
  ('investment_account','invest'), ('equities','invest'), ('unit_trust','invest'),
  ('government_bonds','invest'), ('offshore_investment','invest'), ('mixed_portfolio','invest');

-- ------------------------------------------------------------- config
CREATE TABLE config.setting (
  key         text PRIMARY KEY CHECK (key ~ '^[a-z_]+(\.[a-z_]+)+$'),
  value       jsonb NOT NULL,
  value_type  text NOT NULL CHECK (value_type IN ('boolean','integer','string')),
  description text NOT NULL,
  version     bigint NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by  uuid REFERENCES iam.admin_user(id),
  CHECK (jsonb_typeof(value) = CASE value_type WHEN 'integer' THEN 'number' ELSE value_type END),
  CHECK (value_type <> 'integer' OR (value::numeric % 1 = 0)),
  CHECK (value_type <> 'string'  OR length(value #>> '{}') <= 500)
);
CREATE TRIGGER setting_touch BEFORE UPDATE ON config.setting FOR EACH ROW EXECUTE FUNCTION util.touch();

INSERT INTO config.setting (key, value, value_type, description) VALUES
  ('bid.default_window_minutes',  '240',     'integer', 'Default bid window if no SLA config found'),
  ('bid.max_per_request',         '20',      'integer', 'Max institution bids per client request'),
  ('marketplace.open_to_all',     'true',    'boolean', 'All approved institutions see all requests'),
  ('platform.audit_retention_days','2555',   'integer', 'Audit log retention in days (7 years for FSC)'),
  ('platform.country',            '"MU"',    'string',  'Primary operating country'),
  ('platform.currency',           '"MUR"',   'string',  'Default currency'),
  ('platform.kyc_required',       'true',    'boolean', 'KYC required before requests go live'),
  ('platform.maker_checker_on',   'true',    'boolean', 'Enforce maker-checker for all material actions'),
  ('platform.name',               '"Ficium"','string',  'Platform display name'),
  ('webhook.backoff_base_ms',     '5000',    'integer', 'Base backoff ms for webhook retry'),
  ('webhook.max_retries',         '5',       'integer', 'Max delivery attempts for webhooks');

CREATE FUNCTION config.get_bool(p_key text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT (value)::boolean FROM config.setting WHERE key = p_key AND value_type = 'boolean'
$$;

-- ---------------------------------------------------------------- kyc
CREATE SEQUENCE kyc.policy_version_seq;
CREATE TABLE kyc.check_setting (
  check_key  text PRIMARY KEY CHECK (check_key IN ('ai_analysis','face_match','duplicate_face','ocr_name_match',
             'proof_of_address','velocity_check','document_reuse','liveness_check','mrz_validation','permit_check')),
  enabled    boolean NOT NULL,
  version    bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by uuid REFERENCES iam.admin_user(id)
);
CREATE TRIGGER check_setting_touch BEFORE UPDATE ON kyc.check_setting FOR EACH ROW EXECUTE FUNCTION util.touch();

-- Seeded from the live App DB public.kyc_settings (25 Oct 2026).
INSERT INTO kyc.check_setting (check_key, enabled) VALUES
  ('ai_analysis', true), ('face_match', false), ('duplicate_face', false), ('ocr_name_match', true),
  ('proof_of_address', true), ('velocity_check', true), ('document_reuse', true),
  ('liveness_check', true), ('mrz_validation', true), ('permit_check', true);

CREATE FUNCTION kyc.snapshot() RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_object_agg(check_key, enabled ORDER BY check_key) FROM kyc.check_setting
$$;

-- ------------------------------------------------------------- offers
CREATE TABLE offers.offer (
  id                 uuid PRIMARY KEY DEFAULT util.uuid_v7(),
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','published','withdrawn')),
  listed             boolean NOT NULL DEFAULT false,   -- a version is live in the app
  listed_version     bigint,                            -- which version is live
  institution_name   text NOT NULL CHECK (length(btrim(institution_name)) BETWEEN 2 AND 80),
  category           text NOT NULL CHECK (category IN ('borrow','save','invest')),
  product_type       text NOT NULL REFERENCES ref.product_type(code),
  caption            text NOT NULL CHECK (length(btrim(caption)) BETWEEN 10 AND 400),
  headline           text NOT NULL CHECK (length(btrim(headline)) BETWEEN 2 AND 60),
  terms              text NOT NULL CHECK (length(btrim(terms)) BETWEEN 2 AND 120),
  image_tag          text CHECK (image_tag IS NULL OR length(image_tag) <= 40),
  image_url          text CHECK (image_url IS NULL OR image_url ~ '^https://'),
  image_alt          text CHECK (image_alt IS NULL OR length(image_alt) <= 200),
  is_launch          boolean NOT NULL DEFAULT false,
  launch_window_ends timestamptz,
  expires_at         timestamptz NOT NULL,
  source_url         text CHECK (source_url IS NULL OR source_url ~ '^https://'),
  consent_ref        text CHECK (consent_ref IS NULL OR length(btrim(consent_ref)) >= 3),
  verified_at        timestamptz,
  created_by         uuid NOT NULL REFERENCES iam.admin_user(id),
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by         uuid NOT NULL REFERENCES iam.admin_user(id),
  updated_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  approved_by        uuid REFERENCES iam.admin_user(id),
  approved_at        timestamptz,
  published_by       uuid REFERENCES iam.admin_user(id),
  published_at       timestamptz,
  withdrawn_by       uuid REFERENCES iam.admin_user(id),
  withdrawn_at       timestamptz,
  version            bigint NOT NULL DEFAULT 1,
  CHECK (NOT is_launch OR launch_window_ends IS NOT NULL),
  CHECK (launch_window_ends IS NULL OR launch_window_ends <= expires_at),
  CHECK (status <> 'approved' OR approved_by IS NOT NULL),
  CHECK (listed = (listed_version IS NOT NULL))
);
CREATE INDEX offer_status_idx ON offers.offer (status, expires_at);
CREATE INDEX offer_listed_idx ON offers.offer (expires_at) WHERE listed;

CREATE FUNCTION offers._category_matches(p_category text, p_product_type text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM ref.product_type WHERE code = p_product_type AND category = p_category)
$$;

CREATE FUNCTION offers._assert_publishable(r offers.offer) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
BEGIN
  IF r.image_url IS NULL OR r.image_alt IS NULL THEN RAISE EXCEPTION 'image and image description are required' USING ERRCODE = '22023'; END IF;
  IF r.source_url IS NULL THEN RAISE EXCEPTION 'source link is required' USING ERRCODE = '22023'; END IF;
  IF r.consent_ref IS NULL THEN RAISE EXCEPTION 'bank consent reference is required' USING ERRCODE = '22023'; END IF;
  IF r.verified_at IS NULL OR r.verified_at < clock_timestamp() - interval '30 days' OR r.verified_at > clock_timestamp() THEN
    RAISE EXCEPTION 'rates must be verified within the last 30 days' USING ERRCODE = '22023';
  END IF;
  IF r.expires_at <= clock_timestamp() THEN RAISE EXCEPTION 'expiry is in the past' USING ERRCODE = '22023'; END IF;
END $$;

-- Exactly what the borrower app shows (public.offer_listing on the App DB).
CREATE FUNCTION offers._listing(r offers.offer) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog SET TimeZone = 'UTC' AS $$
  SELECT jsonb_build_object(
    'id', r.id, 'institution_name', r.institution_name, 'category', r.category,
    'product_type', r.product_type, 'caption', r.caption, 'headline', r.headline, 'terms', r.terms,
    'image_tag', r.image_tag, 'image_url', r.image_url, 'image_alt', r.image_alt,
    'is_launch', r.is_launch, 'launch_window_ends', r.launch_window_ends,
    'published_at', r.published_at, 'verified_at', r.verified_at,
    'live_until', least(r.expires_at, r.verified_at + interval '30 days'))
$$;

CREATE FUNCTION offers._lock(p_id uuid, p_expected_version bigint) RETURNS offers.offer
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $$
DECLARE r offers.offer;
BEGIN
  SELECT * INTO r FROM offers.offer WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'offer not found' USING ERRCODE = 'P0002'; END IF;
  IF r.version <> p_expected_version THEN
    RAISE EXCEPTION 'offer changed since you opened it (now version %)', r.version USING ERRCODE = '40001';
  END IF;
  RETURN r;
END $$;

-- ---------------------------------------------------------------- api
CREATE FUNCTION api.config_list() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM iam.require('config.read');
  RETURN coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.key) FROM config.setting s), '[]');
END $$;

CREATE FUNCTION api.config_set(p_key text, p_value jsonb, p_expected_version bigint, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('config.change'); old config.setting; s config.setting;
        r text := util.require_reason(p_reason); ev uuid;
BEGIN
  SELECT * INTO old FROM config.setting WHERE key = p_key FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown setting %', p_key USING ERRCODE = 'P0002'; END IF;
  UPDATE config.setting SET value = p_value, version = version + 1, updated_by = a
   WHERE key = p_key AND version = p_expected_version RETURNING * INTO s;
  IF NOT FOUND THEN RAISE EXCEPTION 'setting changed since you opened it' USING ERRCODE = '40001'; END IF;
  ev := audit.record('config.setting_changed', 'setting', p_key, r,
                     jsonb_build_object('value', old.value), jsonb_build_object('value', s.value));
  PERFORM outbox.enqueue('config.setting_changed', 'setting', p_key, s.version,
                         jsonb_build_object('key', s.key, 'value', s.value, 'version', s.version), ev);
  RETURN to_jsonb(s);
END $$;

CREATE FUNCTION api.kyc_list() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM iam.require('kyc.read');
  RETURN coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.check_key) FROM kyc.check_setting c), '[]');
END $$;

CREATE FUNCTION api.kyc_set_check(p_key text, p_enabled boolean, p_expected_version bigint, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('kyc.change'); old kyc.check_setting; c kyc.check_setting;
        r text := util.require_reason(p_reason); ev uuid; pv bigint;
BEGIN
  IF p_enabled IS NULL THEN RAISE EXCEPTION 'value is required' USING ERRCODE = '22023'; END IF;
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

CREATE FUNCTION api.offer_list(p_status text DEFAULT NULL, p_after uuid DEFAULT NULL, p_limit integer DEFAULT 50) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM iam.require('offer.read');
  RETURN coalesce((SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id DESC) FROM (
    SELECT * FROM offers.offer
    WHERE (p_status IS NULL OR status = p_status) AND (p_after IS NULL OR id < p_after)
    ORDER BY id DESC LIMIT least(greatest(coalesce(p_limit, 50), 1), 200)) o), '[]');
END $$;

CREATE FUNCTION api.offer_get(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM iam.require('offer.read');
  RETURN (SELECT to_jsonb(o) FROM offers.offer o WHERE o.id = p_id);
END $$;

-- Create (p_id NULL) or edit. Any edit returns the offer to draft and clears
-- approval; a live listing stays on its old approved version until republished.
CREATE FUNCTION api.offer_save(p_id uuid, p_data jsonb, p_expected_version bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('offer.edit'); old offers.offer; o offers.offer;
BEGIN
  IF NOT offers._category_matches(p_data->>'category', p_data->>'product_type') THEN
    RAISE EXCEPTION 'product type does not belong to category' USING ERRCODE = '22023';
  END IF;
  IF p_id IS NULL THEN
    INSERT INTO offers.offer (institution_name, category, product_type, caption, headline, terms,
      image_tag, image_url, image_alt, is_launch, launch_window_ends, expires_at,
      source_url, consent_ref, verified_at, created_by, updated_by)
    VALUES (btrim(p_data->>'institution_name'), p_data->>'category', p_data->>'product_type',
      btrim(p_data->>'caption'), btrim(p_data->>'headline'), btrim(p_data->>'terms'),
      p_data->>'image_tag', p_data->>'image_url', p_data->>'image_alt',
      coalesce((p_data->>'is_launch')::boolean, false), (p_data->>'launch_window_ends')::timestamptz,
      (p_data->>'expires_at')::timestamptz, p_data->>'source_url', p_data->>'consent_ref',
      (p_data->>'verified_at')::timestamptz, a, a)
    RETURNING * INTO o;
    PERFORM audit.record('offer.created', 'offer', o.id::text, NULL, NULL, to_jsonb(o));
  ELSE
    old := offers._lock(p_id, p_expected_version);
    IF old.status = 'withdrawn' THEN RAISE EXCEPTION 'a withdrawn offer cannot be edited' USING ERRCODE = '22023'; END IF;
    UPDATE offers.offer SET
      institution_name = btrim(p_data->>'institution_name'), category = p_data->>'category',
      product_type = p_data->>'product_type', caption = btrim(p_data->>'caption'),
      headline = btrim(p_data->>'headline'), terms = btrim(p_data->>'terms'),
      image_tag = p_data->>'image_tag', image_url = p_data->>'image_url', image_alt = p_data->>'image_alt',
      is_launch = coalesce((p_data->>'is_launch')::boolean, false),
      launch_window_ends = (p_data->>'launch_window_ends')::timestamptz,
      expires_at = (p_data->>'expires_at')::timestamptz,
      source_url = p_data->>'source_url', consent_ref = p_data->>'consent_ref',
      verified_at = (p_data->>'verified_at')::timestamptz,
      status = 'draft', approved_by = NULL, approved_at = NULL,
      updated_by = a, updated_at = clock_timestamp(), version = version + 1
    WHERE id = p_id RETURNING * INTO o;
    PERFORM audit.record('offer.edited', 'offer', o.id::text, NULL, to_jsonb(old), to_jsonb(o));
  END IF;
  RETURN to_jsonb(o);
END $$;

CREATE FUNCTION api.offer_approve(p_id uuid, p_expected_version bigint, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('offer.approve'); old offers.offer; o offers.offer; r text := util.require_reason(p_reason);
BEGIN
  old := offers._lock(p_id, p_expected_version);
  IF old.status <> 'draft' THEN RAISE EXCEPTION 'only a draft can be approved' USING ERRCODE = '22023'; END IF;
  IF coalesce(config.get_bool('platform.maker_checker_on'), true) AND a = old.updated_by THEN
    RAISE EXCEPTION 'maker-checker: the last editor cannot approve' USING ERRCODE = '42501';
  END IF;
  PERFORM offers._assert_publishable(old);
  UPDATE offers.offer SET status = 'approved', approved_by = a, approved_at = clock_timestamp(), version = version + 1
   WHERE id = p_id RETURNING * INTO o;
  PERFORM audit.record('offer.approved', 'offer', o.id::text, r, to_jsonb(old), to_jsonb(o));
  RETURN to_jsonb(o);
END $$;

CREATE FUNCTION api.offer_publish(p_id uuid, p_expected_version bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('offer.publish'); old offers.offer; o offers.offer; ev uuid;
BEGIN
  old := offers._lock(p_id, p_expected_version);
  IF old.status <> 'approved' THEN RAISE EXCEPTION 'only an approved offer can be published' USING ERRCODE = '22023'; END IF;
  PERFORM offers._assert_publishable(old);
  UPDATE offers.offer SET status = 'published', published_by = a, published_at = clock_timestamp(),
         listed = true, listed_version = version + 1, version = version + 1
   WHERE id = p_id RETURNING * INTO o;
  ev := audit.record('offer.published', 'offer', o.id::text, NULL, to_jsonb(old), to_jsonb(o));
  PERFORM outbox.enqueue('offer.listing_upserted', 'offer', o.id::text, o.version, offers._listing(o), ev);
  RETURN to_jsonb(o);
END $$;

CREATE FUNCTION api.offer_reverify(p_id uuid, p_verified_at timestamptz, p_expected_version bigint, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('offer.edit'); old offers.offer; o offers.offer; r text := util.require_reason(p_reason); ev uuid;
BEGIN
  IF p_verified_at IS NULL OR p_verified_at > clock_timestamp() OR p_verified_at < clock_timestamp() - interval '30 days' THEN
    RAISE EXCEPTION 'verification date must be within the last 30 days' USING ERRCODE = '22023';
  END IF;
  old := offers._lock(p_id, p_expected_version);
  -- Re-verifying rates is not a content change: approval and listing survive.
  UPDATE offers.offer SET verified_at = p_verified_at, updated_at = clock_timestamp(), version = version + 1,
         listed_version = CASE WHEN listed AND status = 'published' THEN version + 1 ELSE listed_version END
   WHERE id = p_id RETURNING * INTO o;
  ev := audit.record('offer.reverified', 'offer', o.id::text, r,
                     jsonb_build_object('verified_at', old.verified_at), jsonb_build_object('verified_at', o.verified_at));
  IF o.listed AND old.status = 'published' THEN
    PERFORM outbox.enqueue('offer.listing_upserted', 'offer', o.id::text, o.version, offers._listing(o), ev);
  END IF;
  RETURN to_jsonb(o);
END $$;

CREATE FUNCTION api.offer_withdraw(p_id uuid, p_expected_version bigint, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a uuid := iam.require('offer.withdraw'); old offers.offer; o offers.offer; r text := util.require_reason(p_reason); ev uuid;
BEGIN
  old := offers._lock(p_id, p_expected_version);
  IF old.status = 'withdrawn' THEN RAISE EXCEPTION 'offer is already withdrawn' USING ERRCODE = '22023'; END IF;
  UPDATE offers.offer SET status = 'withdrawn', withdrawn_by = a, withdrawn_at = clock_timestamp(),
         listed = false, listed_version = NULL, version = version + 1
   WHERE id = p_id RETURNING * INTO o;
  ev := audit.record('offer.withdrawn', 'offer', o.id::text, r, to_jsonb(old), to_jsonb(o));
  IF old.listed THEN
    PERFORM outbox.enqueue('offer.listing_removed', 'offer', o.id::text, o.version, jsonb_build_object('id', o.id), ev);
  END IF;
  RETURN to_jsonb(o);
END $$;

-- ------------------------------------------------------------- grants
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA config, kyc, offers, api FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  api.config_list(), api.config_set(text, jsonb, bigint, text),
  api.kyc_list(), api.kyc_set_check(text, boolean, bigint, text),
  api.offer_list(text, uuid, integer), api.offer_get(uuid),
  api.offer_save(uuid, jsonb, bigint), api.offer_approve(uuid, bigint, text),
  api.offer_publish(uuid, bigint), api.offer_reverify(uuid, timestamptz, bigint, text),
  api.offer_withdraw(uuid, bigint, text)
  TO app_admin_api;
GRANT USAGE ON SCHEMA ref, config, kyc, offers TO app_admin_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA ref, config, kyc, offers TO app_admin_readonly;
