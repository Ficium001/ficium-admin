import { describe, it, expect, vi } from "vitest";
import { makeHandler } from "../kyc.js";
import { AuthError } from "../_lib/access.js";
import { res, fakeAdmin, staffOk, KJ } from "./admin-harness.js";

const VIEW = { v: { actor: "kj@ficium.net", settings: { face_match: true }, versions: { face_match: 3 }, history: [] } };
const body = (b: Record<string, unknown>) => ({ method: "POST", headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1", "x-vercel-id": "req-1" }, body: b });
const good = { key: "face_match", value: false, version: 3, reason: "Face matching service down, ticket #12" };

describe("/api/kyc on the admin DB", () => {
  it("GET opens a session for the verified identity and returns the view", async () => {
    const db = fakeAdmin({ "api.kyc_view": VIEW }); const r = res();
    await makeHandler({ requireStaff: staffOk(), withAdmin: db.withAdmin, kick: vi.fn() })({ method: "GET", headers: {} }, r);
    expect(r.code).toBe(200); expect(r.body.versions.face_match).toBe(3);
    expect(db.sessions[0]!.staff).toEqual(KJ);
    expect(r.headers["Cache-Control"]).toBe("no-store");
  });

  it("turning a check OFF only files a request (four-eyes) and pushes nothing", async () => {
    const db = fakeAdmin({ "api.kyc_view": VIEW }); const kick = vi.fn(async () => undefined); const r = res();
    await makeHandler({ requireStaff: staffOk(), withAdmin: db.withAdmin, kick })(body({ ...good, actor: "attacker@x.com" }), r);
    expect(r.code).toBe(200);
    expect(db.calls[0]).toEqual({ sql: expect.stringContaining("api.kyc_disable_request"), params: ["face_match", 3, good.reason] });
    expect(db.calls.some((c) => c.sql.includes("kyc_set_check"))).toBe(false);
    expect(kick).not.toHaveBeenCalled();
    expect(r.body.versions.face_match).toBe(3);
    expect(db.sessions[0]!.meta).toMatchObject({ ip: "203.0.113.9", requestId: "req-1" });
  });

  it("turning a check ON applies at once with the version the admin saw, then pushes", async () => {
    const db = fakeAdmin({ "api.kyc_view": VIEW }); const kick = vi.fn(async () => undefined); const r = res();
    await makeHandler({ requireStaff: staffOk(), withAdmin: db.withAdmin, kick })(body({ ...good, value: true }), r);
    expect(r.code).toBe(200);
    expect(db.calls[0]).toEqual({ sql: expect.stringContaining("api.kyc_set_check"), params: ["face_match", 3, good.reason] });
    expect(kick).toHaveBeenCalledOnce();
  });

  const RID = "0193f7a0-0000-7000-8000-000000000001";
  it.each([
    [{ action: "approve", id: RID, version: 1, note: "confirmed outage" }, "api.kyc_disable_approve", [RID, 1, "confirmed outage"], true],
    [{ action: "approve", id: RID, version: 1 }, "api.kyc_disable_approve", [RID, 1, null], true],
    [{ action: "reject", id: RID, version: 2, note: "keep it on, tune it" }, "api.kyc_disable_reject", [RID, 2, "keep it on, tune it"], false],
    [{ action: "withdraw", id: RID, version: 1 }, "api.kyc_disable_withdraw", [RID, 1], false],
  ])("%j calls the DB decision function (pushes only on approve)", async (b, fn, params, pushes) => {
    const db = fakeAdmin({ "api.kyc_view": VIEW }); const kick = vi.fn(async () => undefined); const r = res();
    await makeHandler({ requireStaff: staffOk(), withAdmin: db.withAdmin, kick })(body(b), r);
    expect(r.code).toBe(200);
    expect(db.calls[0]).toEqual({ sql: expect.stringContaining(fn), params });
    expect(kick).toHaveBeenCalledTimes(pushes ? 1 : 0);
  });

  it.each([
    [{ action: "approve", id: "nope", version: 1 }, "Unknown request"],
    [{ action: "approve", id: RID }, "version"],
    [{ action: "reject", id: RID, version: 1, note: "no" }, "reason"],
    [{ action: "delete", id: RID, version: 1 }, "Unknown action"],
  ])("rejects decision %j before opening a session", async (b, msg) => {
    const db = fakeAdmin(); const r = res();
    await makeHandler({ requireStaff: staffOk(), withAdmin: db.withAdmin, kick: vi.fn() })(body(b), r);
    expect(r.code).toBe(400); expect(String(r.body.error)).toContain(msg);
    expect(db.withAdmin).not.toHaveBeenCalled();
  });

  it("a self-approval refused by the DB (four-eyes) is a 403 and pushes nothing", async () => {
    const db = fakeAdmin({}, { match: "kyc_disable_approve", err: Object.assign(new Error("four-eyes: you cannot approve your own request"), { code: "42501" }) });
    const kick = vi.fn(); const r = res();
    await makeHandler({ requireStaff: staffOk(), withAdmin: db.withAdmin, kick })(body({ action: "approve", id: RID, version: 1 }), r);
    expect(r.code).toBe(403); expect(r.body.error).toContain("four-eyes"); expect(kick).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...good, key: "drop_table" }, "Unknown check"],
    [{ ...good, value: "false" }, "true or false"],
    [{ ...good, version: undefined }, "version"],
    [{ ...good, version: 0 }, "version"],
    [{ ...good, reason: "short" }, "reason"],
  ])("rejects %j before opening a session", async (b, msg) => {
    const db = fakeAdmin(); const kick = vi.fn(); const r = res();
    await makeHandler({ requireStaff: staffOk(), withAdmin: db.withAdmin, kick })(body(b), r);
    expect(r.code).toBe(400); expect(String(r.body.error)).toContain(msg);
    expect(db.withAdmin).not.toHaveBeenCalled(); expect(kick).not.toHaveBeenCalled();
  });

  it("touches nothing when the caller isn't signed in", async () => {
    const db = fakeAdmin(); const r = res();
    const deny = vi.fn(async () => { throw new AuthError(401, "no"); });
    await makeHandler({ requireStaff: deny, withAdmin: db.withAdmin, kick: vi.fn() })(body(good), r);
    expect(r.code).toBe(401); expect(db.withAdmin).not.toHaveBeenCalled();
  });

  it.each([
    ["40001", 409], ["42501", 403], ["28000", 403], ["22023", 400], ["P0002", 404], ["CONFIG", 503],
  ])("maps DB error %s to %i and does not push", async (code, status) => {
    const db = fakeAdmin({}, { match: "kyc_disable_request", err: Object.assign(new Error("permission denied: kyc.change"), { code }) });
    const kick = vi.fn(); const r = res();
    await makeHandler({ requireStaff: staffOk(), withAdmin: db.withAdmin, kick })(body(good), r);
    expect(r.code).toBe(status); expect(kick).not.toHaveBeenCalled();
  });

  it("hides unexpected errors", async () => {
    const db = fakeAdmin({}, { match: "kyc_disable_request", err: new Error("password=hunter2") }); const r = res();
    await makeHandler({ requireStaff: staffOk(), withAdmin: db.withAdmin, kick: vi.fn() })(body(good), r);
    expect(r.code).toBe(500); expect(JSON.stringify(r.body)).not.toContain("hunter2");
  });
});
