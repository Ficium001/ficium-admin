/**
 * Ficium's commission fee models (portal-api db/072), shared by the admin API and the
 * Commission page. Pure: no imports, so both builds can use it.
 *
 * A rule's model decides how the fee for one booked deal is worked out:
 *   booked_amount  rate x booked amount                                   (loans)
 *   annualised     rate x (first amount x lump share + monthly amount x months)  (regular plans)
 *   amount_x_term  rate per year x amount x min(term in years, max years) (deposits, bonds)
 *   tiered         banded rates on the booked amount, marginal or whole
 *   flat           a fixed amount per booked deal
 * plus an optional minimum and maximum fee, and a clawback window: if the bank reports the
 * account closed inside it, all or the unearned share of the fee is credited back.
 *
 * modelFromForm() turns what an admin typed (percentages, MUR) into the exact model
 * portal-api receives. The same limits are enforced again by portal-api and by the Portal DB
 * (billing.rule_shape_error), which is the authority; this exists to give a clear message early.
 */

export const BASES = ["booked_amount", "annualised", "amount_x_term", "tiered", "flat"] as const;
export type Basis = (typeof BASES)[number];
export type ClawbackMode = "none" | "full" | "pro_rata";

export const BASIS_LABEL: Record<Basis, string> = {
  booked_amount: "Percentage of the booked amount",
  annualised: "Percentage of the first year's money in",
  amount_x_term: "Percentage per year of term",
  tiered: "Banded rates on the booked amount",
  flat: "Fixed fee per booked deal",
};
export const BASIS_HINT: Record<Basis, string> = {
  booked_amount: "Loans: one disbursement. The bank sends the booked amount.",
  annualised: "Savings and investment plans: a first amount plus a monthly amount. The bank also sends the monthly amount.",
  amount_x_term: "Term deposits and bonds: worth more the longer they run. Uses the deal's term, or the term the bank sends.",
  tiered: "Lower rates on larger amounts. Marginal charges each band at its own rate; whole charges the band the amount falls in.",
  flat: "The same amount for every booked deal, whatever its size.",
};
export const RATED: readonly Basis[] = ["booked_amount", "annualised", "amount_x_term"];

export type Tier = { up_to: number | null; rate: number };
export type FeeModel = {
  basis: Basis;
  rate: string | null;                       // fraction, 4 dp ("0.0045"); null for tiered and flat
  params: Record<string, unknown>;
  min_fee: string | null;                    // MUR, 2 dp
  max_fee: string | null;
  clawback_months: number;
  clawback_mode: ClawbackMode;
};
/** What a rule row from portal-api carries (numbers may arrive as strings). */
export type ModelLike = {
  basis?: string | null; rate?: string | number | null; params?: Record<string, unknown> | null;
  min_fee?: string | number | null; max_fee?: string | number | null;
  clawback_months?: number | string | null; clawback_mode?: string | null; currency?: string | null;
};

export class FeeModelError extends Error {}
const need = (ok: boolean, msg: string) => { if (!ok) throw new FeeModelError(msg); };
const s = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");

export const MAX_PERCENT = 5;
const PERCENT = /^\d{1,2}(\.\d{1,2})?$/;
const MONEY = /^\d{1,9}(\.\d{1,2})?$/;
const WHOLE = /^\d{1,3}$/;

/** "0.45" (%) -> 45 basis points. Exact: at most 2 decimals of a percent. */
function bps(p: string, what: string): number {
  need(PERCENT.test(p), `Enter ${what} as a percentage with at most 2 decimals, e.g. 0.45`);
  const [whole, dec = ""] = p.split(".");
  const n = Number(whole) * 100 + Number(dec.padEnd(2, "0"));
  need(n <= MAX_PERCENT * 100, `${what.charAt(0).toUpperCase()}${what.slice(1)} can't be above ${MAX_PERCENT}%`);
  return n;
}
/** "0.45" (%) -> "0.0045" (fraction, 4 dp). */
export const percentToFraction = (p: string, what = "the rate") => (bps(p, what) / 10_000).toFixed(4);

