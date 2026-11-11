/**
 * DEV-196r (option C): import a demo version package into the LOCAL Supabase stack (database + private bucket).
 *
 *   npx tsx scripts/sales/demo-version/import-local.ts --package <dir> (--prospect <uuid> | --seed-rin)
 *
 * Local only: NEXT_PUBLIC_SUPABASE_URL must be http://127.0.0.1 / http://localhost (and SUPABASE_DB_URL a local
 * stack for --seed-rin); anything else is refused before a request. Uses the service role key from the local
 * environment. --seed-rin creates (or finds) the fictional 輪 shop from SR-001's facts pack. Verifies the package
 * again, ingests it with sales_ingest_demo_version (manual_import; a re-run replays), uploads and re-verifies every
 * file. Prints ids and hashes only — never a key.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { assertLocalSupabaseUrl, ImportError, importPackage, supabasePackageStore } from "../../../lib/demo-version-package/import";
import { PackageError, readPackage } from "../../../lib/demo-version-package/package";
import { assertLocalDbUrl, seedRinShop, type FactsPack } from "../../../lib/demo-version-package/seed-rin";

const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const REPO = resolve(__dirname, "../../..");
const RIN_FACTS = "design-library/research/quality-pipeline/poc/bicycle/facts-pack.json";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function main(): Promise<number> {
  const dir = arg("--package");
  const prospectArg = arg("--prospect");
  const seedRin = process.argv.includes("--seed-rin");
  if (!dir || (!prospectArg && !seedRin) || (prospectArg && !UUID.test(prospectArg))) {
    process.stderr.write("usage: import-local.ts --package <dir> (--prospect <uuid> | --seed-rin)\n");
    return 2;
  }
  const url = assertLocalSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    process.stderr.write("the local service role key is not set\n");
    return 2;
  }
  const pkg = readPackage(dir);
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  let prospectId = prospectArg ?? null;
  let demoId: string;
  if (seedRin) {
    const db = new pg.Client({ connectionString: assertLocalDbUrl(process.env.SUPABASE_DB_URL) });
    await db.connect();
    try {
      const pack = JSON.parse(readFileSync(resolve(REPO, RIN_FACTS), "utf8")) as FactsPack;
      const seeded = await seedRinShop(db, pack);
      prospectId = seeded.prospectId;
      demoId = seeded.demoId;
    } finally {
      await db.end();
    }
  } else {
    const d = await client.from("sales_demos").select("id").eq("prospect_id", prospectId!).maybeSingle();
    if (d.error || !d.data) throw new ImportError("DEMO_NOT_FOUND");
    demoId = (d.data as { id: string }).id;
  }
  const result = await importPackage(pkg, { client, store: supabasePackageStore(client), demoId, workerCommit: (pkg.validatorResult.validator_commit ?? "").match(/^[0-9a-f]{7,40}$/) ? pkg.validatorResult.validator_commit : null });
  process.stdout.write(`${JSON.stringify({ status: "OK", prospect_id: prospectId, ...result }, null, 2)}\n`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    if (e instanceof ImportError || e instanceof PackageError) {
      process.stdout.write(`${JSON.stringify({ status: "FAIL", code: e.code })}\n`);
      process.exit(1);
    }
    process.stderr.write(`${e instanceof Error ? e.name : "error"}\n`);
    process.exit(1);
  });
