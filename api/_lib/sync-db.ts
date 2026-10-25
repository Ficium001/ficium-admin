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

let neon: pg.Pool | null = null;
let app: pg.Pool | null = null;
let warned = false;

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

/**
 * TLS is decided here, not by the URL: node-postgres lets ssl* query
 * parameters override the ssl option, which could silently weaken it.
 */
export function stripSslParams(url: string): string {
  const u = new URL(url);
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
    async apply(e) {
      const r = await appPool().query(
        "select admin.sync_apply($1::uuid, $2, $3, $4, $5::bigint, $6::jsonb) as outcome",
        [e.id, e.topic, e.aggregate_type, e.aggregate_id, e.aggregate_version, JSON.stringify(e.payload)]);
      return r.rows[0].outcome as Outcome;
    },
    async ack(id) { await neonPool().query("select api.outbox_ack($1::uuid)", [id]); },
    async nack(id, error) { await neonPool().query("select api.outbox_nack($1::uuid, $2)", [id, error]); },
    now: () => Date.now(),
  };
}
