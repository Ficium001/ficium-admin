/**
 * Connections used ONLY by the outbox dispatcher.
 *
 * ADMIN_DB_WORKER_URL  Neon app_admin as app_admin_worker: can call
 *                      api.outbox_claim/ack/nack and nothing else.
 * APP_DB_SYNC_URL      App DB (Supabase pooler) as ficium_admin_sync: can call
 *                      admin.sync_apply and nothing else.
 *
 * TLS: Neon presents a publicly trusted certificate, so it is always fully
 * verified. The Supabase pooler uses Supabase's own CA: set APP_DB_CA_CERT
 * (the PEM from Supabase -> Database settings -> SSL) to verify it.
 */
import pg from "pg";
import type { DispatchDeps, OutboxEvent, Outcome } from "./outbox.js";
import { appSyncApply, appSyncConfigured } from "./app-sync.js";

let neon: pg.Pool | null = null;
let app: pg.Pool | null = null;
let warned = false;
let warnedLegacy = false;

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

function appPool(): pg.Pool {
  if (!app) {
    const ca = process.env.APP_DB_CA_CERT;
    if (!ca && !warned) { warned = true; console.warn("APP_DB_CA_CERT not set: App DB TLS certificate is not verified"); }
    app = new pg.Pool({
      connectionString: stripSslParams(need("APP_DB_SYNC_URL")), max: 1,
      ssl: ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false },
    });
  }
  return app;
}

export function liveDeps(): DispatchDeps {
  return {
    async claim(limit, leaseSeconds) {
      const r = await neonPool().query(
        `select id::text, topic, aggregate_type, aggregate_id, aggregate_version::text, payload, attempts
           from api.outbox_claim($1, $2)`, [limit, leaseSeconds]);
      return r.rows as OutboxEvent[];
    },
    // HTTPS to the app's API when configured (the target). The direct App DB
    // connection below is legacy and goes away once every deployment has
    // APP_ADMIN_SYNC_URL + APP_ADMIN_SYNC_SIGNING_KEY.
    apply: appSyncConfigured() ? appSyncApply() : legacyApply,
    async ack(id) { await neonPool().query("select api.outbox_ack($1::uuid)", [id]); },
    async nack(id, error) { await neonPool().query("select api.outbox_nack($1::uuid, $2)", [id, error]); },
    now: () => Date.now(),
  };
}

/** LEGACY: direct App DB connection. Removed once the HTTPS path is live everywhere. */
async function legacyApply(e: OutboxEvent): Promise<Outcome> {
  if (!warnedLegacy) {
    warnedLegacy = true;
    console.warn("admin sync uses the direct App DB connection: set APP_ADMIN_SYNC_URL and APP_ADMIN_SYNC_SIGNING_KEY");
  }
  const r = await appPool().query(
    "select admin.sync_apply($1::uuid, $2, $3, $4, $5::bigint, $6::jsonb) as outcome",
    [e.id, e.topic, e.aggregate_type, e.aggregate_id, e.aggregate_version, JSON.stringify(e.payload)]);
  return r.rows[0].outcome as Outcome;
}
