import { apiFetch } from "../auth/client";

export type Kind = "api_key" | "token" | "signing_key" | "password" | "certificate" | "account";
export type State = "expired" | "due_soon" | "no_date" | "ok" | "retired";
export type Entry = {
  key: string; label: string; kind: Kind; purpose: string; env_names: string; stored_in: string; used_by: string; owner: string;
  expires_on: string | null; rotated_on: string | null; rotate_every_days: number | null;
  due_on: string | null; days_left: number | null; state: State; note: string; retired_at: string | null;
  version: number; updated_at: string; updated_by: string | null;
};
export type View = { actor: string; can_manage: boolean; today: string; items: Entry[]; retired: Entry[] };
export type Draft = {
  key: string; version: number | null; label: string; kind: Kind | ""; purpose: string; env_names: string; stored_in: string;
  used_by: string; owner: string; expires_on: string; rotated_on: string; rotate_every_days: string; note: string; reason: string;
};

// Shares the /api/audit function file (12-function limit on the Vercel plan); see api/_lib/credentials.ts.
async function call(init?: RequestInit): Promise<View> {
  const r = await apiFetch("/api/audit?module=credentials", { ...init, headers: { "Content-Type": "application/json" } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `Request failed (${r.status})`);
  return body as View;
}

export const load = () => call();
/** Adds (version null) or updates an entry. Names, places and dates only: never a key's value. */
export const save = (d: Draft) => call({ method: "POST", body: JSON.stringify({ op: "save", ...d }) });
export const retire = (e: Entry, reason: string) =>
  call({ method: "POST", body: JSON.stringify({ op: "retire", key: e.key, version: e.version, reason }) });
