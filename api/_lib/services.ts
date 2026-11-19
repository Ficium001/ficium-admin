/**
 * Service health (both sites). Served by the /api/audit function file as /api/audit?module=services:
 * the Vercel plan allows 12 function files and this repo has 12. On a plan without that limit, move
 * the default export to api/services.ts unchanged.
 *
 *   GET  ?module=services            -> { actor, services: [...], results: [...], checked_at }
 *   POST ?module=services { op: "probe", key }  -> one fresh result for that service
 *
 * What this answers: is each service this site depends on answering RIGHT NOW. The API traffic page
 * next door answers a different question — what flowed in the last 24 hours and how much of it
 * failed. A service nobody has called shows "No traffic" there and is still either up or down; that
 * gap is what this page closes.
 *
 * Probes are a FIXED registry in this file and the browser sends a key, never a URL or a path. An
 * admin endpoint that forwarded a caller's URL would be a request-forging tool against everything
 * the deployment can reach, including cloud metadata.
 *
 * Every probe is READ-ONLY and safe to run at any time: a health endpoint, a public key set, a
 * SELECT 1, or a read this site already makes. Nothing here can be pointed at an endpoint that
 * changes data, which is why there is a "Test" button at all.
 */
import { requireStaffIdentity, AuthError, type Staff } from "./access.js";
import { withAdmin, requestMeta, dbError, type Q, type Meta } from "./admin-db.js";
import { portalApi, bearer, PortalApiError, type PortalCall } from "./portal-api.js";
import { currentSite, type Site } from "./site.js";
import { appReleases, type AppReleases } from "./app-releases.js";
import { readDrift, driftAlerts, hasDrift, dbFor } from "./schema-drift.js";
import { readCredentialAlerts, names } from "./credential-alerts.js";

type Req = { method?: string; headers: Record<string, string | string[] | undefined>; body?: unknown };
type Res = { status(code: number): Res; json(body: unknown): void; setHeader(k: string, v: string): void };
type Env = Record<string, string | undefined>;

/**
 * up: answering. slow: answering, but past SLOW_MS. down: refused, failed or answered wrongly.
 * attention: working, but something needs doing soon (a key due for renewal, a check that cannot see).
 */
export type Status = "up" | "slow" | "attention" | "down" | "not_configured" | "unknown";

/** One service, as the page describes it. Fixed per site; never built from a request. */
export type Service = {
  key: string;
  label: string;
  /** What it does, in plain words. */
  what: string;
  /** Where it runs, so staff know which console to open. */
  runs_on: string;
  /** What a passing test proves. */
  proves: string;
  /** What a passing test does NOT prove, so nobody over-reads a green row. */
  blind_to: string;
};

export type Result = {
  key: string;
  status: Status;
  /** Round trip in milliseconds, when there was one. */
  ms: number | null;
  /** One line a person can act on. Never a raw stack or a URL with credentials. */
  detail: string;
  /** Where to look next (a build log), only ever on a host this file allows. */
  link?: string;
  checked_at: string;
};

export const SLOW_MS = 2_000;
const TIMEOUT_MS = 8_000;
/** The same service is not probed again inside this window; the last answer is returned instead. */
export const MIN_INTERVAL_MS = 3_000;

