/**
 * DEV-196s (owner decision 2026-11-12): apply the LOCAL-ONLY database patch for the fictional 輪's AI demo photos.
 *
 *   npx tsx scripts/sales/demo-version/apply-local-rin-patch.ts
 *
 * SUPABASE_DB_URL must be a local stack (assertLocalDbUrl: 127.0.0.1 / localhost only, no query string, no PG* host
 * variables). Refuses unless the 輪 seed row exists with its fixed id and fictional markers (run import-local.ts
 * --seed-rin first). Applies scripts/sales/demo-version/local-rin-ai-photos.sql in one transaction; idempotent.
 * Revert with `npx supabase db reset` (local). Prints a fixed status only (never the connection string or a key).
 * Exit 0 applied, 1 refused, 2 usage.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { applyLocalRinPatch, readRinPatchSql } from "../../../lib/demo-version-package/local-rin-patch";
import { assertLocalDbUrl, type FactsPack } from "../../../lib/demo-version-package/seed-rin";

const REPO = resolve(__dirname, "../../..");
const RIN_FACTS = "design-library/research/quality-pipeline/poc/bicycle/facts-pack.json";

async function main(): Promise<number> {
  if (process.argv.length > 2) {
    process.stderr.write("usage: apply-local-rin-patch.ts (no arguments; SUPABASE_DB_URL must be the local stack)\n");
    return 2;
  }
  const config = assertLocalDbUrl(process.env.SUPABASE_DB_URL);
  const pack = JSON.parse(readFileSync(resolve(REPO, RIN_FACTS), "utf8")) as FactsPack;
  const sql = readRinPatchSql(REPO);
  const client = new pg.Client(config);
  await client.connect();
  try {
    await applyLocalRinPatch(client, pack, sql);
  } finally {
    await client.end();
  }
  process.stdout.write(`${JSON.stringify({ status: "OK", patch: "local-rin-ai-photos", scope: "local only", revert: "npx supabase db reset" })}\n`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    const code = e instanceof Error ? /^(DB_URL_[A-Z_]+|RIN_SEED_[A-Z_]+|FACTS_PACK_NOT_RIN)/.exec(e.message)?.[0] : undefined;
    process.stdout.write(`${JSON.stringify({ status: "FAIL", code: code ?? "PATCH_FAILED" })}\n`);
    process.exit(1);
  });
