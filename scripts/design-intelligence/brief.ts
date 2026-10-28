/**
 * DEV-112 Phase 1 CLI: read-only Design Intelligence research brief.
 *
 *   npx tsx scripts/design-intelligence/brief.ts --research-root <dir> --summary
 *       checks the research corpus and prints its counts and file SHA-256s
 *   npx tsx scripts/design-intelligence/brief.ts --research-root <dir> --shop <shop-input.json>
 *       prints a research brief (JSON) for one shop to stdout
 *
 * <dir> is a checkout that contains the research data (for example a worktree
 * of research/approved-editorial-cases-20261027). Nothing is written, fetched,
 * sent to a model or connected to the worker, the sales code or the database.
 * Exit: 0 ok, 2 refused (usage, missing file, schema or policy mismatch).
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildResearchBrief, ShopResearchInput } from "../../lib/design-agent/intelligence/brief";
import { CorpusError, loadResearchCorpus } from "../../lib/design-agent/intelligence/corpus";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const root = arg("--research-root");
  const shopPath = arg("--shop");
  const summary = process.argv.includes("--summary");
  if (!root || summary === Boolean(shopPath)) {
    console.error("usage: --research-root <dir> (--summary | --shop <shop-input.json>)");
    return 2;
  }
  try {
    const corpus = await loadResearchCorpus(resolve(root));
    if (summary) {
      console.log(JSON.stringify({ as_of: corpus.as_of, counts: corpus.counts, source_sha256: corpus.source_sha256 }, null, 2));
      return 0;
    }
    const raw = JSON.parse(await readFile(resolve(shopPath!), "utf8"));
    const shop = ShopResearchInput.safeParse(raw);
    if (!shop.success) {
      console.error(`SHOP_INPUT_INVALID: ${shop.error.issues.map((i) => i.message).join("; ")}`);
      return 2;
    }
    console.log(JSON.stringify(buildResearchBrief(corpus, shop.data), null, 2));
    return 0;
  } catch (e) {
    console.error(e instanceof CorpusError ? e.message : "REFUSED");
    return 2;
  }
}

main().then((code) => process.exit(code));