const APP_SERVICES: Service[] = [
  { key: "admin_api", label: "This admin site's API", runs_on: "Vercel",
    what: "The API behind the pages you are looking at.",
    proves: "It is running and it answered this request.",
    blind_to: "Nothing else: if it were down you could not open this page." },
  { key: "admin_db", label: "Admin database", runs_on: "Neon (app_admin)",
    what: "Holds this site's own records: settings, approvals, the audit log.",
    proves: "It is reachable and answering queries, with the round trip from this deployment.",
    blind_to: "Whether any particular record is correct." },
  { key: "admin_schema", label: "Database changes", runs_on: "Admin database (app_admin)",
    what: "The database changes (migrations) this site's code was built with.",
    proves: "Every one has been applied, and none was edited afterwards.",
    blind_to: "The product's own databases: the Borrower app row checks the borrower app." },
  { key: "identity", label: "Sign-in service", runs_on: "Railway (ficium-auth)",
    what: "Signs in Ficium staff and bank users, and issues the tokens every site checks.",
    proves: "It is serving its public keys, so tokens can still be verified.",
    blind_to: "Whether a password or MFA sign-in itself succeeds." },
  { key: "borrower_app", label: "Borrower app", runs_on: "Vercel",
    what: "The app and website borrowers use, and its API.",
    proves: "Its API is answering, its database is reachable, and no database migration is missing.",
    blind_to: "Whether any individual page or feature works." },
  { key: "app_channel", label: "Channel to the borrower app", runs_on: "This site to the borrower app",
    what: "The signed connection this site uses to read from and push changes to the borrower app.",
    proves: "The signing key is accepted and the borrower app answers this site.",
    blind_to: "Whether a change already sent has been applied; the Audit page shows delivery." },
  { key: "delivery", label: "Delivery of changes", runs_on: "Admin database and the hourly sweep",
    what: "Approved changes wait here until the borrower app has taken them.",
    proves: "Nothing is stuck: no failed deliveries, and nothing waiting too long.",
    blind_to: "Whether the next delivery will succeed." },
  { key: "credentials", label: "Keys and tokens", runs_on: "Admin database (app_admin)",
    what: "The register of every key and token this site and the borrower app depend on, and when each must be replaced.",
    proves: "None has passed its date, and none is due within 14 days.",
    blind_to: "Keys missing from the register, and whether a recorded date is right: the register is only as good as what is entered." },
  { key: "deploy_borrower_app", label: "Borrower app deploys", runs_on: "Vercel, from GitHub ficium",
    what: "Builds and publishes the borrower app and website from main.",
    proves: "The latest commit on main was built and published to production.",
    blind_to: "Why a build failed (the build log says), and whether the published version works (the rows above test that)." },
  { key: "deploy_app_admin", label: "This admin site's deploys", runs_on: "Vercel, from GitHub ficium-admin",
    what: "Builds and publishes this admin site from main.",
    proves: "The latest commit on main was built and published to production.",
    blind_to: "Why a build failed (the build log says), and whether the published version works (the rows above test that)." },
  { key: "deploy_auth", label: "Sign-in service deploys", runs_on: "Railway, from GitHub ficium-auth",
    what: "Builds and publishes the sign-in service from main.",
    proves: "The latest commit on main was built and published to production.",
    blind_to: "Why a build failed (the build log says), and whether the published version works (the rows above test that)." },
];

