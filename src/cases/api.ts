import { apiFetch } from "../auth/client";

export type Kind = "complaint" | "problem" | "question" | "feedback";
export type Category = "kyc" | "request" | "bids" | "deal" | "account" | "app" | "fees" | "privacy" | "conduct" | "other";
export type Channel = "email" | "app" | "phone" | "letter" | "in_person" | "social" | "other";
export type Upheld = "upheld" | "partly" | "not_upheld";
export type Action = "note" | "acknowledge" | "take" | "resolve" | "withdraw" | "reopen" | "referred";
export type Event = { at: string; by: string | null; kind: string; text: string };
export type Case = {
  id: string; ref: string; kind: Kind; category: Category; subject: string; detail: string; requester: string; contact: string;
  client_id: string | null; channel: Channel; received_at: string; ack_due_at: string; resolve_due_on: string; days_left: number | null;
  ack_overdue: boolean; acknowledged_at: string | null; status: "open" | "acknowledged" | "resolved" | "withdrawn";
  outcome: string | null; upheld: Upheld | null; redress: string | null; referred_to: string | null; referred_at: string | null;
  resolved_at: string | null; resolved_by: string | null; on_time: boolean | null; owner: string | null; mine: boolean;
  reopened: number; version: number; events: Event[];
};
export type Target = { kind: Kind; ack_hours: number; resolve_days: number; version: number; updated_by: string | null; updated_at: string };
export type Register = { received: number; resolved: number; on_time: number; upheld: number; partly: number; not_upheld: number; referred: number;
  by_category: Partial<Record<Category, number>> };
export type View = { actor: string; now: string; today: string; can_manage: boolean; can_resolve_complaint: boolean;
  open: Case[]; closed: Case[]; targets: Target[]; complaints_12m: Register };
export type NewCase = { kind: Kind | ""; category: Category | ""; subject: string; detail: string; requester: string; contact: string;
  client_id: string; channel: Channel | ""; received_at: string };

// Shares the /api/clients function file (12-function limit on the Vercel plan); see api/_lib/support-cases.ts.
async function call(init?: RequestInit): Promise<View> {
  const r = await apiFetch("/api/clients?module=cases", { ...init, headers: { "Content-Type": "application/json" } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `Request failed (${r.status})`);
  return body as View;
}
const post = (b: Record<string, unknown>) => call({ method: "POST", body: JSON.stringify(b) });

export const load = () => call();
export const openCase = (n: NewCase) => post({ op: "open", ...n });
export const act = (c: Case, action: Action, input: { text?: string; upheld?: string; redress?: string; at?: string } = {}) =>
  post({ op: "act", id: c.id, version: c.version, action, ...input });
export const saveTarget = (t: Target, ack_hours: number, resolve_days: number, reason: string) =>
  post({ op: "target", kind: t.kind, version: t.version, ack_hours, resolve_days, reason });
