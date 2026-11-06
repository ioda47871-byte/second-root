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
 *  - whether the shop's swap may take `ai_generated_demo` pictures (an owner approval: つぐ手, DEV-185; 輪, DEV-192).
 *
 * Adding a shop here makes its research page swappable OFFLINE with rights-checked photos. It is not an approval to
 * generate pictures for it: the image auto-run takes only scripts/sales-design-worker/autorun-shops.ts's shops (and
 * root's IMAGE_AUTORUN_SHOPS). DEV-192: 輪 is in both for the owner's one-time run (つぐ手 and 輪 only).
 */
import { BICYCLE_PROMPT_SHA256 } from "./bicycle-ai-photos";
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

export const SWAP_SHOP_SPECS = {
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
} as const satisfies Record<string, SwapShopSpec>;

export type SwapShopId = keyof typeof SWAP_SHOP_SPECS;
export const SWAP_SHOP_IDS = Object.keys(SWAP_SHOP_SPECS) as [SwapShopId, ...SwapShopId[]];
export const swapShopSpec = (shop: SwapShopId): SwapShopSpec => SWAP_SHOP_SPECS[shop];
/** The edge set a shop's edges file is measured at (EDGE_VIEWPORTS for a shop without a swap spec). */
export const edgeViewportsFor = (shop: string): readonly EdgeViewport[] => (Object.prototype.hasOwnProperty.call(SWAP_SHOP_SPECS, shop) ? SWAP_SHOP_SPECS[shop as SwapShopId].edgeViewports : EDGE_VIEWPORTS);
