import { apiFetch } from "../auth/client";

export type Status = "up" | "slow" | "attention" | "down" | "not_configured" | "unknown";
export type Service = { key: string; label: string; what: string; runs_on: string; proves: string; blind_to: string };
export type Result = { key: string; status: Status; ms: number | null; detail: string; checked_at: string; link?: string };
export type Loaded = { actor: string; services: Service[]; results: Result[]; checked_at: string };

// Shares the /api/audit function file (12-function limit on the Vercel plan); see api/_lib/services.ts.
async function call(init?: RequestInit): Promise<Loaded> {
  const r = await apiFetch("/api/audit?module=services", { ...init, headers: { "Content-Type": "application/json" } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `Request failed (${r.status})`);
  return body as Loaded;
}

/** Tests every service this site depends on. */
export const load = () => call();
/** Tests one service again, by key. The server decides what that test is. */
export const test = (key: string) => call({ method: "POST", body: JSON.stringify({ op: "probe", key }) });
