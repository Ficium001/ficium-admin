import { apiFetch } from "../auth/client";

export type Rule = {
  rule_id: string; institution_id: string | null; institution_name: string | null; product_code: string | null;
  product_name: string | null; rate: string; basis: string; effective_from: string; ended_on: string | null;
  reason: string; created_at: string; in_force: boolean;
};
export type Bank = { institution_id: string; name: string };
export type Product = { product_code: string; name: string };
export type ChangeRequest = {
  id: string; op: "commission.set" | "commission.end"; target_key: string; target_label: string;
  args: Record<string, unknown>; reason: string; status: "pending" | "approved" | "rejected" | "cancelled";
  maker_email: string; checker_email: string | null; decision_note: string | null; decided_at: string | null;
  created_at: string; version: number;
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
  product_code: string | null; product_name: string | null; deal_amount: string; commission_rate: string;
  commission_amt: string; currency: string; status: "pending" | "invoiced" | "paid" | "waived";
  invoice_ref: string | null; invoiced_at: string | null; paid_at: string | null;
};
export type Statement = {
  institution: { id: string; name: string; reg_number: string | null; country: string | null };
  month: string; lines: StatementLine[];
  totals: { deals: number; commission: string; by_status: Record<string, string>; currencies: string[] };
};
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
    if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;   // never let a spreadsheet run a cell as a formula
    return `"${t.replace(/"/g, '""')}"`;
  };
  const head = ["Booked on", "Deal reference", "Product", "Deal amount", "Rate", "Commission", "Currency", "Status", "Invoice ref"];
  const rows = s.lines.map((l) => [l.booked_on, l.pipeline_id, l.product_name ?? l.product_code ?? "", l.deal_amount,
    l.commission_rate, l.commission_amt, l.currency, l.status, l.invoice_ref ?? ""]);
  const total = ["Total", `${s.totals.deals} deals`, "", "", "", s.totals.commission, s.totals.currencies.join("/"), "", ""];
  const title = [`Ficium commission statement: ${s.institution.name}${s.institution.reg_number ? ` (${s.institution.reg_number})` : ""}, ${s.month}`];
  return [title, [], head, ...rows, total].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
export const ask = (b: Record<string, unknown>) => post("request", b);
export const approve = (r: ChangeRequest, note: string) => post("approve", { id: r.id, version: r.version, note });
export const reject = (r: ChangeRequest, note: string) => post("reject", { id: r.id, version: r.version, note });
export const withdraw = (r: ChangeRequest) => post("withdraw", { id: r.id, version: r.version });

/** "0.0045" -> "0.45%" */
export const pct = (fraction: string | number) => `${(Number(fraction) * 100).toFixed(2).replace(/\.?0+$/, "")}%`;
export const scope = (r: Pick<Rule, "institution_name" | "product_name" | "product_code">) =>
  `${r.institution_name ?? "All banks"} · ${r.product_name ?? r.product_code ?? "All products"}`;
