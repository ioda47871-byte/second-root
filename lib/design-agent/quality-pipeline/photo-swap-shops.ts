/**
 * DEV-189 (Issue #193, owner GO 2026-11-06 item 3): the FIXED per-shop part of the offline photo swap
 * (scripts/design-artifact/photo-swap.ts). Pure data: no file, no browser, no photo, no network.
 *
 * The swap itself (inventory and hash pins, rights, scale and focal-box planning, pixel crops, the all-or-nothing copy,
 * the render checks) is common. What differs per shop is fixed here, in code, per pinned page CSS:
 *  - the breakpoint ranges of the page's CSS (one crop file per range) and the edge of each range the scale is checked at;
 *  - the viewports where a separate SP photo replaces the PC photo (where the page draws its boards in the SP shape);
 *  - the HTML structure of a placeholder (where the 写真｜ caption and the empty board are), which the transform
 *    matches exactly and refuses otherwise;
 *  - the CSS appended to the private copy so that the picture fills its board;
 *  - whether the shop's swap may take `ai_generated_demo` pictures (an owner approval: つぐ手, DEV-185; 輪, DEV-192;
 *    ほし窯, DEV-139 2026-11-18).
 *
 * Adding a shop here makes its research page swappable OFFLINE with rights-checked photos. It is not an approval to
 * generate pictures for it: the image auto-run takes only scripts/sales-design-worker/autorun-shops.ts's shops (and
 * root's IMAGE_AUTORUN_SHOPS). DEV-192: 輪 is in both for the owner's one-time run; DEV-139: ほし窯 was likewise
 * (2026-11-18) until its run was used — Issue #290 P0 removed it from both (autorun-shops.ts CLOSED_SHOPS).
 *
 * DEV-139: ほし窯 (bakery, a FICTIONAL bakery, research page d2-v2, the <wbr>-free version of d2-v1) is here so that its page is swappable offline with
 * rights-checked photos. From the owner's approval of 2026-11-18 (one run, Issue #139 comment 6970468763 follow-up) its
 * swap takes ai_generated_demo pictures of the approved prompt only (aiDemoPromptSha256). It was in AUTORUN_SHOPS and
 * IMAGE_AUTORUN_SHOPS for that one run only; the run is used and Issue #290 P0 removed it from both. aiDemoAllowed stays
 * so the photos already made can be swapped and packaged offline (docs/operations/hoshigama-one-time-run-sheet.md).
 */
import { BICYCLE_PROMPT_SHA256 } from "./bicycle-ai-photos";
import { HOSHIGAMA_PROMPT_DRAFT_SHA256 } from "./hoshigama-ai-photos";
import { EDGE_VIEWPORTS, type EdgeViewport, type PlanViewport } from "./photo-slots";

export type SwapRangeKey = "desktop" | "tablet" | "mobile";
/**
 * One breakpoint range of the pinned CSS: the viewport whose box the crop is cut for comes first; the others in the
 * range use the same file (object-fit: cover). The range's widest edge is among them (the board is largest there).
 */
export type SwapRange = { key: SwapRangeKey; media: string | null; viewports: readonly PlanViewport[] };

/**
 * Where the placeholder sits in the page's HTML.
 *  - "figure_photo_board" (つぐ手): a <figure> holding one <div class="photo"> board (empty, or only drawn seams) and the
 *    caption <figcaption class="ph-label"> / <span> (DEV-166, DEV-184; unchanged).
 *  - "board_before_caption" (輪): the caption <p class="ph…"> directly follows the board `<div class="board…"><div
 *    class="photo"></div></div>`, which directly follows the container's opening tag. DEV-190 (DEV-189 review L2): the
 *    container, board and caption tags are matched as ONE of the listed triples, never mixed across triples.
 */
export type SwapStructure =
  | { kind: "figure_photo_board" }
  | {
      kind: "board_before_caption";
      /**
       * the allowed (container, board, caption) opening tags, as exact triples: the container's tag directly before the
       * board, the board holding exactly one empty <div class="photo"></div>, then the caption (its text may carry <wbr>
       * between its letters)
       */
      triples: ReadonlyArray<{ container: string; board: string; caption: string }>;
    };

