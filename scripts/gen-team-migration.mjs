#!/usr/bin/env node
// Writes the team four-eyes migration for both admin DBs from one template, so they cannot drift.
//   node scripts/gen-team-migration.mjs           (write)
//   node scripts/gen-team-migration.mjs --check   (CI: fail if a generated file differs)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
const tmpl = readFileSync(new URL("../db/admin-db/platform/team_four_eyes.sql.tmpl", import.meta.url), "utf8");
const out = { app_admin: "0017_team_four_eyes.sql", portal_admin: "0014_team_four_eyes.sql" };
let bad = 0;
for (const [db, file] of Object.entries(out)) {
  const url = new URL(`../db/admin-db/${db}/${file}`, import.meta.url);
  const body = tmpl.replaceAll("__DB__", db);
  if (process.argv.includes("--check")) {
    if (!existsSync(url) || readFileSync(url, "utf8") !== body) { console.error(`${db}/${file} is out of date`); bad++; }
  } else writeFileSync(url, body);
}
process.exit(bad ? 1 : 0);
