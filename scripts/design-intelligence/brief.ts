/**
 * DEV-112 Phase 1 CLI: read-only Design Intelligence research brief.
 *
 *   npx tsx scripts/design-intelligence/brief.ts --research-root <dir> --summary
 *       checks the research corpus and prints its counts and file SHA-256s
 *   npx tsx scripts/design-intelligence/brief.ts --research-root <dir> --shop <shop-input.json>
 *       prints a research brief (JSON) for one shop to stdout
 *
 * DEV-113: --mode phase1_compat (default) | partial | strict, and --ledger <file>.
 *   phase1_compat reads no ledger and prints exactly the Phase 1 output (--ledger is refused).
 *   partial requires --ledger and adds a `ledger` report.
 *   strict requires --ledger and always stops (STRICT_APPROVAL_NOT_IMPLEMENTED): a safe
 *   not-yet-implemented state, not a working strict mode.
 *
 * <dir> is a checkout that contains the research data (for example a worktree
 * of research/approved-editorial-cases-20261027). Nothing is written, fetched,
 * sent to a model or connected to the worker, the sales code or the database.
 * Exit: 0 ok, 2 refused (usage, missing file, schema or policy mismatch).
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildResearchBrief, ShopResearchInput } from "../../lib/design-agent/intelligence/brief";
import { CorpusError, loadResearchCorpus, type CorpusOptions } from "../../lib/design-agent/intelligence/corpus";
import { LEDGER_MODES, LedgerError, type LedgerMode } from "../../lib/design-agent/intelligence/ledger";

const VALUE_FLAGS = ["--research-root", "--shop", "--mode", "--ledger"] as const;
type Args = { flags: Partial<Record<(typeof VALUE_FLAGS)[number], string>>; summary: boolean };

/** Strict parsing: an unknown or repeated flag, a missing value or a --flag=value form is refused, never defaulted. */
function parseArgs(argv: string[]): Args | null {
  const out: Args = { flags: {}, summary: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--summary") {
      if (out.summary) return null;
      out.summary = true;
    } else if ((VALUE_FLAGS as readonly string[]).includes(a)) {
      const name = a as (typeof VALUE_FLAGS)[number];
      const value = argv[i + 1];
      if (name in out.flags || value === undefined || value.startsWith("--") || value === "") return null;
      out.flags[name] = value;
      i++;
    } else {
      return null;
    }
  }
  return out;
}

async function main(): Promise<number> {
  const usage =
    "usage: --research-root <dir> (--summary | --shop <shop-input.json>) [--mode phase1_compat|partial|strict] [--ledger <ledger.json>]\n" +
    "  phase1_compat (default) reads no ledger; partial needs --ledger; strict needs --ledger and always stops (not implemented yet)";
  const args = parseArgs(process.argv.slice(2));
  const root = args?.flags["--research-root"];
  const shopPath = args?.flags["--shop"];
  const summary = args?.summary ?? false;
  const modeArg = args?.flags["--mode"] ?? "phase1_compat";
  const ledgerPath = args?.flags["--ledger"];
  if (!args || !root || summary === Boolean(shopPath) || !(LEDGER_MODES as readonly string[]).includes(modeArg) || (modeArg === "phase1_compat" && ledgerPath !== undefined)) {
    console.error(usage);
    return 2;
  }
  const mode = modeArg as LedgerMode;
  const opts: CorpusOptions = mode === "phase1_compat" ? { mode } : { mode, ...(ledgerPath ? { ledgerPath: resolve(ledgerPath) } : {}) };
  try {
    const corpus = await loadResearchCorpus(resolve(root), opts);
    if (summary) {
      console.log(JSON.stringify({ as_of: corpus.as_of, counts: corpus.counts, source_sha256: corpus.source_sha256, ...(corpus.ledger ? { ledger: corpus.ledger } : {}) }, null, 2));
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
    console.error(e instanceof CorpusError || e instanceof LedgerError ? e.message : "REFUSED");
    return 2;
  }
}

main().then((code) => process.exit(code));
