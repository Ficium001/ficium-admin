import { describe, it, expect, vi } from "vitest";
import { makeHandler, parse } from "../_lib/support-cases.js";
import { route } from "../clients.js";
import { AuthError } from "../_lib/access.js";
import { res, fakeAdmin, staffOk, KJ } from "./admin-harness.js";

const H = { authorization: "Bearer staff-token" };
const VIEW = { actor: "kj@ficium.net", now: "2026-11-19T17:00:00Z", today: "2026-11-19", can_manage: true, can_resolve_complaint: true, open: [], closed: [], targets: [], complaints_12m: {} };
const ID = "0193e1a0-0000-7000-8000-000000000001";
const OPEN = { op: "open", kind: "complaint", category: "bids", subject: "No bids after five days", detail: "Posted a home loan request and nothing came in",
  requester: "A. Borrower", contact: "a.borrower@example.com", client_id: "", channel: "email", received_at: "2026-11-18T06:00:00Z" };
const setup = (fail?: { match: string; err: unknown }) => {
  const db = fakeAdmin({ "api.case_view": { v: VIEW } }, fail);
  return { db, handler: makeHandler({ requireStaff: staffOk(), withAdmin: db.withAdmin }) };
};

describe("parsing", () => {
  it("opens a case with the fields the database expects", () => {
    expect(parse(OPEN)).toEqual({ sql: "select api.case_open($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)",
      params: ["complaint", "bids", "No bids after five days", "Posted a home loan request and nothing came in", "A. Borrower",
        "a.borrower@example.com", null, "email", "2026-11-18T06:00:00.000Z"] });
  });
  it.each([
    [{ kind: "rant" }, /kind/], [{ category: "weather" }, /about/], [{ channel: "pigeon" }, /arrived/], [{ subject: "Hi" }, /subject/],
    [{ detail: "short" }, /Describe/], [{ client_id: "nope" }, /borrower id/], [{ received_at: "last week" }, /received/],
  ])("refuses a case with %j", (over, why) => expect(parse({ ...OPEN, ...over })).toMatch(why));

  it("decides a complaint, and edits targets with a reason", () => {
    expect(parse({ op: "act", id: ID, version: 2, action: "resolve", text: "Explained the bidding window", upheld: "partly", redress: "Apology" }))
      .toMatchObject({ params: [ID, 2, "resolve", "Explained the bidding window", "partly", "Apology", null] });
    expect(parse({ op: "act", id: ID, version: 2, action: "resolve", text: "x", upheld: "maybe" })).toMatch(/upheld/);
    expect(parse({ op: "act", id: ID, version: 2, action: "erase" })).toBe("Unknown action");
    expect(parse({ op: "target", kind: "complaint", version: 0, ack_hours: 24, resolve_days: 10, reason: "Tighter targets agreed" }))
      .toMatchObject({ params: ["complaint", 0, 24, 10, "Tighter targets agreed"] });
    expect(parse({ op: "target", kind: "complaint", version: 0, ack_hours: 0, resolve_days: 10, reason: "Tighter targets agreed" })).toMatch(/Acknowledge/);
  });
});

describe("cases endpoint", () => {
  it("GET reads the view; POST runs the call then returns the fresh view", async () => {
    const { db, handler } = setup(); const r = res(); const r2 = res();
    await handler({ method: "GET", headers: H }, r);
    await handler({ method: "POST", headers: H, body: OPEN }, r2);
    expect([r.code, r.body, r2.code]).toEqual([200, VIEW, 200]);
    expect(db.sessions[0]!.staff).toEqual(KJ);
    expect(db.calls.map((c) => c.sql.match(/api\.\w+/)?.[0])).toEqual(["api.case_view", "api.case_open", "api.case_view"]);
  });

  it("maps refusals and never logs what the person wrote", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const [err, code] of [[{ code: "42501", message: "permission denied: case.resolve_complaint" }, 403], [{ code: "40001", message: "x" }, 409],
        [{ code: "42883", message: "x" }, 503], [{ code: "XX000", message: "boom" }, 500]] as const) {
        const s = setup({ match: "api.case_open", err }); const rr = res();
        await s.handler({ method: "POST", headers: H, body: OPEN }, rr);
        expect(rr.code).toBe(code);
      }
      expect(JSON.stringify(spy.mock.calls)).not.toContain("a.borrower@example.com");
    } finally { spy.mockRestore(); }
  });

  it("refuses anyone not signed in and other methods", async () => {
    const db = fakeAdmin();
    const h = makeHandler({ requireStaff: vi.fn(async () => { throw new AuthError(401, "Not signed in", "NO_TOKEN"); }), withAdmin: db.withAdmin });
    const r = res(); await h({ method: "GET", headers: {} }, r);
    const r2 = res(); await setup().handler({ method: "PATCH", headers: H }, r2);
    expect([r.code, r2.code]).toEqual([401, 405]);
  });

  it("routes ?module=cases", () => {
    const clients = vi.fn(), dp = vi.fn(), cases = vi.fn();
    route(clients, dp, cases)({ headers: {}, query: { module: "cases" } } as any, res());
    expect([clients.mock.calls.length, dp.mock.calls.length, cases.mock.calls.length]).toEqual([0, 0, 1]);
  });
});
