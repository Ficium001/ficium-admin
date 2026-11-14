import { describe, it, expect, vi } from "vitest";
import { makeHandler } from "../offers.js";
import { parseOffer } from "../_lib/offers.js";
import { AuthError } from "../_lib/access.js";
import { res, fakeAdmin, staffOk } from "./admin-harness.js";

const ID = "2b9e1c1e-6f1a-4c55-9d8e-0a1b2c3d4e5f";
const good = {
  institution_name: "Bank A", category: "borrow", product_type: "leasing",
  caption: "New vehicles from a great rate", headline: "From 6.25% p.a.", terms: "MUR 200k–2M · up to 7 years",
  image_url: "https://abc123.public.blob.vercel-storage.com/offers/x-123.webp", image_alt: "A car",
  expires_at: "2026-12-31T23:59:59.000Z", verified_at: "2026-10-20T12:00:00.000Z",
  source_url: "https://bank.example/rates", consent_ref: "Email 21 Oct from J. Doe",
};
const answers = { "api.offer_save": { o: { id: ID } }, "api.offer_view(": { o: { id: ID, created_by: "kj@ficium.net" } },
  "api.offer_view_list": { v: { actor: "kj@ficium.net", offers: [] } }, "api.offer_history": { h: [] },
  "api.offer_changes": { c: { since: "last_approval", rows: [{ field: "Terms", before: "6.5%", after: "6.25%" }] } } };
const post = (b: Record<string, unknown>) => ({ method: "POST", headers: {}, body: b });
const handler = (db = fakeAdmin(answers), kick = vi.fn(async () => undefined)) =>
  ({ h: makeHandler({ requireStaff: staffOk(), withAdmin: db.withAdmin, kick }), db, kick });

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

describe("POST /api/offers on the admin DB", () => {
  it("creates through api.offer_save (no actor argument: the DB session is the actor) and returns the display view", async () => {
    const { h, db, kick } = handler(); const r = res();
    await h(post({ action: "save", offer: good, actor: "attacker@x.com" }), r);
    expect(r.code).toBe(200); expect(r.body.offer.created_by).toBe("kj@ficium.net");
    expect(db.calls[0]!.sql).toContain("api.offer_save");
    expect(db.calls[0]!.params).toEqual([null, expect.any(String), null]);
    expect(JSON.stringify(db.calls)).not.toContain("attacker");
    expect(kick).not.toHaveBeenCalled();
  });
  it("edits with the version the admin opened", async () => {
    const { h, db } = handler(); const r = res();
    await h(post({ action: "save", id: ID, version: 4, offer: good }), r);
    expect(db.calls[0]!.params![2]).toBe(4);
  });
  it.each([
    [{ action: "save", id: ID, offer: good }, "version"],
    [{ action: "approve", id: ID, version: 2, reason: "short" }, "reason"],
    [{ action: "withdraw", id: ID, version: 2, reason: "" }, "reason"],
    [{ action: "publish", id: ID }, "version"],
    [{ action: "publish", id: "not-a-uuid", version: 1 }, "Unknown offer"],
    [{ action: "reverify", id: ID, version: 2, reason: "long enough reason" }, "Verification date"],
    [{ action: "delete", id: ID, version: 1 }, "Unknown action"],
  ])("rejects %j before opening a session", async (b, msg) => {
    const { h, db } = handler(); const r = res();
    await h(post(b), r);
    expect(r.code).toBe(400); expect(String(r.body.error)).toContain(msg); expect(db.withAdmin).not.toHaveBeenCalled();
  });
  it.each([
    ["publish", { }, "api.offer_publish", [ID, 3], true],
    ["withdraw", { reason: "Bank withdrew the rate" }, "api.offer_withdraw", [ID, 3, "Bank withdrew the rate"], true],
    ["reverify", { reason: "Checked on bank site", verified_at: "2026-10-24T12:00:00Z" }, "api.offer_reverify",
      [ID, "2026-10-24T12:00:00.000Z", 3, "Checked on bank site"], true],
    ["approve", { reason: "Rates match the bank site" }, "api.offer_approve", [ID, 3, "Rates match the bank site"], false],
  ])("%s calls only its api function and pushes when borrowers are affected", async (action, extra, fn, params, pushes) => {
    const { h, db, kick } = handler(); const r = res();
    await h(post({ action, id: ID, version: 3, ...extra }), r);
    expect(r.code).toBe(200);
    expect(db.calls[0]).toEqual({ sql: expect.stringContaining(fn), params });
    expect(kick).toHaveBeenCalledTimes(pushes ? 1 : 0);
  });
  it("touches nothing when the caller isn't signed in", async () => {
    const db = fakeAdmin(); const r = res();
    const deny = vi.fn(async () => { throw new AuthError(401, "no"); });
    await makeHandler({ requireStaff: deny, withAdmin: db.withAdmin, kick: vi.fn() })(post({ action: "publish", id: ID, version: 1 }), r);
    expect(r.code).toBe(401); expect(db.withAdmin).not.toHaveBeenCalled();
  });
  it("maps maker-checker refusals to 403 with the DB's explanation, and does not push", async () => {
    const err = Object.assign(new Error("maker-checker: the last editor cannot approve"), { code: "42501" });
    const db = fakeAdmin({}, { match: "offer_approve", err }); const kick = vi.fn(); const r = res();
    await makeHandler({ requireStaff: staffOk(), withAdmin: db.withAdmin, kick })(post({ action: "approve", id: ID, version: 2, reason: "Rates match the site" }), r);
    expect(r.code).toBe(403); expect(r.body.error).toContain("maker-checker"); expect(kick).not.toHaveBeenCalled();
  });
  it("maps stale versions to 409 and hides unexpected errors", async () => {
    const stale = fakeAdmin({}, { match: "offer_publish", err: Object.assign(new Error("changed"), { code: "40001" }) });
    const r1 = res(); await makeHandler({ requireStaff: staffOk(), withAdmin: stale.withAdmin, kick: vi.fn() })(post({ action: "publish", id: ID, version: 1 }), r1);
    expect(r1.code).toBe(409);
    const boom = fakeAdmin({}, { match: "offer_publish", err: new Error("password=hunter2") });
    const r2 = res(); await makeHandler({ requireStaff: staffOk(), withAdmin: boom.withAdmin, kick: vi.fn() })(post({ action: "publish", id: ID, version: 1 }), r2);
    expect(r2.code).toBe(500); expect(JSON.stringify(r2.body)).not.toContain("hunter2");
  });
});

describe("GET /api/offers on the admin DB", () => {
  it("lists through api.offer_view_list and never caches", async () => {
    const { h, db } = handler(); const r = res();
    await h({ method: "GET", headers: {} }, r);
    expect(r.code).toBe(200); expect(r.body.actor).toBe("kj@ficium.net");
    expect(db.calls.map((c) => c.sql).join(" ")).not.toMatch(/\b(public|admin|offers)\./);
    expect(r.headers["Cache-Control"]).toBe("no-store");
  });
  it("validates the history id and reads history from the audit view", async () => {
    const { h, db } = handler(); const r1 = res(), r2 = res();
    await h({ method: "GET", headers: {}, query: { id: "x;drop" } }, r1);
    expect(r1.code).toBe(400);
    await h({ method: "GET", headers: {}, query: { id: ID } }, r2);
    expect(r2.code).toBe(200); expect(db.calls[0]!.sql).toContain("api.offer_history");
    expect(r2.body.changes.rows).toEqual([{ field: "Terms", before: "6.5%", after: "6.25%" }]);
  });
});
