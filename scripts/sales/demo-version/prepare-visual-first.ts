/**
 * DEV-139 visual-first handoff: recover the full-page PC/SP and photo plan that
 * the B-route's open-direction prompt intentionally omits. OFFLINE ONLY.
 *
 * npx tsx scripts/sales/demo-version/prepare-visual-first.ts
 *   --facts <facts-pack.json> --directions <direction-set.json>
 *   --direction-id <id> --out <new private directory>
 *
 * This DOES NOT generate a comp, photograph, approval, or sendable package.
 * For the photo-enhanced route, an empty photo inventory is an explicit HOLD.
 */
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { FactsPack } from "../../../lib/design-agent/quality-pipeline/facts-pack";
import { DirectionSet } from "../../../lib/design-agent/quality-pipeline/direction-set";
import { runDirectionSetCheck } from "../../design-artifact/direction-set";

const REPO = resolve(__dirname, "../../..");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const inside = (root: string, target: string) => {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

export class VisualFirstStop extends Error {
  constructor(readonly code: string) { super(code); this.name = "VisualFirstStop"; }
}

function safeFile(path: string): Buffer {
  const p = resolve(path);
  let st;
  try { st = lstatSync(p); } catch { throw new VisualFirstStop("INPUT_FILE_INVALID"); }
  if (!st.isFile() || st.isSymbolicLink() || realpathSync(p) !== p || st.size > 1024 * 1024)
    throw new VisualFirstStop("INPUT_FILE_INVALID");
  return readFileSync(p);
}

export function requirePrivateNewDir(path: string, repoRoot = REPO): void {
  const out = resolve(path);
  let exists = false;
  try { lstatSync(out); exists = true; } catch { /* absent */ }
  if (exists) throw new VisualFirstStop("OUTPUT_EXISTS");
  let parent: string;
  try { parent = realpathSync(dirname(out)); } catch { throw new VisualFirstStop("OUTPUT_PARENT_INVALID"); }
  if (inside(repoRoot, out) || inside(realpathSync(repoRoot), parent))
    throw new VisualFirstStop("OUTPUT_IN_REPO");
}

/**
 * The three-direction gate is the existing C1-C7 check. This function produces
 * only an untrusted, owner-review-required design work order; no approval can
 * be granted by putting an "approved" string in an input.
 */
export function prepareVisualFirst(opts: {
  factsPath: string; directionsPath: string; directionId: string; outDir: string;
}) {
  requirePrivateNewDir(opts.outDir);
  const fb = safeFile(opts.factsPath);
  const db = safeFile(opts.directionsPath);
  let rawFacts: unknown, rawSet: unknown;
  try { rawFacts = JSON.parse(fb.toString("utf8")); rawSet = JSON.parse(db.toString("utf8")); }
  catch { throw new VisualFirstStop("INPUT_JSON_INVALID"); }
  const facts = FactsPack.safeParse(rawFacts);
  const set = DirectionSet.safeParse(rawSet);
  if (!facts.success || !set.success) throw new VisualFirstStop("INPUT_SCHEMA_INVALID");
  if (facts.data.shop_id !== set.data.shop_id || set.data.facts_sha256 !== sha(fb))
    throw new VisualFirstStop("FACTS_IDENTITY_MISMATCH");
  const checked = runDirectionSetCheck(opts.directionsPath, opts.factsPath);
  if (checked.status !== "READY_FOR_COMPS") throw new VisualFirstStop("DIRECTION_SET_HOLD");
  const selected = set.data.directions.find((d) => d.id === opts.directionId);
  if (!selected) throw new VisualFirstStop("DIRECTION_NOT_FOUND");

  // A slot is not an image. Its count and placement are selected by THIS
  // shop's layout, never fixed at six because the 輪 case used six photos.
  const photoSlots = selected.sections.flatMap((section) =>
    section.image_slots.map((slot, i) => ({
      slot_id: `ph-${section.id}-${i + 1}`,
      section_id: section.id,
      role: slot.role,
      size: slot.size,
      status: "needs_measured_pc_sp_slot" as const,
    })));
  const plan = {
    schema: "sales_visual_first_brief_v1",
    shop_id: facts.data.shop_id,
    facts_sha256: sha(fb),
    direction_set_sha256: sha(db),
    direction_id: selected.id,
    reference_mode: checked.reference_mode,
    concept: selected.concept,
    motif: set.data.motif.candidates.find((m) => m.id === selected.motif_focus),
    composition: selected.composition,
    descriptor: selected.descriptor,
    sections: selected.sections,
    ending: selected.ending,
    pc_1440_full_page_plan: selected.pc_plan,
    sp_390_full_page_plan: selected.sp_plan,
    protect: selected.protect,
    reference_principles: selected.references,
    reference_cases_not_used: selected.not_used,
    photo_slots: photoSlots,
    image_policy: {
      photos_generated: false,
      photo_count_fixed: false,
      demo_ai_photos_not_real_shop_evidence: true,
      use_existing_photo_rights_and_swap_gates: true,
    },
    next_required_evidence: [
      "full_page_pc_1440_visual_comp",
      "full_page_sp_390_visual_comp_separate_reading_order",
      "owner_design_review",
      "measured_photo_slot_inventory_pc_sp_and_edges",
      "separately_approved_photo_generation_or_cleared_owner_images",
      "private_photo_rights_provenance_and_crop_check",
      "full_page_photo_swap_renders_and_owner_review",
      "claude_implementation_and_impl_compare",
      "existing_copy_safety_and_demo_packaging",
    ],
    human_gates: {
      pc_sp_comp: "not_done",
      photo_generation: "not_approved",
      image_rights: "not_done",
      photo_integrated_render: "not_done",
      implementation_fidelity: "not_done",
      owner_final_quality: "not_done",
    },
    sendable: false,
  };
  const status = {
    schema: "sales_visual_first_status_v1",
    shop_id: facts.data.shop_id,
    facts_sha256: sha(fb),
    direction_id: selected.id,
    stage: photoSlots.length ? "PHOTO_ENHANCED_BRIEF_READY_FOR_DESIGN" : "PHOTO_SLOTS_REQUIRED",
    photo_slot_count: photoSlots.length,
    visual_design_created: false,
    assets_created: false,
    implementation_created: false,
    owner_review_required: true,
    sendable: false,
  };

  // Fail closed if the validated input changed while the work order was prepared.
  if (sha(safeFile(opts.factsPath)) !== sha(fb) || sha(safeFile(opts.directionsPath)) !== sha(db))
    throw new VisualFirstStop("INPUT_MUTATED");
  mkdirSync(opts.outDir, { mode: 0o700 });
  writeFileSync(join(opts.outDir, "visual-first-brief.json"), `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  writeFileSync(join(opts.outDir, "status.json"), `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return status;
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}
if (require.main === module) {
  const argv = process.argv.slice(2);
  const flags = ["--facts", "--directions", "--direction-id", "--out"];
  const args = Object.fromEntries(flags.map((x) => [x, arg(argv, x)]));
  if (argv.length !== 8 || flags.some((x) => !args[x] || args[x]?.startsWith("--")) ||
      argv.some((v, i) => i % 2 === 0 && !flags.includes(v))) {
    process.stdout.write(JSON.stringify({ status: "refused", code: "USAGE", sendable: false }) + "\n");
    process.exit(2);
  }
  try {
    const status = prepareVisualFirst({
      factsPath: args["--facts"]!, directionsPath: args["--directions"]!,
      directionId: args["--direction-id"]!, outDir: args["--out"]!,
    });
    process.stdout.write(JSON.stringify(status) + "\n");
  } catch (e) {
    process.stdout.write(JSON.stringify({ status: "refused", code: e instanceof VisualFirstStop ? e.code : "INPUT_ERROR", sendable: false }) + "\n");
    process.exit(2);
  }
}
