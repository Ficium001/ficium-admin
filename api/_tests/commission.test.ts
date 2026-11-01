import { describe, it, expect, vi } from "vitest";
import { makeHandler, buildRequest, percentToFraction } from "../commission.js";
import { PortalApiError } from "../_lib/portal-api.js";
import { res, fakeAdmin, staffOk } from "./admin-harness.js";

const INST = "33333333-3333-4333-8333-333333333333";
const RULE = "66666666-6666-4666-8666-666666666666";
const REQ = "55555555-5555-4555-8555-555555555555";
const TODAY = "2026-11-01";
const H = { authorization: "Bearer staff-token" };
const post = (b: Record<string, unknown>) => ({ method: "POST", headers: H, body: b });
const set = { op: "commission.set", institution_id: INST, institution_name: "MCB", product_code: "home_loan",
  product_name: "Home loan", rate_percent: "0.45", effective_from: TODAY, reason: "MCB mortgage rate agreed in pilot" };
const deps = (db: ReturnType<typeof fakeAdmin>, portal: any = vi.fn()) =>
  ({ requireStaff: staffOk(), withAdmin: db.withAdmin, portal, today: () => TODAY });

describe("percentToFraction", () => {
  it.each([["0.45", "0.0045"], ["1", "0.0100"], ["0.9", "0.0090"], ["5", "0.0500"], ["0", "0.0000"], ["0.01", "0.0001"]])(
    "%s%% -> %s", (p, f) => expect(percentToFraction(p)).toBe(f));
  it.each(["5.01", "6", "-1", "0.125", "abc", "", "1e-2"])("refuses %s", (p) => expect(() => percentToFraction(p)).toThrow());
});

describe("buildRequest (commission)", () => {
  it("set: scope key, label and the exact args portal-api receives", () => {
    const r = buildRequest(set, TODAY);
    expect(r.key).toBe(`${INST}:home_loan`);
    expect(r.label).toBe("MCB · Home loan");
    expect(r.args).toEqual({ institution_id: INST, product_code: "home_loan", rate: "0.0045", effective_from: TODAY, reason: set.reason });
  });
  it("set: blank bank and product is the platform default", () => {
    const r = buildRequest({ ...set, institution_id: "", institution_name: "", product_code: "", rate_percent: "0.9" }, TODAY);
    expect(r.key).toBe("*:*");
    expect(r.label).toBe("All banks · All products");
    expect(r.args).toMatchObject({ institution_id: null, product_code: null, rate: "0.0090" });
  });
  it.each([
    [{ effective_from: "2026-10-31" }, "start date"],
    [{ rate_percent: "7" }, "above"],
    [{ reason: "short" }, "reason"],
    [{ institution_id: "nope" }, "institution_id"],
    [{ product_code: "Home Loan" }, "product_code"],
    [{ op: "commission.delete" }, "Unknown"],
  ])("set refuses %o", (over, msg) => expect(() => buildRequest({ ...set, ...over }, TODAY)).toThrow(msg));
  it("end: keyed on the rule", () => {
    const r = buildRequest({ op: "commission.end", rule_id: RULE, label: "MCB · Home loan", ended_on: "2026-12-01", reason: "Pilot pricing ends" }, TODAY);
    expect(r.key).toBe(RULE);
    expect(r.args).toEqual({ rule_id: RULE, ended_on: "2026-12-01", reason: "Pilot pricing ends" });
  });
});

describe("/api/commission (portal admin site)", () => {
  it("GET checks commission.read in the admin DB, then reads the schedule from portal-api", async () => {
    const db = fakeAdmin({ "api.change_request_list": { v: [{ id: REQ }] } });
    const p = vi.fn(async (_path: string, body: any) =>
      body.op === "commission.rules" ? [{ rule_id: RULE }] : body.op === "institutions.list" ? [{ institution_id: INST, name: "MCB", primary_contact_email: "x@y" }] : [{ product_code: "home_loan" }]);
    const r = res();
    await makeHandler(deps(db, p))({ method: "GET", headers: H }, r);
    expect(r.code).toBe(200);
    expect(db.calls[0]!.sql).toContain("api.require_permission('commission.read')");
    expect(r.body.rules).toEqual([{ rule_id: RULE }]);
    expect(r.body.institutions).toEqual([{ institution_id: INST, name: "MCB" }]); // contact details not passed on
    expect(r.body.requests).toEqual([{ id: REQ }]);
  });

  it("GET refuses before asking portal-api when the admin lacks commission.read", async () => {
    const db = fakeAdmin({}, { match: "require_permission", err: { code: "42501", message: "permission denied: commission.read" } });
    const p = vi.fn(); const r = res();
    await makeHandler(deps(db, p))({ method: "GET", headers: H }, r);
    expect(r.code).toBe(403); expect(p).not.toHaveBeenCalled();
  });

  it("a request is stored in the admin DB only; portal-api is not called", async () => {
    const db = fakeAdmin({ "api.change_request_create": { v: { id: REQ, status: "pending" } } }); const p = vi.fn(); const r = res();
    await makeHandler(deps(db, p))(post({ action: "request", ...set }), r);
    expect(r.code).toBe(200);
    expect(db.calls[0]!.params![0]).toBe("commission.set");
    expect(db.calls[0]!.params![3]).toMatchObject({ rate: "0.0045" });
    expect(p).not.toHaveBeenCalled();
  });

  it("approve sends the stored command to portal-api and records the result", async () => {
    const command = { op: "commission.set", command_id: REQ, maker_sub: "m", args: { rate: "0.0045" } };
    const db = fakeAdmin({ "api.change_request_approve": { v: { command } }, "api.change_request_record_result": { v: { id: REQ, status: "approved" } } });
    const p = vi.fn(async () => ({ id: RULE })); const r = res();
    await makeHandler(deps(db, p))(post({ action: "approve", id: REQ, version: 1 }), r);
    expect(r.code).toBe(200);
    expect(p).toHaveBeenCalledWith("commands", command, "staff-token");
  });

  it("a portal refusal (e.g. a later rule exists) is passed back and nothing is recorded as done", async () => {
    const db = fakeAdmin({ "api.change_request_approve": { v: { command: { op: "commission.set" } } } });
    const p = vi.fn(async () => { throw new PortalApiError(409, "later_rule_exists", "A rule for this scope already starts on or after that date."); });
    const r = res();
    await makeHandler(deps(db, p))(post({ action: "approve", id: REQ, version: 1 }), r);
    expect(r.code).toBe(409);
    expect(db.calls.some((c) => c.sql.includes("record_result"))).toBe(false);
  });
});
