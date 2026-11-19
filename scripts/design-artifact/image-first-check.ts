/**
 * Issue #293 P1 CLI — OFFLINE: checks a private IMAGE_FIRST run directory and prints the verdict.
 *
 *   npx tsx scripts/design-artifact/image-first-check.ts --run <private run dir> [--impl <implementation dir>]
 *   npx tsx scripts/design-artifact/image-first-check.ts --assemble <private run dir>
 *
 * --run      validates the run (lib/design-agent/image-first/validate.ts) and prints the verdict: status
 *            (REJECT / AWAITING_OWNER_EVALUATION / READY_FOR_IMPLEMENTATION), the reject codes with fixed details,
 *            warnings, each picture's SHA-256 and size, and the composites' sizes. --impl adds the comp-crop / asset
 *            rights check of an implementation's assets/ (with its assets.json).
 * --assemble prints the record built from <run>/run-plan.json and the files (every SHA, size and dimension computed);
 *            the operator saves it as manifest.json in the private run directory.
 *
 * The run directory must be OUTSIDE this repository (private pictures, prompts and manifests never enter Git).
 * Only reads: never writes a file, uploads, calls Codex, a model or the network, and runs nothing — a real generation
 * needs its own per-run approval packet (docs/design/image-first-handoff.md).
 *
 * Exit: 0 READY_FOR_IMPLEMENTATION (or --assemble built the record), 1 REJECT / AWAITING_OWNER_EVALUATION (or the
 * record could not be built), 2 refused (bad arguments, a run directory inside the repository or not a directory).
 */
import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { insideDir } from "../../lib/design-agent/impl-lane/impl-compare";
import { assembleRecord, readImageFirstRun } from "../../lib/design-agent/image-first/builder";
import { validateImageFirst } from "../../lib/design-agent/image-first/validate";

const REPO = resolve(__dirname, "../..");
const say = (o: object) => process.stdout.write(`${JSON.stringify(o, null, 2)}\n`);
const refuse = (code: string) => (say({ status: "refused", code }), 2);

function parseArgs(argv: string[]): { mode: "run" | "assemble"; dir: string; impl: string | null } | null {
  const o: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    if (!k || !v || !["--run", "--impl", "--assemble"].includes(k) || k in o) return null;
    o[k] = v;
  }
  if (!!o["--run"] === !!o["--assemble"]) return null;
  if (o["--assemble"] && o["--impl"]) return null;
  return o["--run"] ? { mode: "run", dir: resolve(o["--run"]), impl: o["--impl"] ? resolve(o["--impl"]) : null } : { mode: "assemble", dir: resolve(o["--assemble"]!), impl: null };
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (!args) return refuse("ARGS_INVALID");
  let dir: string;
  let repo: string;
  try {
    dir = await realpath(args.dir);
    repo = await realpath(REPO);
  } catch {
    return refuse("PATH_UNRESOLVABLE");
  }
  // private files stay private: a run directory inside the repository (even through a link) is refused
  if (insideDir(repo, dir) || insideDir(REPO, args.dir)) return refuse("RUN_DIR_IN_REPO");
  if ((await lstat(dir).catch(() => null))?.isDirectory() !== true) return refuse("RUN_DIR_NOT_A_DIRECTORY");
  if (args.mode === "assemble") {
    const built = await assembleRecord(dir);
    say(built.record ? { status: "assembled", record: built.record } : { status: "not_assembled", problems: built.problems });
    return built.record ? 0 : 1;
  }
  let impl: string | null = null;
  if (args.impl) {
    impl = await realpath(args.impl).catch(() => null);
    if (!impl || (await lstat(impl).catch(() => null))?.isDirectory() !== true) return refuse("IMPL_DIR_INVALID");
  }
  const verdict = validateImageFirst(await readImageFirstRun(dir, impl ? { implDir: impl } : {}));
  say(verdict);
  return verdict.status === "READY_FOR_IMPLEMENTATION" ? 0 : 1;
}

if (require.main === module)
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    () => {
      say({ status: "refused", code: "REFUSED" });
      process.exit(2);
    },
  );
