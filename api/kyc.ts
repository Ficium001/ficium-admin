/**
 * GET  /api/kyc                               -> { actor, settings, versions, history }
 * POST /api/kyc { key, value, version, reason } -> { settings, versions }
 * The admin DB is the master; a change is pushed to the App DB right after it
 * commits (and retried hourly). The actor is the verified Access identity.
 */
import { requireStaffIdentity, AuthError, type Staff } from "./_lib/access.js";
import { withAdmin, requestMeta, kickDispatch, dbError, type Q, type Meta } from "./_lib/admin-db.js";
import { CHECKS, MIN_REASON } from "./_lib/checks.js";

type Req = { method?: string; headers: Record<string, string | string[] | undefined>; body?: unknown };
type Res = { status(code: number): Res; json(body: unknown): void; setHeader(k: string, v: string): void };

export type Deps = {
  requireStaff: (h: Req["headers"]) => Promise<Staff>;
  withAdmin: <T>(s: Staff, m: Meta, fn: (q: Q) => Promise<T>) => Promise<T>;
  kick: () => Promise<void>;
};
const live: Deps = { requireStaff: (h) => requireStaffIdentity(h), withAdmin, kick: kickDispatch };
const KEYS = new Set<string>(CHECKS.map((c) => c.key));
const view = async (q: Q) => (await q("select api.kyc_view() as v")).rows[0]?.v ?? null;

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
      if (req.method === "GET") return res.status(200).json(await deps.withAdmin(staff, meta, view));

      if (req.method === "POST") {
        const b = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) as Record<string, unknown> | undefined;
        const key = b?.key, value = b?.value, version = Number(b?.version);
        const reason = typeof b?.reason === "string" ? b.reason.trim() : "";
        if (typeof key !== "string" || !KEYS.has(key)) return res.status(400).json({ error: "Unknown check" });
        if (typeof value !== "boolean") return res.status(400).json({ error: "value must be true or false" });
        if (!Number.isInteger(version) || version < 1) return res.status(400).json({ error: "version is required" });
        if (reason.length < MIN_REASON) return res.status(400).json({ error: `Give a reason of at least ${MIN_REASON} characters` });

        const v = await deps.withAdmin(staff, meta, async (q) => {
          await q("select api.kyc_set_check($1, $2, $3, $4)", [key, value, version, reason]);
          return view(q);
        });
        await deps.kick();
        return res.status(200).json({ settings: v?.settings ?? null, versions: v?.versions ?? {} });
      }

      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "Method not allowed" });
    } catch (e: any) {
      if (e instanceof SyntaxError) return res.status(400).json({ error: "Body must be JSON" });
      const m = dbError(e);
      if (m) return res.status(m.status).json({ error: m.error });
      console.error("kyc admin error", e?.code, e?.message);
      return res.status(500).json({ error: "The change could not be saved. Nothing was changed" });
    }
  };
}

export default makeHandler(live);
