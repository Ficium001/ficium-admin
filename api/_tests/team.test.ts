import { describe, it, expect, vi } from "vitest";
import { makeHandler } from "../team.js";
import { provisionStaffLogin, resetStaffLogin, lookupStaff, StaffLoginError } from "../_lib/staff-login.js";
import { res, fakeAdmin, staffOk } from "./admin-harness.js";

const ID = "2b9e1c1e-6f1a-4c55-9d8e-0a1b2c3d4e5f";
const inv = { email: "ana@ficium.net", display_name: "Ana", username: "ana", roles: ["compliance"], reason: "Second approver for offers" };
const post = (b: unknown) => ({ method: "POST", headers: { authorization: "Bearer caller-token" }, body: b });

const deps = (db: ReturnType<typeof fakeAdmin>, x: Partial<Record<"provision" | "reset" | "lookup", any>> = {}) => ({
  requireStaff: staffOk(), withAdmin: db.withAdmin,
  provision: x.provision ?? vi.fn(), reset: x.reset ?? vi.fn(), lookup: x.lookup ?? vi.fn(async () => []),
});

describe("/api/team", () => {
  it("asks for an invite; nothing is created until someone else approves", async () => {
    const db = fakeAdmin({ "api.iam_change_request": { a: { id: ID, status: "pending" } } });
    const d = deps(db); const r = res();
    await makeHandler(d)(post({ action: "request", op: "invite", args: inv, reason: inv.reason }), r);
    expect(r.code).toBe(200); expect(r.body.change.status).toBe("pending");
    expect(db.calls[0]).toEqual({ sql: expect.stringContaining("api.iam_change_request"), params: ["invite", null, JSON.stringify(inv), inv.reason] });
    expect(d.provision).not.toHaveBeenCalled();
  });
  it("approving an invite creates the login as the APPROVER, in the same transaction", async () => {
    const db = fakeAdmin({
      "api.iam_change_approve": { a: { change: { id: ID }, apply: { kind: "provision", email: "ana@ficium.net", username: "ana" } } },
      "api.iam_change_record_result": { a: { id: ID, status: "approved" } },
    });
    const provision = vi.fn(async () => ({ status: "created" as const, email_sent: true })); const r = res();
    await makeHandler(deps(db, { provision }))(post({ action: "approve", id: ID, version: 1 }), r);
    expect(r.code).toBe(200); expect(r.body.result).toEqual({ status: "created", email_sent: true });
    expect(provision).toHaveBeenCalledWith("Bearer caller-token", { email: "ana@ficium.net", username: "ana" });
    expect(db.calls.map((c) => c.sql.match(/api\.\w+/)?.[0])).toEqual(["api.iam_change_approve", "api.iam_change_record_result"]);
    expect(db.withAdmin).toHaveBeenCalledOnce();
  });
  it("rolls the approval back when ficium-auth refuses", async () => {
    const db = fakeAdmin({ "api.iam_change_approve": { a: { change: {}, apply: { kind: "reset", email: "op@ficium.net", reset_mfa: true } } } });
    const reset = vi.fn(async () => { throw new StaffLoginError(404, "No Ficium staff login with that email."); }); const r = res();
    await makeHandler(deps(db, { reset }))(post({ action: "approve", id: ID, version: 3 }), r);
    expect(r.code).toBe(404);
    expect(reset).toHaveBeenCalledWith("Bearer caller-token", { email: "op@ficium.net", reset_mfa: true });
    await expect(db.withAdmin.mock.results[0]!.value).rejects.toBeInstanceOf(StaffLoginError);
  });
  it("approving a DB-only change makes no auth call", async () => {
    const db = fakeAdmin({ "api.iam_change_approve": { a: { change: { id: ID }, apply: null } } });
    const d = deps(db); const r = res();
    await makeHandler(d)(post({ action: "approve", id: ID, version: 1, note: "fine" }), r);
    expect(r.code).toBe(200); expect(d.provision).not.toHaveBeenCalled(); expect(d.reset).not.toHaveBeenCalled();
  });
  it.each([
    [{ action: "request", op: "make_god", reason: inv.reason }, "Unknown change"],
    [{ action: "request", op: "set_roles", target: "nope", args: {}, reason: inv.reason }, "Unknown admin"],
    [{ action: "request", op: "invite", args: inv, reason: "short" }, "reason"],
    [{ action: "reject", id: ID, version: 1, note: "no" }, "Say why"],
    [{ action: "approve", id: "x", version: 1 }, "Unknown request"],
    [{ action: "set_status", id: ID, version: 1, status: "active", reason: inv.reason }, "second admin"],
  ])("validates before touching anything: %j", async (b, msg) => {
    const db = fakeAdmin(); const r = res();
    await makeHandler(deps(db))(post(b), r);
    expect(r.code).toBe(400); expect(String(r.body.error)).toContain(msg);
    expect(db.withAdmin).not.toHaveBeenCalled();
  });
  it("lists the team joined with ficium-auth, and survives ficium-auth being down", async () => {
    const answers = {
      "api.iam_list": { a: [{ id: ID, email: "Ana@ficium.net" }] }, "api.iam_me": { a: { permissions: ["iam.read"] } },
      "api.iam_groups": { a: { groups: [{ code: "read_only" }], permissions: [] } }, "api.iam_change_list": { a: [] },
    };
    const lookup = vi.fn(async () => [{ email: "ana@ficium.net", username: "ana", activated: true, mfa_enabled: true, locked: false, active: true, last_login_at: null }]);
    let r = res();
    await makeHandler(deps(fakeAdmin(answers), { lookup }))({ method: "GET", headers: { authorization: "Bearer caller-token" } }, r);
    expect(r.code).toBe(200); expect(r.body.admins[0].login.username).toBe("ana"); expect(r.body.groups).toHaveLength(1);
    expect(lookup).toHaveBeenCalledWith("Bearer caller-token", ["Ana@ficium.net"]);
    r = res();
    await makeHandler(deps(fakeAdmin(answers), { lookup: vi.fn(async () => { throw new StaffLoginError(502, "down"); }) }))(
      { method: "GET", headers: {} }, r);
    expect(r.code).toBe(200); expect(r.body.admins[0].login).toBeNull(); expect(r.body.identity_error).toBe("down");
  });
  it("re-sends only through the audited, permission-checked DB function", async () => {
    const db = fakeAdmin(); const provision = vi.fn(async () => ({ status: "resent" as const, email_sent: true })); const r = res();
    await makeHandler(deps(db, { provision }))(post({ action: "resend", email: "ana@ficium.net" }), r);
    expect(r.code).toBe(200); expect(db.calls[0]!.sql).toContain("api.iam_invite_resend");
    expect(provision).toHaveBeenCalledWith("Bearer caller-token", { email: "ana@ficium.net" });
  });
  it("maps the admin DB's refusals (four-eyes, stale, no permission)", async () => {
    for (const [code, status] of [["42501", 403], ["40001", 409], ["22023", 400]] as const) {
      const db = fakeAdmin({}, { match: "iam_change_approve", err: Object.assign(new Error("four-eyes: you cannot approve your own request"), { code }) });
      const r = res();
      await makeHandler(deps(db))(post({ action: "approve", id: ID, version: 2 }), r);
      expect(r.code).toBe(status);
    }
  });
});

