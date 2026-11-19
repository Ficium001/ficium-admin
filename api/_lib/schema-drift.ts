/**
 * Database changes merged but never applied ("drift"), for this site's admin database.
 *
 * Four times a migration was merged and the feature then failed in production because nobody ran
 * it. Each admin database lists what it has applied (meta.schema_migration, via api.schema_status);
 * this deployment carries the list it was built with (expected-migrations.ts, generated, checked in
 * CI). Comparing the two says what is missing, and what was edited after being applied.
 *
 * Shown on the Services page (a row), on the Audit page's health banner, and in the hourly
 * dispatcher's "ALERT ops health" log line.
 *
 * A database AHEAD of this deployment (a migration applied before its code deployed) is normal and
 * not reported.
 */
import { EXPECTED_MIGRATIONS, type Expected } from "./expected-migrations.js";
import type { Site } from "./site.js";

type Run = (sql: string) => Promise<{ rows: any[] }>;

export type Drift = {
  db: "app_admin" | "portal_admin";
  /** Expected but not applied, oldest first. */
  missing: string[];
  /** Applied, but the file has changed since. migrate.sh refuses to run until this is resolved. */
  edited: string[];
  /** The check itself (api.schema_status) is not installed, so `missing` cannot be known. */
  uncheckable: boolean;
};

export const dbFor = (site: Site): Drift["db"] => (site === "portal" ? "portal_admin" : "app_admin");

/** Pure comparison. Anything unreadable in `applied` counts as not applied. */
export function compare(db: Drift["db"], applied: unknown, expected: Expected[] = EXPECTED_MIGRATIONS[db]): Drift {
  const have = new Map<string, string>();
  if (Array.isArray(applied)) {
    for (const a of applied) {
      if (a && typeof a.version === "string") have.set(a.version, typeof a.checksum === "string" ? a.checksum : "");
    }
  }
  const missing: string[] = [], edited: string[] = [];
  for (const e of expected) {
    const sum = have.get(e.version);
    if (sum === undefined) missing.push(e.version);
    else if (sum !== e.checksum) edited.push(e.version);
  }
  return { db, missing, edited, uncheckable: false };
}

export const hasDrift = (d: Drift) => d.uncheckable || d.missing.length > 0 || d.edited.length > 0;

/** One line per problem, for the Audit banner and the dispatcher log. */
export function driftAlerts(d: Drift): string[] {
  const out: string[] = [];
  if (d.uncheckable) {
    out.push(`The ${d.db} database cannot report its changes: apply ${d.missing[0] ?? "the schema_status migration"} (db/admin-db/migrate.sh ${d.db}).`);
    return out;
  }
  if (d.missing.length) {
    out.push(`${d.missing.length} database change${d.missing.length === 1 ? " is" : "s are"} not applied to ${d.db}: ${d.missing.join(", ")}. Run db/admin-db/migrate.sh ${d.db}.`);
  }
  if (d.edited.length) {
    out.push(`${d.edited.length} applied database change${d.edited.length === 1 ? " was" : "s were"} edited afterwards in ${d.db}: ${d.edited.join(", ")}. Migrations must not be edited once applied; add a new one.`);
  }
  return out;
}

const UNDEFINED_FUNCTION = "42883";

/**
 * Reads what the database has applied and compares. `inTransaction` wraps the read in a savepoint,
 * so a missing function does not abort the caller's transaction (the staff-session paths).
 */
export async function readDrift(run: Run, db: Drift["db"], inTransaction: boolean): Promise<Drift> {
  if (inTransaction) await run("savepoint schema_drift");
  try {
    const applied = (await run("select api.schema_status() as v")).rows[0]?.v;
    if (inTransaction) await run("release savepoint schema_drift");
    return compare(db, applied);
  } catch (e: any) {
    if (inTransaction) await run("rollback to savepoint schema_drift");
    if (e?.code === UNDEFINED_FUNCTION) {
      const check = EXPECTED_MIGRATIONS[db].find((m) => m.version.endsWith("_schema_status"))?.version;
      return { db, missing: check ? [check] : [], edited: [], uncheckable: true };
    }
    throw e;
  }
}