export type SwapShopSpec = {
  shop: string;
  /**
   * DEV-190: the page versions (fidelity/<version>) this spec's ranges and structure were read from. A page must be one of
   * these AND have its own pinned inventory (photo-slots-<version>.json); any other is refused (PAGE_NOT_IN_SPEC).
   */
  pages: readonly string[];
  /** DEV-190 (DEV-189 review L1): the full-page renders the swap draws and checks (the viewports must be measured ones) */
  renders: ReadonlyArray<{ viewport: "desktop_1440" | "tablet_1024" | "tablet_768" | "mobile_390"; width: number; height: number }>;
  ranges: readonly [SwapRange, SwapRange, SwapRange];
  /** the range edges measured for this shop, in photo-slot-edges*.json order */
  edgeViewports: readonly [EdgeViewport, EdgeViewport, EdgeViewport];
  /** where the separate SP photo is used (when given) */
  spViewports: readonly PlanViewport[];
  structure: SwapStructure;
  /** appended to the private copy's CSS only (the repository page is unchanged) */
  swapCss: string;
  /** DEV-185 owner approval: may this shop's swap take `ai_generated_demo` pictures */
  aiDemoAllowed: boolean;
  /**
   * DEV-192 (PR #234 review L5): when set, an `ai_generated_demo` picture passes only if its provenance names exactly
   * this prompt SHA-256 (the owner-approved text), else AI_DEMO_PROMPT_NOT_APPROVED. 輪: the approved core text.
   */
  aiDemoPromptSha256?: string;
  /**
   * DEV-139: when two ranges of a slot get the very same crop (same source photo, same rectangle) — ほし窯's boards keep
   * one shape across ranges, so its crops coincide — the later range uses the earlier range's file instead of a second,
   * byte-identical file (the demo version package refuses duplicate photos: sales_demo_images.sha256 is unique). Off
   * (absent) for つぐ手 and 輪, whose output is unchanged.
   */
  shareIdenticalCrops?: true;
};

/** つぐ手's CSS addition, byte for byte as DEV-166 wrote it. */
export const TSUGUTE_SWAP_CSS = `
/* DEV-166: private photo swap (this copy only; the repository page is unchanged) */
.photo > picture { position: absolute; inset: 0; display: block; }
.photo > picture > img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: 50% 50%; }
`;

/**
 * 輪's CSS addition. Its .photo is not positioned (it is width/height 100% of the tilted .board). Today the .board's
 * filter/transform already contains the absolute picture, but the copy makes .photo the containing block explicitly so
 * it does not depend on that; nothing else of the board (tilt, drop shadow, aspect ratio) changes.
 */
export const BICYCLE_SWAP_CSS = `
/* DEV-189: private photo swap (this copy only; the repository page is unchanged) */
.photo { position: relative; overflow: hidden; }
.photo > picture { position: absolute; inset: 0; display: block; }
.photo > picture > img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: 50% 50%; }
`;

/**
 * ほし窯's CSS addition (DEV-139). Like 輪's: the .photo (width/height 100% of the .board, not positioned) becomes the
 * picture's containing block; the .board keeps its overflow clip, so the oven mouth's arch (its border-radius) still
 * cuts the picture. Nothing else of the board changes.
 */
export const HOSHIGAMA_SWAP_CSS = `
/* DEV-139: private photo swap (this copy only; the repository page is unchanged) */
.photo { position: relative; overflow: hidden; }
.photo > picture { position: absolute; inset: 0; display: block; }
.photo > picture > img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: 50% 50%; }
`;

/** Freezes a spec and everything in it (arrays, triples, ranges), so nothing can change a shop's approval at run time. */
function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

