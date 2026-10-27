import { describe, it, expect } from "vitest";
import { generateKeyPair, SignJWT, exportJWK, createLocalJWKSet } from "jose";
import { requireStaff, AuthError } from "../_lib/access.js";

const TEAM = "ficium.cloudflareaccess.com", AUD = "aud-123";
const env = { CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD };

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  const getKey = createLocalJWKSet({ keys: [jwk] });
  const sign = (claims: Record<string, unknown>, o: { aud?: string; iss?: string; exp?: string } = {}) =>
    new SignJWT({ sub: "cf-user-1", ...claims }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuedAt()
      .setAudience(o.aud ?? AUD).setIssuer(o.iss ?? `https://${TEAM}`).setExpirationTime(o.exp ?? "5m").sign(privateKey);
  return { getKey, sign };
}
const status = async (p: Promise<unknown>) => { try { await p; return 200; } catch (e) { return (e as AuthError).status; } };

describe("requireStaff", () => {
  it("fails closed when Access is not configured", async () => {
    expect(await status(requireStaff({}, {}))).toBe(503);
  });
  it("rejects a request with no Access token", async () => {
    expect(await status(requireStaff({}, env))).toBe(401);
  });
  it("accepts a valid staff token and returns the email from it", async () => {
    const { getKey, sign } = await setup();
    const t = await sign({ email: "KJ@ficium.net" });
    expect(await requireStaff({ "cf-access-jwt-assertion": t }, env, getKey)).toBe("kj@ficium.net");
  });
  it("rejects wrong audience, wrong issuer and expired tokens", async () => {
    const { getKey, sign } = await setup();
    for (const t of [await sign({ email: "a@ficium.net" }, { aud: "other" }),
                     await sign({ email: "a@ficium.net" }, { iss: "https://evil.cloudflareaccess.com" }),
                     await sign({ email: "a@ficium.net" }, { exp: "-1m" })]) {
      expect(await status(requireStaff({ "cf-access-jwt-assertion": t }, env, getKey))).toBe(401);
    }
  });
  it("rejects a token signed by a different key", async () => {
    const { getKey } = await setup();
    const other = await setup();
    const t = await other.sign({ email: "a@ficium.net" });
    expect(await status(requireStaff({ "cf-access-jwt-assertion": t }, env, getKey))).toBe(401);
  });
  it("rejects non-staff email domains", async () => {
    const { getKey, sign } = await setup();
    const t = await sign({ email: "someone@gmail.com" });
    expect(await status(requireStaff({ "cf-access-jwt-assertion": t }, env, getKey))).toBe(403);
  });
  it("never honours the dev bypass on Vercel", async () => {
    const bypass = { ALLOW_DEV_AUTH: "1", DEV_ACTOR: "dev@ficium.net" };
    expect(await requireStaff({}, bypass)).toBe("dev@ficium.net");
    expect(await status(requireStaff({}, { ...bypass, VERCEL: "1" }))).toBe(503);
    expect(await status(requireStaff({}, { ...bypass, VERCEL_ENV: "production" }))).toBe(503);
  });
});

import { requireStaffIdentity } from "../_lib/access.js";
describe("requireStaffIdentity", () => {
  it("returns a namespaced dev subject only outside Vercel", async () => {
    const env = { ALLOW_DEV_AUTH: "1", DEV_ACTOR: "Dev@Ficium.net" };
    expect(await requireStaffIdentity({}, env)).toEqual({ email: "dev@ficium.net", sub: "dev:dev@ficium.net" });
    await expect(requireStaffIdentity({}, { ...env, VERCEL: "1" })).rejects.toMatchObject({ status: 503 });
  });
});

