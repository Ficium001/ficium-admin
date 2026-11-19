import { describe, it, expect, vi } from "vitest";
import { makeHandler, parseSave, looksSecret } from "../_lib/credentials.js";
import { credentialLines, names } from "../_lib/credential-alerts.js";
import { makeHandler as makeAuditHandler } from "../audit.js";
import { AuthError } from "../_lib/access.js";
import { res, fakeAdmin, staffOk, KJ } from "./admin-harness.js";
import { EXPECTED_MIGRATIONS } from "../_lib/expected-migrations.js";

// Fake secret shapes, assembled at run time so no secret scanner mistakes this file for a leak.
const FAKE = {
  github: ["gh", "p_", "x".repeat(36)].join(""),
  githubPat: ["github", "_pat_", "1".repeat(22), "_", "y".repeat(30)].join(""),
  anthropic: ["sk", "-ant-", "api03-", "z".repeat(10)].join(""),
  aws: ["AK", "IA", "EXAMPLE0000000"].join(""),
  pem: ["-----", "BEGIN PRIVATE KEY", "-----"].join(""),
  jwt: ["eyJ" + "a".repeat(12), "eyJ" + "b".repeat(12), "c".repeat(12)].join("."),
  dsn: ["postgresql://", "role", ":", "pass", "word", "@", "db.example/x"].join(""),
  blob: "Qk".repeat(24),
};

const H = { authorization: "Bearer staff-token" };
const VIEW = { actor: "kj@ficium.net", can_manage: true, today: "2026-11-19", items: [], retired: [] };
const ENTRY = {
  op: "save", key: "borrower_build_github_token", version: 1, label: "GitHub token for borrower app builds", kind: "token",
  purpose: "Lets every Vercel build download ficium-integration.", env_names: "GITHUB_TOKEN",
  stored_in: "Doppler, synced to Vercel (borrower app)", used_by: "Borrower app builds", owner: "KJ",
  expires_on: "2027-02-17", rotated_on: "2026-11-19", rotate_every_days: "", note: "", reason: "Replaced the expired build token",
};
const setup = (fail?: { match: string; err: unknown }) => {
  const db = fakeAdmin({ "api.credential_view": { v: VIEW } }, fail);
  return { db, handler: makeHandler({ requireStaff: staffOk(), withAdmin: db.withAdmin }) };
};

describe("never a secret value", () => {
  it.each(Object.entries(FAKE))("refuses a %s", (_kind, t) => expect(looksSecret(t)).toBe(true));

  it.each([
    "Doppler, synced to Vercel (borrower app, production)",
    "INTEGRATION_B2I_SIGNING_KEY, INTEGRATION_ACCEPT_SIGNING_KEY, INTEGRATION_I2B_VERIFY_KEYS",
    "Fine-grained token, owner Ficium001, ficium-integration only, Contents read-only.",
    "https://vercel.com/ficium-s-projects/ficium",
  ])("allows ordinary descriptions: %s", (t) => expect(looksSecret(t)).toBe(false));
});

describe("parsing a save", () => {
  it("accepts a complete entry and turns empty values into nulls", () => {
    expect(parseSave(ENTRY)).toMatchObject({ key: ENTRY.key, version: 1, expires_on: "2027-02-17", rotate_every_days: null });
    expect(parseSave({ ...ENTRY, version: null, expires_on: "" })).toMatchObject({ version: null, expires_on: null });
  });
  it.each([
    [{ key: "Bad Key" }, /short name/],
    [{ kind: "mystery" }, /kind/],
    [{ stored_in: "" }, /required/],
    [{ env_names: "A=B; rm -rf" }, /Setting names/],
    [{ note: `the value is ${FAKE.github}` }, /secret value/],
    [{ owner: FAKE.dsn }, /secret value/],
    [{ expires_on: "19/11/2026" }, /Dates/],
    [{ rotate_every_days: 2 }, /7 to 3650/],
    [{ reason: "short" }, /reason/],
  ])("refuses %j", (over, why) => expect(parseSave({ ...ENTRY, ...over })).toMatch(why));
});

