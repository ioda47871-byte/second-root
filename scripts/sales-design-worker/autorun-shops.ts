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
 * DEV-191: 輪 has every part but the approvals (a run approval id, the swap's aiDemoAllowed, root's allowlist): it is an
 * OFF candidate in AUTORUN_CANDIDATES, never in AUTORUN_SHOPS.
 */
import { importBicycleAiPhotos } from "../design-artifact/bicycle-ai-intake";
import { importTsuguteAiPhotos, MAX_UPSCALE, type IntakeResult } from "../design-artifact/tsugute-ai-intake";
import { BICYCLE_PHOTOS, BICYCLE_PHOTOS_MAX_IMAGES, BICYCLE_PROMPT_APPROVAL, BICYCLE_PROMPT_BYTES, BICYCLE_PROMPT_FILE, BICYCLE_PROMPT_SHA256, BICYCLE_RUN_APPROVAL_ID, BICYCLE_RUN_PROMPT_CANDIDATE_CHARS, BICYCLE_RUN_PROMPT_CANDIDATE_SHA256 } from "../../lib/design-agent/quality-pipeline/bicycle-ai-photos";
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
 * DEV-191 (owner approval 2026-11-06, Issue #193 comment 6687410438): shops PREPARED for a future one-time run but OFF.
 * Not an AutorunShop and not in AUTORUN_SHOPS / AUTORUN_SHOP_IDS, so the job schema (z.enum of AUTORUN_SHOP_IDS) refuses
 * a job naming one (REFUSED_JOB_INVALID) before any switch, grant, approval or generation step; root's cycle.sh
 * IMAGE_AUTORUN_SHOPS does not list it either (IMAGE_GRANT_SCOPE_MISMATCH, no grant). `runnable: false` is a literal
 * type: making one runnable is a code change (move it into AUTORUN_SHOPS, add a bundle writer to image-autorun.ts, set a
 * run approval id, turn the swap's aiDemoAllowed on) plus root's allowlist — never a job or config value.
 */
export type AutorunCandidate = {
  shop_id: string;
  runnable: false;
  /** the generation approval id: null until an owner GO names one */
  runApprovalId: string | null;
  page: string;
  pageDir: string;
  slotInventory: string;
  slotEdges: string;
  /** the swap slots of the page (the bench has a PC and an SP photo) */
  slotIds: readonly string[];
  /** the photos of the one run, in call order (one image call each) */
  photoIds: readonly string[];
  maxImages: number;
  prompt: {
    /** the owner-approved text and its pins */
    file: string;
    sha256: string;
    bytes: number;
    approval: typeof BICYCLE_PROMPT_APPROVAL;
    source: string;
    brief: string;
    /** the run prompt wrapping it: a CANDIDATE, not approved */
    runCandidateSha256: string;
    runCandidateChars: number;
  };
  bundle: "bicycle_ai_photos_v0";
  intake: typeof importBicycleAiPhotos;
  rights: AutorunShop["rights"];
  /** what a future owner GO must change, in order (all of it; one alone does nothing) */
  enableRequires: readonly string[];
};

const BICYCLE_DIR = "design-library/research/quality-pipeline/poc/bicycle";

export const AUTORUN_CANDIDATES = {
  bicycle: {
    shop_id: "bicycle",
    runnable: false,
    runApprovalId: BICYCLE_RUN_APPROVAL_ID,
    page: "d1-v9",
    pageDir: `${BICYCLE_DIR}/fidelity/d1-v9`,
    slotInventory: `${BICYCLE_DIR}/photo-slots-d1-v9.json`,
    slotEdges: `${BICYCLE_DIR}/photo-slot-edges-d1-v9.json`,
    slotIds: ["ph-d", "ph-a", "ph-c", "ph-b", "ph-bench"],
    photoIds: BICYCLE_PHOTOS.map((p) => p.photo_id),
    maxImages: BICYCLE_PHOTOS_MAX_IMAGES,
    prompt: {
      file: BICYCLE_PROMPT_FILE,
      sha256: BICYCLE_PROMPT_SHA256,
      bytes: BICYCLE_PROMPT_BYTES,
      approval: BICYCLE_PROMPT_APPROVAL,
      source: "lib/design-agent/quality-pipeline/bicycle-ai-photos.ts",
      brief: "docs/design/bicycle-ai-photo-brief.md",
      runCandidateSha256: BICYCLE_RUN_PROMPT_CANDIDATE_SHA256,
      runCandidateChars: BICYCLE_RUN_PROMPT_CANDIDATE_CHARS,
    },
    bundle: "bicycle_ai_photos_v0",
    intake: importBicycleAiPhotos,
    rights: { sourceKind: "ai_generated_demo", demoOnly: true, publicWeb: false, maxUpscale: MAX_UPSCALE, upscaleMethod: "sharp-lanczos3" },
    enableRequires: [
      "owner GO for ONE real run: approval id, the run prompt candidate's SHA-256, 6 images, 1 Codex run, expiry",
      "code: BICYCLE_RUN_APPROVAL_ID set; 輪 moved into AUTORUN_SHOPS with the bicycle bundle writer in image-autorun.ts; photo-swap-shops.ts 輪 aiDemoAllowed true",
      "root (owner, on WSL): cycle.sh IMAGE_AUTORUN_SHOPS gains bicycle:6 in root's clone; /etc/sr-design-worker/image-autorun.json enabled with one entry for that job",
    ],
  },
} as const satisfies Record<string, AutorunCandidate>;

/**
 * Fictional shops that are known but NOT implemented (never accepted; a job naming one is REFUSED_JOB_INVALID like any
 * other unknown shop). Recorded so nobody reads their research pages as ready for generated photos.
 */
export const UNIMPLEMENTED_SHOPS: Readonly<Record<string, string>> = {
  // DEV-189: 輪's research page d1-v7 got a slot inventory + edges and an OFFLINE swap (mock photos only). DEV-191: the
  // prompt text is owner-approved and pinned, the run bundle writer and intake exist (AUTORUN_CANDIDATES, OFF), but a
  // real run is not approved. Still not an auto-run shop.
  bicycle:
    "輪: prepared OFF candidate (DEV-191, AUTORUN_CANDIDATES.bicycle, d1-v9): the prompt text is owner-approved (2026-11-06, SHA 83c9b2c6…) and pinned, the run bundle writer and intake exist, but a real generation run is 未承認 (no run approval id), the swap refuses its ai_generated_demo pictures (not in AI_DEMO_SHOPS), and neither this manifest nor root's IMAGE_AUTORUN_SHOPS lists it",
  sento:
    "ゆげ湯: no photo-slot-edges, no owner-approved photo brief or pinned prompt, and the photo swap takes つぐ手 only",
};
