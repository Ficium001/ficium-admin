import { describe, it, expect, vi } from "vitest";
import { makeHandler, borrowerApp, cleanMarketplace, MarketplaceError, type Deps } from "../_lib/marketplace.js";
import { route } from "../kyc.js";
import { AuthError } from "../_lib/access.js";
import { res, fakeAdmin, staffOk, KJ } from "./admin-harness.js";

const ANSWER = {
  generated_at: "2026-11-19T17:00:00Z", days: 30,
  funnel: { posted: 4, relisted: 0, with_bid: 2, accepted: 2, bank_declined: 1, bids_per_request_with_bid: 1.5, requested_amount: 5700000, accepted_amount: 700000 },
  hours_to_first_bid: { median: 6, p90: 9.2 }, hours_to_acceptance: { median: 30, p90: 30 },
  status: { open: 2, accepted: 1, deal_declined: 1 },
  by_product: [{ product: "mortgage", posted: 2, with_bid: 0, accepted: 0, requested_amount: 5000000 }],
  weekly: [{ week: "2026-11-16", posted: 2, with_bid: 0, accepted: 0 }],
  now: { open: 2, open_no_bid_24h: 1, oldest_no_bid_hours: 72 },
};
const H = { authorization: "Bearer staff-token" };
const get = (days?: string) => ({ method: "GET", headers: H, query: days === undefined ? {} : { days } });
const setup = (read: Deps["read"] = vi.fn(async () => cleanMarketplace(ANSWER)), fail?: { match: string; err: unknown }) => {
  const db = fakeAdmin({ "api.traffic_view": { v: {} } }, fail);
  return { db, read, handler: makeHandler({ requireStaff: staffOk(), withAdmin: db.withAdmin, read }) };
};

describe("marketplace endpoint", () => {
  it("checks the monitoring permission in the admin DB, then asks the borrower app for the window", async () => {
    const { db, read, handler } = setup(); const r = res();
    await handler(get("90"), r);
    expect(r.code).toBe(200);
    expect(db.calls[0]!.sql).toContain("api.traffic_view");
    expect(db.sessions[0]!.staff).toEqual(KJ);
    expect(read).toHaveBeenCalledWith(90);
    expect(r.body.marketplace.funnel.posted).toBe(4);
    expect(r.headers["Cache-Control"]).toBe("no-store");
  });

  it("defaults to 30 days and refuses any other window without asking anyone", async () => {
    const ok = setup(); await ok.handler(get(), res());
    expect(ok.read).toHaveBeenCalledWith(30);
    const bad = setup(); const r = res();
    await bad.handler(get("12"), r);
    expect(r.code).toBe(400);
    expect(bad.db.sessions).toHaveLength(0);
    expect(bad.read).not.toHaveBeenCalled();
  });

  it("asks nothing of the borrower app when the admin DB refuses the viewer", async () => {
    const { read, handler } = setup(undefined, { match: "api.traffic_view", err: { code: "42501", message: "permission denied: traffic.view" } }); const r = res();
    await handler(get("30"), r);
    expect(r.code).toBe(403);
    expect(read).not.toHaveBeenCalled();
  });

  it("names the cause when the borrower app cannot answer", async () => {
    const { handler } = setup(vi.fn(async () => { throw new MarketplaceError("The borrower app refused this site's signature: the admin channel keys no longer match"); })); const r = res();
    await handler(get("30"), r);
    expect([r.code, r.body.error]).toEqual([502, expect.stringMatching(/keys no longer match/)]);
    const none = setup(null); const r2 = res();
    await none.handler(get("30"), r2);
    expect(r2.code).toBe(503);
  });

  it("refuses anyone not signed in, and anything but GET", async () => {
    const db = fakeAdmin();
    const h = makeHandler({ requireStaff: vi.fn(async () => { throw new AuthError(403, "MFA required", "MFA_REQUIRED"); }), withAdmin: db.withAdmin, read: vi.fn() });
    const r = res(); await h(get("30"), r);
    expect(r.code).toBe(403);
    const r2 = res(); await setup().handler({ method: "POST", headers: H, query: {} }, r2);
    expect(r2.code).toBe(405);
  });
});

describe("the signed read", () => {
  const env = { APP_ADMIN_SYNC_URL: "https://app.example/api/internal?op=admin-sync", APP_ADMIN_SYNC_SIGNING_KEY: "k" };
  const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("posts a signed marketplace action to op=admin-app and cleans the answer", async () => {
    const f = answer(200, { marketplace: ANSWER });
    const m = await borrowerApp(env, f)!(30);
    const [url, init] = (f as any).mock.calls[0];
    expect(String(url)).toBe("https://app.example/api/internal?op=admin-app");
    expect(JSON.parse(init.body)).toEqual({ action: "marketplace", days: 30 });
    expect(init.headers["Ficium-Signature"]).toMatch(/\S/);
    expect(m.now.open_no_bid_24h).toBe(1);
  });

  it.each([
    [401, /keys no longer match/], [503, /switched off/], [422, /deploy the borrower app version/], [500, /database change/],
  ])("explains a %s from the borrower app", async (status, why) => {
    await expect(borrowerApp(env, answer(status, { error: "x" }))!(30)).rejects.toThrow(why);
  });

  it("is off without a URL and key, and refuses a non-https URL", async () => {
    expect(borrowerApp({}, answer(200, {}))).toBeNull();
    await expect(borrowerApp({ ...env, APP_ADMIN_SYNC_URL: "http://app.example/x" }, answer(200, {}))!(30)).rejects.toThrow(/https/);
  });

  it("keeps only known fields, bounded, so nothing unexpected reaches the page", () => {
    const c = cleanMarketplace({ ...ANSWER, extra: "x", status: { open: 1, "<script>": 9 },
      by_product: [{ product: "<b>mortgage</b>", posted: -3 }], weekly: [{ week: "javascript:x", posted: 1 }, { week: "2026-11-16", posted: 2 }] });
    expect(c).not.toHaveProperty("extra");
    expect(c.status).toEqual({ open: 1 });
    expect(c.by_product[0]).toMatchObject({ product: "bmortgageb", posted: 0 });
    expect(c.weekly.map((w) => w.week)).toEqual(["2026-11-16"]);
    expect(cleanMarketplace(null).funnel.posted).toBe(0);
  });
});

describe("kyc.ts routing", () => {
  it("sends ?module=marketplace to the marketplace handler", () => {
    const kyc = vi.fn(), releases = vi.fn(), marketplace = vi.fn(); const h = route(kyc, releases, marketplace);
    h({ headers: {}, query: { module: "marketplace" } } as any, res());
    h({ headers: {}, query: { module: "releases" } } as any, res());
    h({ headers: {}, query: {} } as any, res());
    expect([marketplace.mock.calls.length, releases.mock.calls.length, kyc.mock.calls.length]).toEqual([1, 1, 1]);
  });
});
