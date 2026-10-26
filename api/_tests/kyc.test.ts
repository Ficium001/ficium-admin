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

  it("POST calls api.kyc_set_check with the version the admin saw, then pushes to the App DB", async () => {
    const db = fakeAdmin({ "api.kyc_view": VIEW }); const kick = vi.fn(async () => undefined); const r = res();
    await makeHandler({ requireStaff: staffOk(), withAdmin: db.withAdmin, kick })(body({ ...good, actor: "attacker@x.com" }), r);
    expect(r.code).toBe(200);
    expect(db.calls[0]).toEqual({ sql: expect.stringContaining("api.kyc_set_check"), params: ["face_match", false, 3, good.reason] });
    expect(kick).toHaveBeenCalledOnce();
    expect(db.sessions[0]!.meta).toMatchObject({ ip: "203.0.113.9", requestId: "req-1" });
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
    const db = fakeAdmin({}, { match: "kyc_set_check", err: Object.assign(new Error("permission denied: kyc.change"), { code }) });
    const kick = vi.fn(); const r = res();
    await makeHandler({ requireStaff: staffOk(), withAdmin: db.withAdmin, kick })(body(good), r);
    expect(r.code).toBe(status); expect(kick).not.toHaveBeenCalled();
  });

  it("hides unexpected errors", async () => {
    const db = fakeAdmin({}, { match: "kyc_set_check", err: new Error("password=hunter2") }); const r = res();
    await makeHandler({ requireStaff: staffOk(), withAdmin: db.withAdmin, kick: vi.fn() })(body(good), r);
    expect(r.code).toBe(500); expect(JSON.stringify(r.body)).not.toContain("hunter2");
  });
});
