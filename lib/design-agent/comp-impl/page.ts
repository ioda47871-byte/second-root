/**
 * The page contract of a comp implementation (DEV-082): what Claude hands in
 * is one standalone directory
 *
 *   index.html    one page, no script, no inline style, one <link rel="stylesheet" href="style.css">
 *   style.css     the page's whole stylesheet
 *   assets.json   the images the page may use (possibly none)
 *   assets/*.png  those images, nothing else
 *
 * and nothing else (no other file, no sub-directory, no link). This module
 * reads it without following links and runs the checks that need no browser:
 * the HTML refusals and the stylesheet's safety. The browser-side checks
 * (allowed elements and attributes, links, rendering) are in render.ts.
 *
 * The stylesheet: an allowlist in the Stage 3 guard's model (page-css.ts):
 * the guard itself (shop-css/guard.ts) cannot take a whole page's CSS (its
 * selectors must start at the renderer's #shop-css scope and use the
 * renderer's data attributes), so page-css.ts reuses the guard's tokenizer
 * and value grammar with its own selector and @media rules. Written up in
 * docs/operations/comp-to-site.md.
 */
import { lstat, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { MOCKUP_PNG_LIMITS, PngError, readPngNoFollow, type PngLimits } from "../design-image/png";
import { decodePng } from "../worker/png-paint";
import { CompImplError, readSmallFile, sha256 } from "./bundle";
import { pageCssProblems } from "./page-css";

export const PAGE_LIMITS = { htmlBytes: 64 * 1024, cssBytes: 64 * 1024, assets: 6 } as const;
/** An asset is a real image file of a sane size (the comp's own limits, with a smaller minimum side). */
export const ASSET_PNG_LIMITS: PngLimits = { ...MOCKUP_PNG_LIMITS, maxBytes: 8 * 1024 * 1024, minSide: 16 };

export const ASSET_KINDS = ["ai_concept_local", "placeholder"] as const;
const AssetSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/),
  file: z.string().regex(/^assets\/[a-z0-9][a-z0-9-]{0,60}\.png$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  /** ai_concept_local: an AI concept image a person reviewed for a local preview only (never the asset store, never published). */
  kind: z.enum(ASSET_KINDS),
  approval: z.strictObject({ approved_by: z.string().regex(/^[A-Za-z0-9._@-]{1,64}$/), approved_at: z.string().datetime({ offset: true }), record_id: z.string().regex(/^[A-Za-z0-9_-]{3,64}$/) }).nullable(),
  /** Always false: nothing in a comp implementation is published. */
  published: z.literal(false),
});
export const AssetListSchema = z.strictObject({ version: z.literal(1), assets: z.array(AssetSchema).max(PAGE_LIMITS.assets) });
export type PageAsset = z.infer<typeof AssetSchema>;

export type CompPage = {
  dir: string;
  html: string;
  css: string;
  assets: PageAsset[];
  /** The asset files by their path in the page (assets/x.png). */
  files: Map<string, Buffer>;
  htmlSha256: string;
  cssSha256: string;
};

const refuse = (code: string): never => {
  throw new CompImplError(code);
};

