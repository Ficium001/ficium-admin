/**
 * Delivers one admin outbox event to the borrower app over HTTPS:
 * POST <APP_ADMIN_SYNC_URL> (the app's /api/internal?op=admin-sync), signed
 * with APP_ADMIN_SYNC_SIGNING_KEY (Ficium-Signature, same scheme as the
 * integration contract). The app applies it with admin.sync_apply, which is
 * idempotent and versioned, so a retry is always safe.
 *
 * This replaces the direct App DB connection (APP_DB_SYNC_URL): services talk
 * through APIs, never through each other's databases.
 */
import { sign } from "./portal-api.js";
import { appEndpoint } from "./app-endpoint.js";
import type { OutboxEvent, Outcome } from "./outbox.js";

type Env = Record<string, string | undefined>;
const OUTCOMES = new Set<Outcome>(["applied", "stale", "duplicate"] as Outcome[]);

export const appSyncConfigured = (env: Env = process.env) =>
  !!env.APP_ADMIN_SYNC_URL?.trim() && !!env.APP_ADMIN_SYNC_SIGNING_KEY?.trim();

export function appSyncApply(env: Env = process.env, f: typeof fetch = fetch) {
  return async (e: OutboxEvent): Promise<Outcome> => {
    const url = appEndpoint("admin-sync", env);
    const raw = JSON.stringify({
      event_id: e.id, topic: e.topic, aggregate_type: e.aggregate_type, aggregate_id: e.aggregate_id,
      aggregate_version: Number(e.aggregate_version), payload: e.payload,
    });
    const r = await f(url, {
      method: "POST", body: raw, signal: AbortSignal.timeout(10_000),
      headers: { "Content-Type": "application/json", "Ficium-Signature": sign(raw, env.APP_ADMIN_SYNC_SIGNING_KEY!.trim()) },
    });
    const b = (await r.json().catch(() => ({}))) as { outcome?: string; error?: string };
    // Any refusal is retried with backoff by the dispatcher and dead-lettered after 12 tries.
    if (!r.ok) throw new Error(`app answered ${r.status}${b.error ? ` (${b.error})` : ""}`);
    if (!OUTCOMES.has(b.outcome as Outcome)) throw new Error(`app answered an unknown outcome`);
    return b.outcome as Outcome;
  };
}
