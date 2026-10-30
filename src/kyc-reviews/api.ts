import { apiFetch } from "../auth/client";

export type Decision = { decision: "verified" | "rejected"; reason: string; reviewer: string; decided_at: string } | null;
export type CaseRow = {
  submission_id: string; client_id: string; submitted_at: string; status: string; risk_score: number | null;
  flags: string[]; document_type: string | null; document_last4: string; full_name: string | null;
  reviewed_at: string | null; review_note: string | null; waiting: boolean; decision: Decision;
};
export type Case = {
  submission_id: string; client_id: string; submitted_at: string; status: string; risk_score: number | null;
  flags: string[]; document_type: string | null; document_number: string | null; provider: string | null;
  mrz_valid: boolean | null; face_match_score: number | null; name_match_score: number | null;
  document_expired: boolean | null; nationality: string | null; residence_status: string | null;
  reviewed_at: string | null; review_note: string | null; is_latest: boolean;
  ai: { suspicious?: boolean; confidence?: string; flags?: string[]; summary?: string } | null;
  client: { full_name: string | null; date_of_birth: string | null; city: string | null; country: string | null; kyc_status: string; since: string };
  previous: { submitted_at: string; status: string; risk_score: number | null }[];
  documents: Record<"id" | "selfie" | "proof_of_address" | "permit", string | null>;
  links_expire_in_s: number;
};

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await apiFetch(path, { ...init, headers: { "Content-Type": "application/json" } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `Request failed (${r.status})`);
  return body as T;
}

export const listCases = () => call<{ actor: string; cases: CaseRow[] }>("/api/kyc-reviews");
export const openCase = (id: string) => call<{ actor: string; case: Case; decision: Decision }>(`/api/kyc-reviews?id=${encodeURIComponent(id)}`);
export const decide = (id: string, decision: "verified" | "rejected", reason: string) =>
  call<{ decision: Decision }>("/api/kyc-reviews", { method: "POST", body: JSON.stringify({ submission_id: id, decision, reason }) });