const PORTAL_SERVICES: Service[] = [
  { key: "admin_api", label: "This admin site's API", runs_on: "Vercel",
    what: "The API behind the pages you are looking at.",
    proves: "It is running and it answered this request.",
    blind_to: "Nothing else: if it were down you could not open this page." },
  { key: "admin_db", label: "Admin database", runs_on: "Neon (portal_admin)",
    what: "Holds this site's own records: banks, compliance, commission, the audit log.",
    proves: "It is reachable and answering queries, with the round trip from this deployment.",
    blind_to: "Whether any particular record is correct." },
  { key: "admin_schema", label: "Database changes", runs_on: "Admin database (portal_admin)",
    what: "The database changes (migrations) this site's code was built with.",
    proves: "Every one has been applied, and none was edited afterwards.",
    blind_to: "The product's own databases: the portal database has no such check yet." },
  { key: "identity", label: "Sign-in service", runs_on: "Railway (ficium-auth)",
    what: "Signs in Ficium staff and bank users, and issues the tokens every site checks.",
    proves: "It is serving its public keys, so tokens can still be verified.",
    blind_to: "Whether a password or MFA sign-in itself succeeds." },
  { key: "portal_api", label: "Portal API", runs_on: "Railway (ficium-portal-api)",
    what: "The API behind the bank portal and the public /v1 API banks call.",
    proves: "The service is running and answering.",
    blind_to: "Whether its database is reachable: its health check does not touch it. The channel test below does." },
  { key: "portal_channel", label: "Channel to the portal", runs_on: "This site to the portal API",
    what: "The signed connection this site uses to read portal data and send commands.",
    proves: "The signing key and your own sign-in are accepted, and the portal database answered.",
    blind_to: "Whether a command already sent was carried out; the Audit page shows that." },
  { key: "credentials", label: "Keys and tokens", runs_on: "Admin database (portal_admin)",
    what: "The register of every key and token this site and the bank portal depend on, and when each must be replaced.",
    proves: "None has passed its date, and none is due within 14 days.",
    blind_to: "Keys missing from the register, and whether a recorded date is right: the register is only as good as what is entered." },
  { key: "deploy_portal", label: "Bank portal deploys", runs_on: "Vercel, from GitHub ficium-portal",
    what: "Builds and publishes the bank portal website from main.",
    proves: "The latest commit on main was built and published to production.",
    blind_to: "Why a build failed (the build log says), and whether the published version works (the rows above test that)." },
  { key: "deploy_portal_api", label: "Portal API deploys", runs_on: "Railway, from GitHub ficium-portal-api",
    what: "Builds and publishes the portal API from main.",
    proves: "The latest commit on main was built and published to production.",
    blind_to: "Why a build failed (the build log says), and whether the published version works (the rows above test that)." },
  { key: "deploy_portal_admin", label: "This admin site's deploys", runs_on: "Vercel, from GitHub ficium-admin",
    what: "Builds and publishes this admin site from main.",
    proves: "The latest commit on main was built and published to production.",
    blind_to: "Why a build failed (the build log says), and whether the published version works (the rows above test that)." },
  { key: "deploy_auth", label: "Sign-in service deploys", runs_on: "Railway, from GitHub ficium-auth",
    what: "Builds and publishes the sign-in service from main.",
    proves: "The latest commit on main was built and published to production.",
    blind_to: "Why a build failed (the build log says), and whether the published version works (the rows above test that)." },
];

export const servicesFor = (site: Site): Service[] => (site === "portal" ? PORTAL_SERVICES : APP_SERVICES);

/** Origin only, so a probe can never be aimed at a path a caller chose. */
export function originOf(url: string | undefined): string | null {
  if (!url?.trim()) return null;
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(u.hostname)) return null;
    return u.origin;
  } catch {
    return null;
  }
}

const now = () => new Date().toISOString();
const rate = (ms: number, detail: string): Pick<Result, "status" | "ms" | "detail"> =>
  ({ status: ms > SLOW_MS ? "slow" : "up", ms, detail: ms > SLOW_MS ? `${detail} Slower than ${SLOW_MS / 1000} s.` : detail });

