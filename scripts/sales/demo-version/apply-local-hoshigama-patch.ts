/**
 * DEV-139 (owner approval 2026-11-18): apply the LOCAL-ONLY database patch for the fictional ほし窯's AI demo photos
 * (its Stage 0 prospect only).
 *
 *   npx tsx scripts/sales/demo-version/apply-local-hoshigama-patch.ts --owner-approved-local-patch
 *
 * Refuses, before connecting, without the explicit owner flag (HOSHIGAMA_PATCH_FLAG_MISSING) or unless SUPABASE_DB_URL is
 * a local stack (assertLocalDbUrl: 127.0.0.1 / localhost only, no query string, no PG* host variables). Refuses, writing
 * nothing, unless the S0 seed row exists with its fixed id and fictional markers (run s0-local-seed.ts seed first:
 * S0_SEED_MISSING / S0_SEED_MARKERS) and while any AI demo picture of another prospect exists (OTHER_AI_DEMO_ROWS_PRESENT:
 * this patch is S0-only — reset the stack first). Applies scripts/sales/demo-version/local-hoshigama-ai-photos.sql in one
 * transaction; idempotent. Revert with `npx supabase db reset` (local). Prints a fixed status only (never the connection
 * string or a key). Exit 0 applied, 1 refused, 2 usage.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { applyLocalHoshigamaPatch, HOSHIGAMA_PATCH_FLAG, readHoshigamaPatchSql } from "../../../lib/demo-version-package/local-hoshigama-patch";
import { assertLocalDbUrl } from "../../../lib/demo-version-package/seed-rin";
import { S0_FACTS_PATH } from "../../../lib/demo-version-package/seed-s0";

const REPO = resolve(__dirname, "../../..");

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.some((a) => a !== HOSHIGAMA_PATCH_FLAG) || args.length > 1) {
    process.stderr.write(`usage: apply-local-hoshigama-patch.ts ${HOSHIGAMA_PATCH_FLAG} (SUPABASE_DB_URL must be the local stack)\n`);
    return 2;
  }
  if (args.length === 0) throw new Error("HOSHIGAMA_PATCH_FLAG_MISSING");
  const config = assertLocalDbUrl(process.env.SUPABASE_DB_URL);
  const facts = new Uint8Array(readFileSync(resolve(REPO, S0_FACTS_PATH)));
  const sql = readHoshigamaPatchSql(REPO);
  const client = new pg.Client(config);
  await client.connect();
  try {
    await applyLocalHoshigamaPatch(client, facts, sql);
  } finally {
    await client.end();
  }
  process.stdout.write(`${JSON.stringify({ status: "OK", patch: "local-hoshigama-ai-photos", scope: "local only", prospect: "s0 fictional bakery", revert: "npx supabase db reset" })}\n`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    const code = e instanceof Error ? /^(DB_URL_[A-Z_]+|HOSHIGAMA_PATCH_FLAG_MISSING|S0_SEED_[A-Z_]+|S0_FACTS_[A-Z_]+|OTHER_AI_DEMO_ROWS_PRESENT)/.exec(e.message)?.[0] : undefined;
    process.stdout.write(`${JSON.stringify({ status: "FAIL", code: code ?? "PATCH_FAILED" })}\n`);
    process.exit(1);
  });
