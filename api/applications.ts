/**
 * Portal admin site only. Institution applications (portal-api db/060).
 *
 * GET  /api/applications[?status=open|closed|submitted|in_review|info_requested|approved|rejected|provisioned]
 *        -> { applications, requests }
 * POST /api/applications { action, ... }
 *   review              { request_id, reference, status, note? }                    one person
 *   provision_request   { request_id, reference, institution_name, contract_reference,
 *                         deployment_model, reason }                                 asks a second admin
 *   provision_approve   { id, version, note? }  four-eyes: creates the bank + first admin login,
 *                                               then ficium-auth emails the invite
 *   provision_reject    { id, version, note }
 *   provision_withdraw  { id, version }
 *   resend_invite       { email }               re-send the set-password link (never-activated only)
 *
 * Applications live in the portal and are read and changed ONLY through
 * portal-api (signed + the caller's own MFA token). The admin DB decides who may
 * do what and records it. For a change, the admin-DB transaction stays open
 * across the portal call: a refused or unreachable portal rolls back and nothing
 * is recorded as done anywhere. Retries are safe (idempotent command_id).
 * The invite is sent after provisioning commits: if the email fails, the bank and
 * its login exist and the invite can be re-sent; nothing is half-created.
 */
import { requireStaffIdentity, AuthError, type Staff } from "./_lib/access.js";
import { withAdmin, requestMeta, dbError, type Q, type Meta } from "./_lib/admin-db.js";
import { portalApi, bearer, PortalApiError, type PortalCall } from "./_lib/portal-api.js";
import { inviteInstitutionAdmin, InviteError, type InviteResult } from "./_lib/institution-invite.js";
import { onlyOn } from "./_lib/site.js";

type Req = { method?: string; headers: Record<string, string | string[] | undefined>; body?: unknown; query?: Record<string, string | string[] | undefined> };
type Res = { status(code: number): Res; json(body: unknown): void; setHeader(k: string, v: string): void };

