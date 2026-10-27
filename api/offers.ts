/**
 * GET  /api/offers                 -> { actor, offers }
 * GET  /api/offers?id=<uuid>       -> { history }   (from the audit log)
 * POST /api/offers { action, ... } -> { offer }
 *   save (id?, version?, offer) | approve (id, version, reason) | publish (id, version)
 *   | withdraw (id, version, reason) | reverify (id, version, verified_at, reason)
 * Every write is an api.offer_* call in the admin DB (maker-checker, versioning
 * and audit enforced there). Listing changes reach the App DB right after commit.
 */
import { requireStaffIdentity, AuthError, type Staff } from "./_lib/access.js";
import { withAdmin, requestMeta, kickDispatch, dbError, type Q, type Meta } from "./_lib/admin-db.js";
import { parseOffer, isUuid, MIN_REASON } from "./_lib/offers.js";
import { onlyOn } from "./_lib/site.js";

type Req = { method?: string; headers: Record<string, string | string[] | undefined>; body?: unknown; query?: Record<string, string | string[] | undefined> };
type Res = { status(code: number): Res; json(body: unknown): void; setHeader(k: string, v: string): void };

export type Deps = {
  requireStaff: (h: Req["headers"]) => Promise<Staff>;
  withAdmin: <T>(s: Staff, m: Meta, fn: (q: Q) => Promise<T>) => Promise<T>;
  kick: () => Promise<void>;
};
const live: Deps = { requireStaff: (h) => requireStaffIdentity(h), withAdmin, kick: kickDispatch };

const offerView = async (q: Q, id: string) => (await q("select api.offer_view($1) as o", [id])).rows[0]?.o ?? null;

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
        const id = req.query?.id;
        if (id !== undefined) {
          if (!isUuid(id)) return res.status(400).json({ error: "Unknown offer" });
          const history = await deps.withAdmin(staff, meta, async (q) =>
            (await q("select api.offer_history($1) as h", [id])).rows[0]?.h ?? []);
          return res.status(200).json({ history });
        }
        const v = await deps.withAdmin(staff, meta, async (q) => (await q("select api.offer_view_list() as v")).rows[0]?.v);
        return res.status(200).json({ actor: v?.actor ?? staff.email, offers: v?.offers ?? [] });
      }

      if (req.method === "POST") {
        const b = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) as Record<string, unknown> | undefined;
        const action = b?.action;
        const reason = typeof b?.reason === "string" ? b.reason.trim() : "";
        const needReason = () => reason.length < MIN_REASON ? `Give a reason of at least ${MIN_REASON} characters` : null;
        const version = Number(b?.version);
        const badVersion = !Number.isInteger(version) || version < 1;

        if (action === "save") {
          const parsed = parseOffer(b?.offer);
          if (!parsed.ok) return res.status(400).json({ error: parsed.error });
          const id = b?.id ?? null;
          if (id !== null && !isUuid(id)) return res.status(400).json({ error: "Unknown offer" });
          if (id !== null && badVersion) return res.status(400).json({ error: "version is required when editing" });
          const offer = await deps.withAdmin(staff, meta, async (q) => {
            const saved = (await q("select api.offer_save($1, $2::jsonb, $3) as o",
              [id, JSON.stringify(parsed.data), id === null ? null : version])).rows[0]?.o;
            return offerView(q, saved.id);
          });
          return res.status(200).json({ offer });
        }

        if (!isUuid(b?.id)) return res.status(400).json({ error: "Unknown offer" });
        const id = b!.id as string;
        if (!["approve", "publish", "withdraw", "reverify"].includes(String(action))) return res.status(400).json({ error: "Unknown action" });
        if (badVersion) return res.status(400).json({ error: "version is required" });
        if (action !== "publish") { const e = needReason(); if (e) return res.status(400).json({ error: e }); }
        let verifiedAt: string | null = null;
        if (action === "reverify") {
          const at = typeof b?.verified_at === "string" ? Date.parse(b.verified_at) : NaN;
          if (Number.isNaN(at)) return res.status(400).json({ error: "Verification date is required" });
          verifiedAt = new Date(at).toISOString();
        }

        const offer = await deps.withAdmin(staff, meta, async (q) => {
          if (action === "approve") await q("select api.offer_approve($1, $2, $3)", [id, version, reason]);
          if (action === "publish") await q("select api.offer_publish($1, $2)", [id, version]);
          if (action === "withdraw") await q("select api.offer_withdraw($1, $2, $3)", [id, version, reason]);
          if (action === "reverify") await q("select api.offer_reverify($1, $2, $3, $4)", [id, verifiedAt, version, reason]);
          return offerView(q, id);
        });
        if (action !== "approve") await deps.kick();  // approve changes nothing borrowers see
        return res.status(200).json({ offer });
      }

      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "Method not allowed" });
    } catch (e: any) {
      if (e instanceof SyntaxError) return res.status(400).json({ error: "Body must be JSON" });
      const m = dbError(e);
      if (m) return res.status(m.status).json({ error: m.error });
      console.error("offers admin error", e?.code, e?.message);
      return res.status(500).json({ error: "The change could not be saved. Nothing was changed" });
    }
  };
}

export default onlyOn("app", makeHandler(live));
