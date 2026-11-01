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
export const ask = (b: Record<string, unknown>) => post("request", b);
export const approve = (r: ChangeRequest, note: string) => post("approve", { id: r.id, version: r.version, note });
export const reject = (r: ChangeRequest, note: string) => post("reject", { id: r.id, version: r.version, note });
export const withdraw = (r: ChangeRequest) => post("withdraw", { id: r.id, version: r.version });

/** "0.0045" -> "0.45%" */
export const pct = (fraction: string | number) => `${(Number(fraction) * 100).toFixed(2).replace(/\.?0+$/, "")}%`;
export const scope = (r: Pick<Rule, "institution_name" | "product_name" | "product_code">) =>
  `${r.institution_name ?? "All banks"} · ${r.product_name ?? r.product_code ?? "All products"}`;
