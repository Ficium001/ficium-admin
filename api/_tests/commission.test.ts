import { describe, it, expect, vi } from "vitest";
import { makeHandler, buildRequest, percentToFraction } from "../commission.js";
import { PortalApiError } from "../_lib/portal-api.js";
import { res, fakeAdmin, staffOk, fakePortal } from "./admin-harness.js";

const INST = "33333333-3333-4333-8333-333333333333";
const RULE = "66666666-6666-4666-8666-666666666666";
const REQ = "55555555-5555-4555-8555-555555555555";
const TODAY = "2026-11-01";
const H = { authorization: "Bearer staff-token" };
const post = (b: Record<string, unknown>) => ({ method: "POST", headers: H, body: b });
const set = { op: "commission.set", institution_id: INST, institution_name: "MCB", product_code: "home_loan",
  product_name: "Home loan", rate_percent: "0.45", effective_from: TODAY, reason: "MCB mortgage rate agreed in pilot" };
const CURRENT = { rule_id: RULE, institution_id: INST, product_code: "home_loan", rate: "0.0040",
  effective_from: "2026-01-01", ended_on: null };
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
    expect(r.args).toEqual({
      institution_id: INST, product_code: "home_loan", basis: "booked_amount", rate: "0.0045", params: {},
      min_fee: null, max_fee: null, clawback_months: 0, clawback_mode: "none", effective_from: TODAY, reason: set.reason,
    });
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

  it("a request freezes the rule in force for that scope and shows old rate -> new rate", async () => {
    const db = fakeAdmin({ "api.change_request_create": { v: { id: REQ, status: "pending" } } });
    const p = fakePortal({ "commission.rules": [CURRENT] }); const r = res();
    await makeHandler(deps(db, p))(post({ action: "request", ...set }), r);
    expect(r.code).toBe(200);
    const params = db.calls[0]!.params as any[];
    expect(params[0]).toBe("commission.set");
    expect(params[3]).toMatchObject({ rate: "0.0045" });
    expect(params[5]).toEqual({ exists: true, rule_id: RULE, basis: "booked_amount", rate: "0.0040", params: {},
      min_fee: null, max_fee: null, clawback_months: 0, clawback_mode: "none", effective_from: "2026-01-01" });
    expect(params[6].rows).toEqual([
      { field: "Fee", before: "0.4% of the booked amount", after: "0.45% of the booked amount" },
      { field: "Applies from", before: "2026-01-01", after: TODAY },
      { field: "Current rule ends", before: "Open", after: TODAY },
    ]);
    expect(p.mock.calls.every((c) => c[0] === "query")).toBe(true);
  });

  it("a new scope says it has no rule of its own", async () => {
    const db = fakeAdmin({ "api.change_request_create": { v: { id: REQ } } }); const r = res();
    await makeHandler(deps(db, fakePortal({ "commission.rules": [] })))(post({ action: "request", ...set }), r);
    const params = db.calls[0]!.params as any[];
    expect(params[5]).toEqual({ exists: false });
    expect(params[6].rows[0]).toEqual({ field: "Fee", before: "No rule of its own", after: "0.45% of the booked amount" });
  });

  it("approve sends the stored command to portal-api and records the result", async () => {
    const command = { op: "commission.set", command_id: REQ, maker_sub: "m",
      args: { institution_id: INST, product_code: "home_loan", rate: "0.0045", effective_from: TODAY } };
    const db = fakeAdmin({ "api.change_request_approve": { v: { command } }, "api.change_request_record_result": { v: { id: REQ, status: "approved" } } });
    const p = fakePortal({ "commission.rules": [CURRENT] }, () => ({ id: RULE })); const r = res();
    await makeHandler(deps(db, p))(post({ action: "approve", id: REQ, version: 1 }), r);
    expect(r.code).toBe(200);
    expect(p).toHaveBeenCalledWith("commands", command, "staff-token");
  });

  it("a portal refusal (e.g. a later rule exists) is passed back and nothing is recorded as done", async () => {
    const db = fakeAdmin({ "api.change_request_approve": { v: { command: { op: "commission.set", args: { institution_id: INST, product_code: "home_loan" } } } } });
    const p = fakePortal({ "commission.rules": [CURRENT] }, () => { throw new PortalApiError(409, "later_rule_exists", "A rule for this scope already starts on or after that date."); });
    const r = res();
    await makeHandler(deps(db, p))(post({ action: "approve", id: REQ, version: 1 }), r);
    expect(r.code).toBe(409);
    expect(db.calls.some((c) => c.sql.includes("record_result"))).toBe(false);
  });
});

