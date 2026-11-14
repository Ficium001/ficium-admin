/**
 * Portal admin site only. Banks: approval, suspension and module entitlements.
 *
 * GET  /api/institutions                     -> { institutions, catalog, requests }
 * GET  /api/institutions?view=groups         -> { groups }  (read-only role templates)
 * POST /api/institutions { action, ... }
 *   request   { op, institution_id, institution_name, reason, module_code?, status?, plan_tier?, valid_to?,
 *               email?, full_name? }   (email + full_name for institution.invite_admin)
 *   approve   { id, version, note? }   four-eyes: never the person who asked
 *   reject    { id, version, note }
 *   withdraw  { id, version }
 *
 * Every change is four-eyes, held in the admin DB (governance.change_request)
 * and applied through portal-api only (signed + the approver's MFA token). The
 * admin-DB transaction spans the portal call: refused or unreachable portal =
 * rollback, nothing recorded as done. Commands are idempotent by command_id.
 * institution.invite_admin (a first admin for a bank that has none): after it
 * commits, ficium-auth emails that admin a set-password link, as the approver.
 */
import { requireStaffIdentity, AuthError, type Staff } from "./_lib/access.js";
import { withAdmin, requestMeta, dbError, type Q, type Meta } from "./_lib/admin-db.js";
import { portalApi, bearer, PortalApiError, type PortalCall } from "./_lib/portal-api.js";
import { inviteInstitutionAdmin, type InviteResult } from "./_lib/institution-invite.js";
import { onlyOn } from "./_lib/site.js";
import { describeChange, snapshot, ChangeError } from "./_lib/change.js";

type Req = { method?: string; headers: Record<string, string | string[] | undefined>; body?: unknown; query?: Record<string, string | string[] | undefined> };
type Res = { status(code: number): Res; json(body: unknown): void; setHeader(k: string, v: string): void };

