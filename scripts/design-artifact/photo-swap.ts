/**
 * DEV-166 (Issue #193 comment 6623100651; owner, 2026-11-04 item 3) — OFFLINE research tool. つぐ手 (tsugute) only.
 *
 *   npx tsx scripts/design-artifact/photo-swap.ts --page <C page dir> --manifest <intake manifest> --out <new dir>
 *
 * Makes a PRIVATE copy of the つぐ手 C page in which each of its 6 placeholder boards shows a rights-cleared photo,
 * then draws it at PC 1440 and SP 390 (JavaScript off, every request outside the copy refused). The repository page
 * is not changed. Nothing is written inside the repository.
 *
 * Refuses (exit 2, nothing written) unless:
 *  - the page is the one the slot inventory was measured on (HTML, CSS and copy hashes);
 *  - --out is a new directory outside the repository whose parent exists;
 *  - the manifest is outside the repository or under the private .intake/;
 *  - every one of the 6 slots has a photo, and each photo opens from .intake/photos/ (no link) and passes
 *    checkPhotoRights (quality_verification) against its measured bytes;
 *  - each slot passes planSlot: 2× at every viewport (1.5–2× only with an owner exception record), the subject kept,
 *    and a separate SP photo where the PC photo's SP-shaped crops (≤1199px on this page) lose the subject.
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
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { chromium, type Browser } from "playwright";
import { z } from "zod";
import { checkPhotoRights, loadForbiddenSha256, resolvePrivatePhoto, toPublicPhotoRecord, type PhotoBytesInfo, type PhotoRights } from "../../lib/design-agent/quality-pipeline/photo-rights";
import { FocalBox, planSlot, PhotoSlotInventory, type PhotoSlot, type SlotPlan, type SlotViewport } from "../../lib/design-agent/quality-pipeline/photo-slots";

const REPO = resolve(__dirname, "../..");
export const PIPELINE_ROOT = join(REPO, "design-library/research/quality-pipeline");
/** The owner started with つぐ手's 6 slots only (not all 15). */
export const SWAP_SHOPS = ["tsugute"] as const;
export const CAPTION_PREFIX = "写真｜";

/**
 * The breakpoints of the pinned つぐ手 CSS (style.css, hash in photo-slots.json): one crop per range. The viewport
 * whose box the crop is cut for comes first; the others in the range use the same file (object-fit: cover).
 */
export const RANGES = [
  { key: "desktop", media: null, viewports: ["desktop_1440"] },
  { key: "tablet", media: "(max-width: 1199px)", viewports: ["tablet_1024", "tablet_768"] },
  { key: "mobile", media: "(max-width: 600px)", viewports: ["mobile_390"] },
] as const satisfies ReadonlyArray<{ key: string; media: string | null; viewports: readonly SlotViewport[] }>;

/**
 * Where a separate SP photo is used: every board of the pinned つぐ手 CSS takes its SP shape at ≤1199px (e.g. ph-dry
 * is 340/500 above it and 4/3 at and below it), so the SP photo serves the tablet and mobile ranges.
 */
export const TSUGUTE_SP_VIEWPORTS: readonly SlotViewport[] = ["tablet_1024", "tablet_768", "mobile_390"];

const RENDERS = [
  { viewport: "desktop_1440", width: 1440, height: 900 },
  { viewport: "mobile_390", width: 390, height: 844 },
] as const;

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
        /** { scale, reason, decided_by: "owner" }: lets this slot go down to that scale (≥1.5) */
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
export type RenderCheck = { viewport: string; file: string; sha256: string; images: number; images_loaded: number; caption_text_left: boolean; boards_matched: number };
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
  const real = realpathSync(file);
  if (!inside(real, realpathSync(REPO))) return null;
  return inside(real, join(realpathSync(PIPELINE_ROOT), ".intake")) ? null : "MANIFEST_IN_REPO";
}

/** The pinned slot inventory of a shop, and a refusal unless the page is exactly the page it was measured on. */
export function loadInventory(shop: string, pageDir: string): { ok: true; inv: PhotoSlotInventory; dir: string } | { ok: false; code: string } {
  const inv = PhotoSlotInventory.parse(JSON.parse(readFileSync(join(REPO, `design-library/research/quality-pipeline/poc/${shop}/photo-slots.json`), "utf8")));
  let dir: string;
  try {
    dir = realpathSync(resolve(REPO, pageDir));
  } catch {
    return { ok: false, code: "PAGE_NOT_FOUND" };
  }
  if (dir !== realpathSync(join(REPO, inv.page_dir))) return { ok: false, code: "PAGE_NOT_INVENTORIED" };
  const hash = (f: string) => sha(readFileSync(join(dir, f)));
  if (hash("index.html") !== inv.html_sha256 || hash("style.css") !== inv.css_sha256 || hash("copy.json") !== inv.copy_sha256) return { ok: false, code: "PAGE_CHANGED" };
  return { ok: true, inv, dir };
}

/**
 * The page's HTML with each slot's 写真｜ caption taken out of the visible text and its board filled with a <picture>
 * whose <img> carries the alt text. Throws if a caption or board is not where the pinned page has it, or if any
 * 写真｜ text is left.
 */