describe("fee models through the request", () => {
  const plan = { ...set, product_code: "savings_plan", product_name: "Monthly Savings Plan", basis: "annualised",
    rate_percent: "1", months: "12", min_fee: "250", max_fee: "5000", clawback_months: "6", clawback_mode: "pro_rata" };

  it("an annualised plan rule carries its whole model to portal-api", () => {
    const r = buildRequest(plan, TODAY);
    expect(r.args).toMatchObject({ basis: "annualised", rate: "0.0100", params: { months: 12 },
      min_fee: "250.00", max_fee: "5000.00", clawback_months: 6, clawback_mode: "pro_rata" });
  });

  it("the reviewer sees the model in words, old and new", async () => {
    const db = fakeAdmin({ "api.change_request_create": { v: { id: REQ } } }); const r = res();
    await makeHandler(deps(db, fakePortal({ "commission.rules": [] })))(post({ action: "request", ...plan }), r);
    expect(r.code).toBe(200);
    const rows = (db.calls[0]!.params as any[])[6].rows;
    expect(rows[0].after).toBe("1% of the first amount plus 12 months of the monthly amount · at least MUR 250 · at most MUR 5,000 · unearned share refunded if closed within 6 months");
  });

  it("a flat fee has no rate and no limits", () => {
    const r = buildRequest({ ...set, basis: "flat", rate_percent: "", flat_amount: "350" }, TODAY);
    expect(r.args).toMatchObject({ basis: "flat", rate: null, params: { amount: 350 }, min_fee: null, max_fee: null });
  });

  it("tiered bands become numbers, the last with no limit", () => {
    const r = buildRequest({ ...set, basis: "tiered", tier_mode: "marginal",
      tiers: [{ up_to: "100000", rate_percent: "1" }, { up_to: "500000", rate_percent: "0.5" }, { up_to: "", rate_percent: "0.25" }] }, TODAY);
    expect((r.args as { params?: unknown }).params).toEqual({ mode: "marginal", tiers: [
      { up_to: 100000, rate: 0.01 }, { up_to: 500000, rate: 0.005 }, { up_to: null, rate: 0.0025 }] });
  });

  it.each([
    [{ basis: "annualised", months: "0" }, "Months"],
    [{ basis: "tiered", tiers: [{ up_to: "500", rate_percent: "1" }, { up_to: "400", rate_percent: "1" }, { rate_percent: "1" }] }, "above the one before"],
    [{ basis: "flat", flat_amount: "" }, "fixed fee"],
    [{ min_fee: "500", max_fee: "100" }, "minimum fee"],
    [{ clawback_months: "40" }, "Clawback"],
    [{ basis: "trail" }, "Choose how"],
  ])("refuses %o with a clear message", (over, msg) => expect(() => buildRequest({ ...set, ...over }, TODAY)).toThrow(msg));

  it("preview checks commission.read, then asks the Portal DB to do the sum", async () => {
    const db = fakeAdmin(); const portal = vi.fn(async () => ({ calc: { fee: 250 } })); const r = res();
    await makeHandler(deps(db, portal) as any)(post({ action: "preview", ...plan, inputs: { amount: "1000", monthly_amount: "500" } }), r);
    expect(r.code).toBe(200); expect(r.body).toEqual({ calc: { fee: 250 } });
    expect(db.calls[0]!.sql).toContain("require_permission('commission.read')");
    expect(portal).toHaveBeenCalledWith("query", { op: "commission.preview", args: expect.objectContaining({
      basis: "annualised", rate: "0.0100", inputs: { amount: "1000", monthly_amount: "500" } }) }, "staff-token");
  });

  it("preview refuses a bad model or example without asking anyone", async () => {
    const db = fakeAdmin(); const portal = vi.fn(); const r = res();
    await makeHandler(deps(db, portal) as any)(post({ action: "preview", ...plan, months: "99", inputs: { amount: "1000" } }), r);
    expect(r.code).toBe(400); expect(portal).not.toHaveBeenCalled();
    const r2 = res();
    await makeHandler(deps(db, portal) as any)(post({ action: "preview", ...plan, inputs: { amount: "-3" } }), r2);
    expect(r2.code).toBe(400); expect(r2.body.error).toContain("example amount");
  });
});

describe("commission statement", () => {
  const get = (query: Record<string, string>) => ({ method: "GET", headers: H, query });
  const STATEMENT = { institution: { name: "MCB" }, month: "2026-11", lines: [], totals: { deals: 0, commission: "0" } };

  it("checks commission.read, then asks portal-api for exactly that bank and month", async () => {
    const db = fakeAdmin(); const portal = vi.fn(async () => STATEMENT);
    const r = res(); await makeHandler(deps(db, portal) as any)(get({ statement: "1", institution_id: INST, month: "2026-11" }), r);
    expect(r.code).toBe(200); expect(r.body).toEqual(STATEMENT);
    expect(db.calls[0]!.sql).toContain("require_permission('commission.read')");
    expect(portal).toHaveBeenCalledWith("query", { op: "commission.statement", args: { institution_id: INST, month: "2026-11" } }, "staff-token");
  });

  it.each([
    [{ institution_id: "x", month: "2026-11" }, "Choose a bank"],
    [{ institution_id: INST, month: "2026-13" }, "Choose a month"],
    [{ institution_id: INST, month: "" }, "Choose a month"],
  ])("refuses %j without asking anyone", async (q, msg) => {
    const db = fakeAdmin(); const portal = vi.fn();
    const r = res(); await makeHandler(deps(db, portal) as any)(get({ statement: "1", ...q }), r);
    expect(r.code).toBe(400); expect(r.body.error).toContain(msg); expect(db.calls).toEqual([]); expect(portal).not.toHaveBeenCalled();
  });

  it("someone without commission.read never reaches the portal", async () => {
    const db = fakeAdmin({}, { match: "commission.read", err: Object.assign(new Error("permission denied: commission.read"), { code: "42501" }) });
    const portal = vi.fn();
    const r = res(); await makeHandler(deps(db, portal) as any)(get({ statement: "1", institution_id: INST, month: "2026-11" }), r);
    expect(r.code).toBe(403); expect(portal).not.toHaveBeenCalled();
  });
});
