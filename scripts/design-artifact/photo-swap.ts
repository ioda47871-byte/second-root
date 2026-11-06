/**
 * DEV-166 (Issue #193 comment 6623100651; owner, 2026-11-04 item 3) — OFFLINE research tool. つぐ手 (tsugute) and, from
 * DEV-189 (owner GO 2026-11-06 item 3), 輪 (bicycle, a research-only swap: no AI demo pictures).
 *
 *   npx tsx scripts/design-artifact/photo-swap.ts --page <C page dir> --manifest <intake manifest> --out <new dir>
 *
 * Makes a PRIVATE copy of an inventoried C page in which each of its placeholder boards (つぐ手 6, 輪 d1-v7/d1-v9 5) shows a
 * rights-cleared photo, then draws it at the shop's render widths (PC 1440 and SP 390; 輪 also tablet 768) (JavaScript off, every request outside the copy refused).
 * The repository page is not changed. Nothing is written inside the repository.
 *
 * DEV-189: this file is the COMMON part. What is fixed per shop (the CSS breakpoint ranges and their edges, where the
 * SP photo is used, the placeholder's HTML structure, the CSS added to the copy, whether AI demo pictures are taken)
 * lives in lib/design-agent/quality-pipeline/photo-swap-shops.ts. The ranges named below are つぐ手's.
 *
 * Refuses (exit 2, --out not created) unless:
 *  - the page is one a slot inventory was measured on (HTML, CSS and copy hashes). A shop keeps one inventory per
 *    measured page: photo-slots.json (+ photo-slot-edges.json) and, from DEV-184, photo-slots-<page>.json (+
 *    photo-slot-edges-<page>.json) beside it (つぐ手: d1-v3 and d1-v10);
 *  - --out is a new directory outside the repository whose parent exists;
 *  - the manifest is outside the repository or under the private .intake/;
 *  - every slot of the inventory (つぐ手 6) has a photo, and each photo opens from .intake/photos/ (no link) and passes
 *    checkPhotoRights (quality_verification) against its measured bytes;
 *  - each slot passes planSlot: 2× (1.5–2× only with an owner exception record) at the 4 measured viewports AND at the
 *    widest edge of each breakpoint range (mobile ≤600 at 600, tablet 601–1199 at 1199, desktop at 1920 — wider desktop
 *    screens are not guaranteed; photo-slot-edges.json), the subject kept, and a separate SP photo where the PC
 *    photo's SP-shaped crops (≤1199px on this page) lose the subject.
 *
 * All or nothing: every crop is decoded and cut and the HTML transformed in memory first; the copy is then built in a
 * new temporary sibling of --out (same parent, outside the repository), drawn and checked (every image loaded, every
 * board an <img alt>, no 写真｜ left; DEV-189: no horizontal overflow, and each board keeps its measured size with the
 * photo filling it), and only then renamed to --out. Any failure removes the temporary directory and
 * leaves --out absent.
 *
 * Crop: real pixel crops with sharp (already in node_modules through next; no dependency is added). Each photo is
 * auto-oriented (EXIF), cut to the planned rectangle, and written without its metadata (no EXIF, no GPS) as one file
 * per breakpoint of the pinned CSS: desktop (≥1200), tablet (601–1199), mobile (≤600). A <picture> chooses the file;
 * the <img> keeps object-fit: cover for sub-pixel differences. Why pixels and not object-position on the original:
 * the reviewed file is exactly what is shown, the original's metadata never leaves .intake, and PC and SP can come
 * from different photos.
 *
 * Output (all outside the repository):
 *   <out>/page/                the copy the browser may read (index.html, style.css, copy.json, photos/)
 *   <out>/renders/             desktop_1440.png, mobile_390.png (full page)
 *   <out>/swap-summary.json    what may be made public: hashes, sizes, crops, scale basis (no owner, no path)
 *   <out>/rights.private.json  the rights records, private paths and exception reasons (never in the repository)
 *
 * Never calls a model, a generator or the network.
 */
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve, sep } from "node:path";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import { z } from "zod";
import { checkPhotoRights, loadForbiddenSha256, resolvePrivatePhoto, toPublicPhotoRecord, type PhotoBytesInfo, type PhotoRights } from "../../lib/design-agent/quality-pipeline/photo-rights";
import { edgesFor, EDGE_VIEWPORTS, FocalBox, planSlot, PhotoSlotEdges, PhotoSlotInventory, type EdgeVariant, type PhotoSlot, type PlanViewport, type SlotPlan } from "../../lib/design-agent/quality-pipeline/photo-slots";
import { SWAP_SHOP_IDS, SWAP_SHOP_SPECS, swapShopSpec, TSUGUTE_SWAP_CSS, type SwapRangeKey, type SwapShopSpec } from "../../lib/design-agent/quality-pipeline/photo-swap-shops";

const REPO = resolve(__dirname, "../..");
export const PIPELINE_ROOT = join(REPO, "design-library/research/quality-pipeline");
/**
 * The shops the swap takes: つぐ手 (DEV-166) and 輪 (DEV-189, research only), each with its fixed spec
 * (photo-swap-shops.ts). Not the image auto-run's list: that is autorun-shops.ts (つぐ手 only).
 */
