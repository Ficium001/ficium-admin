import { describe, it, expect } from "vitest";
import { compare, driftAlerts, hasDrift, readDrift, dbFor } from "../_lib/schema-drift.js";
import { EXPECTED_MIGRATIONS } from "../_lib/expected-migrations.js";

const EXP = [{ version: "0001_a", checksum: "aa" }, { version: "0002_b", checksum: "bb" }, { version: "0003_c", checksum: "cc" }];

describe("schema drift", () => {
  it("nothing to report when every expected change is applied unedited, even if the database is ahead", () => {
    const d = compare("app_admin", [{ version: "0001_a", checksum: "aa" }, { version: "0002_b", checksum: "bb" }, { version: "0003_c", checksum: "cc" }, { version: "0004_next", checksum: "dd" }], EXP);
    expect(hasDrift(d)).toBe(false);
    expect(driftAlerts(d)).toEqual([]);
  });

  it("reports changes merged but not applied, in order", () => {
    const d = compare("portal_admin", [{ version: "0001_a", checksum: "aa" }], EXP);
    expect(d.missing).toEqual(["0002_b", "0003_c"]);
    expect(driftAlerts(d)[0]).toBe("2 database changes are not applied to portal_admin: 0002_b, 0003_c. Run db/admin-db/migrate.sh portal_admin.");
  });

  it("reports a change edited after it was applied", () => {
    const d = compare("app_admin", [{ version: "0001_a", checksum: "aa" }, { version: "0002_b", checksum: "XX" }, { version: "0003_c", checksum: "cc" }], EXP);
    expect([d.missing, d.edited]).toEqual([[], ["0002_b"]]);
    expect(driftAlerts(d)[0]).toMatch(/edited afterwards in app_admin: 0002_b/);
  });

  it("treats an unreadable answer as nothing applied", () => {
    expect(compare("app_admin", null, EXP).missing).toHaveLength(3);
    expect(compare("app_admin", [{ v: 1 }, null, "x"], EXP).missing).toHaveLength(3);
  });

  it("maps each site to its own database", () => {
    expect([dbFor("app"), dbFor("portal")]).toEqual(["app_admin", "portal_admin"]);
  });

  it("the shipped expected list matches what is applied in production today, plus the new check", () => {
    // Applied in production through 0012 / 0011 (2026-11-19); the credentials register is the new one.
    const app = EXPECTED_MIGRATIONS.app_admin.map((m) => m.version);
    expect(app.at(-2)).toBe("0012_schema_status");
    expect(app.at(-1)).toBe("0013_credentials");
    expect(EXPECTED_MIGRATIONS.portal_admin.map((m) => m.version).slice(-2)).toEqual(["0011_schema_status", "0012_credentials"]);
  });
});

describe("reading drift", () => {
  const runner = (answer: unknown, fail?: { code: string }) => {
    const sql: string[] = [];
    const run = async (s: string) => {
      sql.push(s);
      if (fail && s.includes("schema_status")) throw fail;
      return { rows: s.includes("schema_status") ? [{ v: answer }] : [] };
    };
    return { run, sql };
  };

  it("in a staff transaction, wraps the read in a savepoint", async () => {
    const { run, sql } = runner(EXPECTED_MIGRATIONS.app_admin);
    const d = await readDrift(run, "app_admin", true);
    expect(hasDrift(d)).toBe(false);
    expect(sql).toEqual(["savepoint schema_drift", "select api.schema_status() as v", "release savepoint schema_drift"]);
  });

  it("when the check itself is not installed, says which migration installs it, and keeps the transaction usable", async () => {
    const { run, sql } = runner(null, { code: "42883" });
    const d = await readDrift(run, "portal_admin", true);
    expect(d).toEqual({ db: "portal_admin", missing: ["0011_schema_status"], edited: [], uncheckable: true });
    expect(sql.at(-1)).toBe("rollback to savepoint schema_drift");
    expect(driftAlerts(d)[0]).toBe("The portal_admin database cannot report its changes: apply 0011_schema_status (db/admin-db/migrate.sh portal_admin).");
  });

  it("outside a transaction, no savepoint; other errors are not hidden", async () => {
    const { run, sql } = runner(EXPECTED_MIGRATIONS.app_admin);
    await readDrift(run, "app_admin", false);
    expect(sql).toEqual(["select api.schema_status() as v"]);
    await expect(readDrift(runner(null, { code: "08006" }).run, "app_admin", false)).rejects.toEqual({ code: "08006" });
  });
});
