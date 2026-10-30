/**
 * GET  /api/kyc -> { actor, can, settings, versions, requests, history }
 * POST /api/kyc (every answer is the fresh view, as GET)
 *   { key, value: true,  version, reason }   turn a check ON: immediate
 *   { key, value: false, version, reason }   ask to turn it OFF (four-eyes)
 *   { action: "approve",  id, version, note? }  a DIFFERENT admin approves; it applies now
 *   { action: "reject",   id, version, note }
 *   { action: "withdraw", id, version }         only the person who asked
 * The admin DB enforces all of it (kyc.change / kyc.approve, never your own
 * request, 72 h expiry, stale if the check changed). A change is pushed to the
 * App DB right after it commits (and retried hourly).
 */
import { requireStaffIdentity, AuthError, type Staff } from "./_lib/access.js";
import { withAdmin, requestMeta, kickDispatch, dbError, type Q, type Meta } from "./_lib/admin-db.js";
import { CHECKS, MIN_REASON } from "./_lib/checks.js";
import { isUuid } from "./_lib/offers.js";
import { onlyOn } from "./_lib/site.js";

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
        const version = Number(b?.version);
        if (!Number.isInteger(version) || version < 1) return res.status(400).json({ error: "version is required" });

        if (b?.action !== undefined) {
          const action = String(b.action), id = b.id;
          const note = typeof b.note === "string" ? b.note.trim() : "";
          if (!["approve", "reject", "withdraw"].includes(action)) return res.status(400).json({ error: "Unknown action" });
          if (!isUuid(id)) return res.status(400).json({ error: "Unknown request" });
          if (action === "reject" && note.length < MIN_REASON) return res.status(400).json({ error: `Give a reason of at least ${MIN_REASON} characters` });
          if (note.length > 2000) return res.status(400).json({ error: "Note is too long" });
          const v = await deps.withAdmin(staff, meta, async (q) => {
            if (action === "approve") await q("select api.kyc_disable_approve($1, $2, $3)", [id, version, note || null]);
            if (action === "reject") await q("select api.kyc_disable_reject($1, $2, $3)", [id, version, note]);
            if (action === "withdraw") await q("select api.kyc_disable_withdraw($1, $2)", [id, version]);
            return view(q);
          });
          if (action === "approve") await deps.kick();
          return res.status(200).json(v);
        }

        const key = b?.key, value = b?.value;
        const reason = typeof b?.reason === "string" ? b.reason.trim() : "";
        if (typeof key !== "string" || !KEYS.has(key)) return res.status(400).json({ error: "Unknown check" });
        if (typeof value !== "boolean") return res.status(400).json({ error: "value must be true or false" });
        if (reason.length < MIN_REASON) return res.status(400).json({ error: `Give a reason of at least ${MIN_REASON} characters` });

        const v = await deps.withAdmin(staff, meta, async (q) => {
          if (value) await q("select api.kyc_set_check($1, true, $2, $3)", [key, version, reason]);
          else await q("select api.kyc_disable_request($1, $2, $3)", [key, version, reason]);
          return view(q);
        });
        if (value) await deps.kick();  // a request changes nothing borrowers see until approved
        return res.status(200).json(v);
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

export default onlyOn("app", makeHandler(live));
