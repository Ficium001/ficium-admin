/**
 * Every API request must carry a Cloudflare Access JWT. We verify it here on
 * every call (signature, audience, issuer, expiry) — never trust that the
 * request "must have" come through Cloudflare, because the Vercel URL is
 * reachable directly. The actor's identity comes ONLY from this token.
 *
 * Two ways in, chosen by config (Cloudflare wins if both are set):
 *   1. Cloudflare Access JWT (CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD).
 *   2. Hosted login: a Supabase Auth session from a DEDICATED auth-only project
 *      (SUPABASE_AUTH_URL + STAFF_USER_IDS). The token must belong to an
 *      allowlisted user id and be at assurance level aal2 (TOTP completed).
 *      Allowlisting is by user id (`sub`), never by email, so someone who signs
 *      up with a staff email address still gets nothing.
 *
 * Fail closed: missing config => 503, missing/invalid token => 401.
 * Local dev only: ALLOW_DEV_AUTH=1 + DEV_ACTOR, honoured only when not on Vercel.
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type JWTPayload } from "jose";

export class AuthError extends Error {
  constructor(public status: 401 | 403 | 503, message: string) { super(message); }
}

let jwks: { url: string; get: JWTVerifyGetKey } | null = null;
function keysFor(teamDomain: string): JWTVerifyGetKey {
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  if (!jwks || jwks.url !== url) jwks = { url, get: createRemoteJWKSet(new URL(url)) };
  return jwks.get;
}

type Env = Record<string, string | undefined>;
type Headers = Record<string, string | string[] | undefined>;

let sbJwks: { url: string; get: JWTVerifyGetKey } | null = null;
function supabaseKeysFor(base: string): JWTVerifyGetKey {
  const url = `${base}/auth/v1/.well-known/jwks.json`;
  if (!sbJwks || sbJwks.url !== url) sbJwks = { url, get: createRemoteJWKSet(new URL(url)) };
  return sbJwks.get;
}

export async function requireStaff(headers: Headers, env: Env = process.env, getKey?: JWTVerifyGetKey): Promise<string> {
  if (env.ALLOW_DEV_AUTH === "1" && !env.VERCEL && !env.VERCEL_ENV) {
    if (!env.DEV_ACTOR) throw new AuthError(503, "DEV_ACTOR must be set when ALLOW_DEV_AUTH=1");
    return env.DEV_ACTOR;
  }
  if (env.CF_ACCESS_TEAM_DOMAIN && env.CF_ACCESS_AUD) return viaCloudflare(headers, env, getKey);
  if (env.SUPABASE_AUTH_URL && env.STAFF_USER_IDS) return viaHostedLogin(headers, env, getKey);
  throw new AuthError(503, "Access is not configured on this deployment");
}

async function viaCloudflare(headers: Headers, env: Env, getKey?: JWTVerifyGetKey): Promise<string> {
  const team = env.CF_ACCESS_TEAM_DOMAIN!;  // e.g. ficium.cloudflareaccess.com
  const aud = env.CF_ACCESS_AUD!;           // Application Audience (AUD) tag

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
    return email;
  } catch (e) {
    if (e instanceof AuthError) throw e;
    throw new AuthError(401, "Your Access session is invalid or expired. Reload to sign in again");
  }
}

async function viaHostedLogin(headers: Headers, env: Env, getKey?: JWTVerifyGetKey): Promise<string> {
  const base = env.SUPABASE_AUTH_URL!.replace(/\/+$/, "");
  const raw = headers["authorization"];
  const h = Array.isArray(raw) ? raw[0] : raw;
  const token = h?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) throw new AuthError(401, "Sign in to use this app");

  let payload: JWTPayload;
  try {
    // Projects on legacy symmetric signing: set SUPABASE_JWT_SECRET. Otherwise asymmetric keys via JWKS.
    const secret = env.SUPABASE_JWT_SECRET;
    const opts = { audience: "authenticated", issuer: `${base}/auth/v1` };
    ({ payload } = secret && !getKey
      ? await jwtVerify(token, new TextEncoder().encode(secret), { ...opts, algorithms: ["HS256"] })
      : await jwtVerify(token, getKey ?? supabaseKeysFor(base), { ...opts, algorithms: ["ES256", "RS256"] }));
  } catch {
    throw new AuthError(401, "Your session is invalid or expired. Sign in again");
  }

  const amr = Array.isArray(payload.amr) ? (payload.amr as { method?: string }[]) : [];
  if (payload.aal !== "aal2" || !amr.some((a) => a?.method === "totp"))
    throw new AuthError(401, "Finish two-factor sign-in to use this app");

  const allowed = env.STAFF_USER_IDS!.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  const sub = typeof payload.sub === "string" ? payload.sub.toLowerCase() : "";
  if (!sub || !allowed.includes(sub)) throw new AuthError(403, "This account is not allowed to use this app");

  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (!email) throw new AuthError(403, "Your account has no email");
  return email;
}
