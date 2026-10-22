import type { OfferInput } from "../../api/_lib/offers";

export type Status = "draft" | "approved" | "published" | "withdrawn";
export type Offer = OfferInput & {
  id: string; status: Status; version: number; created_by: string; created_at: string;
  updated_by: string; updated_at: string; approved_by: string | null; approved_at: string | null;
  self_approved: boolean | null; published_by: string | null; published_at: string | null;
  withdrawn_by: string | null; withdrawn_at: string | null; is_live: boolean; live_until: string | null;
};
export type Change = { id: number; changed_at: string; actor: string; action: string; reason: string | null };

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { credentials: "same-origin", ...init });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `Request failed (${r.status})`);
  return body as T;
}
const post = <T,>(payload: unknown) =>
  call<T>("/api/offers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });

export const listOffers = () => call<{ actor: string; offers: Offer[] }>("/api/offers");
export const offerHistory = (id: string) => call<{ history: Change[] }>(`/api/offers?id=${encodeURIComponent(id)}`);
export const saveOffer = (offer: OfferInput, id?: string, version?: number) =>
  post<{ offer: Offer }>({ action: "save", id: id ?? null, version: version ?? null, offer });
export const approveOffer = (id: string, reason: string) => post<{ offer: Offer }>({ action: "approve", id, reason });
export const publishOffer = (id: string) => post<{ offer: Offer }>({ action: "publish", id });
export const withdrawOffer = (id: string, reason: string) => post<{ offer: Offer }>({ action: "withdraw", id, reason });
export const reverifyOffer = (id: string, verified_at: string, reason: string) =>
  post<{ offer: Offer }>({ action: "reverify", id, verified_at, reason });
export const uploadImage = (file: File) =>
  call<{ url: string }>("/api/offer-image", { method: "POST", headers: { "Content-Type": file.type }, body: file });
