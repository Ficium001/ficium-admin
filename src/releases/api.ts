import { apiFetch } from "../auth/client";
import type { VersionUsage } from "./versions";

export type Platform = "ios" | "android";
export type Terms = { latest_version: string; min_version: string; store_url: string };
export type Policy = Terms & { platform: Platform; version: number; updated_at: string; updated_by: string | null };
export type Request = Terms & {
  id: string; platform: Platform; before: Terms; reason: string;
  status: "pending" | "approved" | "rejected" | "withdrawn" | "expired";
  maker: string; checker: string | null; decision_note: string | null; created_at: string; expires_at: string;
  decided_at: string | null; version: number; mine: boolean };
export type Usage = { generated_at: string; policy: { platform: string; version: number }[]; versions: VersionUsage[] };
export type State = { actor: string; can_request: boolean; can_approve: boolean; policy: Policy[]; requests: Request[] };
export type Loaded = State & { usage: Usage | null; usage_error: string | null };

// Shares the /api/kyc function file (12-function limit on the Vercel plan); see api/_lib/releases.ts.
async function call<T>(init?: RequestInit): Promise<T> {
  const r = await apiFetch("/api/kyc?module=releases", { ...init, headers: { "Content-Type": "application/json" } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `Request failed (${r.status})`);
  return body as T;
}
const post = (b: Record<string, unknown>) => call<State>({ method: "POST", body: JSON.stringify(b) });

export const load = () => call<Loaded>();
/** Files a request; nothing changes for app users until a different admin approves. */
export const request = (platform: Platform, terms: Terms, reason: string) => post({ op: "request", platform, ...terms, reason });
export const decide = (op: "approve" | "reject" | "withdraw", r: Request, note?: string) =>
  post({ op, id: r.id, version: r.version, ...(note ? { note } : {}) });
