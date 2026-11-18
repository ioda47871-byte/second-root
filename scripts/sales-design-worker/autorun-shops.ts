/**
 * DEV-188: the FIXED per-shop manifest of the worker's approved demo image job (image-autorun.ts). Code-defined, in the
 * worker's own checkout: a job file only SELECTS a shop_id, its page and slot ids from here — it can never carry a
 * prompt, a URL, a shell command or a file path. Adding a shop is a code change (review, tests, an owner approval),
 * never a job or config value.
 *
 * Root's cycle.sh keeps the same allowlist (IMAGE_AUTORUN_SHOPS, shop:max_images) and refuses any other shop before it
 * issues a grant; tests/unit/design-agent/autorun-shops.test.ts pins the two to each other.
 *
 * An entry is implemented only when every part exists for that shop: an owner-approved pinned prompt (SHA-256 and
 * length), a measured slot inventory + edges for the page, the run-bundle writer, the intake into ai_generated_demo
 * rights records, and a photo swap that takes the shop (photo-swap.ts SWAP_SHOPS and AI_DEMO_SHOPS). つぐ手 (DEV-186) and,
 * from DEV-192 (owner GO 2026-11-07, Issue #193 comment 6689664215), 輪 for ONE approved run: the entry itself is not a
 * permission — each run still needs the owner's root config entry for one job, root's atomic use record, the boot-bound
 * 20-minute grant and the worker's one-use ledger, and the auto-run (timer) stays OFF. DEV-139 (owner approval
 * 2026-11-18, Issue #139 comment 6970468763 follow-up): ほし窯 for ONE approved run on the same terms (3 photos).
 */
import { importBicycleAiPhotos } from "../design-artifact/bicycle-ai-intake";
import { importHoshigamaAiPhotos } from "../design-artifact/hoshigama-ai-intake";
import { importTsuguteAiPhotos, MAX_UPSCALE, type IntakeResult } from "../design-artifact/tsugute-ai-intake";
import { BICYCLE_PHOTOS, BICYCLE_PHOTOS_MAX_IMAGES, BICYCLE_RUN_PROMPT_APPROVAL, BICYCLE_RUN_PROMPT_CANDIDATE_CHARS, BICYCLE_RUN_PROMPT_CANDIDATE_SHA256, buildBicycleRunPrompt } from "../../lib/design-agent/quality-pipeline/bicycle-ai-photos";
import { buildHoshigamaRunPrompt, HOSHIGAMA_APPROVAL, HOSHIGAMA_MAX_UPSCALE, HOSHIGAMA_PHOTOS, HOSHIGAMA_PHOTOS_MAX_IMAGES, type HoshigamaApproval } from "../../lib/design-agent/quality-pipeline/hoshigama-ai-photos";
import { buildTsugutePhotosPrompt, TSUGUTE_PHOTOS_MAX_IMAGES, TSUGUTE_PROMPT_CHARS, TSUGUTE_PROMPT_SHA256, TSUGUTE_SLOTS } from "../../lib/design-agent/quality-pipeline/tsugute-ai-photos";

export type AutorunIntake = (o: { from: string; manifestOut: string; pipelineRoot: string; approvalIds: readonly string[] }) => Promise<IntakeResult>;

