/**
 * Connections used ONLY by the outbox dispatcher.
 *
 * ADMIN_DB_WORKER_URL  Neon app_admin as app_admin_worker: can call
 *                      api.outbox_claim/ack/nack and nothing else. TLS fully verified.
 *
 * Events reach the borrower app ONLY over its signed HTTPS API (app-sync.ts):
 * services never connect to each other's databases. The old direct App DB
 * connection (APP_DB_SYNC_URL, which skipped TLS verification without a CA)
 * was removed on 2026-11-14. Without APP_ADMIN_SYNC_URL + APP_ADMIN_SYNC_SIGNING_KEY
 * every event fails, is retried with backoff and dead-lettered, and the health
 * check reports it: nothing is silently dropped.
 */
import pg from "pg";
import type { DispatchDeps, OutboxEvent, Outcome } from "./outbox.js";
import { appSyncApply, appSyncConfigured } from "./app-sync.js";

let neon: pg.Pool | null = null;

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  try { parseDbUrl(v); } catch (e) { throw new Error(`${name}: ${(e as Error).message}`); }
  return v.trim();
}

/**
 * Parse a postgres URL. On failure, say WHAT is wrong with its shape — never
 * echo the value, which contains a password.
 */
export function parseDbUrl(raw: string): URL {
  const v = raw.trim();
  const problems: string[] = [];
  if (v !== raw) problems.push("has spaces or line breaks at the start/end");
  if (/^["'`]|["'`]$/.test(v)) problems.push("is wrapped in quotes");
  if (!/^postgres(ql)?:\/\//.test(v)) problems.push("must start with postgresql://");
  const auth = v.replace(/^postgres(ql)?:\/\//, "");
  const at = (auth.match(/@/g) ?? []).length;
  if (at === 0) problems.push("has no '@' between credentials and host");
  if (at > 1) problems.push("has more than one '@' (a password '@' must be written %40)");
  if (/[\[\]]/.test(auth.split("@").slice(0, -1).join("@"))) problems.push("has [ ] around the password (remove them)");
  if (/[#?/\s]/.test(auth.split("@").slice(0, -1).join("@"))) problems.push("password contains # ? / or a space (use letters and digits only)");
  if (/\s/.test(v)) problems.push("contains whitespace inside");
  let u: URL | null = null;
  try { u = new URL(v); } catch { problems.push("is not a valid URL"); }
  if (problems.length) throw new Error(`connection string ${[...new Set(problems)].join("; ")}`);
  return u!;
}

/**
 * TLS is decided here, not by the URL: node-postgres lets ssl* query
 * parameters override the ssl option, which could silently weaken it.
 */
export function stripSslParams(url: string): string {
  const u = parseDbUrl(url);
  for (const k of [...u.searchParams.keys()]) if (k.startsWith("ssl") || k === "channel_binding") u.searchParams.delete(k);
  return u.toString();
}

function neonPool(): pg.Pool {
  neon ??= new pg.Pool({ connectionString: stripSslParams(need("ADMIN_DB_WORKER_URL")), max: 1, ssl: { rejectUnauthorized: true } });
  return neon;
}

export function liveDeps(): DispatchDeps {
  return {
    async claim(limit, leaseSeconds) {
      const r = await neonPool().query(
        `select id::text, topic, aggregate_type, aggregate_id, aggregate_version::text, payload, attempts
           from api.outbox_claim($1, $2)`, [limit, leaseSeconds]);
      return r.rows as OutboxEvent[];
    },
    apply: appSyncConfigured() ? appSyncApply() : notConfigured,
    async ack(id) { await neonPool().query("select api.outbox_ack($1::uuid)", [id]); },
    async nack(id, error) { await neonPool().query("select api.outbox_nack($1::uuid, $2)", [id, error]); },
    now: () => Date.now(),
  };
}

export type Health = {
  healthy: boolean; alerts: string[];
  outbox: { pending: number; dead: number; oldest_pending_s: number | null } | null;
  chain: { ok: boolean; mode: string; head_pos: number | null; head_hash: string | null } | null;
};

/** Verifies the audit chain and reads the outbox state (api.ops_health_check, worker role). */
export async function healthCheck(): Promise<Health> {
  const r = await neonPool().query("select api.ops_health_check() as h");
  return r.rows[0].h as Health;
}

/** Fail closed: the event is nacked, retried and dead-lettered; health reports it. */
async function notConfigured(): Promise<Outcome> {
  throw new Error("admin sync not configured: set APP_ADMIN_SYNC_URL and APP_ADMIN_SYNC_SIGNING_KEY");
}
