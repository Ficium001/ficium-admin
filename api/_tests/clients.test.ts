import { describe, it, expect, vi } from "vitest";
import { makeHandler, queryKind, type Deps } from "../clients.js";
import { AppClientsError } from "../_lib/app-clients.js";
import { res, fakeAdmin, staffOk } from "./admin-harness.js";

const CID = "44444444-4444-4444-8444-444444444444";
const RID = "55555555-5555-4555-8555-555555555555";
const ROW = { client_id: CID, full_name: "Jane Doe", email: "jane@example.com", kyc_status: "verified", created_at: "2026-11-01", suspended: false, closed: false };
const SUMMARY = { client_id: CID, full_name: "Jane Doe", suspended: false };
const ACCESS = { "api.client_lookup_access": { v: { actor: "kj@ficium.net", can_request: true, can_approve: true } },
                 "api.client_access_pending": { v: [] } };

function deps(over: Partial<Deps> & { answer?: Record<string, unknown>; fail?: any; summary?: any } = {}) {
  const db = fakeAdmin({ ...ACCESS, ...(over.answer ?? {}) }, over.fail);
  const app = { search: vi.fn(async () => [ROW]), get: vi.fn(async () => (over.summary === undefined ? SUMMARY : over.summary)) };
  const kick = vi.fn(async () => undefined);
  const d: Deps = { requireStaff: staffOk(), withAdmin: db.withAdmin, app, kick, ...over };
  return { d, db, app, kick };
}
const get = (query: Record<string, string> = {}) => ({ method: "GET", headers: {}, query });
const post = (body: unknown) => ({ method: "POST", headers: {}, body });
const fns = (db: ReturnType<typeof fakeAdmin>) => db.calls.map((c) => c.sql.match(/api\.\w+/)?.[0]);

describe("/api/clients", () => {
  it("searches after the permission check, and audits the kind of search, never the text", async () => {
    const { d, db, app } = deps();
    const r = res(); await makeHandler(d)(get({ q: "jane@exa" }), r);
    expect(r.code).toBe(200);
    expect(r.body.clients[0].client_id).toBe(CID);
    expect(fns(db)[0]).toBe("api.client_lookup_access");
    expect(db.calls[0]!.params).toEqual(["email"]);
    expect(JSON.stringify(db.calls)).not.toContain("jane@exa");
    expect(app.search).toHaveBeenCalledWith("jane@exa");
  });

  it("rejects too-short searches without asking anyone", async () => {
    const { d, db, app } = deps();
    const r = res(); await makeHandler(d)(get({ q: "ja" }), r);
    expect(r.code).toBe(400); expect(db.calls).toEqual([]); expect(app.search).not.toHaveBeenCalled();
  });

  it("someone without client.lookup sees nothing and the borrower app is never asked", async () => {
    const { d, app } = deps({ fail: { match: "client_lookup_access", err: Object.assign(new Error("permission denied: client.lookup"), { code: "42501" }) } });
    const r = res(); await makeHandler(d)(get({ q: "jane" }), r);
    expect(r.code).toBe(403); expect(app.search).not.toHaveBeenCalled();
  });

  it("records the view BEFORE reading the borrower, and shows nothing if it can't be recorded", async () => {
    const ok = deps({ answer: { "api.client_viewed": { v: { actor: "kj", requests: [] } } } });
    const r = res(); await makeHandler(ok.d)(get({ id: CID }), r);
    expect(r.code).toBe(200); expect(r.body.client.full_name).toBe("Jane Doe");
    expect(fns(ok.db)).toEqual(["api.client_viewed"]);

    const broken = deps({ fail: { match: "client_viewed", err: Object.assign(new Error("audit down"), { code: "XX000" }) } });
    const r2 = res(); await makeHandler(broken.d)(get({ id: CID }), r2);
    expect(r2.code).toBe(500); expect(broken.app.get).not.toHaveBeenCalled();
    expect(JSON.stringify(r2.body)).not.toContain("Jane");
  });

  it("asks for a suspension with the borrower's CURRENT state read from the app", async () => {
    const { d, db, kick } = deps({ summary: { ...SUMMARY, suspended: true }, answer: { "api.client_access_request": { v: { id: RID } } } });
    const r = res(); await makeHandler(d)(post({ op: "request", client_id: CID, action: "reinstate", reason: "Cleared after review" }), r);
    expect(r.code).toBe(200);
    expect(db.calls.find((c) => c.sql.includes("client_access_request"))!.params).toEqual([CID, "reinstate", "Cleared after review", true]);
    expect(kick).not.toHaveBeenCalled(); // nothing reaches the app until a second admin approves
  });

  it.each([
    [{ op: "request", client_id: "x", action: "suspend", reason: "Suspected fraud here" }, "Unknown borrower"],
    [{ op: "request", client_id: CID, action: "delete", reason: "Suspected fraud here" }, "Action must be suspend or reinstate"],
    [{ op: "request", client_id: CID, action: "suspend", reason: "short" }, "Give a reason"],
    [{ op: "approve", id: RID, version: 0 }, "Unknown request"],
    [{ op: "reject", id: RID, version: 1, note: "no" }, "Give a reason"],
    [{ op: "erase", id: RID, version: 1 }, "Unknown operation"],
  ])("refuses %j", async (body, msg) => {
    const { d, db } = deps();
    const r = res(); await makeHandler(d)(post(body), r);
    expect(r.code).toBe(400); expect(r.body.error).toContain(msg); expect(db.calls).toEqual([]);
  });

  it("approving kicks the dispatcher; approving your own request is refused by the database", async () => {
    const ok = deps({ answer: { "api.client_access_approve": { v: { status: "approved" } } } });
    const r = res(); await makeHandler(ok.d)(post({ op: "approve", id: RID, version: 1 }), r);
    expect(r.code).toBe(200); expect(ok.kick).toHaveBeenCalledOnce();

    const own = deps({ fail: { match: "client_access_approve", err: Object.assign(new Error("four-eyes: you cannot approve your own request"), { code: "42501" }) } });
    const r2 = res(); await makeHandler(own.d)(post({ op: "approve", id: RID, version: 1 }), r2);
    expect(r2.code).toBe(403); expect(r2.body.error).toContain("four-eyes"); expect(own.kick).not.toHaveBeenCalled();
  });

  it("says plainly when the borrower app doesn't answer, and when it isn't connected", async () => {
    const down = deps(); down.app.search.mockRejectedValue(new AppClientsError("borrower app answered 503"));
    const r = res(); await makeHandler(down.d)(get({ q: "jane" }), r);
    expect(r.code).toBe(502);
    const off = deps({ app: null });
    const r2 = res(); await makeHandler(off.d)(get({ q: "jane" }), r2);
    expect(r2.code).toBe(503);
  });

  it("classifies searches for the audit log", () => {
    expect(queryKind(CID)).toBe("id"); expect(queryKind("a@b")).toBe("email"); expect(queryKind("Jane")).toBe("name");
  });
});
