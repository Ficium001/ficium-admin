/**
 * Every API request must carry a Cloudflare Access JWT. We verify it here on
 * every call (signature, audience, issuer, expiry) — never trust that the
 * request "must have" come through Cloudflare, because the Vercel URL is
 * reachable directly. The actor's identity comes ONLY from this token.
 *
 * Fail closed: missing config => 503, missing/invalid token => 401.
 * Local dev only: ALLOW_DEV_AUTH=1 + DEV_ACTOR, honoured only when not on Vercel.
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

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

export async function requireStaff(headers: Headers, env: Env = process.env, getKey?: JWTVerifyGetKey): Promise<string> {
  if (env.ALLOW_DEV_AUTH === "1" && !env.VERCEL && !env.VERCEL_ENV) {
    if (!env.DEV_ACTOR) throw new AuthError(503, "DEV_ACTOR must be set when ALLOW_DEV_AUTH=1");
    return env.DEV_ACTOR;
  }
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
    return email;
  } catch (e) {
    if (e instanceof AuthError) throw e;
    throw new AuthError(401, "Your Access session is invalid or expired. Reload to sign in again");
  }
}
