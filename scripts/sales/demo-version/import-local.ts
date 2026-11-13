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
 *
 * DEV-196s: `--seed-rin --seed-only` creates (or finds) the 輪 shop and stops, so the local-only patch
 * (apply-local-rin-patch.ts, which needs the seed row) can be applied before the photo package is imported.
 *
 * DEV-263a (Issue #263): the LOCAL facts path and the fictional sendable shop 環.
 *
 *   npx tsx scripts/sales/demo-version/import-local.ts --package <dir> (--prospect <uuid> | --seed-sendable) --trusted-facts <committed facts-pack.json>
 *   npx tsx scripts/sales/demo-version/import-local.ts --seed-sendable --seed-only
 *
 * --trusted-facts reads the facts pack from the local facts path (lib/demo-version-package/local-inputs.ts
 * readCommittedFacts: inside the repository, no symbolic link, byte-identical to HEAD and the same blob at
 * origin/develop; refused before any request otherwise) and passes those bytes as `trustedFactsPack`. Before the import
 * it refuses unless the target demo's sales_demos.content names the sha256 of the same bytes and equals the content
 * derived from them (assertDemoContentFromFacts; a 輪 demo is refused), so the demo row and the facts evidence share
 * one origin. --seed-sendable creates (or finds) 環 from its committed facts pack
 * (lib/demo-version-package/seed-sendable.ts).
 *
 * DEV-263f: the importer's trusted facts come from the facts store (sales_demo_facts_packs).
 *
 *   npx tsx scripts/sales/demo-version/import-local.ts --package <dir> (--prospect <uuid> | --seed-sendable) --facts-from-store
 *   npx tsx scripts/sales/demo-version/import-local.ts --package <dir> (--prospect <uuid> | --seed-sendable) --trusted-facts <committed facts-pack.json> --admin <admin user id>
 *
 * --facts-from-store imports with the shop's current stored facts pack (registered by the owner on the admin screen).
 * --trusted-facts is the dev-only source: the committed pack (checked as above) is first REGISTERED in the facts store
 * as the named admin (sales_register_facts_pack_as: the admin must be in sales_admins), then imported from the store.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { assertLocalSupabaseUrl, ImportError, importPackage, supabasePackageStore } from "../../../lib/demo-version-package/import";
import { PackageError, readPackage } from "../../../lib/demo-version-package/package";
import { assertDemoContentFromFacts, LocalInputError, readCommittedFacts } from "../../../lib/demo-version-package/local-inputs";
import { assertLocalDbUrl, seedRinShop, type FactsPack } from "../../../lib/demo-version-package/seed-rin";
import { SENDABLE_FACTS_PATH, seedSendableShop } from "../../../lib/demo-version-package/seed-sendable";
import { factsPackBytes, FactsStoreError, loadCurrentFactsPack, registerFactsPackAsOperator, type RegisteredFactsPack } from "../../../lib/sales/facts-store";

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
  const seedSendable = process.argv.includes("--seed-sendable");
  const seedOnly = process.argv.includes("--seed-only");
  const trustedPath = arg("--trusted-facts");
  const adminArg = arg("--admin");
  const fromStore = process.argv.includes("--facts-from-store");
  const seeds = Number(seedRin) + Number(seedSendable);
  const usage =
    seeds > 1 ||
    (seedOnly ? seeds !== 1 || dir || prospectArg || trustedPath || fromStore : !dir || (!prospectArg && !seeds) || (prospectArg && (seeds || !UUID.test(prospectArg)))) ||
    (process.argv.includes("--trusted-facts") && !trustedPath) ||
    // DEV-263f: the committed pack is registered in the facts store as a named admin; never both sources
    (trustedPath && (!adminArg || !UUID.test(adminArg))) ||
    (!trustedPath && process.argv.includes("--admin")) ||
    (trustedPath && fromStore) ||
    // the sendable shop is imported only with its facts from the facts path; 輪's photo packages never are (ai_demo_internal)
    (seedSendable && !seedOnly && !trustedPath && !fromStore) ||
    (seedRin && (trustedPath || fromStore));
  if (usage) {
    process.stderr.write(
      "usage: import-local.ts --package <dir> (--prospect <uuid> | --seed-rin | --seed-sendable) [--facts-from-store | --trusted-facts <committed facts-pack.json> --admin <admin user id>]\n" +
        "       import-local.ts (--seed-rin | --seed-sendable) --seed-only\n",
    );
    return 2;
  }
  // DEV-263a: the local facts path, checked before any request (inside the repository, committed, unmodified)
  const trustedFacts = trustedPath ? readCommittedFacts(REPO, trustedPath) : null;
  const url = assertLocalSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    process.stderr.write("the local service role key is not set\n");
    return 2;
  }
  const pkg = seedOnly ? null : readPackage(dir!);
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  let prospectId = prospectArg ?? null;
  let demoId: string;
  if (seedSendable) {
    const db = new pg.Client(assertLocalDbUrl(process.env.SUPABASE_DB_URL));
    await db.connect();
    try {
      // committed at HEAD; the trusted import below also requires it on origin/develop
      const seeded = await seedSendableShop(db, readCommittedFacts(REPO, SENDABLE_FACTS_PATH, { requireBase: false }));
      prospectId = seeded.prospectId;
      demoId = seeded.demoId;
    } finally {
      await db.end();
    }
  } else if (seedRin) {
    // the explicit config of the host checked (never the raw string: nothing in it can redirect the connection)
    const db = new pg.Client(assertLocalDbUrl(process.env.SUPABASE_DB_URL));
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
  if (!pkg) {
    process.stdout.write(`${JSON.stringify({ status: "OK", seeded: true, prospect_id: prospectId, demo_id: demoId })}\n`);
    return 0;
  }
  let registered: RegisteredFactsPack | null = null;
  if (trustedFacts || fromStore) {
    const d = await client.from("sales_demos").select("prospect_id, content").eq("id", demoId).maybeSingle();
    if (d.error || !d.data) throw new ImportError("DEMO_NOT_FOUND");
    const demo = d.data as { prospect_id: string; content: unknown };
    if (trustedFacts) {
      // DEV-263a: the demo row and the facts evidence share one origin
      assertDemoContentFromFacts(demo.content, trustedFacts);
      // DEV-263f: the dev-only source is registered in the facts store as the named admin (the database checks the admin)
      registered = await registerFactsPackAsOperator(client, { demoId, factsPack: new TextDecoder("utf-8", { fatal: true }).decode(trustedFacts), adminId: adminArg! });
    } else {
      // the stored pack must still be what the demo's content was derived from
      const cur = await loadCurrentFactsPack(client, demo.prospect_id);
      if (!cur) throw new ImportError("FACTS_STORE_EMPTY");
      assertDemoContentFromFacts(demo.content, factsPackBytes(cur.facts_pack_text));
    }
  }
  const result = await importPackage(pkg, { client, store: supabasePackageStore(client), demoId, factsFromStore: trustedFacts !== null || fromStore, workerCommit: (pkg.validatorResult.validator_commit ?? "").match(/^[0-9a-f]{7,40}$/) ? pkg.validatorResult.validator_commit : null });
  process.stdout.write(`${JSON.stringify({ status: "OK", prospect_id: prospectId, ...(registered ? { facts_registered: registered } : {}), ...result }, null, 2)}\n`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    if (e instanceof ImportError || e instanceof PackageError || e instanceof LocalInputError || e instanceof FactsStoreError) {
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
