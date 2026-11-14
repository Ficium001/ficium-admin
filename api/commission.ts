/**
 * Portal admin site only. Ficium's commission schedule.
 *
 * GET  /api/commission                -> { rules, institutions, products, requests }
 * GET  /api/commission?statement=1&institution_id=<uuid>&month=YYYY-MM
 *                                     -> { institution, month, lines, totals }   (read-only)
 * POST /api/commission { action, ... }
 *   request   { op: "commission.set", institution_id?, institution_name?, product_code?, product_name?,
 *               rate_percent, effective_from, reason }
 *             { op: "commission.end", rule_id, label, ended_on, reason }
 *   approve   { id, version, note? }   four-eyes: never the person who asked
 *   reject    { id, version, note }
 *   withdraw  { id, version }
 *
 * The schedule lives in the Portal DB (billing.commission_rule) and changes only
 * through portal-api's four-eyes commands; requests and decisions are held here
 * (governance.change_request) like every other portal change. The admin-DB
 * transaction spans the portal call: refused or unreachable portal = rollback.
 * A rule is never edited: setting a scope again closes the current rule on the
 * new start date, so what was charged when stays on record.
 */
import { requireStaffIdentity, AuthError, type Staff } from "./_lib/access.js";
import { withAdmin, requestMeta, dbError, type Q, type Meta } from "./_lib/admin-db.js";
import { portalApi, bearer, PortalApiError, type PortalCall } from "./_lib/portal-api.js";
import { onlyOn } from "./_lib/site.js";
import { describeChange, snapshot, ChangeError } from "./_lib/change.js";

type Req = { method?: string; headers: Record<string, string | string[] | undefined>; body?: unknown; query?: Record<string, string | string[] | undefined> };
type Res = { status(code: number): Res; json(body: unknown): void; setHeader(k: string, v: string): void };

export type Deps = {
  requireStaff: (h: Req["headers"]) => Promise<Staff>;
  withAdmin: <T>(s: Staff, m: Meta, fn: (q: Q) => Promise<T>) => Promise<T>;
  portal: PortalCall;
  today?: () => string;
};
const live: Deps = { requireStaff: (h) => requireStaffIdentity(h), withAdmin, portal: portalApi() };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRODUCT = /^[a-z][a-z0-9_]{1,39}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PERCENT = /^\d{1,2}(\.\d{1,2})?$/;
const MONTH = /^20[2-9]\d-(0[1-9]|1[0-2])$/;
const MAX_PERCENT = 5;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const one = (v: string | string[] | undefined) => ((Array.isArray(v) ? v[0] : v) ?? "").trim();

class Bad extends Error {}
const need = (ok: boolean, msg: string) => { if (!ok) throw new Bad(msg); };
const version = (v: unknown) => { const n = Number(v); need(Number.isInteger(n) && n >= 1, "version is required"); return n; };
/** Today in Mauritius, the calendar the Portal DB checks dates against. */
const mauritiusToday = () => new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);

/** "0.45" (%) -> "0.0045" (fraction, 4 dp). Exact for <= 2 decimals of a percent. */
export function percentToFraction(p: string): string {
  need(PERCENT.test(p), "Enter the rate as a percentage with at most 2 decimals, e.g. 0.45");
  const [whole, dec = ""] = p.split(".");
  const bps = Number(whole) * 100 + Number(dec.padEnd(2, "0"));
  need(bps <= MAX_PERCENT * 100, `The rate can't be above ${MAX_PERCENT}%`);
  return (bps / 10_000).toFixed(4);
}

