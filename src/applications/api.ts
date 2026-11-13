import { apiFetch } from "../auth/client";

export type Status = "submitted" | "in_review" | "info_requested" | "approved" | "rejected" | "provisioned";
export type Application = {
  request_id: string; reference: string; institution_name: string; institution_type: string; country: string;
  reg_number: string | null; regulator: string | null; website: string | null;
  contact_name: string; contact_email: string; contact_phone: string | null; contact_role: string | null;
  message: string | null; status: Status; verified_at: string | null; reviewed_at: string | null;
  review_note: string | null; provisioned_at: string | null; contract_reference: string | null;
  institution_id: string | null; created_at: string;
};
export type ProvisionRequest = {
  id: string; op: "institution.provision"; target_key: string; target_label: string;
  args: { request_id: string; contract_reference: string; deployment_model: string };
  reason: string; status: "pending" | "approved" | "rejected" | "cancelled";
  maker_email: string; checker_email: string | null; decision_note: string | null; decided_at: string | null;
  created_at: string; version: number;
};
export type View = { applications: Application[]; requests: ProvisionRequest[] };
export type Invite = { email_sent: boolean } | { error: string };

async function call<T>(init?: RequestInit, query = ""): Promise<T> {
  const r = await apiFetch(`/api/applications${query}`, { ...init, headers: { "Content-Type": "application/json" } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `Request failed (${r.status})`);
  return body as T;
}
const post = <T>(action: string, b: Record<string, unknown>) => call<T>({ method: "POST", body: JSON.stringify({ action, ...b }) });

export const load = (status: "open" | "closed") => call<View>(undefined, `?status=${status}`);
export const review = (a: Application, status: Status, note: string) =>
  post("review", { request_id: a.request_id, reference: a.reference, status, note });
export const askProvision = (a: Application, contract_reference: string, deployment_model: string, reason: string) =>
  post("provision_request", { request_id: a.request_id, reference: a.reference, institution_name: a.institution_name,
    contract_reference, deployment_model, reason });
export const approveProvision = (r: ProvisionRequest, note: string) =>
  post<{ invite: Invite }>("provision_approve", { id: r.id, version: r.version, note });
export const rejectProvision = (r: ProvisionRequest, note: string) => post("provision_reject", { id: r.id, version: r.version, note });
export const withdrawProvision = (r: ProvisionRequest) => post("provision_withdraw", { id: r.id, version: r.version });
export const resendInvite = (email: string) => post<{ invite: Invite }>("resend_invite", { email });
