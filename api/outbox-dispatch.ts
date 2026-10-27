/**
 * GET /api/outbox-dispatch — called hourly by the App DB scheduler
 * (pg_cron job admin-outbox-sweep) and, after the cut-over, by the admin API.
 *
 * Not behind Cloudflare Access (the scheduler calls the deployment directly), so
 * it is protected by CRON_SECRET, sent as "Authorization: Bearer ...".
 * Fail closed: no/short secret => 503; wrong or missing header => 401.
 * It takes no input: the only thing a caller can cause is "drain the outbox".
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { dispatch, type Stats } from "./_lib/outbox.js";
import { liveDeps } from "./_lib/sync-db.js";
import { onlyOn } from "./_lib/site.js";

type Req = { method?: string; headers: Record<string, string | string[] | undefined> };
type Res = { status(code: number): Res; json(body: unknown): void; setHeader(k: string, v: string): void };
export type Deps = { run: () => Promise<Stats>; env: Record<string, string | undefined> };

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
    try {
      const stats = await deps.run();
      return res.status(200).json(stats);
    } catch (e: any) {
      console.error("outbox dispatch error", e?.code, e?.message);
      return res.status(500).json({ error: "Dispatch failed" });
    }
  };
}

export default onlyOn("app", makeHandler({ run: () => dispatch(liveDeps()), env: process.env }));