/** Builds the exact args portal-api will receive; validated here AND by portal-api and the Portal DB. */
export function buildRequest(b: Record<string, unknown>, today: string = mauritiusToday()) {
  const op = str(b.op), reason = str(b.reason);
  need(reason.length >= 10, "Give a reason of at least 10 characters");
  if (op === "commission.set") {
    const iid = str(b.institution_id), product = str(b.product_code), from = str(b.effective_from);
    need(!iid || UUID.test(iid), "institution_id is not valid");
    need(!product || PRODUCT.test(product), "product_code is not valid");
    need(DATE.test(from) && from >= today, "The start date must be today or later");
    const rate = percentToFraction(str(b.rate_percent));
    const bank = iid ? str(b.institution_name) : "All banks";
    const prod = product ? str(b.product_name) || product : "All products";
    need(bank.length > 0 && bank.length <= 120, "institution_name is required");
    return {
      op, key: `${iid || "*"}:${product || "*"}`, label: `${bank} · ${prod}`.slice(0, 200), reason,
      args: { institution_id: iid || null, product_code: product || null, rate, effective_from: from, reason },
    };
  }
  if (op === "commission.end") {
    const rid = str(b.rule_id), until = str(b.ended_on), label = str(b.label);
    need(UUID.test(rid), "rule_id is not valid");
    need(DATE.test(until) && until >= today, "The end date must be today or later");
    need(label.length > 0 && label.length <= 200, "label is required");
    return { op, key: rid, label, reason, args: { rule_id: rid, ended_on: until, reason } };
  }
  throw new Bad("Unknown change");
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
    const actor = bearer(req.headers);

    try {
      if (req.method === "GET" && one(req.query?.statement)) {
        const iid = one(req.query?.institution_id), month = one(req.query?.month);
        if (!UUID.test(iid)) return res.status(400).json({ error: "Choose a bank" });
        if (!MONTH.test(month)) return res.status(400).json({ error: "Choose a month (YYYY-MM)" });
        await deps.withAdmin(staff, meta, async (q) => { await q("select api.require_permission('commission.read')"); });
        const statement = await deps.portal("query", { op: "commission.statement", args: { institution_id: iid, month } }, actor);
        return res.status(200).json(statement);
      }

      if (req.method === "GET") {
        // The schedule lives in the portal: check the permission in the admin DB first.
        const requests = await deps.withAdmin(staff, meta, async (q) => {
          await q("select api.require_permission('commission.read')");
          return (await q("select api.change_request_list(null, 'commission.') as v")).rows[0]?.v ?? [];
        });
        const [rules, institutions, products] = await Promise.all([
          deps.portal("query", { op: "commission.rules", args: {} }, actor),
          deps.portal("query", { op: "institutions.list", args: {} }, actor),
          deps.portal("query", { op: "products.list", args: {} }, actor),
        ]);
        const banks = (institutions as Array<{ institution_id: string; name: string }>).map((i) => ({ institution_id: i.institution_id, name: i.name }));
        return res.status(200).json({ rules, institutions: banks, products, requests });
      }
      if (req.method !== "POST") {
        res.setHeader("Allow", "GET, POST");
        return res.status(405).json({ error: "Method not allowed" });
      }
      const b = (typeof req.body === "string" ? JSON.parse(req.body) : req.body ?? {}) as Record<string, unknown>;

      switch (b.action) {
        case "request": {
          const r = buildRequest(b, deps.today?.());
          const { before, change } = await describeChange(r.op, r.args, deps.portal, actor);
          const out = await deps.withAdmin(staff, meta, async (q) =>
            (await q("select api.change_request_create($1, $2, $3, $4, $5, $6, $7) as v", [r.op, r.key, r.label, r.args, r.reason, before, change])).rows[0]?.v);
          return res.status(200).json({ request: out });
        }
        case "approve": {
          const id = str(b.id), v = version(b.version), note = str(b.note);
          need(UUID.test(id), "id is not valid");
          const out = await deps.withAdmin(staff, meta, async (q) => {
            const a = (await q("select api.change_request_approve($1, $2, $3) as v", [id, v, note || null])).rows[0]?.v;
            await q("select api.change_request_confirm_unchanged($1, $2)", [id, await snapshot(a.command.op, a.command.args, deps.portal, actor)]);
            const result = await deps.portal("commands", a.command, actor);
            return (await q("select api.change_request_record_result($1, $2) as v", [id, { data: result }])).rows[0]?.v;
          });
          return res.status(200).json({ request: out });
        }
        case "reject": {
          const id = str(b.id), v = version(b.version), note = str(b.note);
          need(UUID.test(id), "id is not valid");
          need(note.length >= 10, "Give a reason of at least 10 characters");
          const out = await deps.withAdmin(staff, meta, async (q) =>
            (await q("select api.change_request_reject($1, $2, $3) as v", [id, v, note])).rows[0]?.v);
          return res.status(200).json({ request: out });
        }
        case "withdraw": {
          const id = str(b.id), v = version(b.version);
          need(UUID.test(id), "id is not valid");
          const out = await deps.withAdmin(staff, meta, async (q) =>
            (await q("select api.change_request_cancel($1, $2) as v", [id, v])).rows[0]?.v);
          return res.status(200).json({ request: out });
        }
        default:
          return res.status(400).json({ error: "Unknown action" });
      }
    } catch (e: any) {
      if (e instanceof Bad || e instanceof ChangeError) return res.status(400).json({ error: e.message });
      if (e instanceof SyntaxError) return res.status(400).json({ error: "Body must be JSON" });
      if (e instanceof PortalApiError) return res.status(e.status).json({ error: e.message, code: e.code });
      const m = dbError(e);
      if (m) return res.status(m.status).json({ error: m.error });
      console.error("commission admin error", e?.code, e?.message);
      return res.status(500).json({ error: "Something went wrong. Nothing was changed" });
    }
  };
}

export default onlyOn("portal", makeHandler(live));
