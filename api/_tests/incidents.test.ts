import { describe, it, expect, vi } from "vitest";
import { makeHandler, parse, incidentLines, readIncidentAlerts } from "../_lib/incidents.js";
import { makeHandler as makeAuditHandler, route } from "../audit.js";
import { AuthError } from "../_lib/access.js";
import { res, fakeAdmin, staffOk, KJ } from "./admin-harness.js";
import { EXPECTED_MIGRATIONS } from "../_lib/expected-migrations.js";

const H = { authorization: "Bearer staff-token" };
const VIEW = { actor: "kj@ficium.net", now: "2026-11-19T17:00:00Z", can_manage: true, can_close: true, open: [], closed: [] };
const ID = "0193e1a0-0000-7000-8000-000000000001";
const OPEN = { op: "open", title: "Borrower app deploys failing", severity: 2, kind: "change", service_key: "deploy_borrower_app",
  impact: "No new borrower app version can ship", started_at: "2026-11-17T22:00:00Z", detected_at: "2026-11-19T15:00:00Z", personal_data: false };
const setup = (fail?: { match: string; err: unknown }) => {
  const db = fakeAdmin({ "api.incident_view": { v: VIEW } }, fail);
  return { db, handler: makeHandler({ requireStaff: staffOk(), withAdmin: db.withAdmin }) };
};

describe("parsing", () => {
  it("opens an incident with the fields the database expects", () => {
    expect(parse(OPEN)).toEqual({ sql: "select api.incident_open($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8)",
      params: ["Borrower app deploys failing", 2, "change", "deploy_borrower_app", "No new borrower app version can ship",
        "2026-11-17T22:00:00.000Z", "2026-11-19T15:00:00.000Z", false] });
  });
  it.each([
    [{ title: "Bad" }, /title/], [{ severity: 4 }, /severity/], [{ kind: "aliens" }, /kind/], [{ impact: "short" }, /affected/],
    [{ service_key: "../../etc" }, /Unknown service/], [{ started_at: "yesterday-ish" }, /started/], [{ personal_data: "no" }, /personal data/],
  ])("refuses an incident with %j", (over, why) => expect(parse({ ...OPEN, ...over })).toMatch(why));

  it("works an incident by id, version and a known action only", () => {
    expect(parse({ op: "act", id: ID, version: 3, action: "breach_reported", text: "DPO ref 123", at: "2026-11-19T16:00:00Z" }))
      .toMatchObject({ params: [ID, 3, "breach_reported", "DPO ref 123", "2026-11-19T16:00:00.000Z", null, null, null, null] });
    expect(parse({ op: "act", id: ID, version: 3, action: "follow_up", text: "Track token expiries", owner: "KJ", date: "2026-11-26" }))
      .toMatchObject({ params: [ID, 3, "follow_up", "Track token expiries", null, null, "KJ", "2026-11-26", null] });
    expect(parse({ op: "act", id: ID, version: 3, action: "delete" })).toBe("Unknown action");
    expect(parse({ op: "act", id: ID, version: 3, action: "severity", number: 7 })).toMatch(/Severity/);
    expect(parse({ op: "act", id: ID, version: 3, action: "follow_up_done", follow_up: "x" })).toMatch(/Reload/);
  });
});