export type Deps = {
  requireStaff: (h: Req["headers"]) => Promise<Staff>;
  withAdmin: <T>(s: Staff, m: Meta, fn: (q: Q) => Promise<T>) => Promise<T>;
  portal: PortalCall;
  invite?: (authorization: string, email: string) => Promise<InviteResult>;
};
const live: Deps = {
  requireStaff: (h) => requireStaffIdentity(h), withAdmin, portal: portalApi(),
  invite: (authorization, email) => inviteInstitutionAdmin(authorization, email),
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODULE = /^[A-Z][A-Z0-9_]{1,39}$/;
const OPS = new Set(["institution.approve", "institution.suspend", "entitlement.set", "institution.invite_admin"]);
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const STATUSES = new Set(["active", "trial", "suspended", "expired"]);
const TIERS = new Set(["trial", "standard", "professional", "enterprise"]);
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

class Bad extends Error {}
const need = (ok: boolean, msg: string) => { if (!ok) throw new Bad(msg); };
const version = (v: unknown) => { const n = Number(v); need(Number.isInteger(n) && n >= 1, "version is required"); return n; };

/** Builds the exact args portal-api will receive; validated here AND by portal-api. */
export function buildRequest(b: Record<string, unknown>) {
  const op = str(b.op), iid = str(b.institution_id), name = str(b.institution_name), reason = str(b.reason);
  need(OPS.has(op), "Unknown change");
  need(UUID.test(iid), "institution_id is missing or not valid");
  need(name.length > 0 && name.length <= 200, "institution_name is required");
  need(reason.length >= 10, "Give a reason of at least 10 characters");
  if (op === "institution.approve") return { op, key: iid, label: name, args: { institution_id: iid }, reason };
  if (op === "institution.suspend") return { op, key: iid, label: name, args: { institution_id: iid, reason }, reason };
  if (op === "institution.invite_admin") {
    const email = str(b.email).toLowerCase(), full = str(b.full_name);
    need(EMAIL.test(email) && email.length <= 254, "email is not valid");
    need(full.length >= 2 && full.length <= 200, "full_name is required");
    return { op, key: iid, label: `${name}: ${email}`, args: { institution_id: iid, email, full_name: full, reason }, reason };
  }
  const code = str(b.module_code), status = str(b.status), tier = str(b.plan_tier) || "standard", until = str(b.valid_to);
  need(MODULE.test(code), "module_code is not valid");
  need(STATUSES.has(status), "status is not valid");
  need(TIERS.has(tier), "plan_tier is not valid");
  need(!until || (!Number.isNaN(Date.parse(until)) && Date.parse(until) > Date.now()), "valid_to must be a future date");
  return {
    op, key: `${iid}:${code}`, label: `${name}: ${code}`, reason,
    args: { institution_id: iid, module_code: code, status, plan_tier: tier, ...(until && { valid_to: new Date(until).toISOString() }) },
  };
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
    const list = async (q: Q) => {
      const [a, b] = await Promise.all([
        q("select api.change_request_list(null, 'institution.') as v"),
        q("select api.change_request_list(null, 'entitlement.') as v"),
      ]);
      return [...(a.rows[0]?.v ?? []), ...(b.rows[0]?.v ?? [])]
        .sort((x: any, y: any) => String(y.created_at).localeCompare(String(x.created_at)));
    };

    try {
      if (req.method === "GET") {
        // The bank list lives in the portal: check the permission in the admin DB first.
        const requests = await deps.withAdmin(staff, meta, async (q) => {
          await q("select api.require_permission('institutions.read')");
          return list(q);
        });
        if (one(req.query?.view) === "groups") {
          return res.status(200).json({ groups: await deps.portal("query", { op: "groups.list", args: {} }, actor) });
        }
        const [institutions, catalog] = await Promise.all([
          deps.portal("query", { op: "institutions.list", args: {} }, actor),
          deps.portal("query", { op: "entitlements.catalog", args: {} }, actor),
        ]);
        return res.status(200).json({ institutions, catalog, requests });
      }
      if (req.method !== "POST") {
        res.setHeader("Allow", "GET, POST");
        return res.status(405).json({ error: "Method not allowed" });
      }
      const b = (typeof req.body === "string" ? JSON.parse(req.body) : req.body ?? {}) as Record<string, unknown>;

      switch (b.action) {
        case "request": {
          const r = buildRequest(b);
          const { before, change } = await describeChange(r.op, r.args, deps.portal, actor);
          const out = await deps.withAdmin(staff, meta, async (q) =>
            (await q("select api.change_request_create($1, $2, $3, $4, $5, $6, $7) as v", [r.op, r.key, r.label, r.args, r.reason, before, change])).rows[0]?.v);
          return res.status(200).json({ request: out });
        }
        case "approve": {
          const id = str(b.id), v = version(b.version), note = str(b.note);
          need(UUID.test(id), "id is not valid");
          const { out, op, result } = await deps.withAdmin(staff, meta, async (q) => {
            const a = (await q("select api.change_request_approve($1, $2, $3) as v", [id, v, note || null])).rows[0]?.v;
            await q("select api.change_request_confirm_unchanged($1, $2)", [id, await snapshot(a.command.op, a.command.args, deps.portal, actor)]);
            const result = await deps.portal("commands", a.command, actor);
            const out = (await q("select api.change_request_record_result($1, $2) as v", [id, { data: result }])).rows[0]?.v;
            return { out, op: a.command?.op as string | undefined, result };
          });
          if (op !== "institution.invite_admin") return res.status(200).json({ request: out });
          // Committed. Now the invitation; a failure here leaves a login that can be re-invited.
          let invite: { email_sent: boolean } | { error: string };
          try {
            invite = await (deps.invite ?? live.invite!)(`Bearer ${actor}`, String(result?.admin_email ?? ""));
          } catch (e) {
            invite = { error: e instanceof Error ? e.message : "The invitation was not sent" };
          }
          return res.status(200).json({ request: out, invite });
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
      console.error("institutions admin error", e?.code, e?.message);
      return res.status(500).json({ error: "Something went wrong. Nothing was changed" });
    }
  };
}

export default onlyOn("portal", makeHandler(live));