describe("requireStaffIdentity with Access tokens", () => {
  it("returns email + namespaced subject", async () => {
    const { getKey, sign } = await setup();
    const t = await sign({ email: "KJ@ficium.net", sub: "a1b2" });
    expect(await requireStaffIdentity({ "cf-access-jwt-assertion": t }, env, getKey)).toEqual({ email: "kj@ficium.net", sub: "cf-access:a1b2" });
  });
  it("refuses a token without a subject", async () => {
    const { getKey, sign } = await setup();
    const t = await sign({ email: "kj@ficium.net", sub: undefined });
    expect(await status(requireStaffIdentity({ "cf-access-jwt-assertion": t }, env, getKey))).toBe(403);
  });
});

describe("ficium-auth tokens", () => {
  const fenv = { FICIUM_AUTH_URL: "https://auth.example", STAFF_EMAIL_DOMAIN: "ficium.net" };
  async function fa() {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "ficium-auth-rs256-v1", alg: "RS256" };
    const getKey = createLocalJWKSet({ keys: [jwk] });
    const sign = (claims: Record<string, unknown>, iss = "ficium-auth") =>
      new SignJWT({ sub: "u-1", email: "KJ@ficium.net", institution_id: "00000000-0000-0000-0000-000000000001",
        user_role: "super_admin", amr: ["pwd", "otp", "mfa"], ...claims })
        .setProtectedHeader({ alg: "RS256", kid: "ficium-auth-rs256-v1" }).setIssuedAt()
        .setAudience("authenticated").setIssuer(iss).setExpirationTime("5m").sign(privateKey);
    return { getKey, sign };
  }
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });
  const fail = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return e as AuthError; } };

  it("accepts a platform staff account that signed in with MFA", async () => {
    const { getKey, sign } = await fa();
    expect(await requireStaffIdentity(auth(await sign({})), fenv, getKey)).toEqual({ email: "kj@ficium.net", sub: "ficium-auth:u-1" });
  });
  it("sends a password-only session to MFA setup", async () => {
    const { getKey, sign } = await fa();
    const e = await fail(requireStaffIdentity(auth(await sign({ amr: ["pwd"] })), fenv, getKey));
    expect(e?.status).toBe(403); expect(e?.code).toBe("MFA_REQUIRED");
  });
  it.each([
    [{ institution_id: "f192050a-dfdd-4da7-874e-c3db88f11e41" }, 403],   // a bank user (MCB)
    [{ user_role: "institution_admin" }, 403],
    [{ email: "someone@gmail.com" }, 403],
    [{ sub: undefined }, 403],
  ])("refuses %j", async (claims, status) => {
    const { getKey, sign } = await fa();
    expect((await fail(requireStaffIdentity(auth(await sign(claims)), fenv, getKey)))?.status).toBe(status);
  });
  it("refuses a wrong issuer, a foreign key, and a missing bearer", async () => {
    const { getKey, sign } = await fa();
    expect((await fail(requireStaffIdentity(auth(await sign({}, "evil")), fenv, getKey)))?.status).toBe(401);
    const other = await fa();
    expect((await fail(requireStaffIdentity(auth(await other.sign({})), fenv, getKey)))?.status).toBe(401);
    expect((await fail(requireStaffIdentity({}, fenv, getKey)))?.status).toBe(401);
  });
  it("lets STAFF_EMAIL_DOMAIN list several domains", async () => {
    const { getKey, sign } = await fa();
    const r = await requireStaffIdentity(auth(await sign({ email: "ops@ficium.mu" })), { ...fenv, STAFF_EMAIL_DOMAIN: "ficium.net, ficium.mu" }, getKey);
    expect(r.email).toBe("ops@ficium.mu");
  });
});

describe("token rejection reasons", () => {
  it("reports why, without token content", async () => {
    const { joseReason } = await import("../_lib/access.js");
    expect(joseReason({ code: "ERR_JWT_CLAIM_VALIDATION_FAILED", claim: "iss" })).toBe("ERR_JWT_CLAIM_VALIDATION_FAILED:iss");
    expect(joseReason(new Error("x"))).toBe("ERR_UNKNOWN");
  });
});
