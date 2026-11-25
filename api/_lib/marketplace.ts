/**
 * Marketplace monitor (app site only). Served by the /api/kyc function file as
 * /api/kyc?module=marketplace: the Vercel plan allows 12 function files and this repo has 12.
 *
 *   GET ?module=marketplace&days=7|30|90|365 -> { actor, marketplace: {...} }
 *
 * The request → bid → acceptance funnel: how many requests were posted, how many got a bid, how
 * fast, how many were accepted, how many the bank then declined, and the open requests still
 * waiting for a first bid after 24 hours. The borrower app owns the numbers and returns totals
 * only (no borrower, request or bank), over its signed admin channel
 * (/api/internal?op=admin-app, action "marketplace"). Never a database connection.
 *
 * Permission: traffic.view, the monitoring permission the Services and API traffic pages use,
 * checked in the admin database before the borrower app is asked anything.
 */
import { requireStaffIdentity, AuthError, type Staff } from "./access.js";
import { appEndpoint } from "./app-endpoint.js";
import { withAdmin, requestMeta, dbError, type Q, type Meta } from "./admin-db.js";
import { sign } from "./portal-api.js";

type Req = { method?: string; headers: Record<string, string | string[] | undefined>; query?: Record<string, string | string[] | undefined> };
type Res = { status(code: number): Res; json(body: unknown): void; setHeader(k: string, v: string): void };
type Env = Record<string, string | undefined>;

export const DAYS = [7, 30, 90, 365] as const;
export type Days = (typeof DAYS)[number];

export type Funnel = { posted: number; relisted: number; with_bid: number; accepted: number; bank_declined: number;
  bids_per_request_with_bid: number | null; requested_amount: number; accepted_amount: number };
export type Spread = { median: number | null; p90: number | null };
export type ProductRow = { product: string; posted: number; with_bid: number; accepted: number; requested_amount: number };
export type Week = { week: string; posted: number; with_bid: number; accepted: number };
export type Marketplace = {
  generated_at: string; days: number; funnel: Funnel; hours_to_first_bid: Spread; hours_to_acceptance: Spread;
  status: Record<string, number>; by_product: ProductRow[]; weekly: Week[];
  now: { open: number; open_no_bid_24h: number; oldest_no_bid_hours: number | null };
};

export class MarketplaceError extends Error {
  constructor(message: string, readonly status = 502) { super(message); }
}

const n = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
const orNull = (v: unknown) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const word = (v: unknown, max = 40) => String(v ?? "").replace(/[^a-z0-9_]/gi, "").slice(0, max);
const STATUSES = ["open", "closed", "accepted", "expired", "rejected", "awaiting_consent", "deal_declined"];

/** Keeps only the fields this site shows, typed and bounded, so a surprise in the answer cannot reach the page. */
export function cleanMarketplace(raw: any): Marketplace {
  const f = raw?.funnel ?? {};
  const spread = (s: any): Spread => ({ median: orNull(s?.median), p90: orNull(s?.p90) });
  const status: Record<string, number> = {};
  for (const k of STATUSES) if (raw?.status?.[k] != null) status[k] = n(raw.status[k]);
  return {
    generated_at: String(raw?.generated_at ?? "").slice(0, 40),
    days: n(raw?.days),
    funnel: {
      posted: n(f.posted), relisted: n(f.relisted), with_bid: n(f.with_bid), accepted: n(f.accepted),
      bank_declined: n(f.bank_declined), bids_per_request_with_bid: orNull(f.bids_per_request_with_bid),
      requested_amount: n(f.requested_amount), accepted_amount: n(f.accepted_amount),
    },
    hours_to_first_bid: spread(raw?.hours_to_first_bid),
    hours_to_acceptance: spread(raw?.hours_to_acceptance),
    status,
    by_product: (Array.isArray(raw?.by_product) ? raw.by_product.slice(0, 40) : []).map((p: any) => ({
      product: word(p?.product), posted: n(p?.posted), with_bid: n(p?.with_bid), accepted: n(p?.accepted), requested_amount: n(p?.requested_amount),
    })),
    weekly: (Array.isArray(raw?.weekly) ? raw.weekly.slice(-60) : []).map((w: any) => ({
      week: /^\d{4}-\d{2}-\d{2}$/.test(String(w?.week)) ? String(w.week) : "", posted: n(w?.posted), with_bid: n(w?.with_bid), accepted: n(w?.accepted),
    })).filter((w: Week) => w.week),
    now: { open: n(raw?.now?.open), open_no_bid_24h: n(raw?.now?.open_no_bid_24h), oldest_no_bid_hours: orNull(raw?.now?.oldest_no_bid_hours) },
  };
}