describe("provisionStaffLogin", () => {
  const env = { FICIUM_AUTH_URL: "https://auth.example/" };
  it("forwards the caller's bearer and returns the outcome", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ status: "created", email_sent: false }), { status: 200 }));
    expect(await provisionStaffLogin("Bearer t", { email: "a@ficium.net", username: "a" }, env, f as any)).toEqual({ status: "created", email_sent: false });
    expect((f.mock.calls[0] as any)[0]).toBe("https://auth.example/auth/staff/provision");
    expect((f.mock.calls[0] as any)[1].headers.Authorization).toBe("Bearer t");
  });
  it("turns refusals into clear errors and never echoes a link", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ detail: "That username is taken." }), { status: 409 }));
    await expect(provisionStaffLogin("Bearer t", { email: "a@ficium.net", username: "a" }, env, f as any)).rejects.toMatchObject({ status: 409 });
    const down = vi.fn(async () => { throw new Error("ECONNRESET"); });
    await expect(provisionStaffLogin("Bearer t", { email: "a@ficium.net" }, env, down as any)).rejects.toMatchObject({ status: 502 });
  });
  it("reset and lookup go to their own endpoints", async () => {
    const f = vi.fn(async (u: string) => new Response(JSON.stringify(u.endsWith("/reset") ? { status: "reset", email_sent: true } : { accounts: [{ email: "a@ficium.net" }] }), { status: 200 }));
    expect(await resetStaffLogin("Bearer t", { email: "a@ficium.net", reset_mfa: false }, env, f as any)).toEqual({ status: "reset", email_sent: true });
    expect(await lookupStaff("Bearer t", ["a@ficium.net"], env, f as any)).toHaveLength(1);
    expect(await lookupStaff("Bearer t", [], env, f as any)).toEqual([]);
    expect(f.mock.calls.map((c) => c[0])).toEqual(["https://auth.example/auth/staff/reset", "https://auth.example/auth/staff/lookup"]);
  });
});
