/**
 * Issue #293 P3 (preparation) CLI — OFFLINE, READ ONLY: prints the pin of one IMAGE_FIRST generation for the owner's
 * approval packet.
 *
 *   npx tsx scripts/design-artifact/image-first-prompt.ts --direction d1|d3 --print-pin
 *
 * Prints every prompt text in full, each prompt's SHA-256 and length, the declared section sequences (PC and SP), the
 * batch prompt the one Codex run would read (its SHA-256 and length are the ledger pin), the combined plan SHA-256,
 * the facts pack SHA-256, the chosen direction object's SHA-256 and the success-principle record's SHA-256 with the
 * case ids the principles come from (lib/design-agent/image-first/prompt.ts).
 *
 * Reads only the three pinned inputs; writes nothing, calls no Codex, model, image tool or network, starts no process.
 * Exit: 0 printed, 2 refused (bad arguments, an input whose pin does not hold).
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildPromptPlan, loadPromptInputs, pinOf, PromptStop, type DirectionKey } from "../../lib/design-agent/image-first/prompt";

const REPO = resolve(__dirname, "../..");
const say = (o: object) => process.stdout.write(`${JSON.stringify(o, null, 2)}\n`);

function parse(argv: string[]): DirectionKey | null {
  if (argv.length !== 3) return null;
  const i = argv.indexOf("--direction");
  const d = i >= 0 ? argv[i + 1] : undefined;
  if (!argv.includes("--print-pin") || (d !== "d1" && d !== "d3")) return null;
  return d;
}

async function main(argv: string[]): Promise<number> {
  const key = parse(argv);
  if (!key) return (say({ status: "refused", code: "USAGE" }), 2);
  try {
    const plan = buildPromptPlan(await loadPromptInputs((p) => readFile(resolve(REPO, p)), key));
    say(pinOf(plan));
    return 0;
  } catch (error) {
    say({ status: "refused", code: error instanceof PromptStop ? error.code : "INPUT_UNREADABLE" });
    return 2;
  }
}

// exitCode, not process.exit: a piped stdout is drained in full before the process ends
if (require.main === module)
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
