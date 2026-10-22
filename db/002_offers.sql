-- APPLIED to the App DB (wixfhjlsjkiwfvqewvmt) on 2026-10-22 as migration offers_v1.
-- Full source of truth: Ficium001/ficium supabase/migrations/20261022120000_offers_v1.sql
-- What this app's role gets from it:
GRANT SELECT ON admin.offer, admin.offer_change TO ficium_admin_app;   -- + SELECT policies
GRANT EXECUTE ON FUNCTION
  admin.offer_save(uuid,jsonb,text,integer), admin.offer_approve(uuid,text,text),
  admin.offer_publish(uuid,text), admin.offer_withdraw(uuid,text,text),
  admin.offer_reverify(uuid,text,timestamptz,text) TO ficium_admin_app;
-- The role has NO access to public.offer_listing; only admin.offer_publish writes it.
-- admin.offer_change is append-only (trigger blocks UPDATE/DELETE/TRUNCATE for everyone).
