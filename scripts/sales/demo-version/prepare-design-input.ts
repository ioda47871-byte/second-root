/**
 * Offline only. Reads shop-specific verified direction inputs and prepares the
 * existing phase2f v2 design prompt + SHA pin. NO model invocation, no approval.
 *
 * npx tsx scripts/sales/demo-version/prepare-design-input.ts \
 *   --facts /private/facts.json --directions /private/directions.json \
 *   --direction-id d1 --out /private/new-run \
 *   [--references design-library/phase2f/references/success-references-v1.json]
 *
 * The existing phase2f-design.ts is the sole real-call entry, and requires a
 * separate pinned human approval before an external model may be invoked.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep, join } from "node:path";
import { buildBRouteGenerationPrompt, BRoutePromptStop } from "../../../lib/sales/b-route/generation-prompt";
import { runDirectionSetCheck } from "../../design-artifact/direction-set";

const REPO = resolve(__dirname, "../../..");
const defaultReferences = resolve(REPO, "design-library/phase2f/references/success-references-v1.json");
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
class Stop extends Error { constructor(readonly code: string) { super(code); } }
const inside = (root: string, dest: string) => {
  const x = relative(root, dest);
  return x === "" || (x !== ".." && !x.startsWith(`..${sep}`) && !isAbsolute(x));
};
function file(p: string, max = 1024 * 1024): Buffer {
  const path = resolve(p), stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path || stat.size > max) throw new Stop("INPUT_FILE_UNSAFE");
  return readFileSync(path);
}

export function prepareBRouteDesignInput(opts: {
  factsPath: string; directionsPath: string; directionId: string; outDir: string; referencesPath?: string;
}) {
  const factsPath = resolve(opts.factsPath), directionsPath = resolve(opts.directionsPath),
    refsPath = resolve(opts.referencesPath ?? defaultReferences), outDir = resolve(opts.outDir);
  if (existsSync(outDir)) throw new Stop("OUTPUT_EXISTS");
  if (inside(REPO, outDir) || inside(REPO, realpathSync(dirname(outDir)))) throw new Stop("OUTPUT_IN_REPO");
  const fb = file(factsPath), db = file(directionsPath), rb = file(refsPath);
  const gate = runDirectionSetCheck(directionsPath, factsPath);
  if (gate.status !== "READY_FOR_COMPS") throw new Stop("DIRECTION_SET_HOLD");
  const result = buildBRouteGenerationPrompt({
    facts: JSON.parse(fb.toString("utf8")), directionSet: JSON.parse(db.toString("utf8")),
    directionId: opts.directionId, referenceManifest: JSON.parse(rb.toString("utf8")),
  });
  // Input must not change after the prompt is built and before any output is written.
  if (hash(file(factsPath)) !== hash(fb) || hash(file(directionsPath)) !== hash(db) || hash(file(refsPath)) !== hash(rb))
    throw new Stop("INPUT_MUTATED");
  mkdirSync(outDir, { mode: 0o700 });
  const write = (name: string, data: string) =>
    writeFileSync(join(outDir, name), data, { mode: 0o600, flag: "wx" });
  write("direction.json", `${JSON.stringify(result.direction, null, 2)}\n`);
  write("references.json", `${JSON.stringify(result.references, null, 2)}\n`);
  write("prompt.txt", result.prompt);
  const record = {
    schema: "sales_broute_design_input_v1",
    stage: "awaiting_explicit_generator_call_approval",
    shop_id: JSON.parse(fb.toString("utf8")).shop_id,
    facts_sha256: hash(fb),
    direction_set_sha256: hash(db),
    direction_id: opts.directionId,
    references_manifest_sha256: hash(rb),
    prompt_version: result.prompt_version,
    prompt_sha256: result.prompt_sha256,
    prompt_chars: result.prompt_chars,
    reference_count: result.reference_count,
    reference_mode: gate.reference_mode,
    design_generated: false,
    owner_approval: "required",
    sendable: false,
  };
  write("pin.json", `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

function a(s: string) { const i = process.argv.indexOf(s); return i < 0 ? undefined : process.argv[i + 1]; }
if (require.main === module) {
  const factsPath = a("--facts"), directionsPath = a("--directions"), directionId = a("--direction-id"), outDir = a("--out");
  if (!factsPath || !directionsPath || !directionId || !outDir) {
    process.stderr.write("USAGE: --facts <pack> --directions <3-directions> --direction-id <id> --out <new private dir> [--references <owner-scoped manifest>]\n");
    process.exit(2);
  }
  try {
    const status = prepareBRouteDesignInput({ factsPath, directionsPath, directionId, outDir,
      ...(a("--references") ? { referencesPath: a("--references") } : {}) });
    process.stdout.write(`${JSON.stringify({ stage: status.stage, facts_sha256: status.facts_sha256, prompt_sha256: status.prompt_sha256, prompt_chars: status.prompt_chars, sendable: false })}\n`);
  } catch (e) {
    process.stdout.write(`${JSON.stringify({ status: "blocked", code: e instanceof Stop || e instanceof BRoutePromptStop ? e.code : "INPUT_OR_EXECUTION_FAILED" })}\n`);
    process.exit(1);
  }
}
