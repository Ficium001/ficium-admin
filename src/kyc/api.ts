import { apiFetch } from "../auth/client";

export type Settings = Record<string, boolean | number | string> & { updated_at?: string };
export type Change = { id: number; changed_at: string; check_key: string; old_value: boolean; new_value: boolean;
  actor: string; reason: string; requested_by: string | null };
export type Request = { id: string; check_key: string; reason: string; status: "pending" | "approved" | "rejected" | "withdrawn" | "expired";
  maker: string; checker: string | null; decision_note: string | null; created_at: string; expires_at: string;
  decided_at: string | null; version: number; mine: boolean };
export type State = { actor: string; can: { change: boolean; approve: boolean }; settings: Settings | null;
  versions: Record<string, number>; requests: Request[]; history: Change[] };

async function call(init?: RequestInit): Promise<State> {
  const r = await apiFetch("/api/kyc", { ...init, headers: { "Content-Type": "application/json" } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `Request failed (${r.status})`);
  return body as State;
}
const post = (b: Record<string, unknown>) => call({ method: "POST", body: JSON.stringify(b) });

export const load = () => call();
/** ON applies at once; OFF files a request a second admin must approve. */
export const change = (key: string, value: boolean, reason: string, version: number) => post({ key, value, version, reason });
export const decide = (action: "approve" | "reject" | "withdraw", r: Request, note?: string) =>
  post({ action, id: r.id, version: r.version, ...(note ? { note } : {}) });
