import { describe, it, expect, vi } from "vitest";
import { makeHandler, buildRequest } from "../institutions.js";
import { PortalApiError } from "../_lib/portal-api.js";
import { res, fakeAdmin, staffOk } from "./admin-harness.js";

const INST = "33333333-3333-4333-8333-333333333333";
const REQ = "55555555-5555-4555-8555-555555555555";
const H = { authorization: "Bearer staff-token" };
const post = (b: Record<string, unknown>) => ({ method: "POST", headers: H, body: b });
const portal = (answer: unknown = { ok: true }) => vi.fn(async () => answer);
const base = { op: "institution.approve", institution_id: INST, institution_name: "MCB", reason: "Licence verified with the FSC" };

describe("/api/institutions (portal admin site)", () => {
  it("GET reads requests from the admin DB and banks + catalogue from portal-api", async () => {
    const db = fakeAdmin({ "api.change_request_list": { v: [{ id: REQ, created_at: "2026-10-27" }] } });
    const p = vi.fn(async (_path: string, body: any) => (body.op === "institutions.list" ? [{ name: "MCB" }] : [{ module_code: "AUTOBID" }]));
    const r = res();
    await makeHandler({ requireStaff: staffOk(), withAdmin: db.withAdmin, portal: p as any })({ method: "GET", headers: H }, r);
    expect(r.code).toBe(200);
    expect(r.body.institutions).toEqual([{ name: "MCB" }]);
    expect(r.body.catalog).toEqual([{ module_code: "AUTOBID" }]);
    expect(p).toHaveBeenCalledWith("query", { op: "institutions.list", args: {} }, "staff-token");
  });

  it("a request is only stored in the admin DB; portal-api is not called", async () => {
    const db = fakeAdmin({ "api.change_request_create": { v: { id: REQ, status: "pending" } } }); const p = portal(); const r = res();
    await makeHandler({ requireStaff: staffOk(), withAdmin: db.withAdmin, portal: p })(post({ action: "request", ...base }), r);
    expect(r.code).toBe(200);
    expect(db.calls[0]!.params).toEqual(["institution.approve", INST, "MCB", { institution_id: INST }, base.reason]);
    expect(p).not.toHaveBeenCalled();
  });

  it("approve sends the stored command to portal-api and records the result in one transaction", async () => {
    const command = { op: "institution.approve", command_id: REQ, maker_sub: "m", args: { institution_id: INST } };
    const db = fakeAdmin({ "api.change_request_approve": { v: { command } }, "api.change_request_record_result": { v: { id: REQ, status: "approved" } } });
    const p = portal({ approved: true }); const r = res();
    await makeHandler({ requireStaff: staffOk(), withAdmin: db.withAdmin, portal: p })(post({ action: "approve", id: REQ, version: 1 }), r);
    expect(r.code).toBe(200);
    expect(p).toHaveBeenCalledWith("commands", command, "staff-token");
    expect(db.sessions).toHaveLength(1);
    expect(db.calls.map((c) => c.sql.match(/api\.\w+/)?.[0])).toEqual(["api.change_request_approve", "api.change_request_record_result"]);
  });

  it("a portal refusal surfaces and nothing is recorded as applied", async () => {
    const db = fakeAdmin({ "api.change_request_approve": { v: { command: { op: "institution.approve" } } } });
    const p = vi.fn(async () => { throw new PortalApiError(409, "already_approved", "This bank is already approved."); });
    const r = res();
    await makeHandler({ requireStaff: staffOk(), withAdmin: db.withAdmin, portal: p })(post({ action: "approve", id: REQ, version: 1 }), r);
    expect(r.code).toBe(409); expect(r.body.error).toContain("already approved");
    expect(db.calls.some((c) => c.sql.includes("record_result"))).toBe(false);
  });

  it.each([
    [{ ...base, op: "institution.delete" }, "Unknown change"],
    [{ ...base, institution_id: "x" }, "institution_id"],
    [{ ...base, reason: "short" }, "10 characters"],
    [{ ...base, op: "entitlement.set", module_code: "autobid", status: "active" }, "module_code"],
    [{ ...base, op: "entitlement.set", module_code: "AUTOBID", status: "forever" }, "status"],
    [{ ...base, op: "entitlement.set", module_code: "AUTOBID", status: "active", valid_to: "2020-01-01" }, "future"],
  ])("rejects %j before touching either database", async (b, msg) => {
    const db = fakeAdmin(); const p = portal(); const r = res();
    await makeHandler({ requireStaff: staffOk(), withAdmin: db.withAdmin, portal: p })(post({ action: "request", ...b }), r);
    expect(r.code).toBe(400); expect(String(r.body.error)).toContain(msg);
    expect(db.withAdmin).not.toHaveBeenCalled(); expect(p).not.toHaveBeenCalled();
  });

  it("entitlement requests are keyed per bank and module, so two modules can be pending at once", () => {
    const a = buildRequest({ ...base, op: "entitlement.set", module_code: "AUTOBID", status: "trial", plan_tier: "trial" });
    expect(a.key).toBe(`${INST}:AUTOBID`);
    expect(a.args).toEqual({ institution_id: INST, module_code: "AUTOBID", status: "trial", plan_tier: "trial" });
    const s = buildRequest({ ...base, op: "institution.suspend" });
    expect(s.args).toEqual({ institution_id: INST, reason: base.reason });
  });
});