/** A read-only GET with a timeout. Never returns the body to the caller, only a verdict. */
async function getJson(url: string, f: typeof fetch, headers: Record<string, string> = {}) {
  const started = Date.now();
  try {
    const r = await f(url, { method: "GET", headers: { Accept: "application/json", ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = (await r.json().catch(() => null)) as any;
    return { ms: Date.now() - started, ok: r.ok, status: r.status, body };
  } catch {
    return { ms: Date.now() - started, ok: false, status: 0, body: null };
  }
}

/**
 * Production deploys, read from the commit statuses Vercel and Railway post on GitHub for the
 * latest commit on main. Fixed here: the browser never names a repository.
 *
 * GITHUB_STATUS_TOKEN must be a fine-grained token, owner Ficium001, limited to these repositories,
 * with "Commit statuses: read" and nothing else. Vercel tokens are not used: they cannot be made
 * read-only, so a leaked one could change or delete deployments.
 */
export const GITHUB_OWNER = "Ficium001";
export type DeployTarget = { repo: string; host: "Vercel" | "Railway"; context: RegExp };
export const DEPLOYS: Record<string, DeployTarget> = {
  deploy_borrower_app: { repo: "ficium", host: "Vercel", context: /^Vercel$/ },
  deploy_app_admin: { repo: "ficium-admin", host: "Vercel", context: /^Vercel\s+[–-]\s+ficium-admin$/ },
  deploy_portal: { repo: "ficium-portal", host: "Vercel", context: /^Vercel$/ },
  deploy_portal_admin: { repo: "ficium-admin", host: "Vercel", context: /^Vercel\s+[–-]\s+ficium-portal-admin$/ },
  deploy_portal_api: { repo: "ficium-portal-api", host: "Railway", context: /\s-\s+ficium-portal-api$/ },
  deploy_auth: { repo: "ficium-auth", host: "Railway", context: /\s-\s+ficium-auth$/ },
};
/** A pending deploy older than this is stuck, not running. */
export const DEPLOY_STUCK_MS = 30 * 60_000;
const LOG_HOSTS = /^(vercel\.com|railway\.com|railway\.app)$/;

/** The build log link, only when it points at Vercel or Railway over https. */
export function logLink(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && LOG_HOSTS.test(u.hostname) && !u.username && !u.password ? u.href : undefined;
  } catch {
    return undefined;
  }
}

const WHEN = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Indian/Mauritius" });
const when = (iso: unknown) => (typeof iso === "string" && !Number.isNaN(Date.parse(iso)) ? WHEN.format(new Date(iso)) : "an unknown time");

/** ms is always null: GitHub's round trip says nothing about the deployed service. */
export async function deployProbe(t: DeployTarget, c: ProbeContext, at: number = Date.now()): Promise<Pick<Result, "status" | "ms" | "detail" | "link">> {
  const token = c.env.GITHUB_STATUS_TOKEN?.trim();
  if (!token) {
    return { status: "not_configured", ms: null,
      detail: "Add GITHUB_STATUS_TOKEN (read-only commit statuses) to this site to see deploys." };
  }
  const r = await getJson(`https://api.github.com/repos/${GITHUB_OWNER}/${t.repo}/commits/main/status`, c.fetchImpl, {
    Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "ficium-admin",
  });
  if (!r.ok) {
    if (r.status === 0) return { status: "unknown", ms: null, detail: "GitHub could not be reached, so the last deploy is unknown." };
    if (r.status === 401) {
      return { status: "attention", ms: null,
        detail: "GitHub refused GITHUB_STATUS_TOKEN: it has expired or was revoked. Make a new one and update Keys and tokens." };
    }
    if (r.status === 403 || r.status === 429) {
      if (/rate limit/i.test(String(r.body?.message ?? ""))) return { status: "unknown", ms: null, detail: "GitHub's rate limit was reached. Test again in a few minutes." };
      return { status: "attention", ms: null, detail: `GITHUB_STATUS_TOKEN cannot read ${GITHUB_OWNER}/${t.repo}. Add this repository to the token.` };
    }
    if (r.status === 404 || r.status === 422) {
      return { status: "attention", ms: null, detail: `GITHUB_STATUS_TOKEN cannot see ${GITHUB_OWNER}/${t.repo} or its main branch. Add this repository to the token.` };
    }
    return { status: "unknown", ms: null, detail: `GitHub answered ${r.status}.` };
  }
  const sha = typeof r.body?.sha === "string" ? r.body.sha.slice(0, 7) : "unknown";
  const all = Array.isArray(r.body?.statuses) ? r.body.statuses : [];
  // Newest first, as GitHub returns them; the first match is the current state for that context.
  const s = all.find((x: any) => typeof x?.context === "string" && t.context.test(x.context));
  if (!s) {
    return { status: "unknown", ms: null,
      detail: `The latest commit on main (${sha}) has no ${t.host} deploy status yet. If it stays like this, check that ${t.host} is connected to this repository.` };
  }
  const link = logLink(s.target_url);
  const desc = String(s.description ?? "");
  if (s.state === "success") {
    if (/ignored|skipped|canceled|cancelled/i.test(desc)) {
      return { status: "up", ms: null, link, detail: `The latest commit (${sha}) was not deployed; production runs an earlier successful deploy.` };
    }
    return { status: "up", ms: null, link, detail: `Commit ${sha} is live, deployed ${when(s.updated_at)}.` };
  }
  if (s.state === "pending") {
    const age = at - Date.parse(String(s.created_at ?? s.updated_at ?? ""));
    if (Number.isFinite(age) && age > DEPLOY_STUCK_MS) {
      return { status: "attention", ms: null, link,
        detail: `The deploy of commit ${sha} has been running for ${Math.floor(age / 60_000)} minutes. Production runs the previous deploy until it finishes.` };
    }
    return { status: "up", ms: null, link, detail: `Deploying commit ${sha} now. Production runs the previous deploy until it finishes.` };
  }
  // failure or error: the platform keeps serving the last successful deploy.
  return { status: "down", ms: null, link,
    detail: `The deploy of commit ${sha} failed (${when(s.updated_at)}). Production still runs the last successful deploy, so nothing merged since is live. The reason is in the ${t.host} build log.` };
}

export type ProbeContext = {
  env: Env;
  fetchImpl: typeof fetch;
  /** Runs one statement in the staff's own admin-DB transaction. */
  q: Q;
  /** The signed read this site already makes against the borrower app (app site). */
  app: AppReleases | null;
  /** The signed query channel to portal-api (portal site). */
  portal: PortalCall | null;
  /** The caller's own token, which the portal channel requires. */
  actorToken: string;
  /** Which admin database this deployment uses. */
  site: Site;
};

/** One probe per service key. Read-only by construction: there is no entry here that writes. */
export const PROBES: Record<string, (c: ProbeContext) => Promise<Pick<Result, "status" | "ms" | "detail" | "link">>> = {
  admin_api: async (c) => {
    const where = c.env.VERCEL_ENV ? `${c.env.VERCEL_ENV} deployment` : "this deployment";
    return { status: "up", ms: null, detail: `Answering now, from the ${where}.` };
  },

  admin_db: async (c) => {
    const started = Date.now();
    await c.q("select 1 as ok");
    return rate(Date.now() - started, "Answered a test query.");
  },

  identity: async (c) => {
    const origin = originOf(c.env.FICIUM_AUTH_URL);
    if (!origin) return { status: "not_configured", ms: null, detail: "No sign-in service is configured on this deployment." };
    const r = await getJson(`${origin}/.well-known/jwks.json`, c.fetchImpl);
    if (!r.ok) {
      return { status: "down", ms: r.ms,
        detail: r.status === 0 ? "Could not be reached." : `Answered ${r.status} instead of serving its public keys.` };
    }
    const keys = Array.isArray(r.body?.keys) ? r.body.keys.length : 0;
    if (keys === 0) return { status: "down", ms: r.ms, detail: "Answered, but served no signing keys, so tokens cannot be verified." };
    return rate(r.ms, `Serving ${keys} signing key${keys === 1 ? "" : "s"}.`);
  },

  admin_schema: async (c) => {
    const d = await readDrift(c.q, dbFor(c.site), true);
    if (!hasDrift(d)) return { status: "up", ms: null, detail: "Every database change this deployment expects is applied." };
    return { status: "down", ms: null, detail: driftAlerts(d).join(" ") };
  },

  borrower_app: async (c) => {
    const origin = originOf(c.env.APP_ADMIN_SYNC_URL);
    if (!origin) return { status: "not_configured", ms: null, detail: "No borrower app is configured on this deployment." };
    const r = await getJson(`${origin}/api/keepalive`, c.fetchImpl);
    if (r.body?.code === "SCHEMA_DRIFT") {
      return { status: "down", ms: r.ms,
        detail: "Running, but a database migration has not been applied, so features may fail. Apply it and test again." };
    }
    if (!r.ok) {
      if (r.status === 0) return { status: "down", ms: r.ms, detail: "Could not be reached." };
      if (r.status === 502) return { status: "down", ms: r.ms, detail: "Running, but its database did not answer." };
      return { status: "down", ms: r.ms, detail: `Answered ${r.status}.` };
    }
    // The app answers { ok: true, data: { ok, ms } } on success and { ok: false, error, code } otherwise.
    const db = Number(r.body?.data?.ms);
    const dbMs = Number.isFinite(db) ? ` Its database answered in ${db} ms.` : "";
    return rate(r.ms, `Answering, database reachable, migrations up to date.${dbMs}`);
  },

  app_channel: async (c) => {
    if (!c.app) return { status: "not_configured", ms: null, detail: "The connection to the borrower app is not configured on this deployment." };
    const started = Date.now();
    try {
      await c.app.usage();
      return rate(Date.now() - started, "The borrower app accepted this site's signed read.");
    } catch (e) {
      const why = (e as Error)?.message ?? "";
      return { status: "down", ms: Date.now() - started,
        detail: /401|bad_signature/i.test(why)
          ? "The borrower app refused this site's signature. The signing keys no longer match."
          : "The borrower app did not answer this site." };
    }
  },

  portal_api: async (c) => {
    const origin = originOf(c.env.PORTAL_API_URL);
    if (!origin) return { status: "not_configured", ms: null, detail: "No portal API is configured on this deployment." };
    const r = await getJson(`${origin}/health`, c.fetchImpl);
    if (!r.ok) {
      return { status: "down", ms: r.ms, detail: r.status === 0 ? "Could not be reached." : `Answered ${r.status}.` };
    }
    if (r.body?.status !== "ok") return { status: "down", ms: r.ms, detail: "Answered, but did not report itself healthy." };
    const v = typeof r.body?.version === "string" ? ` Version ${r.body.version}.` : "";
    return rate(r.ms, `Running.${v}`);
  },

  portal_channel: async (c) => {
    if (!c.portal) return { status: "not_configured", ms: null, detail: "The connection to the portal is not configured on this deployment." };
    if (!c.actorToken) return { status: "unknown", ms: null, detail: "Sign in again: this test uses your own sign-in." };
    const started = Date.now();
    try {
      await c.portal("query", { op: "traffic.overview", args: {} }, c.actorToken);
      return rate(Date.now() - started, "The portal accepted this site's signed read and its database answered.");
    } catch (e) {
      const ms = Date.now() - started;
      if (e instanceof PortalApiError) {
        if (e.status === 401) return { status: "down", ms, detail: "The portal refused your sign-in for this read. Sign in again." };
        if (e.status === 403) return { status: "down", ms, detail: "The portal refused this site's signature. The signing keys no longer match." };
        return { status: "down", ms, detail: e.message };
      }
      return { status: "down", ms, detail: "The portal did not answer this site." };
    }
  },

  delivery: async (c) => {
    // Needs audit.read, which not every role has. A refusal is not a fault in delivery.
    await c.q("savepoint probe_delivery");
    let snapshot: any;
    try {
      snapshot = (await c.q("select api.ops_health_view() as v")).rows[0]?.v;
    } catch {
      await c.q("rollback to savepoint probe_delivery");
      return { status: "unknown", ms: null, detail: "You do not have permission to see delivery status." };
    }
    const o = snapshot?.outbox;
    if (!o) return { status: "unknown", ms: null, detail: "This site does not queue changes: they are sent as they are approved." };
    const dead = Number(o.dead ?? 0);
    const pending = Number(o.pending ?? 0);
    const oldest = Number(o.oldest_pending_s ?? 0);
    if (dead > 0) {
      return { status: "down", ms: null,
        detail: `${dead} change${dead === 1 ? "" : "s"} could not be delivered after 12 tries. The Audit page has the detail.` };
    }
    if (oldest > 7200) {
      return { status: "slow", ms: null, detail: `A change has been waiting ${Math.floor(oldest / 3600)} hours to reach the borrower app.` };
    }
    if (pending > 0) return { status: "up", ms: null, detail: `${pending} change${pending === 1 ? "" : "s"} waiting, none overdue.` };
    return { status: "up", ms: null, detail: "Nothing waiting." };
  },

  credentials: async (c) => {
    const a = await readCredentialAlerts(c.q, true);
    if (!a) return { status: "unknown", ms: null, detail: "Not set up yet: the register's database change has not been applied (see Database changes)." };
    if (a.expired.length) {
      return { status: "down", ms: null,
        detail: `${a.expired.length} expired: ${names(a.expired)}. Replace ${a.expired.length === 1 ? "it" : "them"}, then update Keys and tokens.` };
    }
    if (a.due_soon.length) return { status: "attention", ms: null, detail: `Due within 14 days: ${names(a.due_soon)}.` };
    if (a.no_date > 0) {
      return { status: "attention", ms: null,
        detail: `No expiry or rotation date recorded for ${a.no_date} of ${a.tracked}. Add them on Keys and tokens so this page can warn in time.` };
    }
    return { status: "up", ms: null, detail: `${a.tracked} tracked, none due in the next 14 days.` };
  },

  ...Object.fromEntries(Object.entries(DEPLOYS).map(([key, t]) => [key, (c: ProbeContext) => deployProbe(t, c)])),
};

/**
 * Best effort, per running instance: enough that holding the Test button down cannot turn this
 * site into a traffic generator against our own services. Not a security boundary — the caller is
 * already signed-in staff, and every probe is read-only.
 */
const lastRun = new Map<string, { at: number; result: Result }>();

export async function runProbe(key: string, c: ProbeContext, at: number = Date.now()): Promise<Result> {
  const probe = PROBES[key];
  // The handler only passes keys this site lists; this is the backstop.
  if (!probe) throw new Error(`unknown service ${key}`);
  const recent = lastRun.get(key);
  if (recent && at - recent.at < MIN_INTERVAL_MS) return recent.result;
  let result: Result;
  try {
    result = { key, checked_at: now(), ...(await probe(c)) };
  } catch (e) {
    // A probe must never take the page down with it.
    console.warn("service probe failed", key, (e as Error)?.message);
    result = { key, status: "unknown", ms: null, detail: "The test itself could not be run.", checked_at: now() };
  }
  lastRun.set(key, { at, result });
  return result;
}

/** For tests: forget the rate-limit window. */
export const resetProbeWindow = () => lastRun.clear();

export type Deps = {
  requireStaff: (h: Req["headers"]) => Promise<Staff>;
  withAdmin: <T>(s: Staff, m: Meta, fn: (q: Q) => Promise<T>) => Promise<T>;
  site: () => Site;
  context: (q: Q, actorToken: string) => ProbeContext;
};

export const live = (): Deps => ({
  requireStaff: (h) => requireStaffIdentity(h),
  withAdmin,
  site: currentSite,
  context: (q, actorToken) => ({
    env: process.env,
    fetchImpl: fetch,
    q,
    app: currentSite() === "app" ? appReleases() : null,
    portal: currentSite() === "portal" ? portalApi() : null,
    actorToken,
    site: currentSite(),
  }),
});

export function makeHandler(deps: Deps) {
  return async function handler(req: Req, res: Res) {
    res.setHeader("Cache-Control", "no-store");
    let staff: Staff;
    try {
      staff = await deps.requireStaff(req.headers);
    } catch (e) {
      const status = e instanceof AuthError ? e.status : 401;
      return res.status(status).json({ error: e instanceof Error ? e.message : "Not signed in", code: e instanceof AuthError ? e.code : undefined });
    }
    const meta = requestMeta(req.headers);
    const actorToken = bearer(req.headers);
    const services = servicesFor(deps.site());

    let only: string | null = null;
    if (req.method === "POST") {
      let b: Record<string, unknown> | undefined;
      try {
        b = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) as Record<string, unknown> | undefined;
      } catch {
        return res.status(400).json({ error: "Body must be JSON" });
      }
      if (String(b?.op ?? "") !== "probe") return res.status(400).json({ error: "Unknown action" });
      // The key must name a service THIS site lists: never a URL, never another site's service.
      only = services.some((s) => s.key === b?.key) ? String(b?.key) : null;
      if (!only) return res.status(400).json({ error: "Unknown service" });
    } else if (req.method !== "GET") {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    try {
      const results = await deps.withAdmin(staff, meta, async (q) => {
        // Permission first, inside the admin DB: traffic.view, the same permission the API traffic
        // page needs. Nothing is probed until the database says this person may look.
        await q("select api.traffic_view() as v");
        const c = deps.context(q, actorToken);
        const wanted = only ? services.filter((s) => s.key === only) : services;
        // In order, not in parallel: they share one database transaction.
        const out: Result[] = [];
        for (const s of wanted) out.push(await runProbe(s.key, c));
        return out;
      });
      return res.status(200).json({ actor: staff.email, services, results, checked_at: now() });
    } catch (e: any) {
      const m = dbError(e);
      if (m) return res.status(m.status).json({ error: m.error });
      console.error("service health error", e?.code, e?.message);
      return res.status(500).json({ error: "The service tests could not be run" });
    }
  };
}