/** Reads a page directory; refuses anything outside the contract (fixed codes). */
export async function loadCompPage(pageDir: string): Promise<CompPage> {
  let dir: string;
  try {
    dir = await realpath(pageDir);
  } catch {
    return refuse("PAGE_MISSING");
  }
  const top = (await readdir(dir)).sort();
  for (const name of top) if (!["index.html", "style.css", "assets.json", "assets"].includes(name)) refuse("PAGE_FILE_UNEXPECTED");
  const html = (await readSmallFile(join(dir, "index.html"), "PAGE_HTML_INVALID", PAGE_LIMITS.htmlBytes)).toString("utf8");
  const css = (await readSmallFile(join(dir, "style.css"), "PAGE_CSS_INVALID", PAGE_LIMITS.cssBytes)).toString("utf8");
  let list;
  try {
    list = AssetListSchema.safeParse(JSON.parse((await readSmallFile(join(dir, "assets.json"), "PAGE_ASSETS_INVALID")).toString("utf8")));
  } catch (error) {
    if (error instanceof CompImplError) throw error;
    return refuse("PAGE_ASSETS_INVALID");
  }
  if (!list.success) return refuse("PAGE_ASSETS_INVALID");
  const assets = list.data.assets;
  if (new Set(assets.map((a) => a.id)).size !== assets.length || new Set(assets.map((a) => a.file)).size !== assets.length) refuse("PAGE_ASSETS_INVALID");
  // An AI concept image needs a person's review record (design-image-assets.md); a placeholder needs none.
  for (const a of assets) if ((a.kind === "ai_concept_local") !== (a.approval !== null)) refuse("PAGE_ASSET_APPROVAL");
  const files = new Map<string, Buffer>();
  if (top.includes("assets")) {
    const info = await lstat(join(dir, "assets"));
    if (!info.isDirectory() || info.isSymbolicLink()) refuse("PAGE_FILE_UNEXPECTED");
    for (const name of (await readdir(join(dir, "assets"))).sort()) {
      const asset = assets.find((a) => a.file === `assets/${name}`);
      if (!asset) refuse("PAGE_ASSET_UNLISTED");
      let png;
      try {
        png = await readPngNoFollow(join(dir, "assets", name), ASSET_PNG_LIMITS);
      } catch (error) {
        if (error instanceof PngError) refuse("PAGE_ASSET_INVALID");
        throw error;
      }
      if (sha256(png.bytes) !== asset!.sha256) refuse("PAGE_ASSET_HASH");
      // the kind is the author's word; a placeholder must at least be one flat colour (it cannot carry text or a photo)
      if (asset!.kind === "placeholder" && !isFlatPng(png.bytes)) refuse("PAGE_ASSET_PLACEHOLDER_NOT_FLAT");
      files.set(asset!.file, png.bytes);
    }
  }
  if (files.size !== assets.length) refuse("PAGE_ASSET_MISSING");
  return { dir, html, css, assets, files, htmlSha256: sha256(html), cssSha256: sha256(css) };
}

/** A placeholder's every pixel must equal its first pixel (re-review: 6 levels could hold text a filter would reveal). */
export const PLACEHOLDER_FLAT_TOLERANCE = 0;

/**
 * Whether a PNG is one flat colour (every pixel near the first). Read with the
 * worker's decoder (8-bit RGB / RGBA, non-interlaced); anything it cannot read
 * is not flat. No check reads text inside an image: this is what keeps a
 * "placeholder" from carrying any (docs/operations/comp-to-site.md §5).
 */
export function isFlatPng(bytes: Buffer): boolean {
  let px;
  try {
    px = decodePng(bytes);
  } catch {
    return false;
  }
  const c = px.channels;
  for (let i = 0; i < px.width * px.height * c; i += c) for (let k = 0; k < c; k++) if (Math.abs(px.data[i + k]! - px.data[k]!) > PLACEHOLDER_FLAT_TOLERANCE) return false;
  return true;
}

/**
 * Refusals on the HTML source before any browser sees it (the browser-side
 * check in render.ts then checks every element and attribute against an
 * allowlist). Codes only.
 */
export function htmlSourceProblems(html: string): string[] {
  const p = new Set<string>();
  const lower = html.toLowerCase();
  if (/<script\b/.test(lower)) p.add("HTML_SCRIPT");
  if (/<(iframe|object|embed|frame|frameset|form|input|button|textarea|select|base|video|audio|source|canvas|template|svg|math)\b/.test(lower)) p.add("HTML_ELEMENT");
  if (/\son[a-z]+\s*=/.test(lower)) p.add("HTML_EVENT_HANDLER");
  if (/javascript:|vbscript:|data:/.test(lower)) p.add("HTML_URL_SCHEME");
  if (/https?:|\/\/[a-z0-9]/.test(lower)) p.add("HTML_EXTERNAL_URL");
  if (/<style\b|\sstyle\s*=/.test(lower)) p.add("HTML_INLINE_STYLE");
  if (/<meta[^>]*http-equiv/.test(lower)) p.add("HTML_META_REFRESH");
  if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(html)) p.add("HTML_CONTROL_CHAR");
  // bidi controls reorder what is drawn (an invented number from a fact's digits): never in a page
  if (/[\u200e\u200f\u202a-\u202e\u2066-\u2069\u061c]|&#x?0*(200e|200f|202[a-e]|206[6-9]|61c|8206|8207|823[4-8]|829[4-7]|1564);?/i.test(html)) p.add("HTML_BIDI_CONTROL");
  if (/<bdo\b|<bdi\b|\sdir\s*=/.test(lower)) p.add("HTML_BIDI_CONTROL");
  return [...p].sort();
}

/**
 * The stylesheet's safety: the page CSS allowlist (page-css.ts, the Stage 3
 * guard's model and value grammar). Problem codes; empty when accepted.
 */
export function cssProblems(css: string): string[] {
  return pageCssProblems(css);
}
