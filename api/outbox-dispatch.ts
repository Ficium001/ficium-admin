/**
 * GET /api/outbox-dispatch — called hourly by the App DB scheduler
 * (pg_cron job admin-outbox-sweep) and, after the cut-over, by the admin API.
 *
 * Not behind Cloudflare Access (the scheduler calls the deployment directly), so
 * it is protected by CRON_SECRET, sent as "Authorization: Bearer ...".
 * Fail closed: no/short secret => 503; wrong or missing header => 401.
 * It takes no input: the only thing a caller can cause is "drain the outbox"
 * and "check health". After draining it verifies the audit chain and reads the
 * outbox backlog (api.ops_health_check). Every run logs the chain head
 * (position + hash): a copy outside the database that a rewritten or truncated
 * log can't match. Problems are logged as "ALERT ops health" (route that log
 * line to an alert) and shown on the site's Audit page.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { dispatch, type Stats } from "./_lib/outbox.js";
import { liveDeps, healthCheck, type Health } from "./_lib/sync-db.js";
import { onlyOn } from "./_lib/site.js";

type Req = { method?: string; headers: Record<string, string | string[] | undefined> };
type Res = { status(code: number): Res; json(body: unknown): void; setHeader(k: string, v: string): void };
export type Deps = { run: () => Promise<Stats>; health: () => Promise<Health>; env: Record<string, string | undefined> };

const digest = (s: string) => createHash("sha256").update(s).digest();

export function authorised(header: string | string[] | undefined, secret: string): boolean {
  const h = Array.isArray(header) ? header[0] : header;
  if (!h?.startsWith("Bearer ")) return false;
  return timingSafeEqual(digest(h.slice(7)), digest(secret));
}

export function makeHandler(deps: Deps) {
  return async function handler(req: Req, res: Res) {
    res.setHeader("Cache-Control", "no-store");
    const secret = deps.env.CRON_SECRET;
    if (!secret || secret.length < 32) return res.status(503).json({ error: "Dispatcher is not configured" });
    if (!authorised(req.headers["authorization"], secret)) return res.status(401).json({ error: "Unauthorised" });
    if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ error: "Method not allowed" }); }
    let stats: Stats;
    try {
      stats = await deps.run();
    } catch (e: any) {
      console.error("outbox dispatch error", e?.code, e?.message);
      stats = null as unknown as Stats;
    }
    // Health runs even if the dispatch failed: a failing sync is exactly when it matters.
    let health: Health | null = null;
    try {
      health = await deps.health();
      console.info("ops health", JSON.stringify({
        healthy: health.healthy, head_pos: health.chain?.head_pos ?? null, head_hash: health.chain?.head_hash ?? null,
        pending: health.outbox?.pending ?? null, dead: health.outbox?.dead ?? null,
      }));
      if (!health.healthy) console.error("ALERT ops health", JSON.stringify(health.alerts));
    } catch (e: any) {
      console.error("ALERT ops health check failed", e?.code, e?.message);
    }
    if (!stats) return res.status(500).json({ error: "Dispatch failed", health });
    return res.status(200).json({ ...stats, health });
  };
}

export default onlyOn("app", makeHandler({ run: () => dispatch(liveDeps()), health: healthCheck, env: process.env }));
