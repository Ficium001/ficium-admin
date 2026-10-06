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
