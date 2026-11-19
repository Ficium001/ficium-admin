/**
 * Complaints and support cases (app site only). Served by the /api/clients function file as
 * /api/clients?module=cases: the Vercel plan allows 12 function files and this repo has 12.
 *
 *   GET  ?module=cases -> { actor, now, today, can_manage, can_resolve_complaint, open, closed, targets, complaints_12m }
 *   POST ?module=cases (every answer is the fresh view)
 *     { op: "open", kind, category, subject, detail, requester, contact, client_id?, channel, received_at }
 *     { op: "act", id, version, action, text?, upheld?, redress?, at? }
 *     { op: "target", kind, version, ack_hours, resolve_days, reason }
 *
 * Deadlines copied from the targets, compliance-only complaint decisions, redress for upheld
 * complaints, the append-only timeline and the audit record are enforced in the admin database
 * (app_admin 0016). Request bodies hold personal data and are never logged.
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

export const KINDS = ["complaint", "problem", "question", "feedback"] as const;
export const CATEGORIES = ["kyc", "request", "bids", "deal", "account", "app", "fees", "privacy", "conduct", "other"] as const;
export const CHANNELS = ["email", "app", "phone", "letter", "in_person", "social", "other"] as const;
export const ACTIONS = ["note", "acknowledge", "take", "resolve", "withdraw", "reopen", "referred"] as const;
const UPHELD = ["upheld", "partly", "not_upheld"] as const;

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const instant = (v: unknown) => (typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
const among = (list: readonly string[], v: string) => list.includes(v);
const view = async (q: Q) => (await q("select api.case_view() as v")).rows[0]?.v ?? null;

/** The call to make, or the one line that says what to fix. */
export function parse(b: Record<string, unknown>): { sql: string; params: unknown[] } | string {
  const op = str(b.op);
  if (op === "open") {
    const f = { kind: str(b.kind), category: str(b.category), subject: str(b.subject), detail: str(b.detail),
      requester: str(b.requester), contact: str(b.contact), client: str(b.client_id), channel: str(b.channel) };
    const received = instant(b.received_at);
    if (!among(KINDS, f.kind)) return "Choose what kind of case this is";
    if (!among(CATEGORIES, f.category)) return "Choose what it is about";
    if (!among(CHANNELS, f.channel)) return "Choose how it arrived";
    if (f.subject.length < 5 || f.subject.length > 120) return "Give a subject of 5 to 120 characters";
    if (f.detail.length < 10 || f.detail.length > 4000) return "Describe it in 10 to 4000 characters";
    if (!f.requester || f.requester.length > 120) return "Give the person's name (up to 120 characters)";
    if (!f.contact || f.contact.length > 200) return "Give a way to reach them (up to 200 characters)";
    if (f.client && !isUuid(f.client)) return "The borrower id is not valid: copy it from Borrowers, or leave it empty";
    if (!received) return "Give when it was received";
    return { sql: "select api.case_open($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)",
      params: [f.kind, f.category, f.subject, f.detail, f.requester, f.contact, f.client || null, f.channel, received] };
  }
  if (op === "act") {
    const id = str(b.id), action = str(b.action), text = str(b.text), upheld = str(b.upheld), redress = str(b.redress);
    const version = Number(b.version);
    if (!isUuid(id) || !Number.isInteger(version)) return "Reload the page and try again";
    if (!among(ACTIONS, action)) return "Unknown action";
    if (text.length > 4000) return "That text is too long (4000 characters at most)";
    if (upheld && !among(UPHELD, upheld)) return "Say whether the complaint is upheld, partly upheld or not upheld";
    if (redress.length > 1000) return "The redress is too long (1000 characters at most)";
    const at = b.at == null || b.at === "" ? null : instant(b.at);
    if (b.at && !at) return "Give a valid date and time";
    return { sql: "select api.case_act($1, $2, $3, $4, $5, $6, $7::timestamptz)",
      params: [id, version, action, text || null, upheld || null, redress || null, at] };
  }
  if (op === "target") {
    const kind = str(b.kind), reason = str(b.reason), version = Number(b.version);
    const ack = Number(b.ack_hours), days = Number(b.resolve_days);
    if (!among(KINDS, kind) || !Number.isInteger(version)) return "Reload the page and try again";
    if (!Number.isInteger(ack) || ack < 1 || ack > 720 || !Number.isInteger(days) || days < 1 || days > 365) {
      return "Acknowledge within 1 to 720 hours, answer within 1 to 365 days";
    }
    if (reason.length < MIN_REASON || reason.length > 2000) return `Give a reason of ${MIN_REASON} to 2000 characters`;
    return { sql: "select api.case_target_save($1, $2, $3, $4, $5)", params: [kind, version, ack, days, reason] };
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
      return res.status(200).json(await deps.withAdmin(staff, meta, async (q) => { await q(call.sql, call.params); return view(q); }));
    } catch (e: any) {
      const m = dbError(e);
      if (m) return res.status(m.status).json({ error: m.error });
      if (e?.code === "42883") return res.status(503).json({ error: "Cases are not set up on this database yet: its database change has not been applied" });
      console.error("support cases error", e?.code, e?.message);
      return res.status(500).json({ error: "Cases could not be loaded" });
    }
  };
}