export function transformHtml(html: string, slots: ReadonlyArray<{ slot: PhotoSlot; alt: string; files: Record<"desktop" | "tablet" | "mobile", string>; size: { width: number; height: number } }>): string {
  let out = html;
  for (const { slot, alt, files, size } of slots) {
    const caption = `${CAPTION_PREFIX}${slot.role}`;
    const re = new RegExp(`[ \\t]*<(figcaption|span)( class="ph-label")?>${escapeRe(caption)}</\\1>(\\n?)`, "g");
    const hits = [...out.matchAll(re)];
    if (hits.length !== 1) throw new Error(`CAPTION_NOT_FOUND: ${slot.slot_id}`);
    const at = hits[0]!.index!;
    const figStart = out.lastIndexOf("<figure", at);
    const figEnd = out.indexOf("</figure>", at);
    if (figStart < 0 || figEnd < 0) throw new Error(`BOARD_NOT_FOUND: ${slot.slot_id}`);
    const seg = out.slice(figStart, figEnd).replace(hits[0]![0], "");
    const board = '<div class="photo"></div>';
    if (seg.split(board).length !== 2) throw new Error(`BOARD_NOT_FOUND: ${slot.slot_id}`);
    const sources = RANGES.filter((r) => r.media)
      .slice()
      .reverse()
      .map((r) => `<source media="${r.media}" srcset="${escapeHtml(files[r.key])}">`)
      .join("");
    const picture = `<div class="photo"><picture data-slot="${slot.slot_id}">${sources}<img src="${escapeHtml(files.desktop)}" alt="${escapeHtml(alt)}" width="${size.width}" height="${size.height}"></picture></div>`;
    out = out.slice(0, figStart) + seg.replace(board, picture) + out.slice(figEnd);
  }
  if (out.includes(CAPTION_PREFIX)) throw new Error("CAPTION_LEFT: 写真｜ text remains in the page");
  return out;
}

/** Appended to the copy's CSS only: the picture fills the board's whole box (the board keeps its clip, tilt, shadow). */
export const SWAP_CSS = `
/* DEV-166: private photo swap (this copy only; the repository page is unchanged) */
.photo > picture { position: absolute; inset: 0; display: block; }
.photo > picture > img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: 50% 50%; }
`;

type Loaded = { which: "pc" | "sp"; record: PhotoRights; info: PhotoBytesInfo; file: string; focal_box: FocalBox };

