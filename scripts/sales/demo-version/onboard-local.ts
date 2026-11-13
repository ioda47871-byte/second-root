/**
 * DEV-263h (Issue #263, runbook B-2): create (or replace) a prospect's demo content from the shop's confirmed facts pack
 * and register the same bytes in the facts store — the LOCAL development equivalent of the admin screen's
 * 「デモの事実を facts pack から作る」. docs/operations/real-shop-demo-workflow.md.
 *
 *   npx tsx scripts/sales/demo-version/onboard-local.ts --prospect <uuid> --facts <facts-pack.json> --admin <admin user id> [--replace-content]
 *
 * Local only: SUPABASE_DB_URL must be a local stack (assertLocalDbUrl: 127.0.0.1 / localhost, no query string, no PG*
 * host variable); anything else is refused before a connection. The database owner's local CLI switch
 * (sales_facts_registration_settings.operator_cli_enabled, default off) must be on, and the admin must be in
 * sales_admins. The facts pack file must be outside the repository or under its gitignored .local-shops/, never a link.
 * The prospect must already exist (the existing ingest; this never creates a prospect). Replacing an existing demo's
 * content needs --replace-content. Prints ids, hashes and codes only — never a fact, a key or a path.
 */
import { resolve } from "node:path";
import pg from "pg";
import { assertLocalDbUrl } from "../../../lib/demo-version-package/seed-rin";
import { FactsOnboardingError } from "../../../lib/sales/facts-onboarding";
import { onboardFactsLocal, readOnboardingFacts } from "../../../lib/sales/facts-onboarding-local";

const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const REPO = resolve(__dirname, "../../..");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KNOWN = new Set(["--prospect", "--facts", "--admin", "--replace-content"]);

async function main(): Promise<number> {
  const prospectId = arg("--prospect");
  const factsPath = arg("--facts");
  const adminId = arg("--admin");
  const flags = process.argv.slice(2).filter((a) => a.startsWith("--"));
  if (!prospectId || !UUID.test(prospectId) || !factsPath || !adminId || !UUID.test(adminId) || flags.some((f) => !KNOWN.has(f))) {
    process.stderr.write("usage: onboard-local.ts --prospect <uuid> --facts <facts-pack.json> --admin <admin user id> [--replace-content]\n");
    return 2;
  }
  // checked before any connection: the database (local only) and the file (outside the repository or .local-shops/)
  const config = assertLocalDbUrl(process.env.SUPABASE_DB_URL);
  const factsPack = readOnboardingFacts(REPO, factsPath);
  const db = new pg.Client(config);
  await db.connect();
  try {
    const r = await onboardFactsLocal(db, { prospectId, factsPack, adminId, replaceContent: process.argv.includes("--replace-content") });
    process.stdout.write(`${JSON.stringify({ status: "OK", ...r }, null, 2)}\n`);
    return 0;
  } finally {
    await db.end();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    if (e instanceof FactsOnboardingError) {
      process.stdout.write(`${JSON.stringify({ status: "FAIL", code: e.code })}\n`);
      process.exit(1);
    }
    const code = e instanceof Error ? /^DB_URL_[A-Z_]+/.exec(e.message)?.[0] : undefined;
    if (code) {
      process.stdout.write(`${JSON.stringify({ status: "FAIL", code })}\n`);
      process.exit(1);
    }
    process.stderr.write(`${e instanceof Error ? e.name : "error"}\n`);
    process.exit(1);
  });