describe("incidents endpoint", () => {
  it("GET reads the view; POST runs the call then returns the fresh view", async () => {
    const { db, handler } = setup(); const r = res(); const r2 = res();
    await handler({ method: "GET", headers: H }, r);
    await handler({ method: "POST", headers: H, body: OPEN }, r2);
    expect([r.code, r.body, r2.code]).toEqual([200, VIEW, 200]);
    expect(db.sessions[0]!.staff).toEqual(KJ);
    expect(db.calls.map((c) => c.sql.match(/api\.\w+/)?.[0])).toEqual(["api.incident_view", "api.incident_open", "api.incident_view"]);
  });

  it("refuses bad input before the database is opened, and maps refusals", async () => {
    const { db, handler } = setup(); const r = res();
    await handler({ method: "POST", headers: H, body: { ...OPEN, severity: 9 } }, r);
    expect(r.code).toBe(400);
    expect(db.sessions).toHaveLength(0);
    for (const [err, code] of [[{ code: "42501", message: "permission denied: incident.close" }, 403], [{ code: "40001", message: "x" }, 409], [{ code: "42883", message: "x" }, 503]] as const) {
      const s = setup({ match: "api.incident_", err }); const rr = res();
      await s.handler({ method: "GET", headers: H }, rr);
      expect(rr.code).toBe(code);
    }
  });

  it("refuses anyone not signed in and other methods", async () => {
    const db = fakeAdmin();
    const h = makeHandler({ requireStaff: vi.fn(async () => { throw new AuthError(401, "Not signed in", "NO_TOKEN"); }), withAdmin: db.withAdmin });
    const r = res(); await h({ method: "GET", headers: {} }, r);
    const r2 = res(); await setup().handler({ method: "PUT", headers: H }, r2);
    expect([r.code, r2.code]).toEqual([401, 405]);
  });
});

describe("alerts", () => {
  const now = Date.parse("2026-11-19T12:00:00Z");
  it("names the breach deadline in Mauritius time, and a passed one as overdue", () => {
    expect(incidentLines({ open: 1, open_major: [], breach_due: [{ ref: "INC-0002", due_at: "2026-11-21T10:00:00Z" }] }, now))
      .toEqual(["INC-0002 involves personal data: tell the Data Protection Commissioner by 21 Nov, 14:00 (46 h left), or record why it is not needed."]);
    expect(incidentLines({ open: 1, open_major: [], breach_due: [{ ref: "INC-0002", due_at: "2026-11-19T09:00:00Z" }] }, now)[0])
      .toMatch(/passed 3 h ago\. Report it now, with the reasons for the delay\./);
    expect(incidentLines({ open: 1, open_major: [{ ref: "INC-0001", severity: 1, title: "Borrower app down" }], breach_due: [] }, now))
      .toEqual(["Severity 1 incident open: INC-0001 Borrower app down."]);
    expect(incidentLines(null)).toEqual([]);
  });

  it("reads alerts inside a savepoint, and treats a missing register as not set up", async () => {
    const sql: string[] = [];
    const got = await readIncidentAlerts(async (s) => { sql.push(s); if (s.includes("api.incident_alerts")) throw { code: "42883" }; return { rows: [] }; }, true);
    expect(got).toBeNull();
    expect(sql).toEqual(["savepoint incident_alerts", "select api.incident_alerts() as v", "rollback to savepoint incident_alerts"]);
  });

  it.each(["app", "portal"] as const)("the %s site's health banner turns red for a breach deadline", async (site) => {
    const db_ = site === "portal" ? "portal_admin" : "app_admin";
    const db = fakeAdmin({ "api.ops_health_view": { v: { healthy: true, alerts: [] } }, "api.schema_status": { v: EXPECTED_MIGRATIONS[db_] },
      "api.incident_alerts": { v: { open: 1, open_major: [], breach_due: [{ ref: "INC-0002", due_at: new Date(Date.now() + 3_600_000 * 10).toISOString() }] } } });
    const r = res();
    await makeAuditHandler({ requireStaff: staffOk(), withAdmin: db.withAdmin, portal: vi.fn() as any, site: () => site })({ method: "GET", headers: H, query: { source: "health" } }, r);
    expect(r.body.health.healthy).toBe(false);
    expect(r.body.health.alerts).toEqual([expect.stringContaining("INC-0002 involves personal data")]);
  });

  it("routes ?module=incidents", () => {
    const fns = [vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    route(fns[0]!, fns[1]!, fns[2]!, fns[3]!, fns[4]!)({ headers: {}, query: { module: "incidents" } } as any, res());
    expect(fns.map((f) => f.mock.calls.length)).toEqual([0, 0, 0, 0, 1]);
  });
});
