/**
 * The portal admin site's ONLY way to portal data: portal-api's
 * /internal/admin/v1 endpoints over HTTPS. No Portal DB connection exists here.
 *
 * Every call carries two independent proofs (portal-api checks both):
 *  - Ficium-Signature: HMAC-SHA256 of "<t>." + body with ADMIN_PORTAL_SIGNING_KEY
 *    (same scheme as the integration contract; 300 s window).
 *  - X-Ficium-Actor: the signed-in staff member's own ficium-auth token (MFA).
 * Commands are idempotent by command_id, so a retry never applies twice.
 */
import { createHmac } from "node:crypto";

type Env = Record<string, string | undefined>;

export class PortalApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export function sign(raw: string, key: string, t: number = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac("sha256", key).update(`${t}.${raw}`).digest("hex")}`;
}

export type PortalCall = (path: "query" | "commands", body: Record<string, unknown>, actorToken: string) => Promise<any>;

export function portalApi(env: Env = process.env, f: typeof fetch = fetch): PortalCall {
  return async (path, body, actorToken) => {
    const base = env.PORTAL_API_URL?.trim(), key = env.ADMIN_PORTAL_SIGNING_KEY?.trim();
    if (!base || !key) throw new PortalApiError(503, "config", "The portal connection is not configured on this deployment");
    const url = new URL(`/internal/admin/v1/${path}`, base);
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
      throw new PortalApiError(503, "config", "PORTAL_API_URL must use https");
    }
    if (!actorToken) throw new PortalApiError(401, "actor_required", "Sign in again");
    const raw = JSON.stringify(body);
    let r: Response;
    try {
      r = await f(url, {
        method: "POST", body: raw, signal: AbortSignal.timeout(8000),
        headers: { "Content-Type": "application/json", "Ficium-Signature": sign(raw, key), "X-Ficium-Actor": actorToken },
      });
    } catch {
      throw new PortalApiError(502, "unreachable", "The portal could not be reached. Nothing was changed");
    }
    const b = (await r.json().catch(() => ({}))) as { data?: unknown; error?: string; detail?: string };
    if (!r.ok) {
      const status = r.status >= 500 ? 502 : r.status;
      throw new PortalApiError(status, b.error ?? "error", b.detail ?? (r.status >= 500 ? "The portal had a problem. Nothing was changed" : `The portal refused this (${b.error ?? r.status})`));
    }
    return b.data;
  };
}

/** The caller's own bearer token, forwarded so portal-api knows who acts. */
export function bearer(h: Record<string, string | string[] | undefined>): string {
  const raw = h["authorization"];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v?.startsWith("Bearer ") ? v.slice(7) : "";
}
