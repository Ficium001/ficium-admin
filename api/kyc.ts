/**
 * GET  /api/kyc  -> { actor, settings, history }
 * POST /api/kyc  { key, value, reason } -> { settings }
 * The actor recorded in the audit log is the verified Access identity, never
 * anything the browser sends.
 */
import { requireStaff, AuthError } from "./_lib/access.js";
import { db } from "./_lib/db.js";
import { isCheckKey, MIN_REASON } from "./_lib/checks.js";

type Req = { method?: string; headers: Record<string, string | string[] | undefined>; body?: unknown };
type Res = { status(code: number): Res; json(body: unknown): void; setHeader(k: string, v: string): void };

export type Deps = { requireStaff: typeof requireStaff; query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };
const live: Deps = { requireStaff, query: (sql, params) => db().query(sql, params) };

export function makeHandler(deps: Deps) {
  return async function handler(req: Req, res: Res) {
    res.setHeader("Cache-Control", "no-store");
    let actor: string;
    try {
      actor = await deps.requireStaff(req.headers);
    } catch (e) {
      const status = e instanceof AuthError ? e.status : 401;
      return res.status(status).json({ error: e instanceof Error ? e.message : "Not signed in" });
    }

    try {
      if (req.method === "GET") {
        const [s, h] = await Promise.all([
          deps.query("select * from public.kyc_settings where id = 1"),
          deps.query("select id, changed_at, check_key, old_value, new_value, actor, reason from admin.kyc_settings_change order by changed_at desc limit 100"),
        ]);
        return res.status(200).json({ actor, settings: s.rows[0] ?? null, history: h.rows });
      }

      if (req.method === "POST") {
        const b = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) as Record<string, unknown> | undefined;
        const key = b?.key, value = b?.value, reason = typeof b?.reason === "string" ? b.reason.trim() : "";
        if (!isCheckKey(key)) return res.status(400).json({ error: "Unknown check" });
        if (typeof value !== "boolean") return res.status(400).json({ error: "value must be true or false" });
        if (reason.length < MIN_REASON) return res.status(400).json({ error: `Give a reason of at least ${MIN_REASON} characters` });
        const r = await deps.query("select admin.set_kyc_check($1, $2, $3, $4) as settings", [key, value, actor, reason]);
        return res.status(200).json({ settings: r.rows[0]?.settings ?? null });
      }

      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "Method not allowed" });
    } catch (e: any) {
      if (e?.code === "22023") return res.status(400).json({ error: String(e.message) });
      console.error("kyc admin error", e?.code, e?.message);
      return res.status(500).json({ error: "The change could not be saved. Nothing was changed" });
    }
  };
}

export default makeHandler(live);
