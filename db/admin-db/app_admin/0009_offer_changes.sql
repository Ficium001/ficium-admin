-- 0009_offer_changes.sql — the offer approver sees what changed, not just the offer.
--
-- api.offer_changes(id): every field that differs between the offer as saved
-- now and the offer as it was last approved (from the hash-chained audit log),
-- or every field if it was never approved. Shown above the Approve button.
-- api.offer_history now also lists the fields each saved change touched.
SET LOCAL ROLE app_admin_owner;
SET LOCAL search_path = pg_catalog;

CREATE FUNCTION offers._fields() RETURNS TABLE (k text, label text, pos int)
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  VALUES ('institution_name','Provider',1), ('category','Category',2), ('product_type','Product',3),
         ('headline','Headline',4), ('terms','Terms',5), ('caption','Caption',6),
         ('image_url','Image',7), ('image_alt','Image description',8), ('is_launch','Launch offer',9),
         ('launch_window_ends','Launch window ends',10), ('expires_at','Expires',11),
         ('source_url','Source link',12), ('consent_ref','Consent reference',13), ('verified_at','Rates verified',14)
$$;

CREATE FUNCTION offers._diff(p_before jsonb, p_after jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('field', f.label,
           'before', p_before->>f.k, 'after', p_after->>f.k) ORDER BY f.pos), '[]'::jsonb)
    FROM offers._fields() f
   WHERE p_after IS NOT NULL AND (p_before->f.k) IS DISTINCT FROM (p_after->f.k)
$$;

CREATE FUNCTION api.offer_changes(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE cur jsonb; last record;
BEGIN
  PERFORM iam.require('offer.read');
  SELECT to_jsonb(o) INTO cur FROM offers.offer o WHERE o.id = p_id;
  IF cur IS NULL THEN RAISE EXCEPTION 'offer not found' USING ERRCODE = 'P0002'; END IF;
  SELECT e.after, e.occurred_at, iam._email(e.actor_id) AS approver INTO last
    FROM audit.event e
   WHERE e.resource_type = 'offer' AND e.resource_id = p_id::text AND e.action = 'offer.approved'
   ORDER BY e.chain_pos DESC LIMIT 1;
  RETURN jsonb_build_object(
    'since', CASE WHEN last.after IS NULL THEN 'new' ELSE 'last_approval' END,
    'last_approved_at', last.occurred_at, 'last_approved_by', last.approver,
    'rows', offers._diff(last.after, cur));
END $$;

CREATE OR REPLACE FUNCTION api.offer_history(p_id uuid, p_limit integer DEFAULT 100) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM iam.require('offer.read');
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id', e.chain_pos, 'changed_at', e.occurred_at,
      'actor', coalesce(iam._email(e.actor_id), 'system'),
      'action', split_part(e.action, '.', 2), 'reason', e.reason,
      'changes', CASE WHEN e.action IN ('offer.created', 'offer.edited')
                      THEN offers._diff(e.before, e.after) ELSE '[]'::jsonb END) ORDER BY e.chain_pos DESC)
    FROM (SELECT * FROM audit.event WHERE resource_type = 'offer' AND resource_id = p_id::text
          ORDER BY chain_pos DESC LIMIT least(greatest(coalesce(p_limit, 100), 1), 500)) e), '[]');
END $$;

REVOKE EXECUTE ON FUNCTION offers._fields(), offers._diff(jsonb, jsonb), api.offer_changes(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.offer_changes(uuid) TO app_admin_api;
