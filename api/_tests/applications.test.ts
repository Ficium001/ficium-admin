import { describe, it, expect, vi } from "vitest";
import { makeHandler, buildProvision } from "../applications.js";
import { PortalApiError } from "../_lib/portal-api.js";
import { InviteError } from "../_lib/institution-invite.js";
import { res, fakeAdmin, staffOk } from "./admin-harness.js";

const APP = "55555555-5555-4555-8555-555555555555";
const CR = "77777777-7777-4777-8777-777777777777";
const H = { authorization: "Bearer staff-token" };
const post = (b: Record<string, unknown>) => ({ method: "POST", headers: H, body: b });
const prov = { request_id: APP, reference: "AB12CD34EF", institution_name: "ZZ Bank", contract_reference: "MSA-2026-014",
  deployment_model: "saas", reason: "Contract signed on 12 Nov, licence checked" };
const handler = (db: any, portal: any = vi.fn(async () => ({})), invite: any = vi.fn(async () => ({ email_sent: true }))) =>
  ({ h: makeHandler({ requireStaff: staffOk(), withAdmin: db.withAdmin, portal, invite }), portal, invite });

describe("/api/applications (portal admin site)", () => {
  it("GET checks applications.read in the admin DB before asking portal-api", async () => {
    const db = fakeAdmin({ "api.change_request_list": { v: [{ id: CR }] } });
    const { h, portal } = handler(db, vi.fn(async () => [{ request_id: APP }]));
    const r = res();
    await h({ method: "GET", headers: H }, r);
    expect(r.code).toBe(200);
    expect(r.body).toEqual({ applications: [{ request_id: APP }], requests: [{ id: CR }] });
    expect(db.calls[0]!.sql).toContain("api.require_permission('applications.read')");
    expect(portal).toHaveBeenCalledWith("query", { op: "access_requests.list", args: { status: "open" } }, "staff-token");
  });

  it("GET without the permission never reaches portal-api", async () => {
    const db = fakeAdmin({}, { match: "require_permission", err: { code: "42501", message: "permission denied: applications.read" } });
    const { h, portal } = handler(db); const r = res();
    await h({ method: "GET", headers: H }, r);
    expect(r.code).toBe(403); expect(portal).not.toHaveBeenCalled();
  });

  it("GET refuses a filter that would show unconfirmed applications", async () => {
    const db = fakeAdmin(); const { h, portal } = handler(db); const r = res();
    await h({ method: "GET", headers: H, query: { status: "unverified" } } as any, r);
    expect(r.code).toBe(400); expect(portal).not.toHaveBeenCalled();
  });

  it("review: one person, prepared in the admin DB, applied by portal-api, recorded in one transaction", async () => {
    const cmd = { op: "access_request.review", command_id: CR, maker_sub: "s", args: { request_id: APP, status: "in_review" } };
    const db = fakeAdmin({ "api.application_review_prepare": { v: cmd } });
    const { h, portal } = handler(db, vi.fn(async () => ({ status: "in_review" })));
    const r = res();
    await h(post({ action: "review", request_id: APP, reference: "ab12cd34ef", status: "in_review" }), r);
    expect(r.code).toBe(200);
    expect(db.calls[0]!.params).toEqual([APP, "AB12CD34EF", "in_review", null]);
    expect(portal).toHaveBeenCalledWith("commands", cmd, "staff-token");
    expect(db.sessions).toHaveLength(1);
    expect(db.calls.map((c) => c.sql.match(/api\.\w+/)?.[0])).toEqual(["api.application_review_prepare", "api.application_review_record_result"]);
  });

  it.each([
    [{ status: "provisioned" }, "status must be"],
    [{ status: "rejected", note: "no" }, "10 characters"],
    [{ status: "info_requested" }, "10 characters"],
    [{ reference: "x" }, "reference"],
    [{ request_id: "nope" }, "request_id"],
  ])("review rejects %j before touching either database", async (over, msg) => {
    const db = fakeAdmin(); const { h, portal } = handler(db); const r = res();
    await h(post({ action: "review", request_id: APP, reference: "AB12CD34EF", status: "in_review", ...over }), r);
    expect(r.code).toBe(400); expect(r.body.error).toContain(msg);
    expect(db.calls).toHaveLength(0); expect(portal).not.toHaveBeenCalled();
  });

  it("a portal refusal of a review rolls back and is not recorded", async () => {
    const db = fakeAdmin({ "api.application_review_prepare": { v: { command_id: CR } } });
    const p = vi.fn(async () => { throw new PortalApiError(409, "invalid_transition", "An application that is rejected cannot become approved."); });
    const { h } = handler(db, p); const r = res();
    await h(post({ action: "review", request_id: APP, reference: "AB12CD34EF", status: "approved" }), r);
    expect(r.code).toBe(409);
    expect(db.calls.some((c) => c.sql.includes("record_result"))).toBe(false);
  });

  it("provision_request is only stored in the admin DB as a four-eyes request", async () => {
    const db = fakeAdmin({ "api.change_request_create": { v: { id: CR, status: "pending" } } });
    const { h, portal, invite } = handler(db); const r = res();
    await h(post({ action: "provision_request", ...prov }), r);
    expect(r.code).toBe(200);
    expect(db.calls[0]!.params).toEqual(["institution.provision", APP, "ZZ Bank (AB12CD34EF)",
      { request_id: APP, contract_reference: "MSA-2026-014", deployment_model: "saas" }, prov.reason]);
    expect(portal).not.toHaveBeenCalled(); expect(invite).not.toHaveBeenCalled();
  });

  it.each([
    [{ contract_reference: "" }, "contract"],
    [{ deployment_model: "cloud" }, "deployment_model"],
    [{ reason: "short" }, "10 characters"],
  ])("provision_request rejects %j", (over, msg) => {
    expect(() => buildProvision({ ...prov, ...over })).toThrow(msg);
  });

  it("provision_approve applies through portal-api, records it, then invites the new admin", async () => {
    const command = { op: "institution.provision", command_id: CR, maker_sub: "m", args: { request_id: APP } };
    const db = fakeAdmin({ "api.change_request_approve": { v: { command } }, "api.change_request_record_result": { v: { id: CR, status: "approved" } } });
    const result = { institution_id: "i", admin_email: "ada@zzbank.mu" };
    const { h, portal, invite } = handler(db, vi.fn(async () => result));
    const r = res();
    await h(post({ action: "provision_approve", id: CR, version: 1 }), r);
    expect(r.code).toBe(200);
    expect(portal).toHaveBeenCalledWith("commands", command, "staff-token");
    expect(invite).toHaveBeenCalledWith("Bearer staff-token", "ada@zzbank.mu");
    expect(r.body).toEqual({ request: { id: CR, status: "approved" }, provisioned: result, invite: { email_sent: true } });
  });

  it("an invite failure after provisioning is reported, not hidden, and does not undo the bank", async () => {
    const db = fakeAdmin({ "api.change_request_approve": { v: { command: { op: "institution.provision" } } }, "api.change_request_record_result": { v: { id: CR } } });
    const inv = vi.fn(async () => { throw new InviteError(502, "Couldn't reach the sign-in service. The invitation was not sent"); });
    const { h } = handler(db, vi.fn(async () => ({ admin_email: "ada@zzbank.mu" })), inv);
    const r = res();
    await h(post({ action: "provision_approve", id: CR, version: 1 }), r);
    expect(r.code).toBe(200);
    expect(r.body.invite).toEqual({ error: "Couldn't reach the sign-in service. The invitation was not sent" });
    expect(db.calls.some((c) => c.sql.includes("record_result"))).toBe(true);
  });

  it("provision_approve refuses a change request that is not a provisioning (and sends nothing)", async () => {
    const db = fakeAdmin({ "api.change_request_approve": { v: { command: { op: "institution.suspend" } } } });
    const { h, portal, invite } = handler(db); const r = res();
    await h(post({ action: "provision_approve", id: CR, version: 1 }), r);
    expect(r.code).toBe(400); expect(portal).not.toHaveBeenCalled(); expect(invite).not.toHaveBeenCalled();
  });

  it("a portal refusal of provisioning (e.g. email in use) is surfaced and nothing is invited", async () => {
    const db = fakeAdmin({ "api.change_request_approve": { v: { command: { op: "institution.provision" } } } });
    const p = vi.fn(async () => { throw new PortalApiError(409, "email_in_use", "That contact email already has a portal account."); });
    const { h, invite } = handler(db, p); const r = res();
    await h(post({ action: "provision_approve", id: CR, version: 1 }), r);
    expect(r.code).toBe(409); expect(invite).not.toHaveBeenCalled();
    expect(db.calls.some((c) => c.sql.includes("record_result"))).toBe(false);
  });

  it("resend_invite needs applications.review and forwards the caller's own token", async () => {
    const db = fakeAdmin(); const { h, invite } = handler(db); const r = res();
    await h(post({ action: "resend_invite", email: " Ada@ZZBank.mu " }), r);
    expect(r.code).toBe(200);
    expect(db.calls[0]!.sql).toContain("api.require_permission('applications.review')");
    expect(invite).toHaveBeenCalledWith("Bearer staff-token", "ada@zzbank.mu");
  });

  it("resend_invite surfaces ficium-auth's refusal", async () => {
    const db = fakeAdmin();
    const { h } = handler(db, undefined, vi.fn(async () => { throw new InviteError(409, "That account is already active."); }));
    const r = res();
    await h(post({ action: "resend_invite", email: "ada@zzbank.mu" }), r);
    expect(r.code).toBe(409); expect(r.body.error).toContain("already active");
  });
});
