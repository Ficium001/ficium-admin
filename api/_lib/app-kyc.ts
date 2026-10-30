/**
 * Reads the KYC review queue from the borrower app (its /api/internal?op=admin-kyc),
 * signed with APP_ADMIN_SYNC_SIGNING_KEY like the admin sync. The borrower app
 * owns the cases and documents; this site owns the decisions.
 */
import { sign } from "./portal-api.js";

type Env = Record<string, string | undefined>;
export type KycCase = Record<string, any> & { submission_id: string; client_id: string; status: string };
export type AppKyc = { list: () => Promise<KycCase[]>; getCase: (id: string) => Promise<KycCase | null> };

export class AppKycError extends Error {}

export function appKyc(env: Env = process.env, f: typeof fetch = fetch): AppKyc | null {
  const base = env.APP_ADMIN_SYNC_URL?.trim(), key = env.APP_ADMIN_SYNC_SIGNING_KEY?.trim();
  if (!base || !key) return null;
  const call = async (body: Record<string, unknown>): Promise<{ status: number; data: any }> => {
    const url = new URL(base);
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
      throw new AppKycError("APP_ADMIN_SYNC_URL must use https");
    }
    url.searchParams.set("op", "admin-kyc");
    const raw = JSON.stringify(body);
    const r = await f(url, {
      method: "POST", body: raw, signal: AbortSignal.timeout(10_000),
      headers: { "Content-Type": "application/json", "Ficium-Signature": sign(raw, key) },
    });
    const data = (await r.json().catch(() => ({}))) as any;
    if (!r.ok && r.status !== 404) throw new AppKycError(`borrower app answered ${r.status}${data?.error ? ` (${data.error})` : ""}`);
    return { status: r.status, data };
  };
  return {
    list: async () => ((await call({ action: "list" })).data.cases ?? []) as KycCase[],
    getCase: async (id) => {
      const r = await call({ action: "case", submission_id: id });
      return r.status === 404 ? null : (r.data.case as KycCase);
    },
  };
}