export const SWAP_SHOPS = SWAP_SHOP_IDS;
/**
 * DEV-185 (owner approval): the fictional shops whose swap may take `ai_generated_demo` pictures (with their full
 * provenance; every other rights check unchanged): つぐ手 (DEV-185) and, from DEV-192 (owner GO 2026-11-07), 輪.
 */
export const AI_DEMO_SHOPS: ReadonlySet<string> = new Set(SWAP_SHOP_IDS.filter((id) => SWAP_SHOP_SPECS[id].aiDemoAllowed));
export const CAPTION_PREFIX = "写真｜";

/**
 * The breakpoints of the pinned つぐ手 CSS (style.css, hash in photo-slots.json): one crop per range. The viewport
 * whose box the crop is cut for comes first; the others in the range use the same file (object-fit: cover). The last
 * of each is the range's widest edge (the board is largest there; a board's shape does not change inside a range).
 * DEV-189: kept as つぐ手's spec; each shop's own ranges are in photo-swap-shops.ts.
 */
export const RANGES = SWAP_SHOP_SPECS.tsugute.ranges;

/**
 * Where a separate SP photo is used: every board of the pinned つぐ手 CSS takes its SP shape at ≤1199px (e.g. ph-dry
 * is 340/500 above it and 4/3 at and below it), so the SP photo serves the tablet and mobile ranges, edges included.
 */
export const TSUGUTE_SP_VIEWPORTS: readonly PlanViewport[] = SWAP_SHOP_SPECS.tsugute.spViewports;


const PhotoRef = z.strictObject({ rights: z.unknown(), focal_box: FocalBox });
export const SwapManifest = z.strictObject({
  schema: z.literal("photo_swap_manifest_v0"),
  shop: z.enum(SWAP_SHOPS),
  slots: z
    .array(
      z.strictObject({
        slot_id: z.string().regex(/^ph-[a-z0-9-]{1,40}$/),
        /** the alt text; defaults to the slot's role (the caption without 写真｜) */
        alt: z
          .string()
          .trim()
          .min(1)
          .max(120)
          .refine((a) => !a.includes(CAPTION_PREFIX), "alt must not carry the placeholder prefix")
          .optional(),
        pc: PhotoRef,
        /** a separate photo for SP (≤600), when the PC photo's SP crop loses the subject */
        sp: PhotoRef.optional(),
        /**
         * { scale, reason, decided_by: "owner" }: lets this slot go down to that scale (≥1.5). One record per slot: it
         * applies to the PC and the SP photo and to every viewport. decided_by is a statement, not a proof: the tool
         * cannot tell who wrote it (the process keeps it the owner's).
         */
        scale_exception: z.unknown().optional(),
      }),
    )
    .min(1),
});
export type SwapManifest = z.infer<typeof SwapManifest>;

export type SwapRefusal = { slot_id?: string; photo?: "pc" | "sp"; codes: string[] };
export type SwapResult =
  | { ok: true; out: string; summary: SwapSummary; renders: RenderCheck[] }
  | { ok: false; refusals: SwapRefusal[] };
export type RenderCheck = {
  viewport: string;
  file: string;
  sha256: string;
  images: number;
  images_loaded: number;
  caption_text_left: boolean;
  boards_matched: number;
  /** DEV-189: document.documentElement.scrollWidth, and whether it is wider than the window (fidelity-measure's rule: > width + 1) */
  scroll_width: number;
  horizontal_overflow: boolean;
  /** DEV-189: boards whose layout box is within 2px of the inventory's measure at this viewport, and whose photo fills it (within 1px) */
  boards_intact: number;
};
type SwapSummary = Record<string, unknown>;

export type SwapOptions = {
  pageDir: string;
  manifest: unknown;
  out: string;
  /** where .intake/photos/ is; the repository's pipeline root unless a test gives a temporary one */
  pipelineRoot?: string;
  now?: string;
  forbiddenSha256?: ReadonlySet<string>;
  /** draws PC 1440 and SP 390 into <out>/renders with this browser; omitted: no render */
  browser?: Browser;
  /** tests only: a stand-in for transformHtml, to prove a late failure leaves no --out */
  transform?: typeof transformHtml;
};

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const inside = (child: string, parent: string) => (child + sep).startsWith(parent + sep);
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Refuses an --out that exists, has no parent, or is anywhere inside the repository (the private .intake/ too). */
export function checkOut(out: string): string | null {
  const abs = resolve(out);
  if (inside(abs, REPO) || inside(abs, realpathSync(REPO))) return "OUT_INSIDE_REPO";
  if (existsSync(abs) || isLink(abs)) return "OUT_EXISTS";
  let parent: string;
  try {
    parent = realpathSync(dirname(abs));
  } catch {
    return "OUT_PARENT_MISSING";
  }
  // through a link: the parent's real place decides
  return inside(parent, realpathSync(REPO)) ? "OUT_INSIDE_REPO" : null;
}
function isLink(p: string) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** The manifest names owners and consent records: it may live outside the repository or under the private .intake/. */
export function checkManifestPath(file: string): string | null {
  let real: string;
  try {
    real = realpathSync(file);
  } catch {
    return "MANIFEST_NOT_FOUND";
  }
  if (!inside(real, realpathSync(REPO))) return null;
  return inside(real, join(realpathSync(PIPELINE_ROOT), ".intake")) ? null : "MANIFEST_IN_REPO";
}

