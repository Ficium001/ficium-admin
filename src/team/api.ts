import { apiFetch } from "../auth/client";

export type Login = {
  email: string; username: string; activated: boolean; mfa_enabled: boolean;
  locked: boolean; active: boolean; last_login_at: string | null;
};
export type Admin = {
  id: string; email: string; display_name: string; status: "invited" | "active" | "suspended" | "disabled";
  version: number; created_at: string; created_by: string | null; last_seen_at: string | null;
  roles: string[]; login: Login | null;
};
export type Group = {
  code: string; label: string; description: string; is_system: boolean; locked: boolean; retired: boolean;
  permissions: string[]; members: { id: string; display_name: string; status: string }[];
};
export type Permission = { code: string; description: string };
export type Op = "invite" | "set_roles" | "reactivate" | "reset_login" | "rename" | "group_create" | "group_update" | "group_retire";
export type Change = {
  id: string; op: Op; target_user: string | null; target_key: string; target_label: string;
  args: Record<string, unknown>; before: Record<string, unknown> | null; reason: string;
  status: "pending" | "approved" | "rejected" | "cancelled" | "expired";
  maker_id: string; maker_email: string; maker_name: string; checker_email: string | null;
  decision_note: string | null; decided_at: string | null; created_at: string; expires_at: string;
  result: Record<string, unknown> | null; version: number;
};
export type Team = {
  admins: Admin[]; me: { admin_id: string; permissions: string[] }; email: string;
  groups: Group[]; permissions: Permission[]; changes: Change[]; identity_error?: string;
};

async function call<T>(init?: RequestInit): Promise<T> {
  const r = await apiFetch("/api/team", { ...init, headers: { "Content-Type": "application/json" } });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((b as { error?: string }).error ?? `Request failed (${r.status})`);
  return b as T;
}
const post = <T,>(body: unknown) => call<T>({ method: "POST", body: JSON.stringify(body) });

export const loadTeam = () => call<Team>();
export const ask = (op: Op, args: Record<string, unknown>, reason: string, target?: string) =>
  post<{ change: Change }>({ action: "request", op, target, args, reason });
export const approve = (c: Change, note?: string) =>
  post<{ change: Change; result: { status: string; email_sent: boolean } | null }>({ action: "approve", id: c.id, version: c.version, note });
export const reject = (c: Change, note: string) => post({ action: "reject", id: c.id, version: c.version, note });
export const withdraw = (c: Change) => post({ action: "cancel", id: c.id, version: c.version });
export const resend = (email: string) => post<{ status: string; email_sent: boolean }>({ action: "resend", email });
export const cutOff = (a: Admin, status: "suspended" | "disabled", reason: string) =>
  post({ action: "set_status", id: a.id, version: a.version, status, reason });
