/**
 * Data protection requests and the retention schedule (app site only). Served by the
 * /api/clients function file as /api/clients?module=dp: the Vercel plan allows 12 function
 * files and this repo has 12.
 *
 *   GET  ?module=dp -> { actor, today, can_manage, can_close, open: [...], closed: [...], retention: [...] }
 *   POST ?module=dp (every answer is the fresh view)
 *     { op: "log", kind, requester, contact, client_id?, channel, summary, received_on }
 *     { op: "act", id, version, action: note|verify_identity|start|take|complete|refuse|withdraw, text?, date? }
 *     { op: "retention", key, version: null | n, data, where_kept, kept_for, basis, how_deleted, decided, enforced, reason }
 *
 * Deadlines (one month from receipt), identity before work, compliance-only closing, the
 * append-only timeline and the audit record are all enforced in the admin database
 * (app_admin 0014). Request bodies hold personal data and are never logged.
 */
import { requireStaffIdentity, AuthError, type Staff } from "./access.js";
import { withAdmin, requestMeta, dbError, type Q, type Meta } from "./admin-db.js";
import { MIN_REASON } from "./checks.js";
import { isUuid } from "./offers.js";

type Req = { method?: string; headers: Record<string, string | string[] | undefined>; body?: unknown };
type Res = { status(code: number): Res; json(body: unknown): void; setHeader(k: string, v: string): void };

export type Deps = {
  requireStaff: (h: Req["headers"]) => Promise<Staff>;
  withAdmin: <T>(s: Staff, m: Meta, fn: (q: Q) => Promise<T>) => Promise<T>;
};
export const live = (): Deps => ({ requireStaff: (h) => requireStaffIdentity(h), withAdmin });

export const KINDS = ["access", "correction", "erasure", "restriction", "objection", "automated_decision", "withdraw_consent"] as const;
export const CHANNELS = ["email", "app", "letter", "phone", "in_person", "other"] as const;
export const ACTIONS = ["note", "verify_identity", "start", "take", "complete", "refuse", "withdraw"] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KEY = /^[a-z][a-z0-9_]{2,59}$/;

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const date = (v: unknown) => (typeof v === "string" && DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : null);
const view = async (q: Q) => (await q("select api.dp_view() as v")).rows[0]?.v ?? null;

/** The call to make, or the one line that says what to fix. Nothing here is logged. */
export function parse(b: Record<string, unknown>): { sql: string; params: unknown[] } | string {
  const op = str(b.op);
  if (op === "log") {
    const kind = str(b.kind), channel = str(b.channel), requester = str(b.requester), contact = str(b.contact), summary = str(b.summary);
    const clientId = str(b.client_id), received = date(b.received_on);
    if (!(KINDS as readonly string[]).includes(kind)) return "Choose what the person is asking for";
    if (!(CHANNELS as readonly string[]).includes(channel)) return "Choose how the request arrived";
    if (!requester || requester.length > 120) return "Give the requester's name (up to 120 characters)";
    if (!contact || contact.length > 200) return "Give a way to reach the requester (up to 200 characters)";
    if (summary.length < 10 || summary.length > 2000) return "Summarise the request in 10 to 2000 characters";
    if (clientId && !isUuid(clientId)) return "The borrower id is not valid: copy it from the Borrowers page, or leave it empty";
    if (!received) return "Give the date the request was received";
    return { sql: "select api.dp_log($1, $2, $3, $4, $5, $6, $7::date)", params: [kind, requester, contact, clientId || null, channel, summary, received] };
  }
  if (op === "act") {
    const id = str(b.id), action = str(b.action), text = str(b.text), version = Number(b.version);
    if (!isUuid(id) || !Number.isInteger(version)) return "Reload the page and try again";
    if (!(ACTIONS as readonly string[]).includes(action)) return "Unknown action";
    if (text.length > 2000) return "That text is too long (2000 characters at most)";
    const d = b.date == null || b.date === "" ? null : date(b.date);
    if (b.date && !d) return "Dates must look like 2026-12-31";
    return { sql: "select api.dp_act($1, $2, $3, $4, $5::date)", params: [id, version, action, text || null, d] };
  }
  if (op === "retention") {
    const key = str(b.key), reason = str(b.reason);
    const f = { data: str(b.data), where_kept: str(b.where_kept), kept_for: str(b.kept_for), basis: str(b.basis), how_deleted: str(b.how_deleted) };
    if (!KEY.test(key)) return "The short name must be 3 to 60 lowercase letters, digits or _";
    if (Object.values(f).some((v) => !v)) return "Every field is required";
    if (f.basis.length > 400 || f.how_deleted.length > 400 || f.data.length > 200 || f.where_kept.length > 200 || f.kept_for.length > 200) return "One of the fields is too long";
    if (typeof b.decided !== "boolean" || typeof b.enforced !== "boolean") return "Say whether the period is decided and whether the system enforces it";
    const version = b.version == null ? null : Number(b.version);
    if (version !== null && (!Number.isInteger(version) || version < 0)) return "Reload the page and try again";
    if (reason.length < MIN_REASON || reason.length > 2000) return `Give a reason of ${MIN_REASON} to 2000 characters`;
    return { sql: "select api.dp_retention_save($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
      params: [key, version, f.data, f.where_kept, f.kept_for, f.basis, f.how_deleted, b.decided, b.enforced, reason] };
  }
  return "Unknown action";
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
    try {
      if (req.method === "GET") return res.status(200).json(await deps.withAdmin(staff, meta, view));
      if (req.method !== "POST") { res.setHeader("Allow", "GET, POST"); return res.status(405).json({ error: "Method not allowed" }); }
      let b: Record<string, unknown>;
      try {
        b = ((typeof req.body === "string" ? JSON.parse(req.body) : req.body) ?? {}) as Record<string, unknown>;
      } catch {
        return res.status(400).json({ error: "Body must be JSON" });
      }
      const call = parse(b);
      if (typeof call === "string") return res.status(400).json({ error: call });
      const v = await deps.withAdmin(staff, meta, async (q) => { await q(call.sql, call.params); return view(q); });
      return res.status(200).json(v);
    } catch (e: any) {
      const m = dbError(e);
      if (m) return res.status(m.status).json({ error: m.error });
      if (e?.code === "42883") return res.status(503).json({ error: "Data protection is not set up on this database yet: its database change has not been applied" });
      // Code and message only: request bodies hold personal data.
      console.error("data protection error", e?.code, e?.message);
      return res.status(500).json({ error: "Data protection requests could not be loaded" });
    }
  };
}
