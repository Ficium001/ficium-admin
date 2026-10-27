import { apiFetch } from "../auth/client";

export type Bank = {
  institution_id: string; name: string; institution_type: string; onboarding_stage: string | null;
  is_approved: boolean; is_compliant: boolean; can_bid: boolean; missing_docs: string[];
  waived_until: string | null; waiver_reason: string | null; waiver_revoked_at: string | null; docs_pending: number;
};
export type Doc = {
  id: string; institution_id: string; institution_name: string; doc_type_code: string; doc_type_label: string;
  is_mandatory: boolean; file_name: string; mime_type: string | null; status: "pending" | "approved" | "rejected" | "expired";
  expiry_date: string | null; rejection_reason: string | null; uploaded_at: string; reviewed_at: string | null;
};
export type WaiverRequest = {
  id: string; institution_id: string; institution_name: string; action: "grant" | "revoke"; waived_until: string | null;
  reason: string; status: "pending" | "approved" | "rejected" | "cancelled"; maker_email: string; checker_email: string | null;
  decision_note: string | null; decided_at: string | null; created_at: string; version: number;
};
export type Overview = { overview: Bank[]; requests: WaiverRequest[] };

async function call<T>(init?: RequestInit, query = ""): Promise<T> {
  const r = await apiFetch(`/api/compliance${query}`, { ...init, headers: { "Content-Type": "application/json" } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `Request failed (${r.status})`);
  return body as T;
}
const post = <T>(action: string, b: Record<string, unknown>) => call<T>({ method: "POST", body: JSON.stringify({ action, ...b }) });

export const loadOverview = () => call<Overview>();
export const loadDocuments = (institutionId: string) =>
  call<{ documents: Doc[] }>(undefined, `?view=documents&institution_id=${encodeURIComponent(institutionId)}`).then((r) => r.documents);
export const downloadLink = (docId: string) => post<{ url: string; file_name: string }>("download", { doc_id: docId });
export const reviewDocument = (d: Doc, decision: "approve" | "reject", reason: string, expiryDate: string) =>
  post("review", { doc_id: d.id, institution_id: d.institution_id, decision, reason, expiry_date: expiryDate || undefined });
export const askWaiver = (b: Bank, waiverAction: "grant" | "revoke", reason: string, waivedUntil?: string) =>
  post("waiver_request", { institution_id: b.institution_id, institution_name: b.name, waiver_action: waiverAction, reason, waived_until: waivedUntil });
export const approveWaiver = (r: WaiverRequest, note: string) => post("waiver_approve", { id: r.id, version: r.version, note });
export const rejectWaiver = (r: WaiverRequest, note: string) => post("waiver_reject", { id: r.id, version: r.version, note });
export const withdrawWaiver = (r: WaiverRequest) => post("waiver_cancel", { id: r.id, version: r.version });
