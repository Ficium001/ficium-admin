import { describe, it, expect, vi } from "vitest";
import { makeHandler } from "../compliance.js";
import { PortalApiError, sign, portalApi, bearer } from "../_lib/portal-api.js";
import { currentSite, onlyOn } from "../_lib/site.js";
import { createHmac } from "node:crypto";
import { res, fakeAdmin, staffOk } from "./admin-harness.js";

const INST = "33333333-3333-4333-8333-333333333333";
const DOC = "44444444-4444-4444-8444-444444444444";
const REQ = "55555555-5555-4555-8555-555555555555";
const H = { authorization: "Bearer staff-token", "x-vercel-id": "req-9" };
const post = (b: Record<string, unknown>) => ({ method: "POST", headers: H, body: b });

const portal = (answer: unknown = { ok: true }) => vi.fn(async () => answer);

describe("/api/compliance (portal admin site)", () => {
  it("GET checks compliance.read in the admin DB, then reads the overview from portal-api with the caller's token", async () => {
    const db = fakeAdmin({ "api.waiver_request_list": { v: [{ id: REQ }] } }); const p = portal([{ name: "MCB" }]); const r = res();
    await makeHandler({ requireStaff: staffOk(), withAdmin: db.withAdmin, portal: p })({ method: "GET", headers: H }, r);
    expect(r.code).toBe(200);
    expect(r.body).toEqual({ overview: [{ name: "MCB" }], requests: [{ id: REQ }] });
    expect(p).toHaveBeenCalledWith("query", { op: "compliance.overview", args: {} }, "staff-token");
  });

  it("a document review is prepared, sent and recorded in ONE admin transaction", async () => {
    const cmd = { op: "document.review", command_id: "c1", maker_sub: "m", args: { doc_id: DOC } };
    const db = fakeAdmin({ "api.document_review_prepare": { v: cmd } }); const p = portal({ status: "approved" }); const r = res();
    await makeHandler({ requireStaff: staffOk(), withAdmin: db.withAdmin, portal: p })(
      post({ action: "review", doc_id: DOC, institution_id: INST, decision: "approve", expiry_date: "2027-06-30" }), r);
    expect(r.code).toBe(200);
    expect(db.sessions).toHaveLength(1);
    expect(db.calls.map((c) => c.sql.match(/api\.\w+/)?.[0])).toEqual(["api.document_review_prepare", "api.document_review_record_result"]);
    expect(p).toHaveBeenCalledWith("commands", cmd, "staff-token");
  });

  it("if portal-api refuses, the error surfaces and nothing is recorded as done (the transaction throws)", async () => {
    const db = fakeAdmin({ "api.waiver_request_approve": { v: { command: { op: "waiver.grant" } } } });
    const p = vi.fn(async () => { throw new PortalApiError(403, "four_eyes", "The person who asked for this cannot approve it."); });
    const r = res();
    await makeHandler({ requireStaff: staffOk(), withAdmin: db.withAdmin, portal: p })(post({ action: "waiver_approve", id: REQ, version: 2 }), r);
    expect(r.code).toBe(403);
    expect(r.body.error).toContain("cannot approve");
    expect(db.calls.some((c) => c.sql.includes("record_result"))).toBe(false);
  });

  it("the four-eyes refusal from the admin DB is shown as-is", async () => {
    const db = fakeAdmin({}, { match: "waiver_request_approve", err: { code: "42501", message: "four-eyes: you cannot approve your own request" } });
    const p = portal(); const r = res();
    await makeHandler({ requireStaff: staffOk(), withAdmin: db.withAdmin, portal: p })(post({ action: "waiver_approve", id: REQ, version: 1 }), r);
    expect(r.code).toBe(403); expect(r.body.error).toContain("four-eyes");
    expect(p).not.toHaveBeenCalled();
  });

  it.each([
    [{ action: "review", doc_id: "x", institution_id: INST, decision: "approve" }, "doc_id"],
    [{ action: "review", doc_id: DOC, institution_id: INST, decision: "reject", reason: "no" }, "rejected"],
    [{ action: "waiver_request", institution_id: INST, institution_name: "MCB", waiver_action: "grant", reason: "documents in legal review" }, "waived_until"],
    [{ action: "waiver_request", institution_id: INST, institution_name: "MCB", waiver_action: "revoke", reason: "short" }, "10 characters"],
    [{ action: "waiver_approve", id: REQ }, "version"],
    [{ action: "drop" }, "Unknown action"],
  ])("rejects %j before touching either database", async (b, msg) => {
    const db = fakeAdmin(); const p = portal(); const r = res();
    await makeHandler({ requireStaff: staffOk(), withAdmin: db.withAdmin, portal: p })(post(b), r);
    expect(r.code).toBe(400); expect(String(r.body.error)).toContain(msg);
    expect(db.withAdmin).not.toHaveBeenCalled(); expect(p).not.toHaveBeenCalled();
  });
});

describe("portal-api client", () => {
  it("signs t.body with HMAC-SHA256 exactly like the contract", () => {
    const want = createHmac("sha256", "k").update('1700000000.{"op":"x"}').digest("hex");
    expect(sign('{"op":"x"}', "k", 1700000000)).toBe(`t=1700000000,v1=${want}`);
  });

  it("sends the signature and the actor token, to https only", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ data: [1] }), { status: 200 }));
    const call = portalApi({ PORTAL_API_URL: "https://api.example", ADMIN_PORTAL_SIGNING_KEY: "k" }, f as any);
    expect(await call("query", { op: "compliance.overview" }, "tok")).toEqual([1]);
    const [url, init] = f.mock.calls[0] as any;
    expect(String(url)).toBe("https://api.example/internal/admin/v1/query");
    expect(init.headers["X-Ficium-Actor"]).toBe("tok");
    expect(init.headers["Ficium-Signature"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    await expect(portalApi({ PORTAL_API_URL: "http://api.example", ADMIN_PORTAL_SIGNING_KEY: "k" }, f as any)("query", {}, "tok"))
      .rejects.toMatchObject({ status: 503 });
  });

  it("is off without configuration, and maps a portal 5xx to 502", async () => {
    await expect(portalApi({}, vi.fn() as any)("query", {}, "tok")).rejects.toMatchObject({ status: 503 });
    const f = vi.fn(async () => new Response("{}", { status: 500 }));
    await expect(portalApi({ PORTAL_API_URL: "https://a.b", ADMIN_PORTAL_SIGNING_KEY: "k" }, f as any)("commands", {}, "tok"))
      .rejects.toMatchObject({ status: 502 });
  });

  it("bearer() takes only a Bearer token", () => {
    expect(bearer({ authorization: "Bearer abc" })).toBe("abc");
    expect(bearer({ authorization: "Basic abc" })).toBe("");
  });
});

describe("site switch", () => {
  it("defaults to the app site and hides other-site endpoints with 404", async () => {
    expect(currentSite({})).toBe("app");
    expect(currentSite({ ADMIN_SITE: "portal" })).toBe("portal");
    const inner = vi.fn(); const r = res();
    await onlyOn("portal", inner, {})({}, r);
    expect(r.code).toBe(404); expect(inner).not.toHaveBeenCalled();
    await onlyOn("portal", inner, { ADMIN_SITE: "portal" })({}, res());
    expect(inner).toHaveBeenCalledOnce();
  });
});
