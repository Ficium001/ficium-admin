/**
 * Incidents (both sites). Served by the /api/audit function file as /api/audit?module=incidents:
 * the Vercel plan allows 12 function files and this repo has 12.
 *
 *   GET  ?module=incidents -> { actor, now, can_manage, can_close, open: [...], closed: [...] }
 *   POST ?module=incidents (every answer is the fresh view)
 *     { op: "open", title, severity, kind, service_key?, impact, started_at, detected_at, personal_data }
 *     { op: "act", id, version, action, text?, at?, number?, owner?, date?, follow_up? }
 *
 * The order of things (mitigate, resolve, root cause, follow-ups, close), the 72-hour breach clock,
 * compliance-only decisions and the audit record are enforced in the admin database
 * (app_admin 0015 / portal_admin 0013). Request bodies are never logged.
 */
import { requireStaffIdentity, AuthError, type Staff } from "./access.js";
import { withAdmin, requestMeta, dbError, type Q, type Meta } from "./admin-db.js";
import { isUuid } from "./offers.js";

type Req = { method?: string; headers: Record<string, string | string[] | undefined>; body?: unknown };
type Res = { status(code: number): Res; json(body: unknown): void; setHeader(k: string, v: string): void };
type Run = (sql: string) => Promise<{ rows: any[] }>;

export type Deps = {
  requireStaff: (h: Req["headers"]) => Promise<Staff>;
  withAdmin: <T>(s: Staff, m: Meta, fn: (q: Q) => Promise<T>) => Promise<T>;
};
export const live = (): Deps => ({ requireStaff: (h) => requireStaffIdentity(h), withAdmin });

export const KINDS = ["outage", "degraded", "security", "data", "third_party", "change", "other"] as const;
export const ACTIONS = ["update", "severity", "take", "mitigated", "resolved", "personal_data", "breach_reported",
  "breach_not_reported", "people_told", "root_cause", "follow_up", "follow_up_done", "close"] as const;
const KEY = /^[a-z][a-z0-9_]{2,59}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const instant = (v: unknown) => (typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
const view = async (q: Q) => (await q("select api.incident_view() as v")).rows[0]?.v ?? null;

/** The call to make, or the one line that says what to fix. */
export function parse(b: Record<string, unknown>): { sql: string; params: unknown[] } | string {
  const op = str(b.op);
  if (op === "open") {
    const title = str(b.title), kind = str(b.kind), impact = str(b.impact), service = str(b.service_key);
    const severity = Number(b.severity), started = instant(b.started_at), detected = instant(b.detected_at);
    if (title.length < 5 || title.length > 120) return "Give a title of 5 to 120 characters";
    if (![1, 2, 3].includes(severity)) return "Choose a severity";
    if (!(KINDS as readonly string[]).includes(kind)) return "Choose what kind of incident this is";
    if (impact.length < 10 || impact.length > 2000) return "Describe who or what is affected in 10 to 2000 characters";
    if (service && !KEY.test(service)) return "Unknown service";
    if (!started || !detected) return "Give when it started and when it was noticed";
    if (typeof b.personal_data !== "boolean") return "Say whether personal data is involved";
    return { sql: "select api.incident_open($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8)",
      params: [title, severity, kind, service || null, impact, started, detected, b.personal_data] };
  }
  if (op === "act") {
    const id = str(b.id), action = str(b.action), text = str(b.text), owner = str(b.owner), fu = str(b.follow_up);
    const version = Number(b.version);
    if (!isUuid(id) || !Number.isInteger(version)) return "Reload the page and try again";
    if (!(ACTIONS as readonly string[]).includes(action)) return "Unknown action";
    if (text.length > 4000) return "That text is too long (4000 characters at most)";
    if (owner.length > 120) return "The owner is too long";
    const at = b.at == null || b.at === "" ? null : instant(b.at);
    if (b.at && !at) return "Give a valid date and time";
    const date = b.date == null || b.date === "" ? null : (typeof b.date === "string" && DATE.test(b.date) ? b.date : undefined);
    if (date === undefined) return "Dates must look like 2026-12-31";
    const number = b.number == null || b.number === "" ? null : Number(b.number);
    if (number !== null && ![1, 2, 3].includes(number)) return "Severity is 1, 2 or 3";
    if (fu && !isUuid(fu)) return "Reload the page and try again";
    return { sql: "select api.incident_act($1, $2, $3, $4, $5::timestamptz, $6, $7, $8::date, $9)",
      params: [id, version, action, text || null, at, number, owner || null, date, fu || null] };
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
      if (e?.code === "42883") return res.status(503).json({ error: "Incidents are not set up on this database yet: its database change has not been applied" });
      console.error("incidents error", e?.code, e?.message);
      return res.status(500).json({ error: "Incidents could not be loaded" });
    }
  };
}

/* ---------- alerts for the Audit health banner and the hourly dispatcher ---------- */

export type IncidentAlerts = { open_major: { ref: string; severity: number; title: string }[]; breach_due: { ref: string; due_at: string }[]; open: number };

/** null when the incident register's database change is not applied yet: the drift alarm reports that. */
export async function readIncidentAlerts(run: Run, inTransaction: boolean): Promise<IncidentAlerts | null> {
  if (inTransaction) await run("savepoint incident_alerts");
  try {
    const v = (await run("select api.incident_alerts() as v")).rows[0]?.v ?? null;
    if (inTransaction) await run("release savepoint incident_alerts");
    return v as IncidentAlerts | null;
  } catch (e: any) {
    if (inTransaction) await run("rollback to savepoint incident_alerts");
    if (e?.code === "42883") return null;
    throw e;
  }
}

const WHEN = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Indian/Mauritius" });

/** Every open breach deadline and every open severity 1 or 2 is an alert: each needs someone now. */
export function incidentLines(a: IncidentAlerts | null, now: number = Date.now()): string[] {
  if (!a) return [];
  const out: string[] = [];
  for (const b of a.breach_due) {
    const due = Date.parse(b.due_at);
    const hours = Math.round((due - now) / 3_600_000);
    out.push(hours >= 0
      ? `${b.ref} involves personal data: tell the Data Protection Commissioner by ${WHEN.format(due)} (${hours} h left), or record why it is not needed.`
      : `${b.ref} involves personal data and the 72 hours to tell the Data Protection Commissioner passed ${-hours} h ago. Report it now, with the reasons for the delay.`);
  }
  for (const i of a.open_major) out.push(`Severity ${i.severity} incident open: ${i.ref} ${i.title}.`);
  return out;
}
