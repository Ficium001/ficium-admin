/**
 * Portal admin site only. Banks' compliance: documents and waivers.
 *
 * GET  /api/compliance                         -> { overview, requests }
 * GET  /api/compliance?view=documents&institution_id=&status=  -> { documents }
 * POST /api/compliance { action, ... }
 *   download        { doc_id }                                        -> { url, file_name }
 *   review          { doc_id, institution_id, decision, reason?, expiry_date? }   (one person)
 *   waiver_request  { institution_id, institution_name, waiver_action, waived_until?, reason }
 *   waiver_approve  { id, version, note? }    four-eyes: never the person who asked
 *   waiver_reject   { id, version, note }
 *   waiver_cancel   { id, version }
 *
 * Bank data is read and changed ONLY through portal-api (signed + the caller's
 * own MFA token). The admin DB decides who may do what and records it. For a
 * change, the admin-DB transaction stays open across the portal call: if the
 * portal refuses or cannot be reached, the transaction rolls back and nothing
 * is recorded as done anywhere. Retries are safe (idempotent command_id).
 */
import { requireStaffIdentity, AuthError, type Staff } from "./_lib/access.js";
import { withAdmin, requestMeta, dbError, type Q, type Meta } from "./_lib/admin-db.js";
import { portalApi, bearer, PortalApiError, type PortalCall } from "./_lib/portal-api.js";
import { onlyOn } from "./_lib/site.js";

type Req = { method?: string; headers: Record<string, string | string[] | undefined>; body?: unknown; query?: Record<string, string | string[] | undefined> };
type Res = { status(code: number): Res; json(body: unknown): void; setHeader(k: string, v: string): void };

export type Deps = {
  requireStaff: (h: Req["headers"]) => Promise<Staff>;
  withAdmin: <T>(s: Staff, m: Meta, fn: (q: Q) => Promise<T>) => Promise<T>;
  portal: PortalCall;
};
const live: Deps = { requireStaff: (h) => requireStaffIdentity(h), withAdmin, portal: portalApi() };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

class Bad extends Error {}
const need = (ok: boolean, msg: string) => { if (!ok) throw new Bad(msg); };
const uuid = (v: unknown, name: string) => { const s = str(v); need(UUID.test(s), `${name} is missing or not valid`); return s; };
const version = (v: unknown) => { const n = Number(v); need(Number.isInteger(n) && n >= 1, "version is required"); return n; };

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
    const list = async (q: Q) => (await q("select api.waiver_request_list(null) as v")).rows[0]?.v ?? [];

    try {
      if (req.method === "GET") {
        if (one(req.query?.view) === "documents") {
          const iid = str(one(req.query?.institution_id));
          const status = str(one(req.query?.status));
          need(!iid || UUID.test(iid), "institution_id is not valid");
          need(!status || ["pending", "approved", "rejected", "expired"].includes(status), "status is not valid");
          // The admin DB confirms the caller may read compliance before the portal is asked.
          await deps.withAdmin(staff, meta, list);
          const documents = await deps.portal("query", { op: "documents.list", args: { ...(iid && { institution_id: iid }), ...(status && { status }) } }, actor);
          return res.status(200).json({ documents });
        }
        const requests = await deps.withAdmin(staff, meta, list);
        const overview = await deps.portal("query", { op: "compliance.overview", args: {} }, actor);
        return res.status(200).json({ overview, requests });
      }

      if (req.method !== "POST") {
        res.setHeader("Allow", "GET, POST");
        return res.status(405).json({ error: "Method not allowed" });
      }
      const b = (typeof req.body === "string" ? JSON.parse(req.body) : req.body ?? {}) as Record<string, unknown>;

      switch (b.action) {
        case "download": {
          const doc = uuid(b.doc_id, "doc_id");
          await deps.withAdmin(staff, meta, list);
          return res.status(200).json(await deps.portal("query", { op: "document.download", args: { doc_id: doc } }, actor));
        }
        case "review": {
          const doc = uuid(b.doc_id, "doc_id"), iid = uuid(b.institution_id, "institution_id");
          const decision = str(b.decision), reason = str(b.reason), expiry = str(b.expiry_date);
          need(decision === "approve" || decision === "reject", "decision must be approve or reject");
          need(decision === "approve" || reason.length >= 5, "Say why the document is rejected");
          need(!expiry || DATE.test(expiry), "expiry_date must be YYYY-MM-DD");
          const out = await deps.withAdmin(staff, meta, async (q) => {
            const cmd = (await q("select api.document_review_prepare($1, $2, $3, $4, $5) as v",
              [doc, iid, decision, reason || null, expiry || null])).rows[0]?.v;
            const result = await deps.portal("commands", cmd, actor);
            await q("select api.document_review_record_result($1, $2)", [cmd.command_id, { data: result }]);
            return result;
          });
          return res.status(200).json({ result: out });
        }
        case "waiver_request": {
          const iid = uuid(b.institution_id, "institution_id");
          const name = str(b.institution_name), what = str(b.waiver_action), until = str(b.waived_until), reason = str(b.reason);
          need(name.length > 0 && name.length <= 200, "institution_name is required");
          need(what === "grant" || what === "revoke", "waiver_action must be grant or revoke");
          need(what === "revoke" || !Number.isNaN(Date.parse(until)), "waived_until is required for a grant");
          need(reason.length >= 10, "Give a reason of at least 10 characters");
          const r = await deps.withAdmin(staff, meta, async (q) =>
            (await q("select api.waiver_request_create($1, $2, $3, $4, $5) as v",
              [iid, name, what, what === "grant" ? until : null, reason])).rows[0]?.v);
          return res.status(200).json({ request: r });
        }
        case "waiver_approve": {
          const id = uuid(b.id, "id"), v = version(b.version), note = str(b.note);
          const out = await deps.withAdmin(staff, meta, async (q) => {
            const a = (await q("select api.waiver_request_approve($1, $2, $3) as v", [id, v, note || null])).rows[0]?.v;
            const result = await deps.portal("commands", a.command, actor);
            return (await q("select api.waiver_request_record_result($1, $2) as v", [id, { data: result }])).rows[0]?.v;
          });
          return res.status(200).json({ request: out });
        }
        case "waiver_reject": {
          const id = uuid(b.id, "id"), v = version(b.version), note = str(b.note);
          need(note.length >= 10, "Give a reason of at least 10 characters");
          const r = await deps.withAdmin(staff, meta, async (q) =>
            (await q("select api.waiver_request_reject($1, $2, $3) as v", [id, v, note])).rows[0]?.v);
          return res.status(200).json({ request: r });
        }
        case "waiver_cancel": {
          const id = uuid(b.id, "id"), v = version(b.version);
          const r = await deps.withAdmin(staff, meta, async (q) =>
            (await q("select api.waiver_request_cancel($1, $2) as v", [id, v])).rows[0]?.v);
          return res.status(200).json({ request: r });
        }
        default:
          return res.status(400).json({ error: "Unknown action" });
      }
    } catch (e: any) {
      if (e instanceof Bad) return res.status(400).json({ error: e.message });
      if (e instanceof SyntaxError) return res.status(400).json({ error: "Body must be JSON" });
      if (e instanceof PortalApiError) return res.status(e.status).json({ error: e.message, code: e.code });
      const m = dbError(e);
      if (m) return res.status(m.status).json({ error: m.error });
      console.error("compliance admin error", e?.code, e?.message);
      return res.status(500).json({ error: "Something went wrong. Nothing was changed" });
    }
  };
}

export default onlyOn("portal", makeHandler(live));
