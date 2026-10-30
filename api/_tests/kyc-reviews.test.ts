import { describe, it, expect, vi } from "vitest";
import { makeHandler, type Deps } from "../kyc-reviews.js";
import { AppKycError } from "../_lib/app-kyc.js";
import { res, fakeAdmin, staffOk } from "./admin-harness.js";

const SID = "33333333-3333-4333-8333-333333333333";
const CID = "44444444-4444-4444-8444-444444444444";
const CASE = { submission_id: SID, client_id: CID, status: "pending_review", documents: { id: "https://s/1" } };
const ACCESS = { "api.kyc_review_access": { v: { actor: "kj@ficium.net" } } };

function deps(over: Partial<Deps> & { answer?: Record<string, unknown>; fail?: any } = {}) {
  const db = fakeAdmin({ ...ACCESS, ...(over.answer ?? {}) }, over.fail);
  const app = { list: vi.fn(async () => [CASE]), getCase: vi.fn(async () => CASE as any) };
  const kick = vi.fn(async () => undefined);
  const d: Deps = { requireStaff: staffOk(), withAdmin: db.withAdmin, app, kick, ...over };
  return { d, db, app, kick };
}
const get = (query: Record<string, string> = {}) => ({ method: "GET", headers: {}, query });
const post = (body: unknown) => ({ method: "POST", headers: {}, body });

describe("/api/kyc-reviews", () => {
  it("lists the queue with this site's decisions, after the permission check", async () => {
    const { d, db } = deps({ answer: { "api.kyc_case_decisions": { v: { [SID]: { decision: "verified" } } } } });
    const r = res(); await makeHandler(d)(get(), r);
    expect(r.code).toBe(200);
    expect(db.calls[0]!.sql).toContain("api.kyc_review_access");
    expect(r.body.cases[0].decision).toEqual({ decision: "verified" });
  });

  it("records the view BEFORE returning a case", async () => {
    const { d, db } = deps({ answer: { "api.kyc_case_viewed": { v: { decision: null } } } });
    const r = res(); await makeHandler(d)(get({ id: SID }), r);
    expect(r.code).toBe(200); expect(r.body.case.documents.id).toBe("https://s/1");
    expect(db.calls.map((c) => c.sql.match(/api\.\w+/)?.[0])).toEqual(["api.kyc_review_access", "api.kyc_case_viewed"]);
    expect(db.calls[1]!.params).toEqual([SID, CID]);
  });

  it("shows nothing if the view can't be recorded", async () => {
    const { d } = deps({ fail: { match: "kyc_case_viewed", err: Object.assign(new Error("audit down"), { code: "XX000" }) } });
    const r = res(); await makeHandler(d)(get({ id: SID }), r);
    expect(r.code).toBe(500); expect(JSON.stringify(r.body)).not.toContain("https://s/1");
  });

  it("a reviewer without kyc.review sees nothing and the borrower app is never asked", async () => {
    const { d, app } = deps({ fail: { match: "kyc_review_access", err: Object.assign(new Error("permission denied: kyc.review"), { code: "42501" }) } });
    const r = res(); await makeHandler(d)(get({ id: SID }), r);
    expect(r.code).toBe(403); expect(app.getCase).not.toHaveBeenCalled();
  });

  it("decides with the borrower app's client id, then pushes", async () => {
    const { d, db, kick } = deps({ answer: { "api.kyc_case_decide": { v: { decision: "rejected" } } } });
    const r = res(); await makeHandler(d)(post({ submission_id: SID, decision: "rejected", reason: "Selfie is a photo of a screen", client_id: "spoofed" }), r);
    expect(r.code).toBe(200);
    const call = db.calls.find((c) => c.sql.includes("kyc_case_decide"))!;
    expect(call.params).toEqual([SID, CID, "rejected", "Selfie is a photo of a screen"]);
    expect(kick).toHaveBeenCalledOnce();
  });

  it("refuses a case that is no longer awaiting review, and a second decision", async () => {
    const done = deps({ app: { list: vi.fn(), getCase: vi.fn(async () => ({ ...CASE, status: "verified" })) } });
    const r1 = res(); await makeHandler(done.d)(post({ submission_id: SID, decision: "verified", reason: "looks fine to me" }), r1);
    expect(r1.code).toBe(409); expect(done.kick).not.toHaveBeenCalled();
    const twice = deps({ fail: { match: "kyc_case_decide", err: Object.assign(new Error("this case has already been decided"), { code: "23505" }) } });
    const r2 = res(); await makeHandler(twice.d)(post({ submission_id: SID, decision: "verified", reason: "looks fine to me" }), r2);
    expect(r2.code).toBe(409); expect(r2.body.error).toContain("already been decided");
  });

  it.each([
    [{ submission_id: "x", decision: "verified", reason: "long enough reason" }, "Unknown case"],
    [{ submission_id: SID, decision: "maybe", reason: "long enough reason" }, "Decision"],
    [{ submission_id: SID, decision: "verified", reason: "short" }, "reason"],
  ])("validates %j before any session", async (b, msg) => {
    const { d, db } = deps(); const r = res(); await makeHandler(d)(post(b), r);
    expect(r.code).toBe(400); expect(String(r.body.error)).toContain(msg); expect(db.withAdmin).not.toHaveBeenCalled();
  });

  it("borrower app down: 502, nothing changed; not configured: 503", async () => {
    const down = deps({ app: { list: vi.fn(async () => { throw new AppKycError("borrower app answered 500"); }), getCase: vi.fn() } });
    const r = res(); vi.spyOn(console, "error").mockImplementation(() => undefined);
    await makeHandler(down.d)(get(), r); expect(r.code).toBe(502);
    const none = deps({ app: null }); const r2 = res(); await makeHandler(none.d)(get(), r2);
    expect(r2.code).toBe(503);
  });
});
