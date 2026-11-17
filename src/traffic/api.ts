import { apiFetch } from "../auth/client";

export type State = "enabled" | "paused";
export type Stats = {
  key: string; total: number; ok: number; client_errors: number; server_errors: number; network_errors: number; blocked: number;
  p50_ms: number | null; p95_ms: number | null; last_ok_at: string | null; last_error_at: string | null; last_error: string | null;
  applied_state: State | null; applied_version: number | null; hourly_total: number[]; hourly_errors: number[];
};
export type Channel = {
  key: string; direction: "inbound" | "outbound"; label: string; peer: string; description: string;
  pausable: boolean; lock_reason: string | null; state: State; state_reason: string | null;
  version: number; updated_at: string; updated_by: string | null;
  stats: Stats | null; applied: { state: State; version: number } | null;
};
export type ResumeRequest = {
  id: string; channel_key: string; before: Record<string, unknown>; reason: string;
  status: "pending" | "approved" | "rejected" | "withdrawn" | "expired";
  maker: string; checker: string | null; decision_note: string | null; created_at: string; expires_at: string;
  decided_at: string | null; version: number; mine: boolean;
};
export type View = { actor: string; can_control: boolean; can_approve: boolean; channels: Channel[]; requests: ResumeRequest[] };
export type Loaded = View & { generated_at: string | null; window_hours: number; telemetry_error: string | null };

// Shares the /api/audit function file (12-function limit on the Vercel plan); see api/_lib/api-traffic.ts.
async function call<T>(init?: RequestInit): Promise<T> {
  const r = await apiFetch("/api/audit?module=traffic", { ...init, headers: { "Content-Type": "application/json" } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `Request failed (${r.status})`);
  return body as T;
}
const post = (b: Record<string, unknown>) => call<View>({ method: "POST", body: JSON.stringify(b) });

export const load = () => call<Loaded>();
/** One admin, immediate: stopping traffic is the safe direction. */
export const pause = (c: Channel, reason: string) => post({ op: "pause", key: c.key, version: c.version, reason });
/** Resuming is four-eyes: this only asks. */
export const askResume = (c: Channel, reason: string) => post({ op: "resume_request", key: c.key, reason });
export const decide = (op: "approve" | "reject" | "withdraw", r: ResumeRequest, note?: string) =>
  post({ op, id: r.id, version: r.version, ...(note ? { note } : {}) });
