/**
 * DEV-139 P0-2b. A generated photo-free B-route HTML/CSS prototype → private
 * comp with a fact-bound copy.json. It validates the already implemented
 * three-direction gate; it never calls a model, DB, worker, or outreach API.
 *
 * npx tsx scripts/sales/demo-version/from-prototype.ts \
 *   --facts /private/facts-pack.json --prototype /private/prototype \
 *   --directions /private/direction-set.json --direction-id motif-a \
 *   --lane quality_research_fictional --out /private/new-run
 *
 * A direction set is a prerequisite, not proof that the rendered page follows
 * that direction. The output is NOT an approved or sendable demo.
 *
 * The comp is written to <out>/comp/<direction-id>/: the directory name is the direction id, which is what the next
 * stage (prepare-offline.mjs → comp-lane.ts --check-review) reads to tie a review.json to its direction (STEP 2).
 */
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { deriveBRouteCopy, BRouteCopyStop, type BRouteLane } from "../../../lib/sales/b-route/derive-copy";
import { runDirectionSetCheck } from "../../design-artifact/direction-set";

const REPO = resolve(__dirname, "../../..");
const SHA = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The art-direction set's own id rule (lib/design-agent/quality-pipeline/direction-set.ts); also a safe directory name. */
const DIRECTION_ID = /^[a-z0-9][a-z0-9-]{2,40}$/;
export class InputStop extends Error { constructor(readonly code: string) { super(code); } }
export function inside(root: string, dest: string): boolean {
  const rel = relative(root, dest);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function checkedFile(path: string, max: number): Buffer {
  const full = resolve(path);
  let st;
  try { st = lstatSync(full); } catch { throw new InputStop("INPUT_FILE_INVALID"); }
  if (!st.isFile() || st.isSymbolicLink() || realpathSync(full) !== full || st.size > max)
    throw new InputStop("INPUT_FILE_INVALID");
  return readFileSync(full);
}
/**
 * The output must be a NEW directory outside the public repo, also when its parent is reached through a symlink.
 * `repoRoot` is a parameter only so the guard can be tested against a throwaway tree; the CLI always uses REPO.
 */
export function checkPrivateOutputDir(outDir: string, repoRoot: string = REPO): void {
  let exists = true;
  try { lstatSync(outDir); } catch { exists = false; } // a dangling symlink also "exists"
  if (exists) throw new InputStop("OUTPUT_EXISTS");
  let parent: string;
  try { parent = realpathSync(dirname(outDir)); } catch { throw new InputStop("OUTPUT_PARENT_MISSING"); }
  if (inside(repoRoot, outDir) || inside(realpathSync(repoRoot), parent)) throw new InputStop("OUTPUT_IN_REPO");
}
export function stagePrototype(o: {
  factsPath: string; prototypeDir: string; directionsPath: string; directionId: string;
  lane: BRouteLane; outDir: string; prospectId?: string;
}, testHooks: { afterValidation?: () => void } = {}) {
  const factsPath = resolve(o.factsPath), protoDir = resolve(o.prototypeDir);
  const directionsPath = resolve(o.directionsPath), outDir = resolve(o.outDir);
  checkPrivateOutputDir(outDir);
  let protoStat;
  try { protoStat = lstatSync(protoDir); } catch { throw new InputStop("PROTOTYPE_DIR_UNSAFE"); }
  if (!protoStat.isDirectory() || realpathSync(protoDir) !== protoDir)
    throw new InputStop("PROTOTYPE_DIR_UNSAFE");
  if (o.prospectId && !uuid.test(o.prospectId)) throw new InputStop("PROSPECT_ID_INVALID");
  if (o.lane === "real_shop_proposal" && [factsPath, protoDir, directionsPath].some((p) => inside(REPO, p)))
    throw new InputStop("PRIVATE_SHOP_INPUT_IN_PUBLIC_REPO");
  const factsBytes = checkedFile(factsPath, 1024 * 1024);
  const htmlBytes = checkedFile(join(protoDir, "index.html"), 384 * 1024);
  const cssBytes = checkedFile(join(protoDir, "style.css"), 256 * 1024);
  const directionBytes = checkedFile(directionsPath, 1024 * 1024);
  const directionSet = JSON.parse(directionBytes.toString("utf8")) as {
    schema?: string; shop_id?: string; facts_sha256?: string; directions?: { id?: string }[];
  };
  const checked = runDirectionSetCheck(directionsPath, factsPath);
  if (checked.status !== "READY_FOR_COMPS") throw new InputStop("DIRECTION_SET_HOLD");
  if (directionSet.shop_id === undefined || directionSet.facts_sha256 !== SHA(factsBytes) ||
      !DIRECTION_ID.test(o.directionId) || !directionSet.directions?.some((d) => d.id === o.directionId))
    throw new InputStop("DIRECTION_MISMATCH");
  const composed = deriveBRouteCopy({
    factsBytes, html: htmlBytes.toString("utf8"), css: cssBytes.toString("utf8"), lane: o.lane,
  });

  testHooks.afterValidation?.();
  // Do not allow the input source to change between validation and staging.
  if (SHA(checkedFile(factsPath, 1024 * 1024)) !== SHA(factsBytes) ||
      SHA(checkedFile(join(protoDir, "index.html"), 384 * 1024)) !== SHA(htmlBytes) ||
      SHA(checkedFile(join(protoDir, "style.css"), 256 * 1024)) !== SHA(cssBytes) ||
      SHA(checkedFile(directionsPath, 1024 * 1024)) !== SHA(directionBytes))
    throw new InputStop("INPUT_MUTATED");

  mkdirSync(outDir, { mode: 0o700 });
  const compDir = join(outDir, "comp", o.directionId);
  mkdirSync(compDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(compDir, "index.html"), htmlBytes, { mode: 0o600, flag: "wx" });
  writeFileSync(join(compDir, "style.css"), cssBytes, { mode: 0o600, flag: "wx" });
  writeFileSync(join(compDir, "copy.json"), `${JSON.stringify(composed.record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  const status = {
    schema: "sales_broute_comp_handoff_v1",
    stage: "awaiting_copy_and_visual_review",
    prospect_id: o.prospectId ?? null,
    shop_id: composed.record.shop_id,
    facts_sha256: composed.hashes.facts_sha256,
    direction_set_sha256: SHA(directionBytes),
    direction_id: o.directionId,
    prototype_sha256: { html: composed.hashes.html_sha256, css: composed.hashes.css_sha256 },
    copy_sha256: SHA(readFileSync(join(compDir, "copy.json"))),
    copy: composed.stats,
    reference_mode: checked.reference_mode,
    generated_design_quality: "not_assessed",
    owner_approval: "required",
    sendable: false,
    shared_url: null,
  };
  writeFileSync(join(outDir, "status.json"), `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return status;
}

function argument(key: string) {
  const i = process.argv.indexOf(key);
  return i === -1 ? undefined : process.argv[i + 1];
}
if (require.main === module) {
  const factsPath = argument("--facts"), prototypeDir = argument("--prototype"),
    directionsPath = argument("--directions"), directionId = argument("--direction-id"),
    lane = argument("--lane"), outDir = argument("--out"), prospectId = argument("--prospect-id");
  if (!factsPath || !prototypeDir || !directionsPath || !directionId || !lane || !outDir ||
      !["quality_research_fictional", "real_shop_proposal"].includes(lane)) {
    process.stderr.write("USAGE: --facts <pack> --prototype <HTML/CSS dir> --directions <direction-set> --direction-id <id> --lane <quality_research_fictional|real_shop_proposal> --out <new private dir> [--prospect-id <uuid>]\n");
    process.exit(2);
  }
  try {
    const result = stagePrototype({
      factsPath, prototypeDir, directionsPath, directionId, lane: lane as BRouteLane, outDir,
      ...(prospectId ? { prospectId } : {}),
    });
    // No private shop text or path is written to stdout.
    process.stdout.write(`${JSON.stringify({ stage: result.stage, facts_sha256: result.facts_sha256, direction_id: result.direction_id, copy: result.copy, sendable: false })}\n`);
  } catch (error) {
    const code = error instanceof InputStop || error instanceof BRouteCopyStop ? error.code : "INPUT_OR_EXECUTION_FAILED";
    process.stdout.write(`${JSON.stringify({ status: "blocked", code })}\n`);
    process.exit(1);
  }
}