function money(v: unknown, what: string): string | null {
  const t = s(v);
  if (!t) return null;
  need(MONEY.test(t), `${what} must be an amount in MUR with at most 2 decimals`);
  return Number(t).toFixed(2);
}
function whole(v: unknown, what: string, lo: number, hi: number): number {
  const t = s(v);
  need(WHOLE.test(t) && Number(t) >= lo && Number(t) <= hi, `${what} must be a whole number from ${lo} to ${hi}`);
  return Number(t);
}

/** Form fields an admin fills in; every field is a string as typed. */
export type FeeForm = {
  basis?: string; rate_percent?: string;
  months?: string; lump_percent?: string;          // annualised
  max_years?: string;                              // amount_x_term
  tier_mode?: string; tiers?: { up_to?: string; rate_percent?: string }[];  // tiered
  flat_amount?: string;                            // flat
  min_fee?: string; max_fee?: string;
  clawback_months?: string; clawback_mode?: string;
};

export function modelFromForm(f: FeeForm): FeeModel {
  const basis = (s(f.basis) || "booked_amount") as Basis;
  need((BASES as readonly string[]).includes(basis), "Choose how the fee is worked out");
  const params: Record<string, unknown> = {};
  let rate: string | null = null;

  if (RATED.includes(basis)) rate = percentToFraction(s(f.rate_percent));
  if (basis === "annualised") {
    params.months = whole(f.months || "12", "Months of contributions", 1, 60);
    const lump = s(f.lump_percent);
    if (lump && lump !== "100") {
      need(/^\d{1,3}$/.test(lump) && Number(lump) <= 100, "The share of the first amount must be 0 to 100%");
      params.lump_weight = Number(lump) / 100;
    }
  }
  if (basis === "amount_x_term") params.max_years = whole(f.max_years || "5", "Most years charged", 1, 30);
  if (basis === "flat") {
    const amt = money(f.flat_amount, "The fixed fee");
    need(amt != null && Number(amt) > 0 && Number(amt) <= 1_000_000, "Enter the fixed fee, above 0 and at most MUR 1,000,000");
    params.amount = Number(amt);
  }
  if (basis === "tiered") {
    const mode = s(f.tier_mode) || "marginal";
    need(mode === "marginal" || mode === "whole", "Choose marginal or whole bands");
    const rows = (f.tiers ?? []).filter((t) => s(t.up_to) || s(t.rate_percent));
    need(rows.length >= 1 && rows.length <= 10, "Give 1 to 10 bands");
    let prev = 0;
    const tiers: Tier[] = rows.map((t, i) => {
      const r = bps(s(t.rate_percent), `the rate of band ${i + 1}`) / 10_000;
      if (i === rows.length - 1) {
        need(!s(t.up_to), "The last band has no upper limit");
        return { up_to: null, rate: r };
      }
      const up = money(t.up_to, `The upper limit of band ${i + 1}`);
      need(up != null && Number(up) > prev, `Band ${i + 1} needs an upper limit above the one before it`);
      prev = Number(up);
      return { up_to: Number(up), rate: r };
    });
    params.mode = mode; params.tiers = tiers;
  }

  const min_fee = basis === "flat" ? null : money(f.min_fee, "The minimum fee");
  const max_fee = basis === "flat" ? null : money(f.max_fee, "The maximum fee");
  need(max_fee == null || Number(max_fee) > 0, "The maximum fee must be above 0");
  need(min_fee == null || max_fee == null || Number(min_fee) <= Number(max_fee), "The minimum fee can't be above the maximum");

  const claw = s(f.clawback_months) ? whole(f.clawback_months, "Clawback months", 0, 36) : 0;
  const mode = (claw === 0 ? "none" : s(f.clawback_mode) || "pro_rata") as ClawbackMode;
  need(claw === 0 || mode === "full" || mode === "pro_rata", "Choose a full or pro-rata clawback");
  return { basis, rate, params, min_fee, max_fee, clawback_months: claw, clawback_mode: mode };
}

