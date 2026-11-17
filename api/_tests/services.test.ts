import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeHandler, runProbe, resetProbeWindow, servicesFor, originOf, PROBES, MIN_INTERVAL_MS, type Deps, type ProbeContext } from "../_lib/services.js";
import { route } from "../audit.js";
import { PortalApiError } from "../_lib/portal-api.js";
import { AuthError } from "../_lib/access.js";
import { res, fakeAdmin, staffOk, KJ } from "./admin-harness.js";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const ENV = {
  FICIUM_AUTH_URL: "https://auth.example",
  APP_ADMIN_SYNC_URL: "https://app.example/api/internal?op=admin-sync",
  PORTAL_API_URL: "https://portal.example",
  VERCEL_ENV: "production",
};

/** A fetch that answers by URL, and records every URL asked for. */
function net(routes: Record<string, () => Response | Promise<Response>>) {
  const urls: string[] = [];
  const f = vi.fn(async (u: string | URL, init?: RequestInit) => {
    urls.push(String(u));
    expect(init?.method ?? "GET").toBe("GET");   // every probe is a read
    const hit = Object.keys(routes).find((k) => String(u) === k);
    if (!hit) throw new Error("unexpected url " + u);
    return routes[hit]!();
  });
  return { f: f as unknown as typeof fetch, urls };
}

const HEALTHY = {
  "https://auth.example/.well-known/jwks.json": () => json(200, { keys: [{ kid: "a" }, { kid: "b" }] }),
  "https://app.example/api/keepalive": () => json(200, { ok: true, data: { ok: true, ms: 40 } }),
  "https://portal.example/health": () => json(200, { status: "ok", service: "ficium-portal-api", version: "1.4.0" }),
};

function ctx(over: Partial<ProbeContext> = {}, routes: Record<string, () => Response | Promise<Response>> = HEALTHY): { c: ProbeContext; urls: string[]; sql: string[] } {
  const { f, urls } = net(routes);
  const sql: string[] = [];
  const c: ProbeContext = {
    env: ENV, fetchImpl: f, actorToken: "staff-token",
    q: async (s) => { sql.push(s); return { rows: s.includes("ops_health_view") ? [{ v: { outbox: { pending: 0, dead: 0, oldest_pending_s: null } } }] : [{ ok: 1 }] }; },
    app: { usage: vi.fn(async () => ({ generated_at: "", policy: [], versions: [], errors: [] })) },
    portal: vi.fn(async () => ({})) as any,
    ...over,
  };
  return { c, urls, sql };
}

beforeEach(() => resetProbeWindow());

describe("service registry", () => {
  it("lists each site's own services, and every one has a probe", () => {
    const app = servicesFor("app").map((s) => s.key), portal = servicesFor("portal").map((s) => s.key);
    expect(app).toEqual(["admin_api", "admin_db", "identity", "borrower_app", "app_channel", "delivery"]);
    expect(portal).toEqual(["admin_api", "admin_db", "identity", "portal_api", "portal_channel"]);
    for (const k of [...app, ...portal]) expect(PROBES[k]).toBeTypeOf("function");
    for (const s of [...servicesFor("app"), ...servicesFor("portal")]) {
      expect(s.proves.length).toBeGreaterThan(10);
      expect(s.blind_to.length).toBeGreaterThan(10);
    }
  });

  it("keeps the origin only, and refuses anything that is not https", () => {
    expect(originOf("https://app.example/api/internal?op=admin-sync")).toBe("https://app.example");
    expect(originOf("http://app.example")).toBeNull();
    expect(originOf("http://localhost:3000/x")).toBe("http://localhost:3000");
    expect(originOf("not a url")).toBeNull();
    expect(originOf(undefined)).toBeNull();
  });
});

