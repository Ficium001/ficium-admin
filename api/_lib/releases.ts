/**
 * Mobile app releases (app site only). Served by the /api/kyc function file as
 * /api/kyc?module=releases: the Vercel plan allows 12 function files and this site has 12.
 * On a plan without that limit, move the default export to api/releases.ts unchanged.
 *
 *   GET  ?module=releases -> { actor, can_request, can_approve, policy, requests, usage, usage_error }
 *   POST ?module=releases (every answer is the fresh view, as GET without usage)
 *     { op: "request", platform, latest_version, min_version, store_url, reason }
 *     { op: "approve" | "reject" | "withdraw", id, version, note? }
 *
 * The policy (which app versions may still run) lives in the admin database. Every change is
 * four-eyes and audited there (release.request / release.approve, never your own request, 72 h
 * expiry, a minimum can never exceed the latest released version). An approved change reaches the
 * borrower app through the outbox, right after it commits and again hourly until delivered.
 * `usage` (how many borrowers are on each version) is read from the borrower app over its signed
 * API. If that read fails the policy is still shown, with usage_error saying why.
 */
import { requireStaffIdentity, AuthError, type Staff } from "./access.js";
import { withAdmin, requestMeta, kickDispatch, dbError, type Q, type Meta } from "./admin-db.js";
import { appReleases, type AppReleases, type AppUsage } from "./app-releases.js";
import { MIN_REASON } from "./checks.js";
import { isUuid } from "./offers.js";

type Req = { method?: string; headers: Record<string, string | string[] | undefined>; body?: unknown };
type Res = { status(code: number): Res; json(body: unknown): void; setHeader(k: string, v: string): void };

export type Deps = {
  requireStaff: (h: Req["headers"]) => Promise<Staff>;
  withAdmin: <T>(s: Staff, m: Meta, fn: (q: Q) => Promise<T>) => Promise<T>;
  app: AppReleases | null;
  kick: () => Promise<void>;
};
export const live = (): Deps => ({ requireStaff: (h) => requireStaffIdentity(h), withAdmin, app: appReleases(), kick: kickDispatch });

const VERSION = /^[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}$/;
const view = async (q: Q) => (await q("select api.release_view() as v")).rows[0]?.v ?? null;

async function readUsage(app: AppReleases | null): Promise<{ usage: AppUsage | null; usage_error: string | null }> {
  if (!app) return { usage: null, usage_error: "The borrower app connection is not configured on this deployment" };
  try {
    return { usage: await app.usage(), usage_error: null };
  } catch (e) {
    console.warn("app usage read failed", (e as Error)?.message);
    return { usage: null, usage_error: "The borrower app could not be reached, so usage numbers are missing" };
  }
}

export function makeHandler(deps: Deps) {
  return async function handler(req: Req, res: Res) {
    res.setHeader("Cache-Control", "no-store");
    let staff: Staff;
    try {
      staff = await deps.requireStaff(req.headers);
    } catch (e) {
      const status = e instanceof AuthError ? e.status : 401;
      return res.status(status).json({ error: e instanceof Error ? e.message : "Not signed in", code: e instanceof AuthError ? e.code : undefined });
    }
    const meta = requestMeta(req.headers);
    try {
      if (req.method === "GET") {
        // Permission first (release.view, inside the admin DB); the borrower app is asked only after.
        const v = await deps.withAdmin(staff, meta, view);
        return res.status(200).json({ ...v, ...(await readUsage(deps.app)) });
      }

      if (req.method === "POST") {
        const b = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) as Record<string, unknown> | undefined;
        const op = String(b?.op ?? "");

        if (op === "request") {
          const platform = b?.platform, latest = b?.latest_version, min = b?.min_version;
          const storeUrl = typeof b?.store_url === "string" ? b.store_url.trim() : "";
          const reason = typeof b?.reason === "string" ? b.reason.trim() : "";
          if (platform !== "ios" && platform !== "android") return res.status(400).json({ error: "Choose iOS or Android" });
          if (typeof latest !== "string" || !VERSION.test(latest) || typeof min !== "string" || !VERSION.test(min)) {
            return res.status(400).json({ error: "Versions must look like 1.4.2" });
          }
          if (storeUrl.length > 300) return res.status(400).json({ error: "The store link is too long" });
          if (reason.length < MIN_REASON) return res.status(400).json({ error: `Give a reason of at least ${MIN_REASON} characters` });
          if (reason.length > 2000) return res.status(400).json({ error: "The reason is too long" });
          const v = await deps.withAdmin(staff, meta, async (q) => {
            await q("select api.release_request($1, $2, $3, $4, $5)", [platform, latest, min, storeUrl, reason]);
            return view(q);
          });
          return res.status(200).json(v);   // nothing reaches the apps until a second admin approves
        }

        if (op === "approve" || op === "reject" || op === "withdraw") {
          const id = b?.id, version = Number(b?.version);
          const note = typeof b?.note === "string" ? b.note.trim() : "";
          if (!isUuid(id)) return res.status(400).json({ error: "Unknown request" });
          if (!Number.isInteger(version) || version < 1) return res.status(400).json({ error: "version is required" });
          if (op === "reject" && note.length < MIN_REASON) return res.status(400).json({ error: `Give a reason of at least ${MIN_REASON} characters` });
          if (note.length > 2000) return res.status(400).json({ error: "Note is too long" });
          const v = await deps.withAdmin(staff, meta, async (q) => {
            if (op === "approve") await q("select api.release_approve($1, $2, $3)", [id, version, note || null]);
            if (op === "reject") await q("select api.release_reject($1, $2, $3)", [id, version, note]);
            if (op === "withdraw") await q("select api.release_withdraw($1, $2)", [id, version]);
            return view(q);
          });
          if (op === "approve") await deps.kick();
          return res.status(200).json(v);
        }

        return res.status(400).json({ error: "Unknown action" });
      }

      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "Method not allowed" });
    } catch (e: any) {
      if (e instanceof SyntaxError) return res.status(400).json({ error: "Body must be JSON" });
      const m = dbError(e);
      if (m) return res.status(m.status).json({ error: m.error });
      console.error("release admin error", e?.code, e?.message);
      return res.status(500).json({ error: "The change could not be saved. Nothing was changed" });
    }
  };
}
