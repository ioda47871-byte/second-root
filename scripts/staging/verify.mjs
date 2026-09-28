#!/usr/bin/env node
// Read-only check of a Supabase project (docs/STAGING.md §2):
// migrations match the repository, every sales_* table exists, the
// security rules hold, public sign-up is off and exactly one admin exists.
//
//   SUPABASE_ACCESS_TOKEN=… npm run staging:verify -- --project-ref <ref>
//
// Prints no secret and no personal data (only counts).

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { assertProxySupport, assertRef, formatResults, listMigrations, managementQuery, managementRequest, parseArgs, runChecks } from "./lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ref = assertRef(args["project-ref"]);
  assertProxySupport();
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  const query = managementQuery(ref, token);
  const local = listMigrations(join(root, "supabase", "migrations"));

  const { ok, results } = await runChecks(query, local);
  const [{ admins }] = await query("select count(*)::int as admins from public.sales_admins");
  const auth = await managementRequest(ref, token)("GET", "/config/auth");
  results.push({ id: "signup_off", title: "public sign-up is off", ok: auth.disable_signup === true, items: [] });
  results.push({ id: "one_admin", title: "exactly one admin (MVP)", ok: admins === 1, items: admins === 1 ? [] : [`${admins} admins`] });
  console.log(formatResults(results));
  if (!ok || !results.every((r) => r.ok)) process.exit(1);
}

main().catch((err) => {
  console.error(`FAILED: ${err.message}`);
  process.exit(1);
});