/** Validates everything first; writes only when nothing is refused. */
export async function swapPage(opts: SwapOptions): Promise<SwapResult> {
  const refusals: SwapRefusal[] = [];
  const m = SwapManifest.safeParse(opts.manifest);
  if (!m.success) return { ok: false, refusals: [{ codes: ["MANIFEST_INVALID"] }] };
  const manifest = m.data;
  const outCode = checkOut(opts.out);
  if (outCode) refusals.push({ codes: [outCode] });
  const page = loadInventory(manifest.shop, opts.pageDir);
  if (!page.ok) return { ok: false, refusals: [...refusals, { codes: [page.code] }] };
  const { inv, dir } = page;

  // all six, each once
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
      const rights = checkPhotoRights(ref.rights, opened.ok ? opened.info : null, { purpose: "quality_verification", now: opts.now, forbiddenSha256: forbidden });
      const codes = [...(opened.ok ? [] : [opened.code]), ...(rights.ok ? [] : rights.codes)];
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
    const plan = planSlot(slot, { pc: asInput(pc), ...(sp ? { sp: asInput(sp) } : {}), ...(entry.scale_exception !== undefined ? { scale_exception: entry.scale_exception } : {}) }, { spViewports: TSUGUTE_SP_VIEWPORTS });
    if (!plan.ok) refusals.push({ slot_id: entry.slot_id, codes: plan.codes });
    plans.push({ slot, entry, plan, photos });
  }
  if (refusals.length) return { ok: false, refusals };

  // write: the private copy, the pixel crops, the sidecars
  const sharp = (await import("sharp")).default;
  const out = resolve(opts.out);
  mkdirSync(out);
  const pageOut = join(out, "page");
  mkdirSync(join(pageOut, "photos"), { recursive: true });
  const fileShas: Record<string, string> = {};
  const slotsOut: Parameters<typeof transformHtml>[1][number][] = [];
  const crops: Record<string, unknown> = {};
  for (const { slot, entry, plan, photos } of plans) {
    const files = {} as Record<"desktop" | "tablet" | "mobile", string>;
    let size = { width: 0, height: 0 };
    for (const r of RANGES) {
      const lead = plan.byViewport[r.viewports[0]];
      if (!lead.crop.ok) throw new Error(`unreachable: ${slot.slot_id} ${r.key} not planned`);
      const src = photos.find((p) => p.which === lead.source)!;
      const oriented = await sharp(readFileSync(src.file)).rotate().toBuffer({ resolveWithObject: true });
      if (oriented.info.width !== src.info.width || oriented.info.height !== src.info.height) throw new Error(`ORIENTATION_MISMATCH: ${slot.slot_id}`);
      const c = lead.crop.crop;
      const left = Math.min(c.x, oriented.info.width - 1);
      const top = Math.min(c.y, oriented.info.height - 1);
      const rect = { left, top, width: Math.min(c.width, oriented.info.width - left), height: Math.min(c.height, oriented.info.height - top) };
      const ext = src.info.format === "png" ? "png" : "jpg";
      const img = sharp(oriented.data).extract(rect);
      const buf = ext === "png" ? await img.png().toBuffer() : await img.jpeg({ quality: 90 }).toBuffer();
      const name = `photos/${slot.slot_id}-${r.key}.${ext}`;
      writeFileSync(join(pageOut, name), buf, { flag: "wx" });
      files[r.key] = name;
      fileShas[name] = sha(buf);
      if (r.key === "desktop") size = { width: rect.width, height: rect.height };
      crops[`${slot.slot_id}/${r.key}`] = { source: lead.source, asset_id: src.record.asset_id, rect, density: lead.crop.density, scale_basis: lead.crop.scale_basis, exception_applied: lead.crop.exception_applied, kept_area: lead.kept_area };
    }
    slotsOut.push({ slot, alt: entry.alt ?? slot.role, files, size });
  }
  const html = transformHtml(readFileSync(join(dir, "index.html"), "utf8"), slotsOut);
  const css = readFileSync(join(dir, "style.css"), "utf8") + SWAP_CSS;
  writeFileSync(join(pageOut, "index.html"), html, { flag: "wx" });
  writeFileSync(join(pageOut, "style.css"), css, { flag: "wx" });
  copyFileSync(join(dir, "copy.json"), join(pageOut, "copy.json"));

  const renders: RenderCheck[] = [];
  if (opts.browser) {
    mkdirSync(join(out, "renders"));
    for (const r of RENDERS) renders.push(await renderCopy(opts.browser, realpathSync(pageOut), r, inv.slots, join(out, "renders", `${r.viewport}.png`)));
  }

  const summary: SwapSummary = {
    schema: "photo_swap_summary_v0",
    shop: manifest.shop,
    page_dir: inv.page_dir,
    source_hashes: { html: inv.html_sha256, css: inv.css_sha256, copy: inv.copy_sha256 },
    copy_hashes: { html: sha(html), css: sha(css) },
    crop_method: "pixel crop (sharp: auto-orient, extract, metadata stripped), one file per CSS breakpoint range",
    slots: plans.map(({ slot, entry, plan, photos }) => ({
      slot_id: slot.slot_id,
      alt: entry.alt ?? slot.role,
      needs_sp_photo: plan.needs_sp_photo,
      photos: photos.map((p) => ({ which: p.which, ...toPublicPhotoRecord(p.record) })),
      scale_exception: entry.scale_exception === undefined ? null : { scale: (entry.scale_exception as { scale: number }).scale, decided_by: "owner" },
    })),
    crops,
    files: fileShas,
    renders: renders.map((r) => ({ viewport: r.viewport, sha256: r.sha256, images_loaded: r.images_loaded, caption_text_left: r.caption_text_left })),
    owner_review_required: true,
    note: "Not a success-case judgement. The owner looks at the renders and decides.",
  };
  writeFileSync(join(out, "swap-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });
  const privateSidecar = {
    schema: "photo_swap_rights_private_v0",
    warning: "PRIVATE: owners, consent records and paths. Never commit, never paste into an Issue or PR.",
    slots: plans.map(({ entry, photos }) => ({ slot_id: entry.slot_id, scale_exception: entry.scale_exception ?? null, photos: photos.map((p) => ({ which: p.which, focal_box: p.focal_box, rights: p.record })) })),
  };
  writeFileSync(join(out, "rights.private.json"), `${JSON.stringify(privateSidecar, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return { ok: true, out, summary, renders };
}

/** Draws the private copy like fidelity-measure (JS off, nothing outside the copy) and checks the swap took. */
async function renderCopy(browser: Browser, dir: string, r: (typeof RENDERS)[number], slots: PhotoSlot[], file: string): Promise<RenderCheck> {
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
    const check = (await page.evaluate(
      `((sels) => {
        const imgs = Array.from(document.querySelectorAll(".photo > picture > img"));
        return {
          images: imgs.length,
          images_loaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
          caption_text_left: document.body.innerText.includes(${JSON.stringify(CAPTION_PREFIX)}),
          boards_matched: sels.filter((s) => document.querySelectorAll(s + " > picture > img[alt]").length === 1).length,
        };
      })(${JSON.stringify(slots.map((s) => s.board_selector))})`,
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
    return res.renders.every((r) => r.images === 6 && r.images_loaded === 6 && r.boards_matched === 6 && !r.caption_text_left) ? 0 : 2;
  } catch (e) {
    process.stderr.write(`${(e as Error).message.split("\n")[0]}\n`);
    return 2;
  } finally {
    await browser.close();
  }
}

if (require.main === module) main(process.argv.slice(2)).then((c) => process.exit(c));
