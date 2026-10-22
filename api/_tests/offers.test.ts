import { describe, it, expect, vi } from "vitest";
import { makeHandler, type Deps } from "../offers.js";
import { parseOffer } from "../_lib/offers.js";
import { AuthError } from "../_lib/access.js";

function res() {
  const r: any = { code: 0, body: null, headers: {} as Record<string, string> };
  r.status = (c: number) => { r.code = c; return r; };
  r.json = (b: unknown) => { r.body = b; };
  r.setHeader = (k: string, v: string) => { r.headers[k] = v; };
  return r;
}
const staff = (email = "kj@ficium.net") => vi.fn(async () => email) as unknown as Deps["requireStaff"];
const ID = "2b9e1c1e-6f1a-4c55-9d8e-0a1b2c3d4e5f";
const good = {
  institution_name: "Bank A", category: "borrow", product_type: "leasing",
  caption: "New vehicles from a great rate", headline: "From 6.25% p.a.", terms: "MUR 200k–2M · up to 7 years",
  image_url: "https://abc123.public.blob.vercel-storage.com/offers/x-123.webp", image_alt: "A car",
  expires_at: "2026-12-31T23:59:59.000Z", verified_at: "2026-10-20T12:00:00.000Z",
  source_url: "https://bank.example/rates", consent_ref: "Email 21 Oct from J. Doe",
};
const okRows = vi.fn(async () => ({ rows: [{ offer: { id: ID } }] }));

describe("parseOffer", () => {
  it("accepts a complete offer and normalises it", () => {
    const r = parseOffer({ ...good, institution_name: "  Bank A  ", attacker: "x" });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.data.institution_name).toBe("Bank A"); expect(r.data).not.toHaveProperty("attacker"); }
  });
  it.each([
    [{ image_url: "https://evil.example.com/x.png" }, "external image"],
    [{ product_type: "savings_plan" }, "belongs under save"],
    [{ product_type: "drop_table" }, "Unknown product"],
    [{ caption: "short" }, "Caption"],
    [{ is_launch: true }, "launch window"],
    [{ is_launch: true, launch_window_ends: "2027-02-01T00:00:00Z" }, "after the offer expires"],
    [{ source_url: "http://bank.example" }, "https://"],
    [{ expires_at: "" }, "Expiry"],
  ])("rejects %j", (patch, msg) => {
    const r = parseOffer({ ...good, ...patch });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(msg);
  });
});

describe("POST /api/offers", () => {
  it("saves through admin.offer_save with the verified actor, ignoring a browser-sent actor", async () => {
    const query = vi.fn(async () => ({ rows: [{ offer: { id: ID } }] }));
    const r = res();
    await makeHandler({ requireStaff: staff(), query })({ method: "POST", headers: {}, body: { action: "save", offer: good, actor: "attacker@x.com" } }, r);
    expect(r.code).toBe(200);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("admin.offer_save");
    expect(params[2]).toBe("kj@ficium.net");
    expect(params[0]).toBeNull();
  });
  it("requires a version when editing", async () => {
    const query = vi.fn(); const r = res();
    await makeHandler({ requireStaff: staff(), query })({ method: "POST", headers: {}, body: { action: "save", id: ID, offer: good } }, r);
    expect(r.code).toBe(400); expect(query).not.toHaveBeenCalled();
  });
  it.each([
    [{ action: "approve", id: ID, reason: "short" }, "reason"],
    [{ action: "withdraw", id: ID, reason: "" }, "reason"],
    [{ action: "publish", id: "not-a-uuid" }, "Unknown offer"],
    [{ action: "reverify", id: ID, reason: "long enough reason" }, "Verification date"],
    [{ action: "delete", id: ID }, "Unknown action"],
  ])("rejects bad input %j before touching the DB", async (body, msg) => {
    const query = vi.fn(); const r = res();
    await makeHandler({ requireStaff: staff(), query })({ method: "POST", headers: {}, body }, r);
    expect(r.code).toBe(400); expect(String(r.body.error)).toContain(msg); expect(query).not.toHaveBeenCalled();
  });
  it("publishes through admin.offer_publish only", async () => {
    const r = res(); okRows.mockClear();
    await makeHandler({ requireStaff: staff(), query: okRows })({ method: "POST", headers: {}, body: { action: "publish", id: ID } }, r);
    expect(r.code).toBe(200);
    expect(okRows).toHaveBeenCalledWith(expect.stringContaining("admin.offer_publish"), [ID, "kj@ficium.net"]);
  });
  it("touches nothing when the caller isn't signed in", async () => {
    const query = vi.fn(); const r = res();
    const deny = vi.fn(async () => { throw new AuthError(401, "no"); }) as unknown as Deps["requireStaff"];
    await makeHandler({ requireStaff: deny, query })({ method: "POST", headers: {}, body: { action: "publish", id: ID } }, r);
    expect(r.code).toBe(401); expect(query).not.toHaveBeenCalled();
  });
  it("maps DB errors: validation 400, stale version 409, anything else 500 without detail", async () => {
    const run = async (err: unknown) => { const r = res();
      await makeHandler({ requireStaff: staff(), query: vi.fn(async () => { throw err; }) })({ method: "POST", headers: {}, body: { action: "publish", id: ID } }, r);
      return r; };
    expect((await run(Object.assign(new Error("only an approved offer can be published"), { code: "22023" }))).code).toBe(400);
    expect((await run(Object.assign(new Error("changed"), { code: "40001" }))).code).toBe(409);
    const r = await run(new Error("password=hunter2"));
    expect(r.code).toBe(500); expect(JSON.stringify(r.body)).not.toContain("hunter2");
  });
});

describe("GET /api/offers", () => {
  it("never caches and validates the history id", async () => {
    const r1 = res(), r2 = res();
    const query = vi.fn(async () => ({ rows: [] }));
    await makeHandler({ requireStaff: staff(), query })({ method: "GET", headers: {} }, r1);
    expect(r1.headers["Cache-Control"]).toBe("no-store");
    await makeHandler({ requireStaff: staff(), query })({ method: "GET", headers: {}, query: { id: "x;drop" } }, r2);
    expect(r2.code).toBe(400);
  });
  it("reads only admin.* tables", async () => {
    const query = vi.fn(async () => ({ rows: [] })); const r = res();
    await makeHandler({ requireStaff: staff(), query })({ method: "GET", headers: {} }, r);
    expect(String((query.mock.calls[0] as unknown as [string])[0])).not.toMatch(/public\./);
  });
});
