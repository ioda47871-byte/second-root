#!/usr/bin/env node
// Applies supabase/migrations/ to a Supabase project through the Management
// API, then runs the security checks (docs/STAGING.md §2).
//
//   SUPABASE_ACCESS_TOKEN=… npm run staging:apply -- --project-ref <ref>            # plan only
//   SUPABASE_ACCESS_TOKEN=… npm run staging:apply -- --project-ref <ref> --confirm-ref <ref> --apply   # apply + verify
//   … --apply --auth   also turns public sign-up off and requires 12+ character passwords
//
// Never prints the token. Stops at the first failing migration (that
// migration is rolled back as one transaction) and on any drift between the
// project and the repository.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { assertProxySupport, assertQuerySemantics, assertRef, formatResults, HISTORY_DDL, listMigrations, managementQuery, managementRequest, migrationRequest, parseArgs, planMigrations, runChecks } from "./lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ref = assertRef(args["project-ref"]);
  if (args.apply && args["confirm-ref"] !== ref) throw new Error("--apply needs --confirm-ref with the same project ref");
  assertProxySupport();
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  const query = managementQuery(ref, token);
  const local = listMigrations(join(root, "supabase", "migrations"));

  const [{ t: history }] = await query("select to_regclass('supabase_migrations.schema_migrations')::text as t");
  const applied = history ? await query("select version, name from supabase_migrations.schema_migrations order by version") : [];
  const { pending, drift } = planMigrations(local, applied);
  console.log(`project ${ref}: ${applied.length} applied, ${pending.length} pending of ${local.length}`);
  if (drift.length) {
    console.error(`STOP: the project and the repository disagree:\n  ${drift.join("\n  ")}`);
    process.exit(2);
  }
  for (const m of pending) console.log(`  pending ${m.file}`);
  if (!args.apply) {
    console.log("plan only (add --apply to apply)");
    return;
  }

  // Checked on the real project before the first change.
  await assertQuerySemantics(query);
  console.log("checked: SQL runs as postgres, and a failed request changes nothing");
  if (!history) await query(HISTORY_DDL);
  for (const m of pending) {
    process.stdout.write(`applying ${m.file} … `);
    await query(migrationRequest(m));
    console.log("ok");
  }

  if (args.auth) {
    const request = managementRequest(ref, token);
    const current = await request("GET", "/config/auth");
    const minLength = Math.max(Number(current.password_min_length) || 0, 12);
    await request("PATCH", "/config/auth", { disable_signup: true, password_min_length: minLength });
    const after = await request("GET", "/config/auth");
    console.log(`auth: public sign-up ${after.disable_signup ? "OFF" : "ON (!)"}, email confirmation ${after.mailer_autoconfirm ? "OFF (auto-confirm)" : "ON"}, minimum password length ${after.password_min_length}`);
  }

  const { ok, results } = await runChecks(query, local);
  console.log(formatResults(results));
  if (!ok) process.exit(1);
}

main().catch((err) => {
  // Error messages from lib.mjs never contain the token.
  console.error(`FAILED: ${err.message}`);
  process.exit(1);
});
