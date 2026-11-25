/**
 * DEV-303 §6.1 change 4 CLI — OFFLINE: checks a shop's private owner-approved Japanese renderings record
 * (`sr_ja_renderings_v1`, lib/design-agent/ja-renderings/ja-renderings.ts) against its facts pack.
 *
 *   npx tsx scripts/design-artifact/ja-renderings-check.ts --check <ja-renderings.json> --facts <facts-pack.json> [--draft]
 *
 * Every entry's fact_key is a fact of the pack and source_text its value exactly; no ja_text adds a fact (digits,
 * money, dates, history, people, awards … or a Latin word the source does not hold). Gate mode (the default; what
 * request mode and the copy audit run) also needs owner_confirmation whose entries_sha256 is the printed
 * entries_sha256. --draft skips the confirmation (before the owner has read the renderings). Claude records
 * owner_confirmation only when the owner says so; it is a record of that statement, not the owner's signature.
 *
 * The record must be OUTSIDE this repository (e.g. ~/second-root-shops/<shop_id>/ja-renderings.json). Nothing is
 * written. Output: one JSON object; a refusal names its code and, for an added fact, the category, field and key
 * (never the text).
 *
 * Exit: 0 passed, 1 stopped (a named JA_RENDERING* code), 2 refused (bad arguments, the record in the repository,
 * unreadable files).
 */
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { checkJaRenderings, JA_RENDERINGS_MAX_BYTES, jaRenderingDetailOf, JaRenderingsStop } from "../../lib/design-agent/ja-renderings/ja-renderings";
import { FactsPack } from "../../lib/design-agent/quality-pipeline/facts-pack";

const REPO = resolve(__dirname, "../..");
const say = (o: object) => process.stdout.write(`${JSON.stringify(o, null, 2)}\n`);
const refuse = (code: string) => (say({ status: "refused", code }), 2);
const within = (child: string, parent: string) => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

export function parseJaRenderingsArgs(argv: string[]): { file: string; facts: string; draft: boolean } | null {
  const o: Record<string, string> = {};
  let draft = false;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    if (k === "--draft") {
      if (draft) return null;
      draft = true;
      continue;
    }
    const v = argv[i + 1];
    if (!["--check", "--facts"].includes(k) || !v || v.startsWith("--") || k in o) return null;
    o[k] = v;
    i++;
  }
  return o["--check"] && o["--facts"] ? { file: resolve(o["--check"]), facts: resolve(o["--facts"]), draft } : null;
}

/** A regular file, no link at the last step, within `max` bytes; null when unreadable. */
async function readSmall(path: string, max: number): Promise<Buffer | null> {
  try {
    const h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const st = await h.stat();
      if (!st.isFile() || st.size > max) return null;
      return await h.readFile();
    } finally {
      await h.close();
    }
  } catch {
    return null;
  }
}

export async function jaRenderingsMain(argv: string[], repoRoot: string = REPO): Promise<number> {
  const args = parseJaRenderingsArgs(argv);
  if (!args) return refuse("ARGS_INVALID");
  const repo = await realpath(repoRoot).catch(() => repoRoot);
  const real = await realpath(args.file).catch(() => null);
  if (real === null) return refuse("JA_RENDERINGS_RECORD_MISSING");
  // a shop's renderings are private: never read from (or encouraged into) this public repository
  if (within(real, repo) || within(args.file, repoRoot)) return refuse("JA_RENDERINGS_RECORD_IN_REPO");
  const bytes = await readSmall(real, JA_RENDERINGS_MAX_BYTES);
  if (!bytes) return refuse("JA_RENDERINGS_RECORD_UNREADABLE");
  const factsBytes = await readSmall(args.facts, 256 * 1024);
  let facts: FactsPack;
  try {
    facts = FactsPack.parse(JSON.parse(factsBytes?.toString("utf8") ?? ""));
  } catch {
    return refuse("FACTS_INVALID");
  }
  try {
    const c = checkJaRenderings(bytes, facts, { mode: args.draft ? "draft" : "gate" });
    say({ status: "passed", mode: args.draft ? "draft" : "gate", shop_id: c.shop_id, ja_renderings_sha256: c.sha256, entries_sha256: c.entries_sha256, keys: c.entries.map((e) => e.fact_key), owner_confirmed: c.owner_confirmed });
    return 0;
  } catch (error) {
    if (!(error instanceof JaRenderingsStop)) throw error;
    const detail = jaRenderingDetailOf(error);
    say({ status: "stopped", code: error.code, ...(detail ? { detail } : {}) });
    return 1;
  }
}

if (require.main === module)
  jaRenderingsMain(process.argv.slice(2)).then(
    (code) => process.exit(code),
    () => {
      say({ status: "refused", code: "REFUSED" });
      process.exit(2);
    },
  );