export type AutorunShop = {
  shop_id: string;
  /** the approved page version the swap writes into (a job names exactly this) */
  page: string;
  pageDir: string;
  /**
   * the measured slot inventory and its breakpoint edges for that page (photo-slots.ts). Documented values pinned by
   * tests/unit/design-agent/autorun-shops.test.ts; the swap finds its inventory itself and does not read these.
   */
  slotInventory: string;
  slotEdges: string;
  /**
   * the page's exact slot set, in the prompt's call order (all or nothing: the swap needs every slot). DEV-192: for a
   * shop with a slot that takes two pictures (輪's bench: PC and SP), these are the run's PHOTO ids, one image call each,
   * and photoToSlot maps each to its swap slot.
   */
  slotIds: readonly string[];
  /** DEV-192: photo id → swap slot of the page's inventory, when a slot takes more than one picture */
  photoToSlot?: Readonly<Record<string, string>>;
  /** DEV-192: the owner's approval record of the run prompt, when it is separate from the source */
  promptApproval?: typeof BICYCLE_RUN_PROMPT_APPROVAL | HoshigamaApproval;
  /** = slotIds.length; the image calls of the one run (cycle.sh's allowlist carries the same number) */
  maxImages: number;
  /** the whole prompt of the run: built in code from the owner-approved brief, pinned by SHA-256 and length */
  prompt: { source: string; brief: string; sha256: string; chars: number; build: () => string };
  /** which run-bundle writer image-autorun.ts uses (by the bundle's schema name) */
  bundle: "tsugute_ai_photos_v0" | "bicycle_ai_photos_v0" | "hoshigama_ai_photos_v0";
  intake: AutorunIntake;
  /** under the worker's results root: <outRoot>/<subdir>/<job_id>/ (photos, pipeline, swap, renders) */
  out: { subdir: "image-autorun" };
  /**
   * the rights and size rules of the shop's intake, as documented values: a test pins them to the intake's constants
   * (MAX_UPSCALE etc.). Neither the intake nor the swap reads this field at run time — it is not enforced here.
   */
  rights: { sourceKind: "ai_generated_demo"; demoOnly: true; publicWeb: false; maxUpscale: number; upscaleMethod: "sharp-lanczos3" };
};

const TSUGUTE_DIR = "design-library/research/quality-pipeline/poc/tsugute";
const BICYCLE_DIR = "design-library/research/quality-pipeline/poc/bicycle";
const BAKERY_DIR = "design-library/research/quality-pipeline/poc/bakery";

/** DEV-139: the owner's one-run approval of ほし窯 (2026-11-18). Refuses to load the manifest without it (fail closed). */
function hoshigamaApproval(): HoshigamaApproval {
  if (!HOSHIGAMA_APPROVAL) throw new Error("HOSHIGAMA_APPROVAL_MISSING");
  return HOSHIGAMA_APPROVAL;
}
const HOSHIGAMA_RUN_APPROVAL = hoshigamaApproval();