/**
 * The pinned slot inventories of a shop, one per measured page: photo-slots.json with photo-slot-edges.json, and
 * photo-slots-<page>.json with photo-slot-edges-<page>.json (DEV-184). Each inventory names its page (page_dir) and
 * carries that page's hashes.
 */
export const INVENTORY_FILE = /^photo-slots(-[a-z0-9][a-z0-9-]{0,40})?\.json$/;
export function inventoryFiles(shop: string, shopDir: string = join(REPO, `design-library/research/quality-pipeline/poc/${shop}`)): Array<{ slots: string; edges: string }> {
  return readdirSync(shopDir)
    .sort()
    .flatMap((f) => {
      const m = INVENTORY_FILE.exec(f);
      return m ? [{ slots: join(shopDir, f), edges: join(shopDir, `photo-slot-edges${m[1] ?? ""}.json`) }] : [];
    });
}

/**
 * The slot inventory of a shop measured on this page and its range edges, and a refusal unless the page is exactly
 * the page both were measured on. Two inventories naming one page are refused.
 */
export function loadInventory(
  shop: string,
  pageDir: string,
  /** tests only: read the shop's inventory files from this folder instead of poc/<shop>/ (the page itself is still the repository's) */
  seam: { shopDir?: string } = {},
): { ok: true; inv: PhotoSlotInventory; edges: Map<string, EdgeVariant[]>; dir: string } | { ok: false; code: string } {
  let dir: string;
  try {
    dir = realpathSync(resolve(REPO, pageDir));
  } catch {
    return { ok: false, code: "PAGE_NOT_FOUND" };
  }
  const matches: PhotoSlotInventory[] = [];
  const edgeFiles: string[] = [];
  for (const f of inventoryFiles(shop, seam.shopDir)) {
    const one = PhotoSlotInventory.parse(JSON.parse(readFileSync(f.slots, "utf8")));
    let at: string;
    try {
      at = realpathSync(join(REPO, one.page_dir));
    } catch {
      continue;
    }
    if (at !== dir) continue;
    matches.push(one);
    edgeFiles.push(f.edges);
  }
  if (matches.length === 0) return { ok: false, code: "PAGE_NOT_INVENTORIED" };
  // DEV-190: the page must also be one the shop's spec was read from (photo-swap-shops.ts pages), compared as the full
  // research path poc/<shop>/fidelity/<version> (PR #232 review L2: never by the last path segment alone)
  const specPages: readonly string[] | undefined = Object.prototype.hasOwnProperty.call(SWAP_SHOP_SPECS, shop) ? SWAP_SHOP_SPECS[shop as keyof typeof SWAP_SHOP_SPECS].pages.map((v) => `design-library/research/quality-pipeline/poc/${shop}/fidelity/${v}`) : undefined;
  if (specPages && matches.some((m) => !specPages.includes(m.page_dir))) return { ok: false, code: "PAGE_NOT_IN_SPEC" };
  if (matches.length > 1) return { ok: false, code: "INVENTORY_AMBIGUOUS" };
  const inv = matches[0]!;
  if (!existsSync(edgeFiles[0]!)) return { ok: false, code: "EDGES_STALE" };
  const edgeFile = PhotoSlotEdges.parse(JSON.parse(readFileSync(edgeFiles[0]!, "utf8")));
  const edges = edgesFor(inv, edgeFile);
  if (!edges) return { ok: false, code: "EDGES_STALE" };
  // DEV-189: the edges must be the widest edges of THIS shop's ranges (つぐ手 1199, 輪 999)
  const want = Object.prototype.hasOwnProperty.call(SWAP_SHOP_SPECS, shop) ? SWAP_SHOP_SPECS[shop as keyof typeof SWAP_SHOP_SPECS].edgeViewports : EDGE_VIEWPORTS;
  if ((edgeFile.edge_viewports ?? EDGE_VIEWPORTS).join(",") !== want.join(",")) return { ok: false, code: "EDGES_STALE" };
  const hash = (f: string) => sha(readFileSync(join(dir, f)));
  if (hash("index.html") !== inv.html_sha256 || hash("style.css") !== inv.css_sha256 || hash("copy.json") !== inv.copy_sha256) return { ok: false, code: "PAGE_CHANGED" };
  return { ok: true, inv, edges, dir };
}

/**
 * The page's HTML with each slot's 写真｜ caption taken out of the visible text and its board filled with a <picture>
 * whose <img> carries the alt text. Throws if a caption or board is not where the pinned page has it, or if any
 * 写真｜ text is left.
 *
 * DEV-184 (d1-v10): a caption may carry <wbr> between its letters (a line-break hint, no text). A board is what its
 * slot's placeholder says it is, nothing else: "css_board" is an empty <div class="photo"></div>; "css_board_with_svg"
 * is a <div class="photo"> holding only drawn seams (<svg class="dmg …" aria-hidden="true">…</svg>, one or more) and
 * white space, checked against an ALLOWLIST (seamBoardInner): only the SVG shape elements and attributes the seams use,
 * matched without regard to case; any other element, attribute, text, comment or stray "<" fails closed. The picture goes in first and the seams stay after it, so the design's gold seams are drawn above the
 * photo. A board of the other kind, or with anything else in it, is BOARD_NOT_FOUND.
 */