describe("probes", () => {
  it("all pass when every service is healthy, and only ever read", async () => {
    const { c, urls } = ctx();
    for (const k of [...new Set([...servicesFor("app"), ...servicesFor("portal")].map((s) => s.key))]) {
      const r = await runProbe(k, c);
      expect([r.key, r.status]).toEqual([k, "up"]);
    }
    expect(urls.sort()).toEqual(Object.keys(HEALTHY).sort());
  });

  it("identity: down when unreachable, refusing, or serving no keys", async () => {
    for (const [routes, why] of [
      [{ "https://auth.example/.well-known/jwks.json": () => { throw new Error("ECONNREFUSED"); } }, /reached/],
      [{ "https://auth.example/.well-known/jwks.json": () => json(503, {}) }, /503/],
      [{ "https://auth.example/.well-known/jwks.json": () => json(200, { keys: [] }) }, /no signing keys/],
    ] as const) {
      resetProbeWindow();
      const r = await runProbe("identity", ctx({}, routes as any).c);
      expect(r.status).toBe("down");
      expect(r.detail).toMatch(why);
    }
  });

  it("borrower app: reports its database time from the real answer shape", async () => {
    const r = await runProbe("borrower_app", ctx().c);
    expect(r.detail).toMatch(/Its database answered in 40 ms\./);
  });

  it("borrower app: names a missing migration and a database that does not answer", async () => {
    const drift = await runProbe("borrower_app", ctx({}, { "https://app.example/api/keepalive": () => json(503, { ok: false, error: "A database migration has not been applied", code: "SCHEMA_DRIFT" }) }).c);
    expect([drift.status, drift.detail]).toEqual(["down", expect.stringMatching(/migration has not been applied/)]);
    resetProbeWindow();
    const db = await runProbe("borrower_app", ctx({}, { "https://app.example/api/keepalive": () => json(502, { ok: false, error: "DB ping failed", code: "PING_FAILED" }) }).c);
    expect(db.detail).toMatch(/database did not answer/);
  });

  it("portal API: down unless it reports itself ok, and says it does not check the database", async () => {
    const r = await runProbe("portal_api", ctx({}, { "https://portal.example/health": () => json(200, { status: "starting" }) }).c);
    expect(r.status).toBe("down");
    expect(servicesFor("portal").find((s) => s.key === "portal_api")!.blind_to).toMatch(/database/);
  });

  it("channels: tell a key mismatch apart from an outage", async () => {
    const sig = await runProbe("app_channel", ctx({ app: { usage: vi.fn(async () => { throw new Error("borrower app answered 401 (bad_signature)"); }) } }).c);
    expect(sig.detail).toMatch(/signing keys no longer match/);
    const p403 = await runProbe("portal_channel", ctx({ portal: vi.fn(async () => { throw new PortalApiError(403, "bad_signature", "x"); }) as any }).c);
    expect(p403.detail).toMatch(/signing keys no longer match/);
    resetProbeWindow();
    const p401 = await runProbe("portal_channel", ctx({ portal: vi.fn(async () => { throw new PortalApiError(401, "actor", "x"); }) as any }).c);
    expect(p401.detail).toMatch(/Sign in again/);
  });

  it("portal channel uses the existing read-only query and the caller's own sign-in", async () => {
    const portal = vi.fn(async () => ({}));
    await runProbe("portal_channel", ctx({ portal: portal as any }).c);
    expect(portal).toHaveBeenCalledWith("query", { op: "traffic.overview", args: {} }, "staff-token");
  });

  it("delivery: failed deliveries are down, an old wait is slow, a missing permission is unknown, not down", async () => {
    const snap = (outbox: unknown) => ctx({ q: async (s) => ({ rows: s.includes("ops_health_view") ? [{ v: { outbox } }] : [] }) }).c;
    expect((await runProbe("delivery", snap({ pending: 1, dead: 2, oldest_pending_s: 60 }))).status).toBe("down");
    resetProbeWindow();
    const late = await runProbe("delivery", snap({ pending: 1, dead: 0, oldest_pending_s: 3 * 3600 }));
    expect([late.status, late.detail]).toEqual(["slow", expect.stringMatching(/3 hours/)]);

    resetProbeWindow();
    const sql: string[] = [];
    const denied = await runProbe("delivery", ctx({ q: async (s) => { sql.push(s); if (s.includes("ops_health_view")) throw { code: "42501" }; return { rows: [] }; } }).c);
    expect(denied.status).toBe("unknown");
    // The refusal is rolled back to a savepoint so the rest of the transaction can carry on.
    expect(sql).toEqual(["savepoint probe_delivery", "select api.ops_health_view() as v", "rollback to savepoint probe_delivery"]);
  });

  it("marks a slow answer as slow", async () => {
    let t = 0;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => (t += 2500));
    try {
      const r = await runProbe("admin_db", ctx().c);
      expect(r.status).toBe("slow");
    } finally { spy.mockRestore(); }
  });

  it("not configured is its own status, and no request is made", async () => {
    const { c, urls } = ctx({ env: {} , app: null, portal: null });
    for (const k of ["identity", "borrower_app", "app_channel", "portal_api", "portal_channel"]) {
      expect((await runProbe(k, c)).status).toBe("not_configured");
    }
    expect(urls).toEqual([]);
  });

  it("refuses non-https service addresses", async () => {
    const r = await runProbe("identity", ctx({ env: { FICIUM_AUTH_URL: "http://auth.example" } }).c);
    expect(r.status).toBe("not_configured");
  });

  it("does not probe the same service twice inside the window", async () => {
    const { c, urls } = ctx();
    await runProbe("identity", c, 1_000_000);
    await runProbe("identity", c, 1_000_000 + MIN_INTERVAL_MS - 1);
    expect(urls).toHaveLength(1);
    await runProbe("identity", c, 1_000_000 + MIN_INTERVAL_MS);
    expect(urls).toHaveLength(2);
  });

  it("a probe that throws becomes unknown, never an error page", async () => {
    const r = await runProbe("admin_db", ctx({ q: async () => { throw new Error("connection reset"); } }).c);
    expect([r.status, r.detail]).toEqual(["unknown", "The test itself could not be run."]);
  });
});

