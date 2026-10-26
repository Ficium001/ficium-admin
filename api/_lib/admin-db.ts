/**
 * The admin database (Neon, app_admin) as seen by the admin pages.
 *
 * ADMIN_DB_API_URL connects as app_admin_backend, which can only EXECUTE api.*
 * functions — no table access. Every request is ONE transaction that starts
 * with api.begin_session(verified subject, verified email, ...); the database
 * then decides who the admin is and what they may do, and audits it.
 */
import pg from "pg";
import { isIP } from "node:net";
import { stripSslParams } from "./sync-db.js";
import { dispatch, errorText } from "./outbox.js";
import { liveDeps } from "./sync-db.js";
import type { Staff } from "./access.js";

export type Q = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
export type Meta = { requestId: string | null; ip: string | null; userAgent: string | null };
type Headers = Record<string, string | string[] | undefined>;

let pool: pg.Pool | null = null;
function adminPool(): pg.Pool {
  if (!pool) {
    const url = process.env.ADMIN_DB_API_URL;
    if (!url) throw Object.assign(new Error("ADMIN_DB_API_URL is not set"), { code: "CONFIG" });
    pool = new pg.Pool({ connectionString: stripSslParams(url.trim()), max: 2, ssl: { rejectUnauthorized: true } });
  }
  return pool;
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;

export function requestMeta(h: Headers): Meta {
  const fwd = first(h["x-forwarded-for"])?.split(",")[0]?.trim() ?? null;
  return {
    requestId: first(h["x-vercel-id"])?.slice(0, 128) ?? null,
    ip: fwd && isIP(fwd) ? fwd : null,
    userAgent: first(h["user-agent"])?.slice(0, 512) ?? null,
  };
}

export async function withAdmin<T>(staff: Staff, meta: Meta, fn: (q: Q) => Promise<T>): Promise<T> {
  const c = await adminPool().connect();
  try {
    await c.query("begin");
    await c.query("select api.begin_session($1, $2, $3, $4::inet, $5)",
      [staff.sub, staff.email, meta.requestId, meta.ip, meta.userAgent]);
    const out = await fn((sql, params) => c.query(sql, params));
    await c.query("commit");
    return out;
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** Push just-committed changes to the App DB now; the hourly sweep retries anything left. */
export async function kickDispatch(): Promise<void> {
  try {
    await dispatch(liveDeps(), { batch: 25, leaseSeconds: 60, budgetMs: 4000 });
  } catch (e) {
    console.warn("outbox kick failed; the hourly sweep will retry", errorText(e));
  }
}

/** Database error -> HTTP answer. Messages from our own api.* RAISEs are safe to show. */
export function dbError(e: any): { status: number; error: string } | null {
  switch (e?.code) {
    case "22023": return { status: 400, error: String(e.message) };
    case "P0002": return { status: 404, error: String(e.message) };
    case "40001": return { status: 409, error: "Someone changed this since you opened it. Reload and try again" };
    case "42501": return { status: 403, error: String(e.message) };
    case "28000": return { status: 403, error: "You are not an active admin of this app" };
    case "23502": case "23503": case "23514": case "22P02": case "22007": case "22008":
      return { status: 400, error: "One of the fields isn't valid" };
    case "CONFIG": return { status: 503, error: "The admin database is not configured on this deployment" };
    default: return null;
  }
}
