import { apiFetch } from "../auth/client";

export type Admin = { id: string; email: string; display_name: string; status: "invited" | "active" | "suspended" | "disabled";
  version: number; created_at: string; roles: string[] };
export const ROLES: { key: string; label: string; does: string }[] = [
  { key: "super_admin", label: "Super admin", does: "Everything, including managing people" },
  { key: "compliance", label: "Compliance", does: "Approve, publish and withdraw offers; change KYC checks; read the audit log" },
  { key: "operations", label: "Operations", does: "Prepare and edit offers; view settings" },
  { key: "read_only", label: "Read only", does: "View only" },
];

async function call<T>(init?: RequestInit): Promise<T> {
  const r = await apiFetch("/api/team", { ...init, headers: { "Content-Type": "application/json" } });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((b as { error?: string }).error ?? `Request failed (${r.status})`);
  return b as T;
}
export const listTeam = () => call<{ admins: Admin[]; me: string }>();
const post = <T,>(body: unknown) => call<T>({ method: "POST", body: JSON.stringify(body) });
export const invite = (x: { email: string; display_name: string; username: string; roles: string[]; reason: string }) =>
  post<{ status: string; email_sent: boolean }>({ action: "invite", ...x });
export const resend = (email: string) => post<{ status: string; email_sent: boolean }>({ action: "resend", email });
export const setRoles = (a: Admin, roles: string[], reason: string) => post({ action: "set_roles", id: a.id, version: a.version, roles, reason });
export const setStatus = (a: Admin, status: string, reason: string) => post({ action: "set_status", id: a.id, version: a.version, status, reason });