describe("keys and tokens endpoint", () => {
  it("GET reads the view inside the admin DB, as the signed-in admin", async () => {
    const { db, handler } = setup(); const r = res();
    await handler({ method: "GET", headers: H }, r);
    expect([r.code, r.body]).toEqual([200, VIEW]);
    expect(db.sessions[0]!.staff).toEqual(KJ);
    expect(r.headers["Cache-Control"]).toBe("no-store");
  });

  it("POST save passes every field to api.credential_save, then returns the fresh view", async () => {
    const { db, handler } = setup(); const r = res();
    await handler({ method: "POST", headers: H, body: ENTRY }, r);
    expect(r.code).toBe(200);
    expect(db.calls[0]!.sql).toContain("api.credential_save");
    expect(db.calls[0]!.params).toEqual([ENTRY.key, 1, ENTRY.label, "token", ENTRY.purpose, "GITHUB_TOKEN", ENTRY.stored_in,
      ENTRY.used_by, "KJ", "2027-02-17", "2026-11-19", null, "", ENTRY.reason]);
    expect(db.calls[1]!.sql).toContain("api.credential_view");
  });

  it("refuses a pasted secret before the database is opened", async () => {
    const { db, handler } = setup(); const r = res();
    await handler({ method: "POST", headers: H, body: { ...ENTRY, purpose: FAKE.github } }, r);
    expect([r.code, r.body.error]).toEqual([400, expect.stringMatching(/secret value/)]);
    expect(db.sessions).toHaveLength(0);
  });

  it("POST retire needs a reason and the version", async () => {
    const { db, handler } = setup(); const r = res();
    await handler({ method: "POST", headers: H, body: { op: "retire", key: "app_db_ca_cert", version: 2, reason: "No longer used anywhere" } }, r);
    expect(r.code).toBe(200);
    expect(db.calls[0]!.params).toEqual(["app_db_ca_cert", 2, "No longer used anywhere"]);
    const r2 = res();
    await handler({ method: "POST", headers: H, body: { op: "retire", key: "app_db_ca_cert", version: 2, reason: "no" } }, r2);
    expect(r2.code).toBe(400);
  });

  it("maps the database's refusals: permission, stale version, not set up", async () => {
    for (const [err, code] of [
      [{ code: "42501", message: "permission denied: credential.manage" }, 403],
      [{ code: "40001", message: "changed" }, 409],
      [{ code: "42883", message: "function api.credential_view() does not exist" }, 503],
    ] as const) {
      const { handler } = setup({ match: "api.credential_", err }); const r = res();
      await handler({ method: "GET", headers: H }, r);
      expect(r.code).toBe(code);
    }
  });

  it("logs a failure without the request body", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { handler } = setup({ match: "api.credential_save", err: { code: "XX000", message: "boom" } }); const r = res();
      await handler({ method: "POST", headers: H, body: ENTRY }, r);
      expect(r.code).toBe(500);
      expect(JSON.stringify(spy.mock.calls)).not.toContain(ENTRY.stored_in);
    } finally { spy.mockRestore(); }
  });

  it("refuses anyone not signed in, unknown actions and other methods", async () => {
    const db = fakeAdmin();
    const h = makeHandler({ requireStaff: vi.fn(async () => { throw new AuthError(401, "Not signed in", "NO_TOKEN"); }), withAdmin: db.withAdmin });
    const r = res(); await h({ method: "GET", headers: {} }, r);
    expect(r.code).toBe(401);
    const { handler } = setup();
    const r2 = res(); await handler({ method: "POST", headers: H, body: { op: "delete", key: "x" } }, r2);
    const r3 = res(); await handler({ method: "PUT", headers: H }, r3);
    expect([r2.code, r3.code]).toEqual([400, 405]);
  });
});

describe("alerts", () => {
  const a = (over: object) => ({ today: "2026-11-19", expired: [], due_soon: [], no_date: 0, tracked: 3, ...over });
  it("expired is an alert, due soon is a warning, and both name what to replace", () => {
    const l = credentialLines(a({ expired: [{ label: "Build token", due_on: "2026-11-17" }], due_soon: [{ label: "AWS key", due_on: "2026-11-30" }] }));
    expect(l.alerts).toEqual(["1 key or token has expired: Build token (17 Nov 2026). Replace it and update Keys and tokens."]);
    expect(l.warnings).toEqual(["Due within 14 days: AWS key (30 Nov 2026). Replace before then and update Keys and tokens."]);
    expect(credentialLines(null)).toEqual({ alerts: [], warnings: [] });
  });
  it("keeps a long list short", () => {
    const list = ["A", "B", "C", "D", "E"].map((label) => ({ label, due_on: "2026-12-01" }));
    expect(names(list)).toBe("A (1 Dec 2026), B (1 Dec 2026), C (1 Dec 2026) and 2 more");
    expect(names(list.slice(0, 2))).toBe("A (1 Dec 2026) and B (1 Dec 2026)");
  });
  it.each(["app", "portal"] as const)("the %s site's health banner turns red for an expired key, amber for one due soon", async (site) => {
    const db_ = site === "portal" ? "portal_admin" : "app_admin";
    const db = fakeAdmin({ "api.ops_health_view": { v: { healthy: true, alerts: [] } }, "api.schema_status": { v: EXPECTED_MIGRATIONS[db_] },
      "api.credential_alerts": { v: a({ expired: [{ label: "Build token", due_on: "2026-11-17" }], due_soon: [{ label: "AWS key", due_on: "2026-11-30" }] }) } });
    const r = res();
    await makeAuditHandler({ requireStaff: staffOk(), withAdmin: db.withAdmin, portal: vi.fn() as any, site: () => site })({ method: "GET", headers: H, query: { source: "health" } }, r);
    expect(r.body.health.healthy).toBe(false);
    expect(r.body.health.alerts).toEqual([expect.stringContaining("Build token")]);
    expect(r.body.health.warnings).toEqual([expect.stringContaining("AWS key")]);
  });
});
