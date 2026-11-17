/**
 * GET /api/audit?source=admin|portal|health&before=&institution_id=&action_prefix=
 *
 * source=health (both sites): this site's ops health (audit-chain verification,
 * outbox backlog and dead letters) via api.ops_health_view, which enforces
 * audit.read. Counts and hashes only.
 * Both sites. source=admin (default): this site's own admin-DB audit chain
 * (who did what in the admin site), via api.audit_search, which enforces
 * audit.read itself. source=portal (portal site only): the portal's audit
 * trail, read through portal-api after the admin DB confirms audit.read.
 * Read-only.
 *
 * This file also serves /api/audit?module=traffic (API traffic, both sites, _lib/api-traffic.ts) and
 * /api/audit?module=services (service health, both sites, _lib/services.ts): the Vercel plan allows
 * 12 function files and this repo has 12. The handlers share nothing but the file.
 */
import { requireStaffIdentity, AuthError, type Staff } from "./_lib/access.js";
import { withAdmin, requestMeta, dbError, type Q, type Meta } from "./_lib/admin-db.js";
import { portalApi, bearer, PortalApiError, type PortalCall } from "./_lib/portal-api.js";
import { currentSite } from "./_lib/site.js";
import { makeHandler as makeTrafficHandler, live as liveTraffic } from "./_lib/api-traffic.js";
import { makeHandler as makeServicesHandler, live as liveServices } from "./_lib/services.js";

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
      if (source === "health") {
        const health = await deps.withAdmin(staff, meta, async (q) => (await q("select api.ops_health_view() as v")).rows[0]?.v ?? null);
        return res.status(200).json({ source, health });
      }
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

/** One function file, three modules: `?module=traffic`, `?module=services`, anything else is the audit log. */
export function route(
  audit: (req: Req, res: Res) => unknown,
  traffic: (req: Req, res: Res) => unknown,
  services: (req: Req, res: Res) => unknown = audit,
) {
  return (req: Req, res: Res) => {
    const raw = req.query?.module;
    const m = Array.isArray(raw) ? raw[0] : raw;
    return m === "traffic" ? traffic(req, res) : m === "services" ? services(req, res) : audit(req, res);
  };
}

export default route(
  makeHandler(live),
  (req, res) => makeTrafficHandler(liveTraffic())(req as any, res),
  (req, res) => makeServicesHandler(liveServices())(req as any, res),
);
