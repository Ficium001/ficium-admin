import { apiFetch } from "../auth/client";

export type Kind = "access" | "correction" | "erasure" | "restriction" | "objection" | "automated_decision" | "withdraw_consent";
export type Channel = "email" | "app" | "letter" | "phone" | "in_person" | "other";
export type Status = "received" | "in_progress" | "completed" | "refused" | "withdrawn";
export type Action = "note" | "verify_identity" | "start" | "take" | "complete" | "refuse" | "withdraw";
export type Event = { at: string; by: string | null; kind: string; text: string };
export type Request = {
  id: string; ref: string; kind: Kind; requester: string; contact: string; client_id: string | null; channel: Channel;
  summary: string; received_on: string; due_on: string; days_left: number | null; status: Status;
  identity_verified_on: string | null; identity_method: string | null; owner: string | null; mine: boolean;
  outcome: string | null; closed_on: string | null; closed_by: string | null; version: number; created_by: string | null; events: Event[];
};
export type Retention = { key: string; data: string; where_kept: string; kept_for: string; basis: string; how_deleted: string;
  decided: boolean; enforced: boolean; version: number; updated_at: string; updated_by: string | null };
export type View = { actor: string; today: string; can_manage: boolean; can_close: boolean; open: Request[]; closed: Request[]; retention: Retention[] };
export type NewRequest = { kind: Kind | ""; requester: string; contact: string; client_id: string; channel: Channel | ""; summary: string; received_on: string };

// Shares the /api/clients function file (12-function limit on the Vercel plan); see api/_lib/data-protection.ts.
async function call(init?: RequestInit): Promise<View> {
  const r = await apiFetch("/api/clients?module=dp", { ...init, headers: { "Content-Type": "application/json" } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `Request failed (${r.status})`);
  return body as View;
}
const post = (b: Record<string, unknown>) => call({ method: "POST", body: JSON.stringify(b) });

export const load = () => call();
export const logRequest = (n: NewRequest) => post({ op: "log", ...n });
export const act = (r: Request, action: Action, text = "", date = "") => post({ op: "act", id: r.id, version: r.version, action, text, date });
export const saveRetention = (t: Retention, reason: string) =>
  post({ op: "retention", key: t.key, version: t.version, data: t.data, where_kept: t.where_kept, kept_for: t.kept_for,
    basis: t.basis, how_deleted: t.how_deleted, decided: t.decided, enforced: t.enforced, reason });