export const AUTORUN_SHOPS = {
  tsugute: {
    shop_id: "tsugute",
    page: "d1-v10",
    pageDir: `${TSUGUTE_DIR}/fidelity/d1-v10`,
    slotInventory: `${TSUGUTE_DIR}/photo-slots-d1-v10.json`,
    slotEdges: `${TSUGUTE_DIR}/photo-slot-edges-d1-v10.json`,
    slotIds: TSUGUTE_SLOTS.map((s) => s.slot_id),
    maxImages: TSUGUTE_PHOTOS_MAX_IMAGES,
    prompt: {
      source: "lib/design-agent/quality-pipeline/tsugute-ai-photos.ts",
      brief: "docs/design/tsugute-ai-photo-brief.md",
      sha256: TSUGUTE_PROMPT_SHA256,
      chars: TSUGUTE_PROMPT_CHARS,
      build: buildTsugutePhotosPrompt,
    },
    bundle: "tsugute_ai_photos_v0",
    intake: importTsuguteAiPhotos,
    out: { subdir: "image-autorun" },
    rights: { sourceKind: "ai_generated_demo", demoOnly: true, publicWeb: false, maxUpscale: MAX_UPSCALE, upscaleMethod: "sharp-lanczos3" },
  },
  // DEV-192 (owner GO 2026-11-07, comment 6689664215): ONE run of 輪 d1-v9's 6 photos, the approved run prompt pinned
  bicycle: {
    shop_id: "bicycle",
    page: "d1-v9",
    pageDir: `${BICYCLE_DIR}/fidelity/d1-v9`,
    slotInventory: `${BICYCLE_DIR}/photo-slots-d1-v9.json`,
    slotEdges: `${BICYCLE_DIR}/photo-slot-edges-d1-v9.json`,
    slotIds: BICYCLE_PHOTOS.map((p) => p.photo_id),
    photoToSlot: Object.fromEntries(BICYCLE_PHOTOS.map((p) => [p.photo_id, p.slot_id])),
    maxImages: BICYCLE_PHOTOS_MAX_IMAGES,
    prompt: {
      source: "lib/design-agent/quality-pipeline/bicycle-ai-photos.ts",
      brief: "docs/design/bicycle-ai-photo-brief.md",
      sha256: BICYCLE_RUN_PROMPT_CANDIDATE_SHA256,
      chars: BICYCLE_RUN_PROMPT_CANDIDATE_CHARS,
      build: () => buildBicycleRunPrompt(),
    },
    promptApproval: BICYCLE_RUN_PROMPT_APPROVAL,
    bundle: "bicycle_ai_photos_v0",
    intake: importBicycleAiPhotos,
    out: { subdir: "image-autorun" },
    rights: { sourceKind: "ai_generated_demo", demoOnly: true, publicWeb: false, maxUpscale: MAX_UPSCALE, upscaleMethod: "sharp-lanczos3" },
  },
  // DEV-139 (owner approval 2026-11-18, Issue #139 comment 6970468763 follow-up): ONE run of ほし窯 d2-v2's 3 photos, the
  // approved run prompt pinned. Removed again by the follow-up PR after the run (the run sheet's (g)).
  bakery: {
    shop_id: "bakery",
    page: "d2-v2",
    pageDir: `${BAKERY_DIR}/fidelity/d2-v2`,
    slotInventory: `${BAKERY_DIR}/photo-slots-d2-v2.json`,
    slotEdges: `${BAKERY_DIR}/photo-slot-edges-d2-v2.json`,
    slotIds: HOSHIGAMA_PHOTOS.map((p) => p.photo_id),
    photoToSlot: Object.fromEntries(HOSHIGAMA_PHOTOS.map((p) => [p.photo_id, p.slot_id])),
    maxImages: HOSHIGAMA_PHOTOS_MAX_IMAGES,
    prompt: {
      source: "lib/design-agent/quality-pipeline/hoshigama-ai-photos.ts",
      brief: "docs/design/hoshigama-ai-photo-brief.md",
      sha256: HOSHIGAMA_RUN_APPROVAL.run_prompt_sha256,
      chars: HOSHIGAMA_RUN_APPROVAL.run_prompt_chars,
      build: () => buildHoshigamaRunPrompt(),
    },
    promptApproval: HOSHIGAMA_RUN_APPROVAL,
    bundle: "hoshigama_ai_photos_v0",
    intake: importHoshigamaAiPhotos,
    out: { subdir: "image-autorun" },
    rights: { sourceKind: "ai_generated_demo", demoOnly: true, publicWeb: false, maxUpscale: HOSHIGAMA_MAX_UPSCALE, upscaleMethod: "sharp-lanczos3" },
  },
} as const satisfies Record<string, AutorunShop>;

export type AutorunShopId = keyof typeof AUTORUN_SHOPS;
export const AUTORUN_SHOP_IDS = Object.keys(AUTORUN_SHOPS) as [AutorunShopId, ...AutorunShopId[]];

/**
 * Fictional shops that are known but NOT implemented (never accepted; a job naming one is REFUSED_JOB_INVALID like any
 * other unknown shop). Recorded so nobody reads their research pages as ready for generated photos.
 */
export const UNIMPLEMENTED_SHOPS: Readonly<Record<string, string>> = {
  // DEV-192: 輪 left this list for AUTORUN_SHOPS (owner GO 2026-11-07, one approved run)
  sento:
    "ゆげ湯: no photo-slot-edges, no owner-approved photo brief or pinned prompt, and the photo swap takes つぐ手 only",
};