export type Reader = (days: Days) => Promise<Marketplace>;

/** The signed read from the borrower app; null when this deployment has no channel to it. */
export function borrowerApp(env: Env = process.env, f: typeof fetch = fetch): Reader | null {
  const base = env.APP_ADMIN_SYNC_URL?.trim(), key = env.APP_ADMIN_SYNC_SIGNING_KEY?.trim();
  if (!base || !key) return null;
  return async (days) => {
    let url: URL;
    try { url = appEndpoint("admin-app", env); }
    catch (e) { throw new MarketplaceError((e as Error).message, 503); }
    const raw = JSON.stringify({ action: "marketplace", days });
    let r: Response;
    try {
      r = await f(url, { method: "POST", body: raw, signal: AbortSignal.timeout(10_000),
        headers: { "Content-Type": "application/json", "Ficium-Signature": sign(raw, key) } });
    } catch {
      throw new MarketplaceError("The borrower app could not be reached");
    }
    const data = (await r.json().catch(() => ({}))) as any;
    if (r.ok) return cleanMarketplace(data?.marketplace);
    // Say which of the usual causes it is, so nobody has to open logs to find out.
    if (r.status === 401) throw new MarketplaceError("The borrower app refused this site's signature: the admin channel keys no longer match");
    if (r.status === 503) throw new MarketplaceError("The borrower app has the admin channel switched off (ADMIN_SYNC_VERIFY_KEYS is not set there)");
    if (r.status === 422) throw new MarketplaceError("The borrower app does not offer marketplace numbers yet: deploy the borrower app version that does");
    if (r.status >= 500) throw new MarketplaceError("The borrower app failed while counting: its database change for this page may not be applied");
    throw new MarketplaceError(`The borrower app answered ${r.status}`);
  };
}

export type Deps = {
  requireStaff: (h: Req["headers"]) => Promise<Staff>;
  withAdmin: <T>(s: Staff, m: Meta, fn: (q: Q) => Promise<T>) => Promise<T>;
  read: Reader | null;
};
export const live = (): Deps => ({ requireStaff: (h) => requireStaffIdentity(h), withAdmin, read: borrowerApp() });

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export function makeHandler(deps: Deps) {
  return async function handler(req: Req, res: Res) {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ error: "Method not allowed" }); }
    let staff: Staff;
    try {
      staff = await deps.requireStaff(req.headers);
    } catch (e) {
      const status = e instanceof AuthError ? e.status : 401;
      return res.status(status).json({ error: e instanceof Error ? e.message : "Not signed in", code: e instanceof AuthError ? e.code : undefined });
    }
    const raw = one(req.query?.days) || "30";
    const days = (DAYS as readonly number[]).includes(Number(raw)) ? (Number(raw) as Days) : null;
    if (days === null) return res.status(400).json({ error: "days must be 7, 30, 90 or 365" });
    try {
      // Permission first, inside the admin DB; the borrower app is asked only after.
      await deps.withAdmin(staff, requestMeta(req.headers), (q) => q("select api.traffic_view() as v"));
    } catch (e: any) {
      const m = dbError(e);
      if (m) return res.status(m.status).json({ error: m.error });
      console.error("marketplace permission error", e?.code, e?.message);
      return res.status(500).json({ error: "The marketplace numbers could not be loaded" });
    }
    if (!deps.read) return res.status(503).json({ error: "The connection to the borrower app is not configured on this deployment" });
    try {
      return res.status(200).json({ actor: staff.email, marketplace: await deps.read(days) });
    } catch (e) {
      if (e instanceof MarketplaceError) return res.status(e.status).json({ error: e.message });
      console.error("marketplace read error", (e as Error)?.message);
      return res.status(502).json({ error: "The borrower app did not answer" });
    }
  };
}
