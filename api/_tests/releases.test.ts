import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";
import { makeHandler, type Deps } from "../_lib/releases.js";
import { appReleases, cleanUsage, type AppUsage } from "../_lib/app-releases.js";
import { route } from "../kyc.js";
import { AuthError } from "../_lib/access.js";
import { res, fakeAdmin, staffOk, KJ } from "./admin-harness.js";

const ID = "018f3a6e-7c1b-7c2a-9d3e-1a2b3c4d5e6f";
const VIEW = { v: { actor: "kj@ficium.net", can_request: true, can_approve: true,
  policy: [{ platform: "android", latest_version: "1.0.0", min_version: "1.0.0", store_url: "", version: 0 }], requests: [] } };
const USAGE: AppUsage = { generated_at: "2026-11-16T08:00:00Z",
  policy: [{ platform: "android", min_version: "1.0.0", latest_version: "1.0.0", store_url: "", version: 0, updated_at: "2026-11-16T07:00:00Z" }],
  versions: [{ platform: "android", app_version: "1.0.0", active_7d: 4, active_30d: 9 }] };
const post = (b: Record<string, unknown>) => ({ method: "POST", headers: { "x-forwarded-for": "203.0.113.9", "x-vercel-id": "req-1" }, body: b });
const ask = { op: "request", platform: "android", latest_version: "1.1.0", min_version: "1.0.0",
  store_url: " https://play.google.com/store/apps/details?id=net.ficium.app ", reason: "1.1.0 went live on Google Play today" };

function setup(over: Partial<Deps> = {}, fail?: { match: string; err: unknown }) {
  const db = fakeAdmin({ "api.release_view": VIEW }, fail);
  const kick = vi.fn(async () => undefined);
  const app = { usage: vi.fn(async () => USAGE) };
  const handler = makeHandler({ requireStaff: staffOk(), withAdmin: db.withAdmin, app, kick, ...over });
  return { db, kick, app, handler };
}

describe("app releases on the admin DB", () => {
  it("GET returns the policy for the verified identity, with usage from the borrower app", async () => {
    const { db, app, handler } = setup(); const r = res();
    await handler({ method: "GET", headers: {} }, r);
    expect(r.code).toBe(200);
    expect(r.body.policy[0].platform).toBe("android");
    expect(r.body.usage).toEqual(USAGE);
    expect(r.body.usage_error).toBeNull();
    expect(db.sessions[0]!.staff).toEqual(KJ);
    expect(app.usage).toHaveBeenCalledTimes(1);
    expect(r.headers["Cache-Control"]).toBe("no-store");
  });

  it("still shows the policy when the borrower app cannot be reached or is not configured", async () => {
    const down = setup({ app: { usage: vi.fn(async () => { throw new Error("borrower app answered 503"); }) } }); const r = res();
    await down.handler({ method: "GET", headers: {} }, r);
    expect(r.code).toBe(200);
    expect(r.body.policy).toHaveLength(1);
    expect(r.body.usage).toBeNull();
    expect(r.body.usage_error).toMatch(/could not be reached/);

    const none = setup({ app: null }); const r2 = res();
    await none.handler({ method: "GET", headers: {} }, r2);
    expect(r2.code).toBe(200);
    expect(r2.body.usage_error).toMatch(/not configured/);
  });

  it("never asks the borrower app when the admin DB refuses the viewer", async () => {
    const { app, handler } = setup({}, { match: "api.release_view", err: { code: "42501", message: "permission denied: release.view" } }); const r = res();
    await handler({ method: "GET", headers: {} }, r);
    expect(r.code).toBe(403);
    expect(app.usage).not.toHaveBeenCalled();
  });

  it("a change only files a request (four-eyes) and pushes nothing to the app", async () => {
    const { db, kick, handler } = setup(); const r = res();
    await handler(post({ ...ask, maker: "attacker@x.com", status: "approved" }), r);
    expect(r.code).toBe(200);
    expect(db.calls[0]).toEqual({ sql: expect.stringContaining("api.release_request"),
      params: ["android", "1.1.0", "1.0.0", "https://play.google.com/store/apps/details?id=net.ficium.app", ask.reason] });
    expect(db.calls.some((c) => c.sql.includes("release_approve"))).toBe(false);
    expect(kick).not.toHaveBeenCalled();
    expect(db.sessions[0]!.meta).toMatchObject({ ip: "203.0.113.9", requestId: "req-1" });
  });

  it.each([
    [{ ...ask, platform: "windows" }, /iOS or Android/],
    [{ ...ask, latest_version: "1.1" }, /look like/],
    [{ ...ask, min_version: "v1.0.0" }, /look like/],
    [{ ...ask, min_version: 1 }, /look like/],
    [{ ...ask, reason: "short" }, /reason/],
    [{ ...ask, store_url: "https://play.google.com/" + "x".repeat(300) }, /too long/],
    [{ op: "publish" }, /Unknown action/],
  ])("refuses %j before touching the database", async (body, message) => {
    const { db, handler } = setup(); const r = res();
    await handler(post(body as Record<string, unknown>), r);
    expect(r.code).toBe(400);
    expect(r.body.error).toMatch(message);
    expect(db.calls).toHaveLength(0);
  });

  it("approving runs in the approver's own session and then pushes to the app", async () => {
    const { db, kick, handler } = setup(); const r = res();
    await handler(post({ op: "approve", id: ID, version: 1, note: "  checked the store  " }), r);
    expect(r.code).toBe(200);
    expect(db.calls[0]).toEqual({ sql: expect.stringContaining("api.release_approve"), params: [ID, 1, "checked the store"] });
    expect(kick).toHaveBeenCalledTimes(1);
  });

  it("rejecting needs a reason; rejecting and withdrawing push nothing", async () => {
    const a = setup(); const r = res();
    await a.handler(post({ op: "reject", id: ID, version: 1, note: "no" }), r);
    expect(r.code).toBe(400);
    expect(a.db.calls).toHaveLength(0);

    const b = setup(); const r2 = res();
    await b.handler(post({ op: "reject", id: ID, version: 1, note: "wrong app id in the link" }), r2);
    expect(b.db.calls[0]!.sql).toContain("api.release_reject");
    const c = setup(); const r3 = res();
    await c.handler(post({ op: "withdraw", id: ID, version: 2 }), r3);
    expect(c.db.calls[0]).toEqual({ sql: expect.stringContaining("api.release_withdraw"), params: [ID, 2] });
    expect(b.kick).not.toHaveBeenCalled(); expect(c.kick).not.toHaveBeenCalled();
  });

  it("refuses a decision without a valid id or version", async () => {
    for (const body of [{ op: "approve", id: "1; drop table", version: 1 }, { op: "approve", id: ID }, { op: "approve", id: ID, version: 0 }]) {
      const { db, kick, handler } = setup(); const r = res();
      await handler(post(body), r);
      expect(r.code).toBe(400);
      expect(db.calls).toHaveLength(0);
      expect(kick).not.toHaveBeenCalled();
    }
  });

  it("passes the admin DB's own refusals through with their status", async () => {
    const own = setup({}, { match: "release_approve", err: { code: "42501", message: "four-eyes: you cannot approve your own request" } }); const r = res();
    await own.handler(post({ op: "approve", id: ID, version: 1 }), r);
    expect(r.code).toBe(403);
    expect(r.body.error).toMatch(/four-eyes/);
    expect(own.kick).not.toHaveBeenCalled();

    const high = setup({}, { match: "release_request", err: { code: "22023", message: "the minimum version cannot be higher than the latest released version (1.0.0)" } }); const r2 = res();
    await high.handler(post({ ...ask, latest_version: "1.0.0", min_version: "1.1.0" }), r2);
    expect(r2.code).toBe(400);
    expect(r2.body.error).toMatch(/cannot be higher/);
  });

  it("refuses anyone who is not signed-in staff, and other methods", async () => {
    const db = fakeAdmin({ "api.release_view": VIEW });
    const handler = makeHandler({ requireStaff: vi.fn(async () => { throw new AuthError(403, "MFA required", "MFA_REQUIRED"); }),
      withAdmin: db.withAdmin, app: null, kick: vi.fn() });
    const r = res(); await handler({ method: "GET", headers: {} }, r);
    expect(r.code).toBe(403); expect(r.body.code).toBe("MFA_REQUIRED"); expect(db.sessions).toHaveLength(0);

    const ok = setup(); const r2 = res();
    await ok.handler({ method: "DELETE", headers: {} }, r2);
    expect(r2.code).toBe(405);
  });
});