// ── describing a model in words ──────────────────────────────────────────────
const n = (v: unknown) => Number(v);
export const pct = (fraction: unknown) => {
  const x = n(fraction);
  return Number.isFinite(x) ? `${(x * 100).toFixed(2).replace(/\.?0+$/, "")}%` : String(fraction);
};
export const mur = (v: unknown, cur = "MUR") =>
  `${cur} ${n(v).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const plural = (k: number, one: string) => `${k} ${one}${k === 1 ? "" : "s"}`;

/** Short tag: "0.45%", "1% annualised", "MUR 350 flat", "Tiered". */
export function shortModel(m: ModelLike): string {
  const p = m.params ?? {};
  switch (m.basis ?? "booked_amount") {
    case "booked_amount": return pct(m.rate);
    case "annualised": return `${pct(m.rate)} of ${plural(n(p.months), "month")} in`;
    case "amount_x_term": return `${pct(m.rate)} a year`;
    case "tiered": return "Banded";
    case "flat": return `${mur(p.amount, m.currency ?? "MUR")} flat`;
    default: return String(m.basis);
  }
}

/** One sentence a reviewer can check: how the fee is worked out, its limits and its clawback. */
export function describeModel(m: ModelLike): string {
  const p = m.params ?? {};
  const cur = m.currency ?? "MUR";
  const parts: string[] = [];
  switch (m.basis ?? "booked_amount") {
    case "booked_amount": parts.push(`${pct(m.rate)} of the booked amount`); break;
    case "annualised": {
      const lump = p.lump_weight == null ? 1 : n(p.lump_weight);
      const first = lump === 1 ? "the first amount" : `${Math.round(lump * 100)}% of the first amount`;
      parts.push(`${pct(m.rate)} of ${first} plus ${plural(n(p.months), "month")} of the monthly amount`);
      break;
    }
    case "amount_x_term": parts.push(`${pct(m.rate)} of the amount per year of term, at most ${plural(n(p.max_years), "year")}`); break;
    case "tiered": {
      const tiers = (Array.isArray(p.tiers) ? p.tiers : []) as Tier[];
      let lo = 0;
      const bands = tiers.map((t) => {
        const label = t.up_to == null ? `above ${mur(lo, cur)}` : `${lo === 0 ? "up to" : `${mur(lo, cur)} to`} ${mur(t.up_to, cur)}`;
        if (t.up_to != null) lo = n(t.up_to);
        return `${pct(t.rate)} ${label}`;
      });
      parts.push(`${p.mode === "whole" ? "Whole amount at its band's rate" : "Each band at its own rate"}: ${bands.join(", ")}`);
      break;
    }
    case "flat": parts.push(`${mur(p.amount, cur)} per booked deal`); break;
    default: parts.push(String(m.basis));
  }
  if (m.min_fee != null && m.min_fee !== "") parts.push(`at least ${mur(m.min_fee, cur)}`);
  if (m.max_fee != null && m.max_fee !== "") parts.push(`at most ${mur(m.max_fee, cur)}`);
  const claw = n(m.clawback_months ?? 0);
  if (claw > 0) {
    parts.push(m.clawback_mode === "full"
      ? `full refund if closed within ${plural(claw, "month")}`
      : `unearned share refunded if closed within ${plural(claw, "month")}`);
  }
  return parts.join(" · ");
}

/** The fields that define a model, in a fixed order: snapshots compare as JSON. */
export function modelOf(r: ModelLike): Record<string, unknown> {
  return {
    basis: r.basis ?? "booked_amount",
    rate: r.rate == null ? null : String(r.rate),
    params: r.params ?? {},
    min_fee: r.min_fee == null ? null : String(r.min_fee),
    max_fee: r.max_fee == null ? null : String(r.max_fee),
    clawback_months: n(r.clawback_months ?? 0),
    clawback_mode: r.clawback_mode ?? "none",
  };
}
