import { apiFetch } from "../auth/client";

export type Days = 7 | 30 | 90 | 365;
export type Spread = { median: number | null; p90: number | null };
export type Week = { week: string; posted: number; with_bid: number; accepted: number };
export type ProductRow = { product: string; posted: number; with_bid: number; accepted: number; requested_amount: number };
export type Marketplace = {
  generated_at: string; days: number;
  funnel: { posted: number; relisted: number; with_bid: number; accepted: number; bank_declined: number;
    bids_per_request_with_bid: number | null; requested_amount: number; accepted_amount: number };
  hours_to_first_bid: Spread; hours_to_acceptance: Spread;
  status: Record<string, number>; by_product: ProductRow[]; weekly: Week[];
  now: { open: number; open_no_bid_24h: number; oldest_no_bid_hours: number | null };
};
export type Loaded = { actor: string; marketplace: Marketplace };

// Shares the /api/kyc function file (12-function limit on the Vercel plan); see api/_lib/marketplace.ts.
export async function load(days: Days): Promise<Loaded> {
  const r = await apiFetch(`/api/kyc?module=marketplace&days=${days}`);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `Request failed (${r.status})`);
  return body as Loaded;
}
