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
    new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuedAt()
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

describe("requireStaff — hosted login (Supabase Auth)", () => {
  const BASE = "https://authonly.supabase.co", UID = "11111111-1111-4111-8111-111111111111";
  const henv = { SUPABASE_AUTH_URL: BASE, STAFF_USER_IDS: `${UID},22222222-2222-4222-8222-222222222222` };
  async function hsetup() {
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    const getKey = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "s1", alg: "ES256" }] });
    const sign = (claims: Record<string, unknown>, o: { aud?: string; iss?: string; exp?: string; sub?: string } = {}) =>
      new SignJWT(claims).setProtectedHeader({ alg: "ES256", kid: "s1" }).setIssuedAt().setSubject(o.sub ?? UID)
        .setAudience(o.aud ?? "authenticated").setIssuer(o.iss ?? `${BASE}/auth/v1`).setExpirationTime(o.exp ?? "5m").sign(privateKey);
    return { getKey, sign };
  }
  const good = { email: "KJ@ficium.net", aal: "aal2", amr: [{ method: "password" }, { method: "totp" }] };
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

  it("fails closed when only half the config is present", async () => {
    expect(await status(requireStaff({}, { SUPABASE_AUTH_URL: BASE }))).toBe(503);
    expect(await status(requireStaff({}, { STAFF_USER_IDS: UID }))).toBe(503);
  });
  it("rejects a request with no bearer token", async () => {
    expect(await status(requireStaff({}, henv))).toBe(401);
  });
  it("accepts an allowlisted user at aal2 and returns the email", async () => {
    const { getKey, sign } = await hsetup();
    expect(await requireStaff(bearer(await sign(good)), henv, getKey)).toBe("kj@ficium.net");
  });
  it("rejects a password-only session (aal1) — MFA is mandatory", async () => {
    const { getKey, sign } = await hsetup();
    const t = await sign({ email: "kj@ficium.net", aal: "aal1", amr: [{ method: "password" }] });
    expect(await status(requireStaff(bearer(t), henv, getKey))).toBe(401);
  });
  it("rejects aal2 claimed without a totp method", async () => {
    const { getKey, sign } = await hsetup();
    const t = await sign({ email: "kj@ficium.net", aal: "aal2", amr: [{ method: "password" }] });
    expect(await status(requireStaff(bearer(t), henv, getKey))).toBe(401);
  });
  it("rejects a valid user who is not on the allowlist, even with a staff email", async () => {
    const { getKey, sign } = await hsetup();
    const t = await sign(good, { sub: "99999999-9999-4999-8999-999999999999" });
    expect(await status(requireStaff(bearer(t), henv, getKey))).toBe(403);
  });
  it("rejects wrong audience, wrong issuer, expired, and foreign-key tokens", async () => {
    const { getKey, sign } = await hsetup();
    const other = await hsetup();
    for (const t of [await sign(good, { aud: "anon" }), await sign(good, { iss: "https://evil.supabase.co/auth/v1" }),
                     await sign(good, { exp: "-1m" }), await other.sign(good)]) {
      expect(await status(requireStaff(bearer(t), henv, getKey))).toBe(401);
    }
  });
  it("Cloudflare config takes precedence and ignores bearer tokens", async () => {
    const { getKey, sign } = await hsetup();
    expect(await status(requireStaff(bearer(await sign(good)), { ...henv, ...env }, getKey))).toBe(401);
  });
  it("never honours the dev bypass on Vercel in this mode either", async () => {
    expect(await status(requireStaff({}, { ...henv, ALLOW_DEV_AUTH: "1", DEV_ACTOR: "x@ficium.net", VERCEL: "1" }))).toBe(401);
  });
});
