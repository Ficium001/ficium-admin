import type { ChangeRow } from "../shared/ChangeTable";
import { apiFetch } from "../auth/client";

export type Entitlement = { module_code: string; status: string; plan_tier: string; valid_to: string | null };
export type Institution = {
  institution_id: string; name: string; legal_name: string; institution_type: string; country: string;
  onboarding_stage: string; approved: boolean; approved_at: string | null; suspended_at: string | null;
  suspension_reason: string | null; primary_contact_name: string | null; primary_contact_email: string | null;
  created_at: string; active_members: number; entitlements: Entitlement[];
};
export type Module = { module_code: string; name: string; description: string | null; billing_model: string };
export type ChangeRequest = {
  id: string; op: "institution.approve" | "institution.suspend" | "entitlement.set" | "institution.invite_admin"; target_key: string; target_label: string;
  args: Record<string, unknown>; reason: string; status: "pending" | "approved" | "rejected" | "cancelled";
  maker_email: string; checker_email: string | null; decision_note: string | null; decided_at: string | null;
  created_at: string; version: number;
  change?: { rows: ChangeRow[]; described?: boolean } | null;
};
export type View = { institutions: Institution[]; catalog: Module[]; requests: ChangeRequest[] };

async function call<T>(init?: RequestInit): Promise<T> {
  const r = await apiFetch("/api/institutions", { ...init, headers: { "Content-Type": "application/json" } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `Request failed (${r.status})`);
  return body as T;
}
const post = <T>(action: string, b: Record<string, unknown>) => call<T>({ method: "POST", body: JSON.stringify({ action, ...b }) });

export const load = () => call<View>();
export const ask = (b: Record<string, unknown>) => post("request", b);
export type Invite = { email_sent: boolean } | { error: string };
export const approve = (r: ChangeRequest, note: string) => post<{ invite?: Invite }>("approve", { id: r.id, version: r.version, note });
export const reject = (r: ChangeRequest, note: string) => post("reject", { id: r.id, version: r.version, note });
export const withdraw = (r: ChangeRequest) => post("withdraw", { id: r.id, version: r.version });
