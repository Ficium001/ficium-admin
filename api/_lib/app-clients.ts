/**
 * Borrower lookup from the borrower app (its /api/internal?op=admin-clients), signed with
 * APP_ADMIN_SYNC_SIGNING_KEY like the admin sync and KYC reads. The borrower app owns the data;
 * this site owns who looked, who asked and who approved. Never a database connection.
 */
import { sign } from "./portal-api.js";
import { appEndpoint } from "./app-endpoint.js";

type Env = Record<string, string | undefined>;
export type ClientRow = { client_id: string; full_name: string | null; email: string | null; kyc_status: string; created_at: string; suspended: boolean; closed: boolean };
export type ClientSummary = Record<string, unknown> & { client_id: string; suspended: boolean };
export type AppClients = { search: (q: string) => Promise<ClientRow[]>; get: (id: string) => Promise<ClientSummary | null> };

export class AppClientsError extends Error {}

export function appClients(env: Env = process.env, f: typeof fetch = fetch): AppClients | null {
  const base = env.APP_ADMIN_SYNC_URL?.trim(), key = env.APP_ADMIN_SYNC_SIGNING_KEY?.trim();
  if (!base || !key) return null;
  const call = async (body: Record<string, unknown>): Promise<{ status: number; data: any }> => {
    let url: URL;
    try { url = appEndpoint("admin-clients", env); }
    catch (e) { throw new AppClientsError((e as Error).message); }
    const raw = JSON.stringify(body);
    const r = await f(url, {
      method: "POST", body: raw, signal: AbortSignal.timeout(10_000),
      headers: { "Content-Type": "application/json", "Ficium-Signature": sign(raw, key) },
    });
    const data = (await r.json().catch(() => ({}))) as any;
    if (!r.ok && r.status !== 404) throw new AppClientsError(`borrower app answered ${r.status}${data?.error ? ` (${data.error})` : ""}`);
    return { status: r.status, data };
  };
  return {
    search: async (q) => ((await call({ action: "search", q })).data.clients ?? []) as ClientRow[],
    get: async (id) => {
      const r = await call({ action: "client", client_id: id });
      return r.status === 404 ? null : (r.data.client as ClientSummary);
    },
  };
}
