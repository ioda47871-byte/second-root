/**
 * DEV-196s (owner approval 2026-11-11): reads a photo-swapped page and its rights READ-ONLY and prepares what
 * buildPackage stores — the HTML / CSS with only the photo URLs rewritten (proved), the photos as WebP, the image
 * records — plus the pixel comparison of a render with the research render.
 *
 * Nothing is written here and nothing is changed in the inputs (the swap's copy, the rights file, the originals stay
 * as they are). Plain files only: a symbolic link, a directory where a file belongs, or a file the swap does not write
 * (in page/photos/) is refused. copy.json is not part of a demo version and is not read.
 */
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { loadForbiddenSha256 } from "@/lib/design-agent/quality-pipeline/photo-rights";
import { convertPhoto, photoRefs, photoUrlMap, provePhotoUrlRewrite, rewritePhotoUrls, SWAP_PHOTO_URL, type ConvertedPhoto, type RewriteProof } from "./photos";
import { buildSwapImages, type PackageImage, type SwapImages } from "./swap-rights";

export { PhotoError } from "./photos";
export { SwapRightsError } from "./swap-rights";

export class SwapInputError extends Error {
  constructor(
    public readonly code: string,
    public readonly details: readonly string[] = [],
  ) {
    super(details.length ? `${code}: ${details.join(",")}` : code);
  }
}

const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

/** A plain file (no link), or SwapInputError. */
function readPlain(path: string, code: string): Buffer {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    throw new SwapInputError(code, ["missing"]);
  }
  if (!st.isFile()) throw new SwapInputError(code, ["not a plain file"]);
  return readFileSync(path);
}

export type SwapPage = { html: string; css: string; photos: Map<string, Buffer> };

/** The swap's copy: index.html, style.css and every file of photos/ (each must be a swap photo name). */
export function readSwapPage(pageDir: string): SwapPage {
  const html = readPlain(join(pageDir, "index.html"), "PAGE_HTML_UNREADABLE").toString("utf8");
  const css = readPlain(join(pageDir, "style.css"), "PAGE_CSS_UNREADABLE").toString("utf8");
  const photos = new Map<string, Buffer>();
  let names: string[];
  try {
    if (!lstatSync(join(pageDir, "photos")).isDirectory()) throw new Error("not a directory");
    names = readdirSync(join(pageDir, "photos"));
  } catch {
    throw new SwapInputError("PAGE_PHOTOS_UNREADABLE");
  }
  for (const n of names.sort()) {
    const url = `photos/${n}`;
    if (!SWAP_PHOTO_URL.test(url)) throw new SwapInputError("PAGE_PHOTO_UNEXPECTED", [n]);
    photos.set(url, readPlain(join(pageDir, "photos", n), "PAGE_PHOTO_UNREADABLE"));
  }
  if (photos.size === 0) throw new SwapInputError("PAGE_NO_PHOTOS");
  return { html, css, photos };
}

/** The original photos of the run: every plain PNG / JPEG / WebP file directly in the directory. */
export function readOriginals(dir: string): Buffer[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    throw new SwapInputError("ORIGINALS_UNREADABLE");
  }
  const out = names.filter((n) => /\.(png|jpe?g|webp)$/i.test(n)).sort().map((n) => readPlain(join(dir, n), "ORIGINAL_UNREADABLE"));
  if (out.length === 0) throw new SwapInputError("ORIGINALS_NONE");
  return out;
}

export type PhotoConversion = { stored: string; swap: string; mode: ConvertedPhoto["mode"]; quality: number | null; original: ConvertedPhoto["original"]; webp_sha256: string; webp_bytes: number };

export type PreparedSwap = {
  /** the stored copy: only the photo URLs differ from the swap's */
  html: string;
  css: string;
  /** stored URL path (photos/<slot>-<range>.webp) → WebP bytes */
  photos: Map<string, Uint8Array>;
  images: PackageImage[];
  sources: SwapImages["sources"];
  conversions: PhotoConversion[];
  proof: { html: RewriteProof; css: RewriteProof };
};

/**
 * The swap's copy (`page`), its rights file and summary, and the run's originals → the stored copy. Every photo the
 * copy holds must be referenced by its HTML or CSS, and every reference must be a photo it holds.
 */
export async function prepareSwap(o: { page: SwapPage; rights: unknown; summary: unknown; originals: readonly Uint8Array[]; forbiddenSha256: ReadonlySet<string>; now: string; photoLimit?: number }): Promise<PreparedSwap> {
  const refs = new Set([...photoRefs(o.page.html), ...photoRefs(o.page.css)]);
  for (const ref of refs) if (!o.page.photos.has(ref)) throw new SwapInputError("PHOTO_REF_UNKNOWN", [ref]);
  for (const url of o.page.photos.keys()) if (!refs.has(url)) throw new SwapInputError("PHOTO_NOT_REFERENCED", [url]);
  const map = photoUrlMap(o.page.photos.keys());
  const html = rewritePhotoUrls(o.page.html, map);
  const css = rewritePhotoUrls(o.page.css, map);
  const proof = { html: provePhotoUrlRewrite(o.page.html, html, map), css: provePhotoUrlRewrite(o.page.css, css, map) };
  const photos = new Map<string, Uint8Array>();
  const conversions: PhotoConversion[] = [];
  for (const [swap, bytes] of o.page.photos) {
    const stored = map.get(swap)!;
    const c = await convertPhoto(bytes, o.photoLimit);
    photos.set(stored, c.webp);
    conversions.push({ stored, swap, mode: c.mode, quality: c.quality, original: c.original, webp_sha256: sha256(c.webp), webp_bytes: c.webp.byteLength });
  }
  const built = buildSwapImages({
    rights: o.rights,
    summary: o.summary,
    pageHtml: o.page.html,
    pageCss: o.page.css,
    pagePhotoSha256: new Map([...o.page.photos].map(([k, b]) => [k, sha256(b)])),
    converted: conversions.map((c) => ({ swapUrl: c.swap, storedUrl: c.stored, webp: { sha256: c.webp_sha256, bytes: c.webp_bytes, width: c.original.width, height: c.original.height } })),
    originals: o.originals,
    forbiddenSha256: o.forbiddenSha256,
    now: o.now,
  });
  return { html, css, photos, images: built.images, sources: built.sources, conversions, proof };
}

/** The success-case hashes the swap forbids (the repository's originals inventory). */
export const forbiddenHashes = (repo: string) => loadForbiddenSha256(repo);

export type PixelDiff = { ours: { width: number; height: number }; research: { width: number; height: number }; same_size: boolean; differing_pixels: number | null; ratio: number | null; max_channel_delta: number | null };

/** Compares two PNG renders pixel by pixel (RGBA). Different sizes: only the sizes are reported. */
export async function pixelDiff(ours: Uint8Array, research: Uint8Array): Promise<PixelDiff> {
  const a = await sharp(ours).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const b = await sharp(research).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const sizes = { ours: { width: a.info.width, height: a.info.height }, research: { width: b.info.width, height: b.info.height } };
  if (a.info.width !== b.info.width || a.info.height !== b.info.height) return { ...sizes, same_size: false, differing_pixels: null, ratio: null, max_channel_delta: null };
  let differing = 0;
  let max = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    let px = 0;
    for (let c = 0; c < 4; c += 1) px = Math.max(px, Math.abs(a.data[i + c]! - b.data[i + c]!));
    if (px > 0) differing += 1;
    if (px > max) max = px;
  }
  const total = a.info.width * a.info.height;
  return { ...sizes, same_size: true, differing_pixels: differing, ratio: Number((differing / total).toFixed(6)), max_channel_delta: max };
}
