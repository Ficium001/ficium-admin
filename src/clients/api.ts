import { apiFetch } from "../auth/client";

export type AccessRequest = {
  id: string; client_id: string; action: "suspend" | "reinstate"; reason: string;
  status: "pending" | "approved" | "rejected" | "withdrawn" | "expired";
  maker: string; checker: string | null; decision_note: string | null;
  created_at: string; expires_at: string; decided_at: string | null; version: number; mine: boolean;
};
export type ClientRow = { client_id: string; full_name: string | null; email: string | null; kyc_status: string; created_at: string; suspended: boolean; closed: boolean };
export type Client = {
  client_id: string; full_name: string | null; email: string | null; phone_last4: string | null; user_type: string | null;
  country: string | null; kyc_status: string; kyc_submitted_at: string | null; created_at: string;
  last_sign_in_at: string | null; email_confirmed: boolean; suspended: boolean; closed_at: string | null; retain_until: string | null;
  requests: Record<string, number>;
  recent_requests: { id: string; product_type: string; amount: number; status: string; created_at: string }[];
};
type Access = { actor: string; can_request: boolean; can_approve: boolean };

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await apiFetch(path, { ...init, headers: { "Content-Type": "application/json" } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `Request failed (${r.status})`);
  return body as T;
}

export const search = (q: string) =>
  call<Access & { clients: ClientRow[]; pending: AccessRequest[] }>(`/api/clients${q ? `?q=${encodeURIComponent(q)}` : ""}`);
export const openClient = (id: string) =>
  call<Access & { client: Client; requests: AccessRequest[] }>(`/api/clients?id=${encodeURIComponent(id)}`);
export const requestAccess = (client_id: string, action: "suspend" | "reinstate", reason: string) =>
  call<{ request: AccessRequest }>("/api/clients", { method: "POST", body: JSON.stringify({ op: "request", client_id, action, reason }) });
export const decideAccess = (op: "approve" | "reject" | "withdraw", r: AccessRequest, note?: string) =>
  call<{ request: AccessRequest }>("/api/clients", { method: "POST", body: JSON.stringify({ op, id: r.id, version: r.version, note }) });
