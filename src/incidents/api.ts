import { apiFetch } from "../auth/client";

export type Kind = "outage" | "degraded" | "security" | "data" | "third_party" | "change" | "other";
export type Status = "investigating" | "mitigated" | "resolved" | "closed";
export type Action = "update" | "severity" | "take" | "mitigated" | "resolved" | "personal_data" | "breach_reported"
  | "breach_not_reported" | "people_told" | "root_cause" | "follow_up" | "follow_up_done" | "close";
export type Event = { at: string; by: string | null; kind: string; text: string };
export type FollowUp = { id: string; text: string; owner: string; due_on: string | null; done_at: string | null; done_by: string | null };
export type Incident = {
  id: string; ref: string; title: string; severity: 1 | 2 | 3; kind: Kind; service_key: string | null; impact: string;
  started_at: string; detected_at: string; mitigated_at: string | null; resolved_at: string | null; closed_at: string | null; status: Status;
  personal_data: boolean; breach_reported_at: string | null; breach_not_reported: string | null; people_told_at: string | null;
  breach_due_at: string | null; root_cause: string | null; owner: string | null; mine: boolean; closed_by: string | null;
  created_by: string | null; version: number; events: Event[]; follow_ups: FollowUp[];
};
export type View = { actor: string; now: string; can_manage: boolean; can_close: boolean; open: Incident[]; closed: Incident[] };
export type NewIncident = { title: string; severity: number; kind: Kind | ""; service_key: string; impact: string;
  started_at: string; detected_at: string; personal_data: boolean };
export type ActInput = { text?: string; at?: string; number?: number; owner?: string; date?: string; follow_up?: string };

// Shares the /api/audit function file (12-function limit on the Vercel plan); see api/_lib/incidents.ts.
async function call(init?: RequestInit): Promise<View> {
  const r = await apiFetch("/api/audit?module=incidents", { ...init, headers: { "Content-Type": "application/json" } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `Request failed (${r.status})`);
  return body as View;
}
const post = (b: Record<string, unknown>) => call({ method: "POST", body: JSON.stringify(b) });

export const load = () => call();
export const openIncident = (n: NewIncident) => post({ op: "open", ...n });
export const act = (i: Incident, action: Action, input: ActInput = {}) => post({ op: "act", id: i.id, version: i.version, action, ...input });
