/**
 * Issue #293 P3 (preparation) CLI — OFFLINE, READ ONLY: prints the pin of one IMAGE_FIRST generation for the owner's
 * approval packet.
 *
 *   npx tsx scripts/design-artifact/image-first-prompt.ts --direction d1|d3|d4 --print-pin
 *   npx tsx scripts/design-artifact/image-first-prompt.ts --direction d1|d3|d4 --print-direction-sha
 *
 * --print-pin prints every prompt text in full, each prompt's SHA-256 and length, the declared section sequences (PC and
 * SP), the batch prompt the one Codex run would read (its SHA-256 and length are the ledger pin), the combined plan
 * SHA-256, the facts pack SHA-256, the chosen direction object's SHA-256 and the success-principle record's SHA-256 with
 * the case ids the principles come from (lib/design-agent/image-first/prompt.ts).
 *
 * --print-direction-sha (Issue #302 P5) prints only the canonical direction.json SHA-256 of the direction object as it is
 * in its file now, and whether it equals the pin in DIRECTIONS — the value to write into DIRECTIONS after editing a
 * direction, without an ad-hoc hashing command. It reads only that direction's file.
 *
 * Writes nothing, calls no Codex, model, image tool or network, starts no process.
 * Exit: 0 printed, 2 refused (bad arguments, an input whose pin does not hold).
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildPromptPlan, currentDirectionSha256, DIRECTIONS, loadPromptInputs, pinOf, PromptStop, type DirectionKey } from "../../lib/design-agent/image-first/prompt";

const REPO = resolve(__dirname, "../..");
const say = (o: object) => process.stdout.write(`${JSON.stringify(o, null, 2)}\n`);

type Mode = "--print-pin" | "--print-direction-sha";

function parse(argv: string[]): { key: DirectionKey; mode: Mode } | null {
  if (argv.length !== 3) return null;
  const i = argv.indexOf("--direction");
  const d = i >= 0 ? argv[i + 1] : undefined;
  const mode = (["--print-pin", "--print-direction-sha"] as const).find((m) => argv.includes(m));
  if (!mode || !d || !Object.hasOwn(DIRECTIONS, d)) return null;
  return { key: d as DirectionKey, mode };
}

async function directionSha(key: DirectionKey): Promise<object> {
  const sha256 = await currentDirectionSha256((p) => readFile(resolve(REPO, p)), key);
  return { mode: "print_direction_sha", direction_key: key, direction_id: DIRECTIONS[key].id, file: DIRECTIONS[key].set, sha256, matches_pin: sha256 === DIRECTIONS[key].sha256 };
}

async function main(argv: string[]): Promise<number> {
  const args = parse(argv);
  if (!args) return (say({ status: "refused", code: "USAGE" }), 2);
  try {
    if (args.mode === "--print-direction-sha") say(await directionSha(args.key));
    else say(pinOf(buildPromptPlan(await loadPromptInputs((p) => readFile(resolve(REPO, p)), args.key))));
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