export type TransformSlot = { slot: PhotoSlot; alt: string; files: Record<SwapRangeKey, string>; size: { width: number; height: number } };
export function transformHtml(html: string, slots: ReadonlyArray<TransformSlot>, spec: SwapShopSpec = SWAP_SHOP_SPECS.tsugute): string {
  let out = html;
  for (const { slot, alt, files, size } of slots) {
    const caption = `${CAPTION_PREFIX}${slot.role}`;
    const sources = spec.ranges
      .filter((r) => r.media)
      .slice()
      .reverse()
      .map((r) => `<source media="${r.media}" srcset="${escapeHtml(files[r.key])}">`)
      .join("");
    const pictureEl = `<picture data-slot="${slot.slot_id}">${sources}<img src="${escapeHtml(files.desktop)}" alt="${escapeHtml(alt)}" width="${size.width}" height="${size.height}"></picture>`;
    if (spec.structure.kind === "board_before_caption") {
      out = swapBoardBeforeCaption(out, slot, caption, pictureEl, spec.structure);
      continue;
    }
    const re = new RegExp(`[ \\t]*<(figcaption|span)( class="ph-label")?>${[...caption].map(escapeRe).join("(?:<wbr>)?")}</\\1>(\\n?)`, "g");
    const hits = [...out.matchAll(re)];
    if (hits.length !== 1) throw new Error(`CAPTION_NOT_FOUND: ${slot.slot_id}`);
    const at = hits[0]!.index!;
    const figStart = out.lastIndexOf("<figure", at);
    const figEnd = out.indexOf("</figure>", at);
    if (figStart < 0 || figEnd < 0) throw new Error(`BOARD_NOT_FOUND: ${slot.slot_id}`);
    const seg = out.slice(figStart, figEnd).replace(hits[0]![0], "");
    const open = '<div class="photo">';
    const start = seg.indexOf(open);
    if (start < 0 || seg.indexOf(open, start + 1) >= 0) throw new Error(`BOARD_NOT_FOUND: ${slot.slot_id}`);
    const end = seg.indexOf("</div>", start);
    if (end < 0) throw new Error(`BOARD_NOT_FOUND: ${slot.slot_id}`);
    const inner = seg.slice(start + open.length, end);
    const seams = slot.placeholder === "css_board_with_svg" ? seamBoardInner(inner) : inner === "" ? "" : null;
    if (seams === null) throw new Error(`BOARD_NOT_FOUND: ${slot.slot_id}`);
    const picture = `<div class="photo">${pictureEl}${seams}</div>`;
    // plain concatenation: no replacement-string expansion of $&, $`, $' or $$ found in the alt text
    out = out.slice(0, figStart) + seg.slice(0, start) + picture + seg.slice(end + "</div>".length) + out.slice(figEnd);
  }
  if (out.replace(/<wbr\s*\/?>/gi, "").includes(CAPTION_PREFIX)) throw new Error("CAPTION_LEFT: 写真｜ text remains in the page");
  return out;
}

/**
 * DEV-189 (輪): the caption `<p class="ph…">写真｜…</p>` (one match in the page, <wbr> allowed between its letters) must
 * directly follow `<container><board><div class="photo"></div></div>`, the three tags one of the spec's triples (DEV-190), with nothing in
 * between and nothing inside the board but the empty .photo. The caption is taken out and the .photo gets the picture.
 * Anything else — a second caption, a board with content, a missing container — throws (fail closed).
 */
function swapBoardBeforeCaption(html: string, slot: PhotoSlot, caption: string, pictureEl: string, st: Extract<SwapShopSpec["structure"], { kind: "board_before_caption" }>): string {
  const alt = (xs: readonly string[]) => `(?:${xs.map(escapeRe).join("|")})`;
  const text = [...caption].map(escapeRe).join("(?:<wbr>)?");
  const re = new RegExp(`${alt([...new Set(st.triples.map((t) => t.caption))])}${text}</p>`, "g");
  const hits = [...html.matchAll(re)];
  if (hits.length !== 1) throw new Error(`CAPTION_NOT_FOUND: ${slot.slot_id}`);
  const at = hits[0]!.index!;
  const before = html.slice(0, at);
  // DEV-190 (review L2): the container, the board and the caption must be one listed triple, not a mix of two
  const empty = (t: (typeof st.triples)[number]) => `${t.container}${t.board}<div class="photo"></div></div>`;
  const triple = st.triples.find((t) => hits[0]![0].startsWith(t.caption) && before.endsWith(empty(t)));
  if (!triple || slot.placeholder !== "css_board") throw new Error(`BOARD_NOT_FOUND: ${slot.slot_id}`);
  // plain concatenation: no replacement-string expansion of $&, $`, $' or $$ found in the alt text
  return `${before.slice(0, before.length - empty(triple).length)}${triple.container}${triple.board}<div class="photo">${pictureEl}</div></div>${html.slice(at + hits[0]![0].length)}`;
}