/**
 * DEV-139 (PR #288 review M1): frozen. A shop's AI demo approval (aiDemoAllowed, aiDemoPromptSha256) is what is written
 * here and nothing else: no module can set it at run time. Tests that show the path after an approval hand an explicit
 * spec to the in-process seams (photo-swap.ts SwapOptions.spec, swap-rights / swap-package aiDemoSpecFor,
 * package-local.ts main's seams); the CLIs never take one.
 */
export const SWAP_SHOP_SPECS = deepFreeze({
  tsugute: {
    shop: "tsugute",
    pages: ["d1-v3", "d1-v10"],
    renders: [
      { viewport: "desktop_1440", width: 1440, height: 900 },
      { viewport: "mobile_390", width: 390, height: 844 },
    ],
    // the pinned つぐ手 CSS: desktop ≥1200, tablet 601–1199, mobile ≤600
    ranges: [
      { key: "desktop", media: null, viewports: ["desktop_1440", "desktop_1920"] },
      { key: "tablet", media: "(max-width: 1199px)", viewports: ["tablet_1024", "tablet_768", "tablet_1199"] },
      { key: "mobile", media: "(max-width: 600px)", viewports: ["mobile_390", "mobile_600"] },
    ],
    edgeViewports: EDGE_VIEWPORTS,
    // every board of the pinned つぐ手 CSS takes its SP shape at ≤1199px (e.g. ph-dry is 340/500 above it and 4/3 at and
    // below it), so the SP photo serves the tablet and mobile ranges, edges included
    spViewports: ["tablet_1024", "tablet_768", "tablet_1199", "mobile_390", "mobile_600"],
    structure: { kind: "figure_photo_board" },
    swapCss: TSUGUTE_SWAP_CSS,
    aiDemoAllowed: true,
  },
  bicycle: {
    shop: "bicycle",
    // d1-v7 (DEV-189) and the integrated d1-v9 (DEV-190: B1 hub-disc + B2 cta-hero + B3 check-horizontal): the same
    // breakpoints and the same placeholder markup; each has its own pinned inventory
    pages: ["d1-v7", "d1-v9"],
    renders: [
      { viewport: "desktop_1440", width: 1440, height: 900 },
      { viewport: "tablet_768", width: 768, height: 1024 },
      { viewport: "mobile_390", width: 390, height: 844 },
    ],
    // the pinned 輪 d1-v7 / d1-v9 CSS: desktop ≥1000 (so the measured 1024 is a desktop width here), tablet 601–999, mobile ≤600.
    // Inside each range the boards are sized in vw (desktop, tablet) or by the column (mobile): they grow with the window.
    ranges: [
      { key: "desktop", media: null, viewports: ["desktop_1440", "tablet_1024", "desktop_1920"] },
      { key: "tablet", media: "(max-width: 999px)", viewports: ["tablet_768", "tablet_999"] },
      { key: "mobile", media: "(max-width: 600px)", viewports: ["mobile_390", "mobile_600"] },
    ],
    edgeViewports: ["mobile_600", "tablet_999", "desktop_1920"],
    // 輪's boards keep a landscape shape near 4:3 at ≥601px (260/200 … 300/220) and change shape only at ≤600 (the
    // stations 350/210 and 310/210, the bench a tall 240/440): the SP photo serves the mobile range only
    spViewports: ["mobile_390", "mobile_600"],
    structure: {
      kind: "board_before_caption",
      triples: [
        // the four repair stations
        { container: '<div class="fig">', board: '<div class="board">', caption: '<p class="ph">' },
        // the workbench
        { container: '<figure class="bench">', board: '<div class="board board-bench">', caption: '<p class="ph ph-bench">' },
      ],
    },
    swapCss: BICYCLE_SWAP_CSS,
    // DEV-192 (owner GO 2026-11-07, comment 6689664215): the swap takes 輪's ai_generated_demo pictures for the one
    // approved run (rights unchanged: demo only, never a public site, full provenance; the intake checks the prompt pins)
    aiDemoAllowed: true,
    aiDemoPromptSha256: BICYCLE_PROMPT_SHA256,
  },
  // DEV-139: ほし窯 (fictional bakery) d2-v2 — AI demo photos of the approved prompt, for the owner's one run (2026-11-18).
  // Issue #290 P1: d2-v3, the next design candidate (d2-v2 stays as it is), takes the SAME photos already taken: the same
  // two boards and placeholder triples, the same ranges (its extra media queries inside the PC range move text only),
  // its boards within the 2× of the intake's photos at every measured width and range edge (photo-slots-d2-v3.json).
  bakery: {
    shop: "bakery",
    pages: ["d2-v2", "d2-v3"],
    renders: [
      { viewport: "desktop_1440", width: 1440, height: 900 },
      { viewport: "mobile_390", width: 390, height: 844 },
    ],
    // the pinned d2-v2 CSS (d2-v1's plus line-box rules) has two ranges: SP ≤600 (laid out first) and PC ≥601 (`@media (min-width: 601px)`, every
    // board sized in vw, its shape unchanged from 601 to 1920). d2-v3 likewise (its 601–767 and 601–1023 rules re-place text, never a board). The PC range is cut into two crop files at 1199 (the
    // measured edge, EDGE_VIEWPORTS) only so that the copy keeps the swap's three files per slot (desktop / tablet /
    // mobile, which the demo version package expects); both PC files are cut to the same board shape.
    ranges: [
      { key: "desktop", media: null, viewports: ["desktop_1440", "desktop_1920"] },
      { key: "tablet", media: "(max-width: 1199px)", viewports: ["tablet_1024", "tablet_768", "tablet_1199"] },
      { key: "mobile", media: "(max-width: 600px)", viewports: ["mobile_390", "mobile_600"] },
    ],
    edgeViewports: EDGE_VIEWPORTS,
    // the oven mouth's board is nearly square at ≥601 (460/510) and tall at ≤600 (190/315); the loaf keeps 1.2 in both
    // (d2-v3: the same oven-mouth shapes, the SP one 1.19× larger; the loaf 4:3 in both, the photo's own shape).
    // The SP photo (when given) serves the SP range only
    spViewports: ["mobile_390", "mobile_600"],
    structure: {
      kind: "board_before_caption",
      // the page's markup, exactly: the container on its own line, the board on the next, the caption on the line after
      // (the line break and indent before the caption belong to the caption's triple entry, and go with the caption)
      triples: [
        { container: '<div class="fig fig-mouth">\n    ', board: '<div class="board board-mouth">', caption: '\n    <p class="ph ph-mouth">' },
        { container: '<div class="fig fig-loaf">\n    ', board: '<div class="board board-loaf">', caption: '\n    <p class="ph ph-loaf">' },
      ],
    },
    swapCss: HOSHIGAMA_SWAP_CSS,
    // the loaf is 1.2 at every width and the oven mouth 0.9 at every PC width: identical crops share one file
    shareIdenticalCrops: true,
    // DEV-139 (owner approval 2026-11-18, one run): the swap takes ほし窯's ai_generated_demo pictures of the approved
    // prompt text only (rights unchanged: demo only, never a public site, full provenance; the intake checks the pins)
    aiDemoAllowed: true,
    aiDemoPromptSha256: HOSHIGAMA_PROMPT_DRAFT_SHA256,
  },
} as const satisfies Record<string, SwapShopSpec>);

export type SwapShopId = keyof typeof SWAP_SHOP_SPECS;
export const SWAP_SHOP_IDS = Object.keys(SWAP_SHOP_SPECS) as [SwapShopId, ...SwapShopId[]];
export const swapShopSpec = (shop: SwapShopId): SwapShopSpec => SWAP_SHOP_SPECS[shop];
/** The edge set a shop's edges file is measured at (EDGE_VIEWPORTS for a shop without a swap spec). */
export const edgeViewportsFor = (shop: string): readonly EdgeViewport[] => (Object.prototype.hasOwnProperty.call(SWAP_SHOP_SPECS, shop) ? SWAP_SHOP_SPECS[shop as SwapShopId].edgeViewports : EDGE_VIEWPORTS);