describe("one function file, two modules", () => {
  it("sends ?module=releases to releases and everything else to KYC", () => {
    const kyc = vi.fn(), releases = vi.fn(); const h = route(kyc, releases);
    h({ headers: {}, query: { module: "releases" } }, res());
    h({ headers: {}, query: { module: ["releases", "x"] } }, res());
    h({ headers: {}, query: {} }, res());
    h({ headers: {}, query: { module: "RELEASES" } }, res());
    h({ headers: {} }, res());
    expect(releases).toHaveBeenCalledTimes(2);
    expect(kyc).toHaveBeenCalledTimes(3);
  });
});

describe("reading usage from the borrower app", () => {
  const env = { APP_ADMIN_SYNC_URL: "https://app.example/api/internal?op=admin-sync", APP_ADMIN_SYNC_SIGNING_KEY: "k1" };

  it("is off unless both the URL and the signing key are set", () => {
    expect(appReleases({})).toBeNull();
    expect(appReleases({ APP_ADMIN_SYNC_URL: env.APP_ADMIN_SYNC_URL })).toBeNull();
  });

  it("makes one signed POST to op=admin-app and returns the cleaned stats", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ stats: USAGE }), { status: 200 }));
    await expect(appReleases(env, f as any)!.usage()).resolves.toEqual(USAGE);
    const [url, init] = f.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe("https://app.example/api/internal?op=admin-app");
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"action":"stats"}');
    const sig = (init.headers as Record<string, string>)["Ficium-Signature"]!;
    const t = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(sig)!;
    expect(t[2]).toBe(createHmac("sha256", "k1").update(`${t[1]}.${init.body}`).digest("hex"));
  });

  it("refuses a non-https URL and reports a refusal from the app", async () => {
    await expect(appReleases({ ...env, APP_ADMIN_SYNC_URL: "http://app.example/api/internal" }, vi.fn() as any)!.usage()).rejects.toThrow(/https/);
    const f = vi.fn(async () => new Response(JSON.stringify({ error: "bad_signature" }), { status: 401 }));
    await expect(appReleases(env, f as any)!.usage()).rejects.toThrow(/401 \(bad_signature\)/);
  });

  it("keeps only known fields and turns junk counts into zero", () => {
    const out = cleanUsage({ generated_at: 5, extra: "x", policy: "nope",
      versions: [{ platform: "ios", app_version: "1.0.0", active_7d: "12", active_30d: -3, client_ids: ["leak"] }, null] });
    expect(out).toEqual({ generated_at: "5", policy: [], versions: [
      { platform: "ios", app_version: "1.0.0", active_7d: 12, active_30d: 0 },
      { platform: "", app_version: "", active_7d: 0, active_30d: 0 }] });
  });
});
