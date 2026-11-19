import { describe, it, expect, vi } from "vitest";
import { makeHandler, parse } from "../_lib/data-protection.js";
import { route } from "../clients.js";
import { AuthError } from "../_lib/access.js";
import { res, fakeAdmin, staffOk, KJ } from "./admin-harness.js";

const H = { authorization: "Bearer staff-token" };
const VIEW = { actor: "kj@ficium.net", today: "2026-11-19", can_manage: true, can_close: true, open: [], closed: [], retention: [] };
const ID = "0193e1a0-0000-7000-8000-000000000001";
const LOG = { op: "log", kind: "access", requester: "A. Borrower", contact: "a.borrower@example.com", client_id: "",
  channel: "email", summary: "Asked for a copy of all data held about them", received_on: "2026-11-03" };
const setup = (fail?: { match: string; err: unknown }) => {
  const db = fakeAdmin({ "api.dp_view": { v: VIEW } }, fail);
  return { db, handler: makeHandler({ requireStaff: staffOk(), withAdmin: db.withAdmin }) };
};

describe("parsing", () => {
  it("logs a request with the fields the database expects", () => {
    expect(parse(LOG)).toEqual({ sql: "select api.dp_log($1, $2, $3, $4, $5, $6, $7::date)",
      params: ["access", "A. Borrower", "a.borrower@example.com", null, "email", "Asked for a copy of all data held about them", "2026-11-03"] });
  });
  it.each([
    [{ kind: "gossip" }, /asking for/], [{ channel: "pigeon" }, /arrived/], [{ requester: "" }, /name/],
    [{ summary: "short" }, /Summarise/], [{ client_id: "not-a-uuid" }, /borrower id/], [{ received_on: "3/11/2026" }, /date/],
  ])("refuses a log with %j", (over, why) => expect(parse({ ...LOG, ...over })).toMatch(why));

  it("works a request by id, version and a known action only", () => {
    expect(parse({ op: "act", id: ID, version: 2, action: "verify_identity", text: "Video call against NIC", date: "2026-11-04" }))
      .toEqual({ sql: "select api.dp_act($1, $2, $3, $4, $5::date)", params: [ID, 2, "verify_identity", "Video call against NIC", "2026-11-04"] });
    expect(parse({ op: "act", id: ID, version: 2, action: "delete_everything" })).toBe("Unknown action");
    expect(parse({ op: "act", id: "x", version: 2, action: "note", text: "hi" })).toMatch(/Reload/);
  });

  it("edits the retention schedule with a reason", () => {
    const r = { op: "retention", key: "vault_documents", version: 0, data: "Vault documents", where_kept: "Vault", kept_for: "7 years",
      basis: "FIAMLA", how_deleted: "With regulated records", decided: true, enforced: false, reason: "Decided with compliance" };
    expect(parse(r)).toMatchObject({ params: ["vault_documents", 0, "Vault documents", "Vault", "7 years", "FIAMLA", "With regulated records", true, false, "Decided with compliance"] });
    expect(parse({ ...r, reason: "short" })).toMatch(/reason/);
    expect(parse({ ...r, decided: "yes" })).toMatch(/decided/);
    expect(parse({ ...r, kept_for: "" })).toMatch(/required/);
  });
});

describe("data protection endpoint", () => {
  it("GET reads the view as the signed-in admin", async () => {
    const { db, handler } = setup(); const r = res();
    await handler({ method: "GET", headers: H }, r);
    expect([r.code, r.body]).toEqual([200, VIEW]);
    expect(db.sessions[0]!.staff).toEqual(KJ);
  });

  it("POST runs the call, then returns the fresh view", async () => {
    const { db, handler } = setup(); const r = res();
    await handler({ method: "POST", headers: H, body: LOG }, r);
    expect(r.code).toBe(200);
    expect(db.calls.map((c) => c.sql)).toEqual([expect.stringContaining("api.dp_log"), expect.stringContaining("api.dp_view")]);
  });

  it("refuses bad input before the database is opened", async () => {
    const { db, handler } = setup(); const r = res();
    await handler({ method: "POST", headers: H, body: { ...LOG, kind: "x" } }, r);
    expect(r.code).toBe(400);
    expect(db.sessions).toHaveLength(0);
  });

  it("maps the database's refusals, and never logs the personal data in a request", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const [err, code] of [
        [{ code: "42501", message: "permission denied: dp.close" }, 403], [{ code: "22023", message: "check the requester's identity first" }, 400],
        [{ code: "40001", message: "changed" }, 409], [{ code: "42883", message: "no function" }, 503], [{ code: "XX000", message: "boom" }, 500],
      ] as const) {
        const { handler } = setup({ match: "api.dp_log", err }); const r = res();
        await handler({ method: "POST", headers: H, body: LOG }, r);
        expect(r.code).toBe(code);
      }
      expect(JSON.stringify(spy.mock.calls)).not.toContain("a.borrower@example.com");
    } finally { spy.mockRestore(); }
  });

  it("refuses anyone not signed in and other methods", async () => {
    const db = fakeAdmin();
    const h = makeHandler({ requireStaff: vi.fn(async () => { throw new AuthError(401, "Not signed in", "NO_TOKEN"); }), withAdmin: db.withAdmin });
    const r = res(); await h({ method: "GET", headers: {} }, r);
    const r2 = res(); await setup().handler({ method: "DELETE", headers: H }, r2);
    expect([r.code, r2.code]).toEqual([401, 405]);
  });
});

describe("clients.ts routing", () => {
  it("sends ?module=dp to data protection, anything else to borrower support", () => {
    const clients = vi.fn(), dp = vi.fn(); const h = route(clients, dp);
    h({ headers: {}, query: { module: "dp" } } as any, res());
    h({ headers: {}, query: { q: "abc" } } as any, res());
    expect([dp.mock.calls.length, clients.mock.calls.length]).toEqual([1, 1]);
  });
});
