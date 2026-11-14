/**
 * Borrower support (app site only). Needs client.lookup; asking needs client.access.request;
 * approving needs client.access.approve and is never allowed on your own request (four-eyes).
 *
 *   GET  /api/clients?q=<3-100 chars>   -> { actor, can_request, can_approve, clients, pending }
 *   GET  /api/clients?id=<uuid>         -> { actor, can_request, can_approve, client, requests }
 *                                          opening a borrower is audited FIRST
 *   GET  /api/clients                   -> { actor, ..., clients: [], pending }   (the approval queue)
 *   POST /api/clients { op: "request", client_id, action: "suspend"|"reinstate", reason }
 *   POST /api/clients { op: "approve"|"reject"|"withdraw", id, version, note? }
 *
 * Borrower data comes from the borrower app over its signed API. Requests and decisions live in
 * the admin database (audited); an approved change reaches the app through the outbox.
 */
import { requireStaffIdentity, AuthError, type Staff } from "./_lib/access.js";
import { withAdmin, requestMeta, kickDispatch, dbError, type Q, type Meta } from "./_lib/admin-db.js";
import { appClients, AppClientsError, type AppClients } from "./_lib/app-clients.js";
import { MIN_REASON } from "./_lib/checks.js";
import { isUuid } from "./_lib/offers.js";
import { onlyOn } from "./_lib/site.js";

type Req = { method?: string; headers: Record<string, string | string[] | undefined>; query?: Record<string, string | string[] | undefined>; body?: unknown };
type Res = { status(code: number): Res; json(body: unknown): void; setHeader(k: string, v: string): void };

export type Deps = {
  requireStaff: (h: Req["headers"]) => Promise<Staff>;
  withAdmin: <T>(s: Staff, m: Meta, fn: (q: Q) => Promise<T>) => Promise<T>;
  app: AppClients | null;
  kick: () => Promise<void>;
};

const live = (): Deps => ({ requireStaff: (h) => requireStaffIdentity(h), withAdmin, app: appClients(), kick: kickDispatch });
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

/** What kind of search this was, for the audit log: never the search text itself. */
export const queryKind = (q: string): "id" | "email" | "name" => (isUuid(q) ? "id" : String(q).includes("@") ? "email" : "name");

export function makeHandler(deps: Deps) {
  return async function handler(req: Req, res: Res) {
    res.setHeader("Cache-Control", "no-store");
    let staff: Staff;
    try {
      staff = await deps.requireStaff(req.headers);
    } catch (e) {
      const status = e instanceof AuthError ? e.status : 401;
      return res.status(status).json({ error: e instanceof Error ? e.message : "Not signed in" });
    }
    const app = deps.app;
    if (!app) return res.status(503).json({ error: "Borrower lookup needs the borrower app connection (APP_ADMIN_SYNC_URL and APP_ADMIN_SYNC_SIGNING_KEY)" });
    const meta = requestMeta(req.headers);
    try {
      if (req.method === "GET") {
        const id = one(req.query?.id);
        if (id) {
          if (!isUuid(id)) return res.status(400).json({ error: "Unknown borrower" });
          const out = await deps.withAdmin(staff, meta, async (q) => {
            // Recorded before anything is returned; if it can't be recorded, nothing is shown.
            const v = (await q("select api.client_viewed($1) as v", [id])).rows[0]?.v;
            const client = await app.get(id);
            if (!client) throw new HttpError(404, "Borrower not found");
            return { ...v, client };
          });
          return res.status(200).json(out);
        }
        const term = one(req.query?.q).trim();
        if (term && (term.length < 3 || term.length > 100)) {
          return res.status(400).json({ error: "Search with 3 to 100 characters" });
        }
        const out = await deps.withAdmin(staff, meta, async (q) => {
          const access = (await q("select api.client_lookup_access($1) as v", [term ? queryKind(term) : "queue"])).rows[0]?.v;
          const pending = (await q("select api.client_access_pending() as v")).rows[0]?.v ?? [];
          const clients = term ? await app.search(term) : [];
          return { ...access, clients, pending };
        });
        return res.status(200).json(out);
      }

      if (req.method === "POST") {
        const b = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) as Record<string, unknown> | undefined;
        const op = b?.op;
        if (op === "request") {
          const clientId = b?.client_id, action = b?.action;
          const reason = typeof b?.reason === "string" ? b.reason.trim() : "";
          if (!isUuid(clientId)) return res.status(400).json({ error: "Unknown borrower" });
          if (action !== "suspend" && action !== "reinstate") return res.status(400).json({ error: "Action must be suspend or reinstate" });
          if (reason.length < MIN_REASON) return res.status(400).json({ error: `Give a reason of at least ${MIN_REASON} characters` });
          if (reason.length > 2000) return res.status(400).json({ error: "Reason is too long" });
          const out = await deps.withAdmin(staff, meta, async (q) => {
            const c = await app.get(String(clientId));
            if (!c) throw new HttpError(404, "Borrower not found");
            const r = (await q("select api.client_access_request($1, $2, $3, $4) as v",
                               [clientId, action, reason, c.suspended === true])).rows[0]?.v;
            return { request: r };
          });
          return res.status(200).json(out);
        }
        if (op === "approve" || op === "reject" || op === "withdraw") {
          const id = b?.id, version = Number(b?.version);
          const note = typeof b?.note === "string" ? b.note.trim() : "";
          if (!isUuid(id) || !Number.isInteger(version) || version < 1) return res.status(400).json({ error: "Unknown request" });
          if (op === "reject" && note.length < MIN_REASON) return res.status(400).json({ error: `Give a reason of at least ${MIN_REASON} characters` });
          if (note.length > 2000) return res.status(400).json({ error: "Note is too long" });
          const out = await deps.withAdmin(staff, meta, async (q) => {
            const r = op === "withdraw"
              ? (await q("select api.client_access_withdraw($1, $2) as v", [id, version])).rows[0]?.v
              : (await q(`select api.client_access_${op}($1, $2, $3) as v`, [id, version, note || null])).rows[0]?.v;
            return { request: r };
          });
          if (op === "approve") await deps.kick();
          return res.status(200).json(out);
        }
        return res.status(400).json({ error: "Unknown operation" });
      }

      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "Method not allowed" });
    } catch (e: any) {
      if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
      if (e instanceof SyntaxError) return res.status(400).json({ error: "Body must be JSON" });
      if (e instanceof AppClientsError) {
        console.error("clients: borrower app", e.message);
        return res.status(502).json({ error: "The borrower app didn't answer. Nothing was changed. Try again shortly" });
      }
      const m = dbError(e);
      if (m) return res.status(m.status).json({ error: m.error });
      console.error("clients error", e?.code, e?.message);
      return res.status(500).json({ error: "Something went wrong. Nothing was changed" });
    }
  };
}

export default onlyOn("app", (req: Req, res: Res) => makeHandler(live())(req, res));
