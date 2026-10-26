-- 0004_ui_read_models.sql — display-ready reads for the ficium-admin pages.
-- People are shown by email, never by internal id; history comes from the
-- hash-chained audit log. All reads are permission-checked like writes.
SET LOCAL ROLE app_admin_owner;
SET LOCAL search_path = pg_catalog;

CREATE FUNCTION iam._email(p uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT email FROM iam.admin_user WHERE id = p
$$;

CREATE FUNCTION api.kyc_view(p_history_limit integer DEFAULT 100) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE me uuid := iam.require('kyc.read');
BEGIN
  RETURN jsonb_build_object(
    'actor', iam._email(me),
    'settings', (SELECT jsonb_object_agg(check_key, enabled) || jsonb_build_object('updated_at', max(updated_at))
                 FROM kyc.check_setting),
    'versions', (SELECT jsonb_object_agg(check_key, version) FROM kyc.check_setting),
    'history', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id', e.chain_pos, 'changed_at', e.occurred_at, 'check_key', e.resource_id,
        'old_value', (e.before->>'enabled')::boolean, 'new_value', (e.after->>'enabled')::boolean,
        'actor', coalesce(iam._email(e.actor_id), 'system'), 'reason', e.reason) ORDER BY e.chain_pos DESC)
      FROM (SELECT * FROM audit.event WHERE action = 'kyc.check_changed'
            ORDER BY chain_pos DESC LIMIT least(greatest(coalesce(p_history_limit, 100), 1), 500)) e), '[]'));
END $$;

CREATE FUNCTION offers._view(o offers.offer) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT to_jsonb(o)
    || jsonb_build_object(
         'created_by',   iam._email(o.created_by),
         'updated_by',   iam._email(o.updated_by),
         'approved_by',  iam._email(o.approved_by),
         'published_by', iam._email(o.published_by),
         'withdrawn_by', iam._email(o.withdrawn_by),
         'self_approved', CASE WHEN o.approved_by IS NULL THEN NULL ELSE o.approved_by = o.updated_by END,
         'is_live', o.listed AND o.status <> 'withdrawn' AND o.expires_at > clock_timestamp()
                    AND o.verified_at > clock_timestamp() - interval '30 days',
         'live_until', CASE WHEN o.listed THEN least(o.expires_at, o.verified_at + interval '30 days') END)
$$;

CREATE FUNCTION api.offer_view_list(p_limit integer DEFAULT 200) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE me uuid := iam.require('offer.read');
BEGIN
  RETURN jsonb_build_object('actor', iam._email(me), 'offers', coalesce((
    SELECT jsonb_agg(offers._view(o) ORDER BY o.updated_at DESC)
    FROM (SELECT * FROM offers.offer ORDER BY updated_at DESC
          LIMIT least(greatest(coalesce(p_limit, 200), 1), 500)) o), '[]'));
END $$;

CREATE FUNCTION api.offer_view(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM iam.require('offer.read');
  RETURN (SELECT offers._view(o) FROM offers.offer o WHERE o.id = p_id);
END $$;

CREATE FUNCTION api.offer_history(p_id uuid, p_limit integer DEFAULT 100) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM iam.require('offer.read');
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id', e.chain_pos, 'changed_at', e.occurred_at,
      'actor', coalesce(iam._email(e.actor_id), 'system'),
      'action', split_part(e.action, '.', 2), 'reason', e.reason) ORDER BY e.chain_pos DESC)
    FROM (SELECT * FROM audit.event WHERE resource_type = 'offer' AND resource_id = p_id::text
          ORDER BY chain_pos DESC LIMIT least(greatest(coalesce(p_limit, 100), 1), 500)) e), '[]');
END $$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA iam, offers, api FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.kyc_view(integer), api.offer_view_list(integer), api.offer_view(uuid),
  api.offer_history(uuid, integer) TO app_admin_api;
-- re-assert earlier grants (REVOKE ... ALL FUNCTIONS FROM PUBLIC never touches role grants; kept explicit)