function setup(site: "app" | "portal" = "app", fail?: { match: string; err: unknown }) {
  const db = fakeAdmin({ "api.traffic_view": { v: {} }, "select 1": { ok: 1 }, "ops_health_view": { v: { outbox: { pending: 0, dead: 0 } } } }, fail);
  const { f, urls } = net(HEALTHY);
  const deps: Deps = {
    requireStaff: staffOk(), withAdmin: db.withAdmin, site: () => site,
    context: (q, actorToken) => ({ env: ENV, fetchImpl: f, q, actorToken,
      app: { usage: vi.fn(async () => ({ generated_at: "", policy: [], versions: [], errors: [] })) }, portal: vi.fn(async () => ({})) as any }),
  };
  return { db, urls, handler: makeHandler(deps) };
}
const authed = { authorization: "Bearer staff-token" };

describe("service health endpoint", () => {
  it("GET checks permission in the admin DB first, then tests every service of this site", async () => {
    const { db, handler } = setup("portal"); const r = res();
    await handler({ method: "GET", headers: authed }, r);
    expect(r.code).toBe(200);
    expect(db.calls[0]!.sql).toContain("api.traffic_view");
    expect(db.sessions[0]!.staff).toEqual(KJ);
    expect(r.body.results.map((x: any) => x.key)).toEqual(["admin_api", "admin_db", "identity", "portal_api", "portal_channel"]);
    expect(r.body.results.every((x: any) => x.status === "up")).toBe(true);
    expect(r.headers["Cache-Control"]).toBe("no-store");
  });

  it("tests nothing when the admin DB refuses the viewer", async () => {
    const { urls, handler } = setup("app", { match: "api.traffic_view", err: { code: "42501", message: "permission denied: traffic.view" } }); const r = res();
    await handler({ method: "GET", headers: authed }, r);
    expect(r.code).toBe(403);
    expect(urls).toEqual([]);
  });

  it("POST tests one service by key", async () => {
    const { urls, handler } = setup("app"); const r = res();
    await handler({ method: "POST", headers: authed, body: { op: "probe", key: "identity" } }, r);
    expect(r.code).toBe(200);
    expect(r.body.results).toHaveLength(1);
    expect(urls).toEqual(["https://auth.example/.well-known/jwks.json"]);
  });

  it.each([
    [{ op: "probe", key: "https://169.254.169.254/latest/meta-data" }],
    [{ op: "probe", key: "portal_api" }],          // another site's service
    [{ op: "probe", key: "__proto__" }],
    [{ op: "probe" }],
    [{ op: "probe", key: "nope", url: "https://evil.example" }],
    [{ op: "delete", key: "identity" }],
  ])("refuses %j without making any request", async (body) => {
    const { db, urls, handler } = setup("app"); const r = res();
    await handler({ method: "POST", headers: authed, body }, r);
    expect(r.code).toBe(400);
    expect(urls).toEqual([]);
    expect(db.sessions).toHaveLength(0);
  });

  it("ignores any URL sent alongside a valid key", async () => {
    const { urls, handler } = setup("app"); const r = res();
    await handler({ method: "POST", headers: authed, body: { op: "probe", key: "borrower_app", url: "https://evil.example/x" } }, r);
    expect(urls).toEqual(["https://app.example/api/keepalive"]);
  });

  it("refuses anyone who is not signed-in staff, and other methods", async () => {
    const db = fakeAdmin();
    const handler = makeHandler({ requireStaff: vi.fn(async () => { throw new AuthError(403, "MFA required", "MFA_REQUIRED"); }),
      withAdmin: db.withAdmin, site: () => "app", context: () => { throw new Error("must not run"); } });
    const r = res(); await handler({ method: "GET", headers: {} }, r);
    expect([r.code, r.body.code]).toEqual([403, "MFA_REQUIRED"]);
    const ok = setup(); const r2 = res();
    await ok.handler({ method: "DELETE", headers: authed }, r2);
    expect(r2.code).toBe(405);
  });
});

describe("audit.ts routing", () => {
  it("sends ?module=services to the services handler", () => {
    const audit = vi.fn(), traffic = vi.fn(), services = vi.fn(); const h = route(audit, traffic, services);
    h({ headers: {}, query: { module: "services" } }, res());
    h({ headers: {}, query: { module: "traffic" } }, res());
    h({ headers: {}, query: {} }, res());
    expect([services.mock.calls.length, traffic.mock.calls.length, audit.mock.calls.length]).toEqual([1, 1, 1]);
  });
});
