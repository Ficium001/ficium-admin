/**
 * The one place that turns APP_ADMIN_SYNC_URL into a borrower-app endpoint.
 *
 * APP_ADMIN_SYNC_URL names the borrower app's internal API: https://<host>/api/internal. Every
 * caller says which operation it wants and this sets ?op= itself, overwriting whatever the
 * variable carries. So the variable may be given with or without "?op=admin-sync" and still works.
 *
 * Why: on 2026-11-25 the variable lost its "?op=admin-sync". Every other caller already set its own
 * op and kept working, but the sync posted the URL as given, the app routed it as a legacy internal
 * call and answered 403, and admin changes stopped reaching the app for four hours with nothing on
 * the Services page to say so. Anything this cannot repair (not https, wrong path, not a URL) is a
 * configuration problem: appEndpointProblem names it for the health check and the Services page,
 * and appEndpoint refuses, so no request goes to the wrong place.
 */
type Env = Record<string, string | undefined>;

export type AppOp = "admin-sync" | "admin-kyc" | "admin-clients" | "admin-app";

export const APP_ENDPOINT_PATH = "/api/internal";

export class AppEndpointError extends Error {}

/** Null when APP_ADMIN_SYNC_URL is usable (or not set at all); otherwise what is wrong with it. */
export function appEndpointProblem(env: Env = process.env): string | null {
  const raw = env.APP_ADMIN_SYNC_URL?.trim();
  if (!raw) return null; // "not configured" is reported separately, with its own wording
  let u: URL;
  try { u = new URL(raw); } catch { return "APP_ADMIN_SYNC_URL is not a valid URL."; }
  if (u.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(u.hostname)) {
    return "APP_ADMIN_SYNC_URL must use https.";
  }
  if (u.pathname.replace(/\/+$/, "") !== APP_ENDPOINT_PATH) {
    return `APP_ADMIN_SYNC_URL must point at the borrower app's ${APP_ENDPOINT_PATH} (it points at "${u.pathname}").`;
  }
  return null;
}

/** The URL for one operation. Throws AppEndpointError if APP_ADMIN_SYNC_URL is unset or unusable. */
export function appEndpoint(op: AppOp, env: Env = process.env): URL {
  const raw = env.APP_ADMIN_SYNC_URL?.trim();
  if (!raw) throw new AppEndpointError("APP_ADMIN_SYNC_URL is not set.");
  const problem = appEndpointProblem(env);
  if (problem) throw new AppEndpointError(problem);
  const u = new URL(raw);
  u.pathname = APP_ENDPOINT_PATH; // drops a trailing slash
  u.searchParams.set("op", op);
  return u;
}
