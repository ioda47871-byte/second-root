/**
 * DEV-139 Stage 0 (A-4): the LOCAL database seed of the Stage 0 fictional bakery (S0_FACTS_PATH) and its cleanup.
 * docs/operations/s0-local-db-seed.md. Never run against a hosted database; never run without the owner's approval.
 *
 *   npx tsx scripts/sales/demo-version/s0-local-seed.ts plan
 *   npx tsx scripts/sales/demo-version/s0-local-seed.ts seed    --admin <admin user id> --record <file outside the repo> --owner-approved-local-seed
 *   npx tsx scripts/sales/demo-version/s0-local-seed.ts verify  --admin-email <email>      (password in S0_ADMIN_PASSWORD)
 *   npx tsx scripts/sales/demo-version/s0-local-seed.ts cleanup --record <file> --owner-approved-local-seed [--include-imported]
 *
 * plan: no connection; prints the rows the seed would write (fictional values only).
 * seed / cleanup: refused before any connection without --owner-approved-local-seed, or unless SUPABASE_DB_URL is a local
 * stack (127.0.0.1 / localhost, no query string, no PG* host variable). The facts pack is the committed S0_FACTS_PATH
 * (readCommittedFacts: inside the repository, no link, byte-identical to HEAD).
 * verify: read-only. Needs NODE_OPTIONS=--conditions=react-server (the read path imports server-only modules). Signs in as the admin on the LOCAL API (NEXT_PUBLIC_SUPABASE_URL must be http://127.0.0.1 /
 * localhost) and runs PR #280's loadVerifiedGenerationFacts under the admin's own session (RLS intact); OK only when the
 * returned SHA is the committed pack's. Prints ids, hashes and codes only — never a key or a password.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { LocalInputError, readCommittedFacts, factsPackSha256 } from "../../../lib/demo-version-package/local-inputs";
import {
  assertS0LocalApiUrl, assertS0RecordPath, assertS0WriteAllowed, precheckS0RecordFile, writeS0RecordFile, cleanupS0Seed, parseS0SeedRecord, S0_FACTS_PATH, S0_PROSPECT_ID, S0SeedError, s0SeedPlan, seedS0Shop,
} from "../../../lib/demo-version-package/seed-s0";

const REPO = resolve(__dirname, "../../..");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
const KNOWN: Record<string, string[]> = {
  plan: [],
  seed: ["--admin", "--record", "--owner-approved-local-seed"],
  verify: ["--admin-email"],
  cleanup: ["--record", "--owner-approved-local-seed", "--include-imported"],
};
const USAGE =
  "usage: s0-local-seed.ts plan\n" +
  "       s0-local-seed.ts seed --admin <admin user id> --record <file outside the repo> --owner-approved-local-seed\n" +
  "       s0-local-seed.ts verify --admin-email <email>   (S0_ADMIN_PASSWORD in the environment)\n" +
  "       s0-local-seed.ts cleanup --record <file> --owner-approved-local-seed [--include-imported]\n";

async function main(): Promise<number> {
  const cmd = process.argv[2] ?? "";
  const flags = process.argv.slice(3).filter((a) => a.startsWith("--"));
  if (!(cmd in KNOWN) || flags.some((f) => !KNOWN[cmd]!.includes(f))) {
    process.stderr.write(USAGE);
    return 2;
  }
  // seed / cleanup: the flag, a local stack and the record path are checked first, before anything is read or connected
  const write = cmd === "seed" || cmd === "cleanup" ? { config: assertS0WriteAllowed(process.argv, process.env), recordPath: assertS0RecordPath(REPO, arg("--record")) } : null;
  // the committed facts pack of the Stage 0 fictional bakery (the seed may run before the pack is on develop)
  const facts = readCommittedFacts(REPO, S0_FACTS_PATH, { requireBase: false });
  if (cmd === "plan") {
    out({ status: "OK", plan: s0SeedPlan(facts) });
    return 0;
  }
  if (cmd === "verify") {
    const email = arg("--admin-email");
    const password = process.env.S0_ADMIN_PASSWORD;
    const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!email || !password || !anon) {
      process.stderr.write(USAGE);
      return 2;
    }
    let read: typeof import("../../../lib/sales/b-route/verified-generation-facts");
    try {
      // server-only modules: loadable only under the react-server condition (NODE_OPTIONS=--conditions=react-server)
      read = await import("../../../lib/sales/b-route/verified-generation-facts");
    } catch {
      out({ status: "FAIL", code: "S0_VERIFY_NEEDS_REACT_SERVER_CONDITION" });
      return 2;
    }
    const client = createClient(assertS0LocalApiUrl(process.env.NEXT_PUBLIC_SUPABASE_URL), anon, { auth: { persistSession: false, autoRefreshToken: false } });
    const s = await client.auth.signInWithPassword({ email, password });
    if (s.error) {
      out({ status: "FAIL", code: "S0_ADMIN_SIGN_IN_FAILED" });
      return 1;
    }
    try {
      const r = await read.loadVerifiedGenerationFacts(client, S0_PROSPECT_ID);
      const expected = factsPackSha256(facts);
      out({ status: r.factsSha256 === expected ? "OK" : "FAIL", ...(r.factsSha256 === expected ? {} : { code: "S0_READ_SHA_NOT_COMMITTED" }),
        prospect_id: r.prospectId, demo_id: r.demoId, facts_pack_id: r.factsPackId, shop_id: r.shopId, facts_sha256: r.factsSha256 });
      return r.factsSha256 === expected ? 0 : 1;
    } finally {
      await client.auth.signOut();
    }
  }
  // seed / cleanup: the flag and a local stack, checked before any connection
  const { config, recordPath } = write!;
  if (cmd === "seed") {
    const adminId = arg("--admin");
    if (!adminId || !UUID.test(adminId)) {
      process.stderr.write(USAGE);
      return 2;
    }
    precheckS0RecordFile(recordPath);
    const db = new pg.Client(config);
    await db.connect();
    try {
      const r = await seedS0Shop(db, { factsPack: facts, adminId });
      let file: string;
      try {
        file = writeS0RecordFile(recordPath, r.record);
      } catch (e) {
        // the rows exist: print their ids so they are never lost
        out({ status: "FAIL", code: e instanceof S0SeedError ? e.code : "S0_RECORD_FILE_WRITE_FAILED", created: r.created, record: r.record });
        return 1;
      }
      out({ status: "OK", created: r.created, record: r.record, record_file: file });
      return 0;
    } finally {
      await db.end();
    }
  }
  const record = parseS0SeedRecord(JSON.parse(readFileSync(recordPath, "utf8")));
  const db = new pg.Client(config);
  await db.connect();
  try {
    const r = await cleanupS0Seed(db, record, { factsPack: facts, includeImported: process.argv.includes("--include-imported") });
    out({ status: "OK", prospect_id: record.prospect_id, deleted: r.deleted, storage_prefixes_left: r.storagePrefixesLeft.length });
    return 0;
  } finally {
    await db.end();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    // GenerationFactsStop (PR #280) is matched by name: its module is loaded only by verify
    if (e instanceof S0SeedError || e instanceof LocalInputError || (e instanceof Error && e.name === "GenerationFactsStop")) {
      out({ status: "FAIL", code: (e as unknown as { code: string }).code, ...(e instanceof S0SeedError && e.detail ? { rows: e.detail } : {}) });
      process.exit(1);
    }
    // a database refusal: its code only (the message's first word), never the statement or a value
    const code = e instanceof Error ? /^[a-z_]+/.exec(e.message)?.[0] : undefined;
    out({ status: "FAIL", code: code ?? "S0_UNEXPECTED" });
    process.exit(1);
  });
