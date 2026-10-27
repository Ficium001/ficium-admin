/**
 * One codebase, two sites. Each Vercel project sets ADMIN_SITE:
 *   app    (default) — borrower-app admin: KYC, offers, team. Admin DB: app_admin.
 *   portal           — institution-portal admin: compliance, team. Admin DB: portal_admin.
 * ADMIN_DB_API_URL on each project points at that site's own database, so the
 * two sites share code but never data or credentials.
 */
export type Site = "app" | "portal";
type Env = Record<string, string | undefined>;

export const currentSite = (env: Env = process.env): Site => (env.ADMIN_SITE === "portal" ? "portal" : "app");

type Res = { status(code: number): Res; json(body: unknown): void; setHeader(k: string, v: string): void };

/** An endpoint that exists on one site only answers 404 on the other. */
export function onlyOn<Req, R extends Res>(site: Site, handler: (req: Req, res: R) => unknown, env: Env = process.env) {
  return async (req: Req, res: R) => {
    if (currentSite(env) !== site) {
      res.setHeader("Cache-Control", "no-store");
      return res.status(404).json({ error: "Not found" });
    }
    return handler(req, res);
  };
}
