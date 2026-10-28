import { describe, it, expect, vi } from "vitest";
import { makeHandler } from "../audit.js";
import { res, fakeAdmin, staffOk } from "./admin-harness.js";

const H = { authorization: "Bearer staff-token" };
const get = (query: Record<string, string> = {}) => ({ method: "GET", headers: H, query });
const deps = (db: any, site: "app" | "portal" = "portal", portal = vi.fn(async () => [{ action: "x" }])) =>
  ({ requireStaff: staffOk(), withAdmin: db.withAdmin, portal, site: () => site });

describe("/api/audit", () => {
  it("admin source reads this site's chain through api.audit_search (which enforces audit.read)", async () => {
    const db = fakeAdmin({ "api.audit_search": { v: [{ chain_pos: 3 }] } }); const r = res();
    await makeHandler(deps(db, "app"))(get({ before: "10" }), r);
    expect(r.code).toBe(200); expect(r.body.events).toEqual([{ chain_pos: 3 }]);
    expect(db.calls[0]!.params).toEqual(["10"]);
  });

  it("portal source checks audit.read in the admin DB, then reads through portal-api", async () => {
    const db = fakeAdmin(); const p = vi.fn(async () => [{ action: "compliance.waiver_granted" }]); const r = res();
    await makeHandler(deps(db, "portal", p))(get({ source: "portal", action_prefix: "compliance." }), r);
    expect(r.code).toBe(200);
    expect(db.calls[0]!.sql).toContain("api.require_permission('audit.read')");
    expect(p).toHaveBeenCalledWith("query", { op: "audit.search", args: { limit: 100, action_prefix: "compliance." } }, "staff-token");
  });

  it("a permission refusal stops before portal-api is asked", async () => {
    const db = fakeAdmin({}, { match: "require_permission", err: { code: "42501", message: "permission denied: audit.read" } });
    const p = vi.fn(); const r = res();
    await makeHandler(deps(db, "portal", p as any))(get({ source: "portal" }), r);
    expect(r.code).toBe(403); expect(p).not.toHaveBeenCalled();
  });

  it.each([
    [{ source: "portal" }, "app", "Unknown source"],
    [{ source: "elsewhere" }, "portal", "Unknown source"],
    [{ source: "portal", action_prefix: "x'; drop" }, "portal", "action_prefix"],
    [{ source: "portal", institution_id: "nope" }, "portal", "institution_id"],
    [{ before: "yesterday" }, "portal", "position"],
  ])("rejects %j on the %s site", async (q, site, msg) => {
    const db = fakeAdmin(); const p = vi.fn(); const r = res();
    await makeHandler(deps(db, site as any, p as any))(get(q), r);
    expect(r.code).toBe(400); expect(String(r.body.error)).toContain(msg);
    expect(db.withAdmin).not.toHaveBeenCalled(); expect(p).not.toHaveBeenCalled();
  });

  it("is GET only", async () => {
    const r = res();
    await makeHandler(deps(fakeAdmin()))({ method: "POST", headers: H }, r);
    expect(r.code).toBe(405);
  });
});
