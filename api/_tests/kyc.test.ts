import { describe, it, expect, vi } from "vitest";
import { makeHandler, type Deps } from "../kyc.js";
import { AuthError } from "../_lib/access.js";

function res() {
  const r: any = { code: 0, body: null, headers: {} as Record<string, string> };
  r.status = (c: number) => { r.code = c; return r; };
  r.json = (b: unknown) => { r.body = b; };
  r.setHeader = (k: string, v: string) => { r.headers[k] = v; };
  return r;
}
const staff = (email = "kj@ficium.net") => vi.fn(async () => email) as unknown as Deps["requireStaff"];

describe("POST /api/kyc", () => {
  it("records the verified actor, ignoring any actor the browser sends", async () => {
    const query = vi.fn(async () => ({ rows: [{ settings: { face_match: true } }] }));
    const r = res();
    await makeHandler({ requireStaff: staff(), query })(
      { method: "POST", headers: {}, body: { key: "face_match", value: true, reason: "Re-enabling after audit", actor: "attacker@x.com" } }, r);
    expect(r.code).toBe(200);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("admin.set_kyc_check"),
      ["face_match", true, "kj@ficium.net", "Re-enabling after audit"]);
  });
  it.each([
    [{ key: "drop_table", value: true, reason: "long enough reason" }, "Unknown check"],
    [{ key: "face_match", value: "yes", reason: "long enough reason" }, "value"],
    [{ key: "face_match", value: true, reason: "short" }, "reason"],
  ])("rejects bad input %j", async (body, msg) => {
    const query = vi.fn();
    const r = res();
    await makeHandler({ requireStaff: staff(), query })({ method: "POST", headers: {}, body }, r);
    expect(r.code).toBe(400);
    expect(String(r.body.error)).toContain(msg);
    expect(query).not.toHaveBeenCalled();
  });
  it("touches nothing when the caller isn't signed in", async () => {
    const query = vi.fn();
    const r = res();
    const deny = vi.fn(async () => { throw new AuthError(401, "no"); }) as unknown as Deps["requireStaff"];
    await makeHandler({ requireStaff: deny, query })({ method: "POST", headers: {}, body: { key: "face_match", value: false, reason: "long enough reason" } }, r);
    expect(r.code).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });
  it("passes DB validation errors through as 400, hides others", async () => {
    const r1 = res(), r2 = res();
    const e1 = Object.assign(new Error("a reason of at least 10 characters is required"), { code: "22023" });
    await makeHandler({ requireStaff: staff(), query: vi.fn(async () => { throw e1; }) })(
      { method: "POST", headers: {}, body: { key: "face_match", value: true, reason: "long enough reason" } }, r1);
    expect(r1.code).toBe(400);
    await makeHandler({ requireStaff: staff(), query: vi.fn(async () => { throw new Error("connection string secret"); }) })(
      { method: "POST", headers: {}, body: { key: "face_match", value: true, reason: "long enough reason" } }, r2);
    expect(r2.code).toBe(500);
    expect(JSON.stringify(r2.body)).not.toContain("secret");
  });
  it("never caches responses", async () => {
    const r = res();
    await makeHandler({ requireStaff: staff(), query: vi.fn(async () => ({ rows: [] })) })({ method: "GET", headers: {} }, r);
    expect(r.headers["Cache-Control"]).toBe("no-store");
  });
});