/**
 * The inside of a board that holds only drawn seams, or null. An allowlist: one or more top-level decorative <svg> (class
 * "dmg …", aria-hidden="true") holding only the shape elements below, each with only the attributes below, and white
 * space between the tags. Names are compared in lower case (so <Text>, <foreignobject>, <SCRIPT> are all refused); any
 * other element (image, use, a, text, foreignObject, script, style, title, …), any other attribute (href, style, on…),
 * any text, comment, CDATA or stray "<" refuses the board.
 */
const SEAM_ELEMENTS = new Set(["svg", "path", "g", "defs", "lineargradient", "radialgradient", "stop"]);
const SEAM_ATTRIBUTES = new Set(["class", "viewbox", "preserveaspectratio", "aria-hidden", "data-pa-role", "d", "id", "x1", "y1", "x2", "y2", "cx", "cy", "r", "fx", "fy", "offset", "stop-color", "stop-opacity", "gradientunits", "gradienttransform", "transform"]);
export function seamBoardInner(inner: string): string | null {
  const TAG = /<(\/?)([A-Za-z][A-Za-z0-9:-]*)((?:\s+[A-Za-z][A-Za-z0-9:-]*="[^"<>]*")*)\s*(\/?)>/g;
  // everything that is not a well-formed tag must be white space: no text, comment, CDATA, entity or stray "<"
  if (inner.replace(TAG, "").trim() !== "") return null;
  let depth = 0;
  let svgs = 0;
  for (const m of inner.matchAll(TAG)) {
    const [, close, rawName, attrs, selfClose] = m;
    const name = rawName!.toLowerCase();
    if (!SEAM_ELEMENTS.has(name)) return null;
    if (close) {
      if (attrs || selfClose) return null;
      if (name === "svg" ? depth !== 1 : depth < 2) return null;
      depth -= 1;
      continue;
    }
    const list = [...attrs!.matchAll(/\s+([A-Za-z][A-Za-z0-9:-]*)="([^"]*)"/g)].map((a) => [a[1]!.toLowerCase(), a[2]!] as const);
    if (list.some(([k]) => !SEAM_ATTRIBUTES.has(k)) || new Set(list.map(([k]) => k)).size !== list.length) return null;
    if (name === "svg") {
      // only at the top level, decorative, and a seam drawing
      if (depth !== 0) return null;
      const a = Object.fromEntries(list);
      if (a["aria-hidden"] !== "true" || !/^dmg(?: [a-z-]+)*$/.test(a.class ?? "")) return null;
      svgs += 1;
    } else if (depth === 0) return null;
    if (!selfClose) depth += 1;
    else if (name === "svg") return null;
  }
  return depth === 0 && svgs >= 1 ? inner : null;
}

/** Appended to the つぐ手 copy's CSS only: the picture fills the board's whole box (the board keeps its clip, tilt, shadow). Each shop's own: photo-swap-shops.ts. */
export const SWAP_CSS = TSUGUTE_SWAP_CSS;

/** DEV-189: what a render must show to pass (every shop): every image loaded in its board, no 写真｜, no horizontal overflow, every board intact. */
export function renderCheckPassed(check: Omit<RenderCheck, "viewport" | "file" | "sha256">, n: number): boolean {
  return check.images === n && check.images_loaded === n && check.boards_matched === n && check.caption_text_left === false && check.horizontal_overflow === false && check.boards_intact === n;
}

type Loaded = { which: "pc" | "sp"; record: PhotoRights; info: PhotoBytesInfo; file: string; focal_box: FocalBox };

/** Validates everything first; writes only when nothing is refused. */
export async function swapPage(opts: SwapOptions): Promise<SwapResult> {
  const refusals: SwapRefusal[] = [];
  const m = SwapManifest.safeParse(opts.manifest);
  if (!m.success) return { ok: false, refusals: [{ codes: ["MANIFEST_INVALID"] }] };
  const manifest = m.data;
  const outCode = checkOut(opts.out);
  if (outCode) refusals.push({ codes: [outCode] });
  const spec = swapShopSpec(manifest.shop);
  const page = loadInventory(manifest.shop, opts.pageDir);
  if (!page.ok) return { ok: false, refusals: [...refusals, { codes: [page.code] }] };
  const { inv, edges, dir } = page;

  // every slot of the inventory, each once
  const ids = manifest.slots.map((s) => s.slot_id);
  const known = new Set(inv.slots.map((s) => s.slot_id));
  const missing = inv.slots.filter((s) => !ids.includes(s.slot_id)).map((s) => s.slot_id);
  if (missing.length) refusals.push({ codes: ["SLOTS_INCOMPLETE", ...missing.map((id) => `missing:${id}`)] });
  for (const id of ids) if (!known.has(id)) refusals.push({ slot_id: id, codes: ["SLOT_UNKNOWN"] });
  if (new Set(ids).size !== ids.length) refusals.push({ codes: ["SLOT_DUPLICATE"] });

  const pipelineRoot = opts.pipelineRoot ?? PIPELINE_ROOT;
  const forbidden = opts.forbiddenSha256 ?? loadForbiddenSha256(REPO);
  const plans: Array<{ slot: PhotoSlot; entry: SwapManifest["slots"][number]; plan: SlotPlan; photos: Loaded[] }> = [];
  for (const entry of manifest.slots) {
    const slot = inv.slots.find((s) => s.slot_id === entry.slot_id);
    if (!slot) continue;
    const photos: Loaded[] = [];
    for (const which of ["pc", "sp"] as const) {
      const ref = entry[which];
      if (!ref) continue;
      const path = (ref.rights as { private_path?: unknown } | null)?.private_path;
      const opened = typeof path === "string" ? resolvePrivatePhoto(pipelineRoot, path) : ({ ok: false, code: "PATH_NOT_PRIVATE" } as const);
      const rights = checkPhotoRights(ref.rights, opened.ok ? opened.info : null, { purpose: "quality_verification", now: opts.now, forbiddenSha256: forbidden, aiDemoAllowed: spec.aiDemoAllowed });
      const codes: string[] = [...(opened.ok ? [] : [opened.code]), ...(rights.ok ? [] : rights.codes)];
      // DEV-192 (PR #234 review L5): a shop that pins its approved prompt takes only AI demo pictures made from it
      if (rights.ok && spec.aiDemoPromptSha256 && rights.record.source_kind === "ai_generated_demo" && rights.record.ai_provenance?.prompt_sha256 !== spec.aiDemoPromptSha256) codes.push("AI_DEMO_PROMPT_NOT_APPROVED");
      if (codes.length || !opened.ok || !rights.ok) {
        refusals.push({ slot_id: entry.slot_id, photo: which, codes: [...new Set(codes)] });
        continue;
      }
      photos.push({ which, record: rights.record, info: opened.info, file: opened.file, focal_box: ref.focal_box });
    }
    const pc = photos.find((p) => p.which === "pc");
    if (!pc || (entry.sp && !photos.some((p) => p.which === "sp"))) continue;
    const sp = photos.find((p) => p.which === "sp");
    const asInput = (p: Loaded) => ({ width: p.info.width, height: p.info.height, focal_box: p.focal_box });
    const plan = planSlot(slot, { pc: asInput(pc), ...(sp ? { sp: asInput(sp) } : {}), ...(entry.scale_exception !== undefined ? { scale_exception: entry.scale_exception } : {}) }, { spViewports: spec.spViewports, edges: edges.get(slot.slot_id) ?? [] });
    if (!plan.ok) refusals.push({ slot_id: entry.slot_id, codes: plan.codes });
    plans.push({ slot, entry, plan, photos });
  }
  if (refusals.length) return { ok: false, refusals };

  // build: every crop and the HTML in memory first, then the copy in a temporary sibling of --out, renamed at the end
  const out = resolve(opts.out);
  const built = await buildCopy(inv, plans, dir, opts.transform ?? transformHtml, spec);
  if (!built.ok) return built;
  const { files, crops, html, css } = built;
  let tmp: string;
  try {
    tmp = mkdtempSync(join(dirname(out), `.${basename(out)}.partial-`));
  } catch {
    return { ok: false, refusals: [{ codes: ["OUT_TEMP_FAILED"] }] };
  }
  try {
    const pageOut = join(tmp, "page");
    mkdirSync(join(pageOut, "photos"), { recursive: true });
    for (const [name, buf] of Object.entries(files)) writeFileSync(join(pageOut, name), buf, { flag: "wx" });
    writeFileSync(join(pageOut, "index.html"), html, { flag: "wx" });
    writeFileSync(join(pageOut, "style.css"), css, { flag: "wx" });
    copyFileSync(join(dir, "copy.json"), join(pageOut, "copy.json"));

    const renders: RenderCheck[] = [];
    if (opts.browser) {
      mkdirSync(join(tmp, "renders"));
      for (const r of spec.renders) {
        let check: RenderCheck;
        try {
          check = await renderCopy(opts.browser, realpathSync(pageOut), r, inv.slots, join(tmp, "renders", `${r.viewport}.png`));
        } catch {
          return abort(tmp, [{ codes: ["RENDER_FAILED", `viewport:${r.viewport}`] }]);
        }
        if (!renderCheckPassed(check, inv.slots.length)) return abort(tmp, [{ codes: ["RENDER_CHECK_FAILED", `viewport:${r.viewport}`] }]);
        renders.push({ ...check, file: join(out, "renders", `${r.viewport}.png`) });
      }
    }

    const fileShas = Object.fromEntries(Object.entries(files).map(([name, buf]) => [name, sha(buf)]));
    const summary: SwapSummary = {
      schema: "photo_swap_summary_v0",
      shop: manifest.shop,
      page_dir: inv.page_dir,
      source_hashes: { html: inv.html_sha256, css: inv.css_sha256, copy: inv.copy_sha256 },
      copy_hashes: { html: sha(html), css: sha(css) },
      crop_method: "pixel crop (sharp: auto-orient, extract, metadata stripped), one file per CSS breakpoint range",
      scale_checked_at: `the 4 measured viewports and each range's widest edge (${spec.edgeViewports.map((v) => v.split("_")[1]).join(", ")}); wider than 1920 is not guaranteed`,
      slots: plans.map(({ slot, entry, plan, photos }) => ({
        slot_id: slot.slot_id,
        alt: entry.alt ?? slot.role,
        needs_sp_photo: plan.needs_sp_photo,
        photos: photos.map((p) => ({ which: p.which, ...toPublicPhotoRecord(p.record) })),
        scale_exception: entry.scale_exception === undefined ? null : { scale: (entry.scale_exception as { scale: number }).scale, decided_by: "owner" },
      })),
      crops,
      files: fileShas,
      renders: renders.map((r) => ({ viewport: r.viewport, sha256: r.sha256, images_loaded: r.images_loaded, caption_text_left: r.caption_text_left, horizontal_overflow: r.horizontal_overflow, boards_intact: r.boards_intact })),
      owner_review_required: true,
      note: "Not a success-case judgement. The owner looks at the renders and decides.",
    };
    writeFileSync(join(tmp, "swap-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });
    const privateSidecar = {
      schema: "photo_swap_rights_private_v0",
      warning: "PRIVATE: owners, consent records and paths. Never commit, never paste into an Issue or PR.",
      slots: plans.map(({ entry, photos }) => ({ slot_id: entry.slot_id, scale_exception: entry.scale_exception ?? null, photos: photos.map((p) => ({ which: p.which, focal_box: p.focal_box, rights: p.record })) })),
    };
    writeFileSync(join(tmp, "rights.private.json"), `${JSON.stringify(privateSidecar, null, 2)}\n`, { flag: "wx", mode: 0o600 });

    // the last step: --out appears whole or not at all (checked again: it may have been made while this ran)
    if (existsSync(out) || isLink(out)) return abort(tmp, [{ codes: ["OUT_EXISTS"] }]);
    renameSync(tmp, out);
    return { ok: true, out, summary, renders };
  } catch {
    return abort(tmp, [{ codes: ["WRITE_FAILED"] }]);
  }
}

function abort(tmp: string, refusals: SwapRefusal[]): SwapResult {
  rmSync(tmp, { recursive: true, force: true });
  return { ok: false, refusals };
}

type Plan = { slot: PhotoSlot; entry: SwapManifest["slots"][number]; plan: SlotPlan; photos: Loaded[] };
type Built = { ok: true; files: Record<string, Buffer>; crops: Record<string, unknown>; html: string; css: string } | { ok: false; refusals: SwapRefusal[] };

/** Every crop (decoded, cut, re-encoded) and the transformed HTML, in memory. Nothing is written. */
async function buildCopy(inv: PhotoSlotInventory, plans: Plan[], dir: string, transform: typeof transformHtml, spec: SwapShopSpec): Promise<Built> {
  const sharp = (await import("sharp")).default;
  const files: Record<string, Buffer> = {};
  const slotsOut: TransformSlot[] = [];
  const crops: Record<string, unknown> = {};
  for (const { slot, entry, plan, photos } of plans) {
    const names = {} as Record<SwapRangeKey, string>;
    let size = { width: 0, height: 0 };
    for (const r of spec.ranges) {
      const lead = plan.byViewport[r.viewports[0]!];
      if (!lead || !lead.crop.ok) return { ok: false, refusals: [{ slot_id: slot.slot_id, codes: ["NOT_PLANNED", `range:${r.key}`] }] };
      const src = photos.find((p) => p.which === lead.source)!;
      const c = lead.crop.crop;
      let buf: Buffer;
      let rect: { left: number; top: number; width: number; height: number };
      const ext = src.info.format === "png" ? "png" : "jpg";
      try {
        // sharp's default failOn ("warning") stops a cut-off file that passed the header and rights checks
        const oriented = await sharp(readFileSync(src.file)).rotate().toBuffer({ resolveWithObject: true });
        if (oriented.info.width !== src.info.width || oriented.info.height !== src.info.height) return { ok: false, refusals: [{ slot_id: slot.slot_id, photo: src.which, codes: ["ORIENTATION_MISMATCH"] }] };
        const left = Math.min(c.x, oriented.info.width - 1);
        const top = Math.min(c.y, oriented.info.height - 1);
        rect = { left, top, width: Math.min(c.width, oriented.info.width - left), height: Math.min(c.height, oriented.info.height - top) };
        const img = sharp(oriented.data).extract(rect);
        buf = ext === "png" ? await img.png().toBuffer() : await img.jpeg({ quality: 90 }).toBuffer();
      } catch {
        // the decoder's message is not passed on: codes only
        return { ok: false, refusals: [{ slot_id: slot.slot_id, photo: src.which, codes: ["PHOTO_DECODE_FAILED"] }] };
      }
      const name = `photos/${slot.slot_id}-${r.key}.${ext}`;
      files[name] = buf;
      names[r.key] = name;
      if (r.key === "desktop") size = { width: rect.width, height: rect.height };
      const checked = Object.fromEntries(r.viewports.map((v) => [v, plan.byViewport[v]?.crop.ok ? (plan.byViewport[v]!.crop as { density: number }).density : null]));
      crops[`${slot.slot_id}/${r.key}`] = { source: lead.source, asset_id: src.record.asset_id, rect, density: lead.crop.density, density_by_viewport: checked, scale_basis: lead.crop.scale_basis, exception_applied: lead.crop.exception_applied, kept_area: lead.kept_area };
    }
    slotsOut.push({ slot, alt: entry.alt ?? slot.role, files: names, size });
  }
  let html: string;
  try {
    html = transform(readFileSync(join(dir, "index.html"), "utf8"), slotsOut, spec);
  } catch (e) {
    const code = /^([A-Z_]+):/.exec((e as Error).message)?.[1] ?? "TRANSFORM_FAILED";
    return { ok: false, refusals: [{ codes: [code] }] };
  }
  if (inv.slots.some((s) => !html.includes(`<picture data-slot="${s.slot_id}">`))) return { ok: false, refusals: [{ codes: ["BOARD_NOT_FOUND"] }] };
  return { ok: true, files, crops, html, css: readFileSync(join(dir, "style.css"), "utf8") + spec.swapCss };
}

/** Draws the private copy like fidelity-measure (JS off, nothing outside the copy) and checks the swap took. */
async function renderCopy(browser: Browser, dir: string, r: SwapShopSpec["renders"][number], slots: PhotoSlot[], file: string): Promise<RenderCheck> {
  const ctx = await browser.newContext({ viewport: { width: r.width, height: r.height }, deviceScaleFactor: 1, javaScriptEnabled: false, serviceWorkers: "block" });
  try {
    const page = await ctx.newPage();
    const base = `file://${dir}${sep}`;
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (!url.startsWith(base)) return route.abort();
      let real: string;
      try {
        real = realpathSync(decodeURIComponent(new URL(url).pathname));
      } catch {
        return route.abort();
      }
      return inside(real, dir) ? route.continue() : route.abort();
    });
    await page.goto(`${base}index.html`, { waitUntil: "load" });
    await page.evaluate("document.fonts.ready.then(() => true)");
    // DEV-189: each board's layout box (as photo-slots.ts measures it) against the inventory at this viewport
    const boards = slots.map((s) => {
      const v = s.variants.find((x) => x.viewport === r.viewport)!;
      return { sel: s.board_selector, w: v.width_px, h: v.height_px };
    });
    const check = (await page.evaluate(
      `((boards) => {
        const imgs = Array.from(document.querySelectorAll(".photo > picture > img"));
        // the picture sits in the board itself (つぐ手: the board is the .photo) or in the board's one .photo (輪)
        const imgOf = (s) => Array.from(document.querySelectorAll(s + " > picture > img[alt], " + s + " > .photo > picture > img[alt]"));
        const intact = (b) => {
          const el = document.querySelectorAll(b.sel);
          const im = imgOf(b.sel);
          if (el.length !== 1 || im.length !== 1) return false;
          const cs = getComputedStyle(el[0]);
          const w = parseFloat(cs.width), h = parseFloat(cs.height);
          if (Math.abs(w - b.w) > 2 || Math.abs(h - b.h) > 2) return false;
          // the photo fills the board's box (layout sizes: a tilted board keeps them)
          const host = im[0].closest(".photo");
          return Math.abs(im[0].offsetWidth - host.offsetWidth) <= 1 && Math.abs(im[0].offsetHeight - host.offsetHeight) <= 1 && Math.abs(host.offsetWidth - w) <= 1 && Math.abs(host.offsetHeight - h) <= 1;
        };
        const de = document.documentElement;
        return {
          images: imgs.length,
          images_loaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
          caption_text_left: document.body.innerText.includes(${JSON.stringify(CAPTION_PREFIX)}),
          boards_matched: boards.filter((b) => imgOf(b.sel).length === 1).length,
          scroll_width: de.scrollWidth,
          horizontal_overflow: de.scrollWidth > window.innerWidth + 1,
          boards_intact: boards.filter(intact).length,
        };
      })(${JSON.stringify(boards)})`,
    )) as Omit<RenderCheck, "viewport" | "file" | "sha256">;
    const png = await page.screenshot({ fullPage: true, path: file });
    return { viewport: r.viewport, file, sha256: sha(png), ...check };
  } finally {
    await ctx.close();
  }
}

async function main(argv: string[]): Promise<number> {
  const arg = (k: string) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const pageDir = arg("--page");
  const manifestPath = arg("--manifest");
  const out = arg("--out");
  if (!pageDir || !manifestPath || !out) return (process.stderr.write("usage: --page <C page dir> --manifest <intake manifest> --out <new dir outside the repository>\n"), 2);
  const where = checkManifestPath(manifestPath);
  if (where) return (process.stderr.write(`REFUSED: ${where}\n`), 2);
  const outCode = checkOut(out);
  if (outCode) return (process.stderr.write(`REFUSED: ${outCode}\n`), 2);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  try {
    const res = await swapPage({ pageDir, manifest, out, browser });
    if (!res.ok) {
      // codes only: never the owner, the consent record or the path
      for (const r of res.refusals) process.stderr.write(`REFUSED: ${r.slot_id ?? "-"} ${r.photo ?? ""} ${r.codes.join(",")}\n`);
      return 2;
    }
    process.stdout.write(`${JSON.stringify({ out: res.out, renders: res.renders.map((r) => ({ viewport: r.viewport, sha256: r.sha256, images_loaded: r.images_loaded, caption_text_left: r.caption_text_left })) }, null, 2)}\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`${(e as Error).message.split("\n")[0]}\n`);
    return 2;
  } finally {
    await browser.close();
  }
}

if (require.main === module) main(process.argv.slice(2)).then((c) => process.exit(c));
