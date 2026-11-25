import type { ChangeRow } from "../shared/ChangeTable";
import { apiFetch } from "../auth/client";
import { pct, mur, type Basis, type FeeForm, type ModelLike } from "../../api/_lib/fee-model";

export type Rule = ModelLike & {
  rule_id: string; institution_id: string | null; institution_name: string | null; product_code: string | null;
  product_name: string | null; rate: string | null; basis: Basis; params: Record<string, unknown>;
  min_fee: string | null; max_fee: string | null; currency: string; clawback_months: number;
  clawback_mode: "none" | "full" | "pro_rata"; effective_from: string; ended_on: string | null;
  reason: string; created_at: string; in_force: boolean;
};
export type Bank = { institution_id: string; name: string };
export type Product = { product_code: string; name: string };
export type ChangeRequest = {
  id: string; op: "commission.set" | "commission.end"; target_key: string; target_label: string;
  args: Record<string, unknown>; reason: string; status: "pending" | "approved" | "rejected" | "cancelled";
  maker_email: string; checker_email: string | null; decision_note: string | null; decided_at: string | null;
  created_at: string; version: number;
  change?: { rows: ChangeRow[]; described?: boolean } | null;
};
export type View = { rules: Rule[]; institutions: Bank[]; products: Product[]; requests: ChangeRequest[] };

async function call<T>(init?: RequestInit): Promise<T> {
  const r = await apiFetch("/api/commission", { ...init, headers: { "Content-Type": "application/json" } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `Request failed (${r.status})`);
  return body as T;
}
const post = <T>(action: string, b: Record<string, unknown>) => call<T>({ method: "POST", body: JSON.stringify({ action, ...b }) });

export const load = () => call<View>();

export type StatementLine = {
  commission_id: string; pipeline_id: string; request_id: string | null; booked_on: string;
  product_code: string | null; product_name: string | null; deal_amount: string; commission_rate: string | null;
  commission_amt: string; currency: string; status: "pending" | "invoiced" | "paid" | "waived";
  basis?: Basis | null; fee_base?: string | null; calc?: Calc | null; clawback_until?: string | null;
  invoice_ref: string | null; invoiced_at: string | null; paid_at: string | null;
};
export type Adjustment = {
  adjustment_id: string; commission_id: string; pipeline_id: string; kind: "clawback"; amount: string;
  currency: string; effective_on: string; reason: string; product_code: string | null; product_name: string | null;
  calc: { fee?: number; share?: number; months_run?: number; window_months?: number; mode?: string } | null;
};
export type Statement = {
  institution: { id: string; name: string; reg_number: string | null; country: string | null };
  month: string; lines: StatementLine[]; adjustments?: Adjustment[];
  totals: { deals: number; commission: string; by_status: Record<string, string>; currencies: string[];
            adjustments?: string; net?: string };
};
/** The working the Portal DB returns for a fee (billing.compute_fee). */
export type Calc = {
  basis: Basis; rate?: number; params?: Record<string, unknown>; base?: number; years?: number; raw_fee: number; fee: number;
  floor_applied: boolean; cap_applied: boolean; min_fee?: number; max_fee?: number;
  inputs: { amount: number; monthly_amount?: number; term_months?: number };
  tiers?: { from: number; up_to: number | null; rate: number; on: number; fee: number }[];
};
export async function preview(model: FeeForm, inputs: { amount: string; monthly_amount?: string; term_months?: string }) {
  return post<{ calc: Calc }>("preview", { ...model, inputs });
}
export async function statement(institutionId: string, month: string): Promise<Statement> {
  const qs = new URLSearchParams({ statement: "1", institution_id: institutionId, month });
  const r = await apiFetch(`/api/commission?${qs}`, { headers: { "Content-Type": "application/json" } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `Request failed (${r.status})`);
  return body as Statement;
}

/** CSV with a header, one row per booked deal and a total row. Values are quoted; formulas are neutralised. */
export function statementCsv(s: Statement): string {
  const cell = (v: unknown) => {
    let t = v == null ? "" : String(v);
    // never let a spreadsheet run a cell as a formula; a plain number (a credit is negative) stays a number
    if (/^[=+\-@\t\r]/.test(t) && !/^-?\d+(\.\d+)?$/.test(t)) t = `'${t}`;
    return `"${t.replace(/"/g, '""')}"`;
  };
  const head = ["Date", "Deal reference", "Product", "Type", "Deal amount", "Fee base", "Rate", "Commission", "Currency", "Status", "Invoice ref"];
  const rows = s.lines.map((l) => [l.booked_on, l.pipeline_id, l.product_name ?? l.product_code ?? "", `Booked (${l.basis ?? "booked_amount"})`,
    l.deal_amount, l.fee_base ?? "", l.commission_rate ?? "", l.commission_amt, l.currency, l.status, l.invoice_ref ?? ""]);
  const credits = (s.adjustments ?? []).map((a) => [a.effective_on, a.pipeline_id, a.product_name ?? a.product_code ?? "",
    `Clawback: ${a.reason}`, "", "", "", a.amount, a.currency, "credit", ""]);
  const cur = s.totals.currencies.join("/");
  const total = ["Total", `${s.totals.deals} deals`, "", "", "", "", "", s.totals.commission, cur, "", ""];
  const extra = credits.length
    ? [["Clawbacks", `${credits.length}`, "", "", "", "", "", s.totals.adjustments ?? "0", cur, "", ""],
       ["Net", "", "", "", "", "", "", s.totals.net ?? s.totals.commission, cur, "", ""]]
    : [];
  const title = [`Ficium commission statement: ${s.institution.name}${s.institution.reg_number ? ` (${s.institution.reg_number})` : ""}, ${s.month}`];
  return [title, [], head, ...rows, ...credits, total, ...extra].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
export const ask = (b: Record<string, unknown>) => post("request", b);
export const approve = (r: ChangeRequest, note: string) => post("approve", { id: r.id, version: r.version, note });
export const reject = (r: ChangeRequest, note: string) => post("reject", { id: r.id, version: r.version, note });
export const withdraw = (r: ChangeRequest) => post("withdraw", { id: r.id, version: r.version });

export { pct };

/** "Fee MUR 250: 1% of MUR 7,000 = MUR 70, raised to the minimum MUR 250." */
export function working(c: Calc): string {
  const steps: string[] = [];
  if (c.basis === "flat") steps.push("fixed fee");
  else if (c.basis === "tiered") steps.push((c.tiers ?? []).map((t) => `${pct(t.rate)} of ${mur(t.on)} = ${mur(t.fee)}`).join(" + "));
  else {
    const base = c.basis === "annualised"
      ? `${mur(c.base ?? 0)} (first amount + ${mur(c.inputs.monthly_amount ?? 0)} a month)`
      : c.basis === "amount_x_term" ? `${mur(c.inputs.amount)} × ${c.years} years` : mur(c.base ?? c.inputs.amount);
    steps.push(`${pct(c.rate)} of ${base} = ${mur(c.raw_fee)}`);
  }
  if (c.floor_applied) steps.push(`raised to the minimum ${mur(c.min_fee)}`);
  if (c.cap_applied) steps.push(`limited to the maximum ${mur(c.max_fee)}`);
  return `Fee ${mur(c.fee)}: ${steps.join(", ")}.`;
}


export const scope = (r: Pick<Rule, "institution_name" | "product_name" | "product_code">) =>
  `${r.institution_name ?? "All banks"} · ${r.product_name ?? r.product_code ?? "All products"}`;