export type Deps = {
  requireStaff: (h: Req["headers"]) => Promise<Staff>;
  withAdmin: <T>(s: Staff, m: Meta, fn: (q: Q) => Promise<T>) => Promise<T>;
  portal: PortalCall;
  invite: (authorization: string, email: string) => Promise<InviteResult>;
};
const live: Deps = {
  requireStaff: (h) => requireStaffIdentity(h), withAdmin, portal: portalApi(),
  invite: (authorization, email) => inviteInstitutionAdmin(authorization, email),
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFERENCE = /^[A-Z0-9]{6,20}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const FILTERS = new Set(["open", "closed", "submitted", "in_review", "info_requested", "approved", "rejected", "provisioned"]);
const DECISIONS = new Set(["in_review", "info_requested", "approved", "rejected"]);
const MODELS = new Set(["saas", "paas", "on_prem"]);
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

class Bad extends Error {}
const need = (ok: boolean, msg: string) => { if (!ok) throw new Bad(msg); };
const uuid = (v: unknown, name: string) => { const s = str(v); need(UUID.test(s), `${name} is missing or not valid`); return s; };
const version = (v: unknown) => { const n = Number(v); need(Number.isInteger(n) && n >= 1, "version is required"); return n; };

/** Exact args portal-api will receive for institution.provision; validated here AND by portal-api. */
export function buildProvision(b: Record<string, unknown>) {
  const rid = uuid(b.request_id, "request_id");
  const ref = str(b.reference).toUpperCase(), name = str(b.institution_name);
  const contract = str(b.contract_reference), model = str(b.deployment_model) || "saas", reason = str(b.reason);
  need(REFERENCE.test(ref), "reference is not valid");
  need(name.length > 0 && name.length <= 200, "institution_name is required");
  need(contract.length >= 3 && contract.length <= 100, "Enter the signed contract's reference (3-100 characters)");
  need(MODELS.has(model), "deployment_model must be saas, paas or on_prem");
  need(reason.length >= 10, "Give a reason of at least 10 characters");
  return {
    key: rid, label: `${name} (${ref})`, reason,
    args: { request_id: rid, contract_reference: contract, deployment_model: model },
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
    const requests = async (q: Q) => (await q("select api.change_request_list(null, 'institution.provision') as v")).rows[0]?.v ?? [];

    try {
      if (req.method === "GET") {
        const status = str(one(req.query?.status)) || "open";
        need(FILTERS.has(status), "status is not valid");
        // The applications live in the portal: check the permission in the admin DB first.
        const reqs = await deps.withAdmin(staff, meta, async (q) => {
          await q("select api.require_permission('applications.read')");
          return requests(q);
        });
        const applications = await deps.portal("query", { op: "access_requests.list", args: { status } }, actor);
        return res.status(200).json({ applications, requests: reqs });
      }
      if (req.method !== "POST") {
        res.setHeader("Allow", "GET, POST");
        return res.status(405).json({ error: "Method not allowed" });
      }
      const b = (typeof req.body === "string" ? JSON.parse(req.body) : req.body ?? {}) as Record<string, unknown>;

      switch (b.action) {
        case "review": {
          const rid = uuid(b.request_id, "request_id"), ref = str(b.reference).toUpperCase();
          const decision = str(b.status), note = str(b.note);
          need(REFERENCE.test(ref), "reference is not valid");
          need(DECISIONS.has(decision), "status must be in_review, info_requested, approved or rejected");
          need(!["info_requested", "rejected"].includes(decision) || note.length >= 10, "Say why, in at least 10 characters");
          need(note.length <= 500, "Keep the note under 500 characters");
          const out = await deps.withAdmin(staff, meta, async (q) => {
            const cmd = (await q("select api.application_review_prepare($1, $2, $3, $4) as v", [rid, ref, decision, note || null])).rows[0]?.v;
            const result = await deps.portal("commands", cmd, actor);
            await q("select api.application_review_record_result($1, $2)", [cmd.command_id, { data: result }]);
            return result;
          });
          return res.status(200).json({ result: out });
        }
        case "provision_request": {
          const r = buildProvision(b);
          const out = await deps.withAdmin(staff, meta, async (q) =>
            (await q("select api.change_request_create($1, $2, $3, $4, $5) as v", ["institution.provision", r.key, r.label, r.args, r.reason])).rows[0]?.v);
          return res.status(200).json({ request: out });
        }
        case "provision_approve": {
          const id = uuid(b.id, "id"), v = version(b.version), note = str(b.note);
          const { request, result } = await deps.withAdmin(staff, meta, async (q) => {
            const a = (await q("select api.change_request_approve($1, $2, $3) as v", [id, v, note || null])).rows[0]?.v;
            need(a?.command?.op === "institution.provision", "That request is not an application provisioning");
            const result = await deps.portal("commands", a.command, actor);
            const request = (await q("select api.change_request_record_result($1, $2) as v", [id, { data: result }])).rows[0]?.v;
            return { request, result };
          });
          // Committed. Now the invitation; a failure here leaves a bank whose admin can be re-invited.
          let invite: { email_sent: boolean } | { error: string };
          try {
            invite = await deps.invite(`Bearer ${actor}`, String(result?.admin_email ?? ""));
          } catch (e) {
            invite = { error: e instanceof Error ? e.message : "The invitation was not sent" };
          }
          return res.status(200).json({ request, provisioned: result, invite });
        }
        case "provision_reject": {
          const id = uuid(b.id, "id"), v = version(b.version), note = str(b.note);
          need(note.length >= 10, "Give a reason of at least 10 characters");
          const out = await deps.withAdmin(staff, meta, async (q) =>
            (await q("select api.change_request_reject($1, $2, $3) as v", [id, v, note])).rows[0]?.v);
          return res.status(200).json({ request: out });
        }
        case "provision_withdraw": {
          const id = uuid(b.id, "id"), v = version(b.version);
          const out = await deps.withAdmin(staff, meta, async (q) =>
            (await q("select api.change_request_cancel($1, $2) as v", [id, v])).rows[0]?.v);
          return res.status(200).json({ request: out });
        }
        case "resend_invite": {
          const email = str(b.email).toLowerCase();
          need(EMAIL.test(email) && email.length <= 254, "email is not valid");
          await deps.withAdmin(staff, meta, async (q) => { await q("select api.require_permission('applications.review')"); });
          return res.status(200).json({ invite: await deps.invite(`Bearer ${actor}`, email) });
        }
        default:
          return res.status(400).json({ error: "Unknown action" });
      }
    } catch (e: any) {
      if (e instanceof Bad) return res.status(400).json({ error: e.message });
      if (e instanceof SyntaxError) return res.status(400).json({ error: "Body must be JSON" });
      if (e instanceof PortalApiError) return res.status(e.status).json({ error: e.message, code: e.code });
      if (e instanceof InviteError) return res.status(e.status).json({ error: e.message });
      const m = dbError(e);
      if (m) return res.status(m.status).json({ error: m.error });
      console.error("applications admin error", e?.code, e?.message);
      return res.status(500).json({ error: "Something went wrong. Nothing was changed" });
    }
  };
}

export default onlyOn("portal", makeHandler(live));
