/**
 * Every API request must carry a verified identity token; the actor comes ONLY
 * from it. Two providers, chosen by configuration:
 *
 *  - ficium-auth (FICIUM_AUTH_URL set) — `Authorization: Bearer <access token>`,
 *    RS256 verified against ficium-auth's JWKS (public key only: this app can
 *    verify tokens but never mint them). Accepted only for a Ficium platform
 *    staff account (PLATFORM_INSTITUTION_ID + STAFF_ROLES) that signed in WITH
 *    MFA (`amr` contains "mfa"). A password-only token gets 403 MFA_REQUIRED.
 *  - Cloudflare Access (CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD) — the earlier
 *    option, kept so switching later is configuration only.
 *
 * Fail closed: no provider configured => 503, missing/invalid token => 401.
 * Local dev only: ALLOW_DEV_AUTH=1 + DEV_ACTOR, honoured only when not on Vercel.
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export class AuthError extends Error {
  constructor(public status: 401 | 403 | 503, message: string, public code?: string) { super(message); }
}

/** Why a token failed, as a jose error code (+claim). Contains no token content. */
export function joseReason(e: unknown): string {
  const err = e as { code?: unknown; claim?: unknown } | null;
  const code = typeof err?.code === "string" ? err.code : "ERR_UNKNOWN";
  return typeof err?.claim === "string" ? `${code}:${err.claim}` : code;
}

const PLATFORM_INSTITUTION = "00000000-0000-0000-0000-000000000001";
const ficiumKeys = new Map<string, JWTVerifyGetKey>();
function ficiumAuthKeys(base: string): JWTVerifyGetKey {
  const url = `${base.replace(/\/+$/, "")}/.well-known/jwks.json`;
  let k = ficiumKeys.get(url);
  if (!k) { k = createRemoteJWKSet(new URL(url)); ficiumKeys.set(url, k); }
  return k;
}
const list = (v: string | undefined, dflt: string) => (v ?? dflt).split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);

let jwks: { url: string; get: JWTVerifyGetKey } | null = null;
function keysFor(teamDomain: string): JWTVerifyGetKey {
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  if (!jwks || jwks.url !== url) jwks = { url, get: createRemoteJWKSet(new URL(url)) };
  return jwks.get;
}

type Env = Record<string, string | undefined>;
type Headers = Record<string, string | string[] | undefined>;

export type Staff = { email: string; sub: string };

/** Email only — kept for endpoints that just need to know a staff member is calling. */
export async function requireStaff(headers: Headers, env: Env = process.env, getKey?: JWTVerifyGetKey): Promise<string> {
  return (await requireStaffIdentity(headers, env, getKey)).email;
}

/**
 * Verified email + stable subject. The subject (the token's `sub`) is what the
 * admin DB binds an invited admin to on first sign-in.
 */
export async function requireStaffIdentity(headers: Headers, env: Env = process.env, getKey?: JWTVerifyGetKey): Promise<Staff> {
  if (env.ALLOW_DEV_AUTH === "1" && !env.VERCEL && !env.VERCEL_ENV) {
    if (!env.DEV_ACTOR) throw new AuthError(503, "DEV_ACTOR must be set when ALLOW_DEV_AUTH=1");
    return { email: env.DEV_ACTOR.trim().toLowerCase(), sub: `dev:${env.DEV_ACTOR.trim().toLowerCase()}` };
  }
  if (env.FICIUM_AUTH_URL) return ficiumAuthIdentity(headers, env, getKey);

  const team = env.CF_ACCESS_TEAM_DOMAIN;  // e.g. ficium.cloudflareaccess.com
  const aud = env.CF_ACCESS_AUD;           // Application Audience (AUD) tag
  if (!team || !aud) throw new AuthError(503, "Access is not configured on this deployment");

  const raw = headers["cf-access-jwt-assertion"];
  const token = Array.isArray(raw) ? raw[0] : raw;
  if (!token) throw new AuthError(401, "Sign in through Ficium Access to use this app");

  try {
    const { payload } = await jwtVerify(token, getKey ?? keysFor(team), {
      audience: aud, issuer: `https://${team}`, algorithms: ["RS256"],
    });
    const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
    if (!email) throw new AuthError(403, "Your Access identity has no email");
    const allowed = (env.STAFF_EMAIL_DOMAIN ?? "ficium.net").toLowerCase();
    if (!email.endsWith(`@${allowed}`)) throw new AuthError(403, "Only Ficium staff accounts can use this app");
    const sub = typeof payload.sub === "string" && payload.sub.length > 0 ? payload.sub : "";
    if (!sub) throw new AuthError(403, "Your Access identity has no subject");
    return { email, sub: `cf-access:${sub}` };
  } catch (e) {
    if (e instanceof AuthError) throw e;
    throw new AuthError(401, "Your Access session is invalid or expired. Reload to sign in again");
  }
}

async function ficiumAuthIdentity(headers: Headers, env: Env, getKey?: JWTVerifyGetKey): Promise<Staff> {
  const raw = headers["authorization"];
  const h = Array.isArray(raw) ? raw[0] : raw;
  if (!h?.startsWith("Bearer ")) throw new AuthError(401, "Sign in to use this app");
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(h.slice(7), getKey ?? ficiumAuthKeys(env.FICIUM_AUTH_URL!), {
      issuer: "ficium-auth", audience: "authenticated", algorithms: ["RS256"],
    }));
  } catch (e) {
    const reason = joseReason(e);
    console.warn("ficium-auth token rejected", reason);
    throw new AuthError(401, "Your session is invalid or expired. Sign in again", reason);
  }
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  const sub = typeof payload.sub === "string" ? payload.sub : "";
  if (!email || !sub) throw new AuthError(403, "Your sign-in has no identity");
  if (payload.institution_id !== (env.PLATFORM_INSTITUTION_ID ?? PLATFORM_INSTITUTION)) {
    throw new AuthError(403, "Only Ficium staff accounts can use this app");
  }
  if (!list(env.STAFF_ROLES, "super_admin").includes(String(payload.user_role ?? "").toLowerCase())) {
    throw new AuthError(403, "Your account is not a Ficium staff role");
  }
  const domains = list(env.STAFF_EMAIL_DOMAIN, "ficium.net");
  if (!domains.some((d) => email.endsWith(`@${d}`))) throw new AuthError(403, "Only Ficium staff accounts can use this app");
  const amr = Array.isArray(payload.amr) ? payload.amr : [];
  if (!amr.includes("mfa")) throw new AuthError(403, "Set up two-factor authentication to use this app", "MFA_REQUIRED");
  return { email, sub: `ficium-auth:${sub}` };
}
