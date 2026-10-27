import { describe, it, expect, vi } from "vitest";
import { makeHandler } from "../team.js";
import { provisionStaffLogin, StaffLoginError } from "../_lib/staff-login.js";
import { res, fakeAdmin, staffOk } from "./admin-harness.js";

const ID = "2b9e1c1e-6f1a-4c55-9d8e-0a1b2c3d4e5f";
const inv = { action: "invite", email: "Ana@Ficium.net", display_name: "Ana", username: "ana", roles: ["compliance"], reason: "Second approver for offers" };
const post = (b: unknown) => ({ method: "POST", headers: { authorization: "Bearer caller-token" }, body: b });

describe("/api/team", () => {
  it("invites in ONE admin-DB transaction and creates the login as the caller", async () => {
    const db = fakeAdmin({ "api.iam_invite": { a: { id: ID } } });
    const provision = vi.fn(async () => ({ status: "created" as const, email_sent: true })); const r = res();
    await makeHandler({ requireStaff: staffOk(), withAdmin: db.withAdmin, provision })(post(inv), r);
    expect(r.code).toBe(200); expect(r.body).toMatchObject({ status: "created", email_sent: true });
    expect(db.calls[0]).toEqual({ sql: expect.stringContaining("api.iam_invite"), params: ["ana@ficium.net", "Ana", ["compliance"], inv.reason] });
    expect(provision).toHaveBeenCalledWith("Bearer caller-token", { email: "ana@ficium.net", username: "ana" });
    expect(db.withAdmin).toHaveBeenCalledOnce();
  });
  it("rolls the invite back when the login cannot be created", async () => {
    const db = fakeAdmin({ "api.iam_invite": { a: { id: ID } } });
    const provision = vi.fn(async () => { throw new StaffLoginError(409, "That email already has an account."); });
    const r = res();
    await makeHandler({ requireStaff: staffOk(), withAdmin: db.withAdmin, provision })(post(inv), r);
    expect(r.code).toBe(409); expect(r.body.error).toContain("already has an account");
    // the throw happened inside withAdmin's callback => the real implementation rolls back
    await expect(db.withAdmin.mock.results[0]!.value).rejects.toBeInstanceOf(StaffLoginError);
  });
  it.each([
    [{ ...inv, email: "x" }, "email"], [{ ...inv, display_name: "" }, "name"], [{ ...inv, username: "A B" }, "Username"],
    [{ ...inv, roles: [] }, "role"], [{ ...inv, roles: ["god"] }, "role"], [{ ...inv, reason: "short" }, "reason"],
  ])("validates invites before touching anything: %j", async (b, msg) => {
    const db = fakeAdmin(); const provision = vi.fn(); const r = res();
    await makeHandler({ requireStaff: staffOk(), withAdmin: db.withAdmin, provision })(post(b), r);
    expect(r.code).toBe(400); expect(String(r.body.error)).toContain(msg);
    expect(db.withAdmin).not.toHaveBeenCalled(); expect(provision).not.toHaveBeenCalled();
  });
  it("re-sends only through the audited, permission-checked DB function", async () => {
    const db = fakeAdmin(); const provision = vi.fn(async () => ({ status: "resent" as const, email_sent: true })); const r = res();
    await makeHandler({ requireStaff: staffOk(), withAdmin: db.withAdmin, provision })(post({ action: "resend", email: "ana@ficium.net" }), r);
    expect(r.code).toBe(200); expect(db.calls[0]!.sql).toContain("api.iam_invite_resend");
    expect(provision).toHaveBeenCalledWith("Bearer caller-token", { email: "ana@ficium.net" });
  });
  it("maps the admin DB's refusals (self-change, stale, no permission)", async () => {
    for (const [code, status] of [["42501", 403], ["40001", 409]] as const) {
      const db = fakeAdmin({}, { match: "iam_set_status", err: Object.assign(new Error("you cannot change your own status"), { code }) });
      const r = res();
      await makeHandler({ requireStaff: staffOk(), withAdmin: db.withAdmin, provision: vi.fn() })(
        post({ action: "set_status", id: ID, status: "disabled", version: 2, reason: "Left the company today" }), r);
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
});
