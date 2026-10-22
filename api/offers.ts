/**
 * GET  /api/offers                 -> { actor, offers }
 * GET  /api/offers?id=<uuid>       -> { history }   (change log for one offer)
 * POST /api/offers { action, ... } -> { offer }
 *   action: save (id?, version?, offer) | approve (id, reason) | publish (id)
 *         | withdraw (id, reason) | reverify (id, verified_at, reason)
 * Every write goes through an admin.offer_* function; the actor is always the
 * verified Access identity, never anything the browser sends.
 */
import { requireStaff, AuthError } from "./_lib/access.js";
import { db } from "./_lib/db.js";
import { parseOffer, isUuid, MIN_REASON } from "./_lib/offers.js";

type Req = { method?: string; headers: Record<string, string | string[] | undefined>; body?: unknown; query?: Record<string, string | string[] | undefined> };
type Res = { status(code: number): Res; json(body: unknown): void; setHeader(k: string, v: string): void };

export type Deps = { requireStaff: typeof requireStaff; query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };
const live: Deps = { requireStaff, query: (sql, params) => db().query(sql, params) };

// "Live" is derived from admin.offer alone (same rule as the listing's
// live_until), so the admin app never reads borrower-side tables.
const LIST = `select o.*,
    (o.status = 'published' and o.expires_at > now() and o.verified_at > now() - interval '30 days') as is_live,
    least(o.expires_at, o.verified_at + interval '30 days') as live_until
  from admin.offer o order by o.updated_at desc limit 200`;

export function makeHandler(deps: Deps) {
  return async function handler(req: Req, res: Res) {
    res.setHeader("Cache-Control", "no-store");
    let actor: string;
    try {
      actor = await deps.requireStaff(req.headers);
    } catch (e) {
      const status = e instanceof AuthError ? e.status : 401;
      return res.status(status).json({ error: e instanceof Error ? e.message : "Not signed in" });
    }

    try {
      if (req.method === "GET") {
        const id = req.query?.id;
        if (id !== undefined) {
          if (!isUuid(id)) return res.status(400).json({ error: "Unknown offer" });
          const h = await deps.query(
            "select id, changed_at, actor, action, reason from admin.offer_change where offer_id = $1 order by changed_at desc limit 100", [id]);
          return res.status(200).json({ history: h.rows });
        }
        const r = await deps.query(LIST);
        return res.status(200).json({ actor, offers: r.rows });
      }

      if (req.method === "POST") {
        const b = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) as Record<string, unknown> | undefined;
        const action = b?.action;
        const reason = typeof b?.reason === "string" ? b.reason.trim() : "";
        const needReason = () => reason.length < MIN_REASON ? `Give a reason of at least ${MIN_REASON} characters` : null;
        const one = async (sql: string, params: unknown[]) => (await deps.query(sql, params)).rows[0]?.offer ?? null;

        if (action === "save") {
          const parsed = parseOffer(b?.offer);
          if (!parsed.ok) return res.status(400).json({ error: parsed.error });
          const id = b?.id ?? null;
          if (id !== null && !isUuid(id)) return res.status(400).json({ error: "Unknown offer" });
          const version = id === null ? null : Number(b?.version);
          if (id !== null && !Number.isInteger(version)) return res.status(400).json({ error: "version is required when editing" });
          const offer = await one("select admin.offer_save($1, $2::jsonb, $3, $4) as offer", [id, JSON.stringify(parsed.data), actor, version]);
          return res.status(200).json({ offer });
        }

        if (!isUuid(b?.id)) return res.status(400).json({ error: "Unknown offer" });
        const id = b!.id as string;
        if (action === "approve") {
          const e = needReason(); if (e) return res.status(400).json({ error: e });
          return res.status(200).json({ offer: await one("select admin.offer_approve($1, $2, $3) as offer", [id, actor, reason]) });
        }
        if (action === "publish") {
          return res.status(200).json({ offer: await one("select admin.offer_publish($1, $2) as offer", [id, actor]) });
        }
        if (action === "withdraw") {
          const e = needReason(); if (e) return res.status(400).json({ error: e });
          return res.status(200).json({ offer: await one("select admin.offer_withdraw($1, $2, $3) as offer", [id, actor, reason]) });
        }
        if (action === "reverify") {
          const e = needReason(); if (e) return res.status(400).json({ error: e });
          const at = typeof b?.verified_at === "string" ? Date.parse(b.verified_at) : NaN;
          if (Number.isNaN(at)) return res.status(400).json({ error: "Verification date is required" });
          return res.status(200).json({ offer: await one("select admin.offer_reverify($1, $2, $3, $4) as offer", [id, actor, new Date(at).toISOString(), reason]) });
        }
        return res.status(400).json({ error: "Unknown action" });
      }

      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "Method not allowed" });
    } catch (e: any) {
      if (e instanceof SyntaxError) return res.status(400).json({ error: "Body must be JSON" });
      if (e?.code === "22023") return res.status(400).json({ error: String(e.message) });
      if (e?.code === "40001") return res.status(409).json({ error: "Someone changed this offer since you opened it. Reload and try again" });
      if (e?.code === "23514" || e?.code === "22P02" || e?.code === "22007") return res.status(400).json({ error: "One of the fields isn't valid" });
      console.error("offers admin error", e?.code, e?.message);
      return res.status(500).json({ error: "The change could not be saved. Nothing was changed" });
    }
  };
}

export default makeHandler(live);
