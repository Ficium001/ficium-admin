import { describe, it, expect, vi } from "vitest";
import { makeHandler, buildRequest } from "../institutions.js";
import { PortalApiError } from "../_lib/portal-api.js";
import { res, fakeAdmin, staffOk, fakePortal } from "./admin-harness.js";

const INST = "33333333-3333-4333-8333-333333333333";
const REQ = "55555555-5555-4555-8555-555555555555";
const H = { authorization: "Bearer staff-token" };
const post = (b: Record<string, unknown>) => ({ method: "POST", headers: H, body: b });
const MCB = { institution_id: INST, name: "MCB", approved: false, suspended_at: null, active_members: 0,
  entitlements: [{ module_code: "AUTOBID", status: "trial", plan_tier: "trial", valid_to: null }] };
const portal = (answer: unknown = { ok: true }, inst: unknown = MCB) => fakePortal({ "institutions.list": [inst] }, () => answer);
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
    expect(db.calls[0]!.sql).toContain("api.require_permission('institutions.read')");
  });

  it("GET refuses before asking portal-api when the admin lacks institutions.read", async () => {
    const db = fakeAdmin({}, { match: "require_permission", err: { code: "42501", message: "permission denied: institutions.read" } });
    const p = vi.fn(); const r = res();
    await makeHandler({ requireStaff: staffOk(), withAdmin: db.withAdmin, portal: p as any })({ method: "GET", headers: H }, r);
    expect(r.code).toBe(403); expect(p).not.toHaveBeenCalled();
  });

  it("view=groups returns the read-only role templates", async () => {
    const db = fakeAdmin(); const p = vi.fn(async () => [{ slug: "bank_officer" }]); const r = res();
    await makeHandler({ requireStaff: staffOk(), withAdmin: db.withAdmin, portal: p as any })({ method: "GET", headers: H, query: { view: "groups" } } as any, r);
    expect(r.code).toBe(200); expect(r.body.groups).toEqual([{ slug: "bank_officer" }]);
    expect(p).toHaveBeenCalledWith("query", { op: "groups.list", args: {} }, "staff-token");
  });

  it("a request freezes the bank's current state and the change; portal-api is only read", async () => {
    const db = fakeAdmin({ "api.change_request_create": { v: { id: REQ, status: "pending" } } }); const p = portal(); const r = res();
    await makeHandler({ requireStaff: staffOk(), withAdmin: db.withAdmin, portal: p })(post({ action: "request", ...base }), r);
    expect(r.code).toBe(200);
    expect(db.calls[0]!.params).toEqual(["institution.approve", INST, "MCB", { institution_id: INST }, base.reason,
      { status: "Not yet approved" },
      { rows: [{ field: "Status", before: "Not yet approved", after: "Active" }], described: true }]);
    expect(p.mock.calls.every((c) => c[0] === "query")).toBe(true);
  });

  it("an entitlement change shows the module as it is now next to what it will be", async () => {
    const db = fakeAdmin({ "api.change_request_create": { v: { id: REQ } } }); const r = res();
    await makeHandler({ requireStaff: staffOk(), withAdmin: db.withAdmin, portal: portal() })(
      post({ action: "request", ...base, op: "entitlement.set", module_code: "AUTOBID", status: "active", plan_tier: "professional" }), r);
    expect(r.code).toBe(200);
    const [, , , , , before, change] = db.calls[0]!.params as any[];
    expect(before).toEqual({ exists: true, status: "trial", plan_tier: "trial", valid_to: null });
    expect(change.rows).toEqual([
      { field: "Module", before: "AUTOBID", after: "AUTOBID" },
      { field: "Status", before: "Trial", after: "Active" },
      { field: "Plan", before: "Trial", after: "Professional" },
      { field: "Valid until", before: "No end date", after: "No end date" },
    ]);
  });

  it("approval is refused when the bank changed after the request (the DB compares the fresh read)", async () => {
    const command = { op: "institution.approve", command_id: REQ, maker_sub: "m", args: { institution_id: INST } };
    const db = fakeAdmin({ "api.change_request_approve": { v: { command } } },
      { match: "confirm_unchanged", err: { code: "FC409", message: "CHANGED_SINCE_REQUEST: this record changed after the request was made. Reject it and ask again" } });
    const p = portal(); const r = res();
    await makeHandler({ requireStaff: staffOk(), withAdmin: db.withAdmin, portal: p })(post({ action: "approve", id: REQ, version: 1 }), r);
    expect(r.code).toBe(409); expect(r.body.error).toMatch(/^this record changed/);
    expect(db.calls.find((c) => c.sql.includes("confirm_unchanged"))!.params).toEqual([REQ, { status: "Not yet approved" }]);
    expect(p.mock.calls.some((c) => c[0] === "commands")).toBe(false);
  });

  it("approve sends the stored command to portal-api and records the result in one transaction", async () => {
    const command = { op: "institution.approve", command_id: REQ, maker_sub: "m", args: { institution_id: INST } };
    const db = fakeAdmin({ "api.change_request_approve": { v: { command } }, "api.change_request_record_result": { v: { id: REQ, status: "approved" } } });
    const p = portal({ approved: true }); const r = res();
    await makeHandler({ requireStaff: staffOk(), withAdmin: db.withAdmin, portal: p })(post({ action: "approve", id: REQ, version: 1 }), r);
    expect(r.code).toBe(200);
    expect(p).toHaveBeenCalledWith("commands", command, "staff-token");
    expect(db.sessions).toHaveLength(1);
    expect(db.calls.map((c) => c.sql.match(/api\.\w+/)?.[0])).toEqual(["api.change_request_approve", "api.change_request_confirm_unchanged", "api.change_request_record_result"]);
  });

  it("a portal refusal surfaces and nothing is recorded as applied", async () => {
    const db = fakeAdmin({ "api.change_request_approve": { v: { command: { op: "institution.approve", args: { institution_id: INST } } } } });
    const p = fakePortal({ "institutions.list": [MCB] }, () => { throw new PortalApiError(409, "already_approved", "This bank is already approved."); });
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

  it("invite_admin needs an email and a name, and is stored as a four-eyes request", async () => {
    expect(() => buildRequest({ ...base, op: "institution.invite_admin", email: "x", full_name: "MCB Ops" })).toThrow("email");
    expect(() => buildRequest({ ...base, op: "institution.invite_admin", email: "ops@mcb.mu", full_name: "" })).toThrow("full_name");
    const r = buildRequest({ ...base, op: "institution.invite_admin", email: " Ops@MCB.mu ", full_name: "MCB Ops" });
    expect(r.args).toEqual({ institution_id: INST, email: "ops@mcb.mu", full_name: "MCB Ops", reason: base.reason });
    expect(r.label).toBe("MCB: ops@mcb.mu");
  });

  it("approving invite_admin applies it, then emails the invite as the approver", async () => {
    const command = { op: "institution.invite_admin", command_id: REQ, maker_sub: "m", args: { institution_id: INST } };
    const db = fakeAdmin({ "api.change_request_approve": { v: { command } }, "api.change_request_record_result": { v: { id: REQ } } });
    const p = portal({ admin_email: "ops@mcb.mu" }); const invite = vi.fn(async () => ({ email_sent: true })); const r = res();
    await makeHandler({ requireStaff: staffOk(), withAdmin: db.withAdmin, portal: p, invite })(post({ action: "approve", id: REQ, version: 1 }), r);
    expect(r.code).toBe(200);
    expect(invite).toHaveBeenCalledWith("Bearer staff-token", "ops@mcb.mu");
    expect(r.body.invite).toEqual({ email_sent: true });
  });

  it("other approvals never send an invitation", async () => {
    const command = { op: "institution.approve", command_id: REQ, maker_sub: "m", args: { institution_id: INST } };
    const db = fakeAdmin({ "api.change_request_approve": { v: { command } }, "api.change_request_record_result": { v: { id: REQ } } });
    const invite = vi.fn(); const r = res();
    await makeHandler({ requireStaff: staffOk(), withAdmin: db.withAdmin, portal: portal(), invite })(post({ action: "approve", id: REQ, version: 1 }), r);
    expect(r.code).toBe(200); expect(invite).not.toHaveBeenCalled();
  });
});
