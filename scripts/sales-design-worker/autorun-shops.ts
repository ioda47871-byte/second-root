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
 * rights records, and a photo swap that takes the shop (photo-swap.ts SWAP_SHOPS and AI_DEMO_SHOPS). Only つぐ手 today.
 */
import { importTsuguteAiPhotos, MAX_UPSCALE, type IntakeResult } from "../design-artifact/tsugute-ai-intake";
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
  /** the page's exact slot set, in the prompt's call order (all or nothing: the swap needs every slot) */
  slotIds: readonly string[];
  /** = slotIds.length; the image calls of the one run (cycle.sh's allowlist carries the same number) */
  maxImages: number;
  /** the whole prompt of the run: built in code from the owner-approved brief, pinned by SHA-256 and length */
  prompt: { source: string; brief: string; sha256: string; chars: number; build: () => string };
  /** which run-bundle writer image-autorun.ts uses (by the bundle's schema name) */
  bundle: "tsugute_ai_photos_v0";
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
} as const satisfies Record<string, AutorunShop>;

export type AutorunShopId = keyof typeof AUTORUN_SHOPS;
export const AUTORUN_SHOP_IDS = Object.keys(AUTORUN_SHOPS) as [AutorunShopId, ...AutorunShopId[]];

/**
 * Fictional shops that are known but NOT implemented (never accepted; a job naming one is REFUSED_JOB_INVALID like any
 * other unknown shop). Recorded so nobody reads their research pages as ready for generated photos.
 */
export const UNIMPLEMENTED_SHOPS: Readonly<Record<string, string>> = {
  // DEV-189: 輪's research page d1-v7 now has a slot inventory + edges and an OFFLINE swap (mock photos only, no AI demo
  // pictures); the brief is a draft. Still not an auto-run shop.
  bicycle:
    "輪: research-only offline swap of d1-v7 (DEV-189, photo-slots-d1-v7.json + edges, mock photos); no owner-approved photo brief or pinned prompt (docs/design/bicycle-ai-photo-brief.md is a 未承認 draft), the swap refuses its ai_generated_demo pictures (not in AI_DEMO_SHOPS), and no run bundle or intake",
  sento:
    "ゆげ湯: no photo-slot-edges, no owner-approved photo brief or pinned prompt, and the photo swap takes つぐ手 only",
};
