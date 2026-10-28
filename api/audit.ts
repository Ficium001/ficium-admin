/**
 * GET /api/audit?source=admin|portal&before=&institution_id=&action_prefix=
 *
 * Both sites. source=admin (default): this site's own admin-DB audit chain
 * (who did what in the admin site), via api.audit_search, which enforces
 * audit.read itself. source=portal (portal site only): the portal's audit
 * trail, read through portal-api after the admin DB confirms audit.read.
 * Read-only.
 */
import { requireStaffIdentity, AuthError, type Staff } from "./_lib/access.js";
import { withAdmin, requestMeta, dbError, type Q, type Meta } from "./_lib/admin-db.js";
import { portalApi, bearer, PortalApiError, type PortalCall } from "./_lib/portal-api.js";
import { currentSite } from "./_lib/site.js";

type Req = { method?: string; headers: Record<string, string | string[] | undefined>; query?: Record<string, string | string[] | undefined> };
type Res = { status(code: number): Res; json(body: unknown): void; setHeader(k: string, v: string): void };

export type Deps = {
  requireStaff: (h: Req["headers"]) => Promise<Staff>;
  withAdmin: <T>(s: Staff, m: Meta, fn: (q: Q) => Promise<T>) => Promise<T>;
  portal: PortalCall;
  site: () => "app" | "portal";
};
const live: Deps = { requireStaff: (h) => requireStaffIdentity(h), withAdmin, portal: portalApi(), site: () => currentSite() };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFIX = /^[a-z_]+(\.[a-z_]*)*$/;
const one = (v: string | string[] | undefined) => ((Array.isArray(v) ? v[0] : v) ?? "").trim();

export function makeHandler(deps: Deps) {
  return async function handler(req: Req, res: Res) {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ error: "Method not allowed" }); }
    let staff: Staff;
    try {
      staff = await deps.requireStaff(req.headers);
    } catch (e) {
      const status = e instanceof AuthError ? e.status : 401;
      return res.status(status).json({ error: e instanceof Error ? e.message : "Not signed in", code: e instanceof AuthError ? e.code : undefined });
    }
    const meta = requestMeta(req.headers);
    const source = one(req.query?.source) || "admin";
    const before = one(req.query?.before);
    try {
      if (source === "admin") {
        if (before && !/^\d+$/.test(before)) return res.status(400).json({ error: "before must be a position number" });
        const events = await deps.withAdmin(staff, meta, async (q) =>
          (await q("select coalesce(jsonb_agg(to_jsonb(e) order by e.chain_pos desc), '[]'::jsonb) as v from api.audit_search(null, null, null, $1, 100) e",
            [before || null])).rows[0]?.v ?? []);
        return res.status(200).json({ source, events });
      }
      if (source !== "portal" || deps.site() !== "portal") return res.status(400).json({ error: "Unknown source" });
      const iid = one(req.query?.institution_id), prefix = one(req.query?.action_prefix);
      if (iid && !UUID.test(iid)) return res.status(400).json({ error: "institution_id is not valid" });
      if (prefix && !PREFIX.test(prefix)) return res.status(400).json({ error: "action_prefix is not valid" });
      if (before && Number.isNaN(Date.parse(before))) return res.status(400).json({ error: "before must be a date" });
      await deps.withAdmin(staff, meta, (q) => q("select api.require_permission('audit.read')"));
      const events = await deps.portal("query", {
        op: "audit.search",
        args: { limit: 100, ...(iid && { institution_id: iid }), ...(prefix && { action_prefix: prefix }), ...(before && { before }) },
      }, bearer(req.headers));
      return res.status(200).json({ source, events });
    } catch (e: any) {
      if (e instanceof PortalApiError) return res.status(e.status).json({ error: e.message, code: e.code });
      const m = dbError(e);
      if (m) return res.status(m.status).json({ error: m.error });
      console.error("audit read error", e?.code, e?.message);
      return res.status(500).json({ error: "The audit log could not be read" });
    }
  };
}

export default makeHandler(live);
