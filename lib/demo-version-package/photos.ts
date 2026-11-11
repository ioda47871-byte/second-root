/**
 * DEV-196s (owner approval 2026-11-11): the photos of a photo-swapped page (scripts/design-artifact/photo-swap.ts
 * output `<swap>/page/photos/<slot_id>-<range>.<png|jpg>`) made into what the server accepts, without changing the
 * design:
 *
 *  - each photo becomes WebP: LOSSLESS when that fits the server's per-photo limit (ARTIFACT_LIMITS.photoBytes), else
 *    the highest lossy quality that fits (100 down to PHOTO_MIN_QUALITY; none fits → refused). Converted to sRGB,
 *    written with NO ICC profile and NO metadata (the manifest's producer contract). The pixel size is never changed
 *    (a side over the server's 4096 px limit is refused, never resized). Which mode and the original's sha256 are
 *    recorded;
 *  - each name follows the server's PHOTO_NAME: the slot's hyphens become underscores (ph-bench → ph_bench), the
 *    range is kept, the extension is .webp;
 *  - in the stored HTML (and CSS), ONLY those photo URLs are rewritten. `provePhotoUrlRewrite` shows that nothing else
 *    changed: with every old URL and its new URL replaced by the same marker, the two texts are byte-identical.
 *
 * Node only (sharp). Reads nothing itself: the caller passes the bytes.
 */
import { createHash } from "node:crypto";
import sharp, { type Metadata, type OutputInfo, type WebpOptions } from "sharp";
import { ARTIFACT_LIMITS, PHOTO_NAME } from "@/lib/sales/demo-version/manifest";

/** A photo of the swap's copy, as its HTML references it. The slot id is the swap's (`ph-…`, hyphens allowed). */
export const SWAP_PHOTO_URL = /^photos\/(ph-[a-z0-9-]{1,36})-(desktop|tablet|mobile)\.(png|jpg)$/;
/** Every `photos/…` reference in an HTML or CSS text (an attribute value, a srcset entry, a url()). */
const PHOTO_REF = /photos\/[^\s"'()<>,;\\]+/g;
export const PHOTO_MIN_QUALITY = 60;
/** The fixed WebP settings (deterministic output for the same input). */
export const PHOTO_WEBP = { effort: 6, smartSubsample: false } as const;

export class PhotoError extends Error {
  constructor(
    public readonly code: string,
    public readonly details: readonly string[] = [],
  ) {
    super(details.length ? `${code}: ${details.join(",")}` : code);
  }
}

const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

/** The stored name (URL path, without `page/`) of a swap photo, or a PhotoError. */
export function storedPhotoUrl(swapUrl: string): string {
  const m = SWAP_PHOTO_URL.exec(swapUrl);
  if (!m) throw new PhotoError("PHOTO_NAME_UNEXPECTED", [swapUrl]);
  const stored = `photos/${m[1]!.replace(/-/g, "_")}-${m[2]}.webp`;
  if (!PHOTO_NAME.test(`page/${stored}`)) throw new PhotoError("PHOTO_NAME_UNEXPECTED", [swapUrl]);
  return stored;
}

/** old URL → new URL for every photo; refuses two photos that would get the same stored name. */
export function photoUrlMap(swapUrls: Iterable<string>): Map<string, string> {
  const map = new Map<string, string>();
  const taken = new Set<string>();
  for (const url of [...swapUrls].sort()) {
    const stored = storedPhotoUrl(url);
    if (taken.has(stored)) throw new PhotoError("PHOTO_NAME_COLLISION", [url]);
    taken.add(stored);
    map.set(url, stored);
  }
  return map;
}

/** Every `photos/…` reference in a text, in order. */
export function photoRefs(text: string): string[] {
  return [...text.matchAll(PHOTO_REF)].map((m) => m[0]);
}

/**
 * Rewrites every photo reference through the map. A reference that is not in the map (a photo that is not in the
 * copy, or anything else under photos/) is refused: nothing is left pointing at a file the package does not hold.
 */
export function rewritePhotoUrls(text: string, map: ReadonlyMap<string, string>): string {
  return text.replace(PHOTO_REF, (ref) => {
    const to = map.get(ref);
    if (!to) throw new PhotoError("PHOTO_REF_UNKNOWN", [ref]);
    return to;
  });
}

export type RewriteProof = {
  /** references rewritten */
  refs: number;
  bytes_before: number;
  bytes_after: number;
  /** sha256 of the text with every photo URL replaced by its marker (the same for both sides) */
  normalized_sha256: string;
};

/**
 * Proves that `after` differs from `before` ONLY in the photo URLs of the map: both texts, with each old URL (in
 * `before`) and its new URL (in `after`) replaced by the same marker, must be byte-identical; no old URL may be left
 * in `after` and no new URL may already have been in `before`. Throws PhotoError("REWRITE_CHANGED_MORE") otherwise.
 */
export function provePhotoUrlRewrite(before: string, after: string, map: ReadonlyMap<string, string>): RewriteProof {
  const marker = (i: number) => `\u0000PHOTO${i}\u0000`;
  if (before.includes("\u0000") || after.includes("\u0000")) throw new PhotoError("REWRITE_CHANGED_MORE", ["nul"]);
  const keys = [...map.keys()].sort();
  const index = new Map(keys.map((k, i) => [k, i]));
  const back = new Map(keys.map((k, i) => [map.get(k)!, i]));
  let refs = 0;
  const a = before.replace(PHOTO_REF, (ref) => {
    if (back.has(ref) && !index.has(ref)) throw new PhotoError("REWRITE_CHANGED_MORE", ["new name before"]);
    const i = index.get(ref);
    if (i === undefined) return ref;
    refs += 1;
    return marker(i);
  });
  let refsAfter = 0;
  const b = after.replace(PHOTO_REF, (ref) => {
    if (index.has(ref) && !back.has(ref)) throw new PhotoError("REWRITE_CHANGED_MORE", ["old name left"]);
    const i = back.get(ref);
    if (i === undefined) return ref;
    refsAfter += 1;
    return marker(i);
  });
  if (a !== b || refs !== refsAfter) throw new PhotoError("REWRITE_CHANGED_MORE", ["bytes"]);
  return { refs, bytes_before: Buffer.byteLength(before), bytes_after: Buffer.byteLength(after), normalized_sha256: sha256(a) };
}

export type PhotoOriginal = { sha256: string; bytes: number; format: "png" | "jpeg"; width: number; height: number; icc: boolean };
export type ConvertedPhoto = {
  webp: Uint8Array;
  width: number;
  height: number;
  /** lossless, or lossy at `quality` (the highest that fits the limit) */
  mode: "lossless" | "lossy";
  quality: number | null;
  original: PhotoOriginal;
};

/**
 * One swap photo (PNG or JPEG) → WebP within the server's photo limit, same pixel size, sRGB, no ICC, no metadata.
 * `limit` is the server's (a test may pass a smaller one to reach the lossy branch).
 */
export async function convertPhoto(bytes: Uint8Array, limit: number = ARTIFACT_LIMITS.photoBytes): Promise<ConvertedPhoto> {
  let meta: Metadata;
  try {
    meta = await sharp(bytes).metadata();
  } catch {
    throw new PhotoError("PHOTO_UNREADABLE");
  }
  if ((meta.format !== "png" && meta.format !== "jpeg") || !meta.width || !meta.height) throw new PhotoError("PHOTO_NOT_PNG_OR_JPEG");
  // EXIF orientation would make the shown shape differ from the stored one: the swap writes none, so any is refused
  if (meta.orientation !== undefined && meta.orientation !== 1) throw new PhotoError("PHOTO_ORIENTED");
  if (Math.max(meta.width, meta.height) > ARTIFACT_LIMITS.imageSidePx) throw new PhotoError("PHOTO_SIDE_OVER_LIMIT");
  const original: PhotoOriginal = { sha256: sha256(bytes), bytes: bytes.byteLength, format: meta.format, width: meta.width, height: meta.height, icc: Boolean(meta.icc) };
  // sharp converts an embedded profile to sRGB on output and, without withMetadata / keepIccProfile, writes none
  const encode = (o: WebpOptions) => sharp(bytes, { failOn: "warning" }).toColorspace("srgb").webp({ ...PHOTO_WEBP, ...o }).toBuffer({ resolveWithObject: true });
  const done = (r: { data: Buffer; info: OutputInfo }, mode: ConvertedPhoto["mode"], quality: number | null): ConvertedPhoto => {
    if (r.info.width !== meta.width || r.info.height !== meta.height) throw new PhotoError("PHOTO_SIZE_CHANGED");
    return { webp: new Uint8Array(r.data), width: r.info.width, height: r.info.height, mode, quality, original };
  };
  const lossless = await encode({ lossless: true });
  if (lossless.data.byteLength <= limit) return done(lossless, "lossless", null);
  for (let q = 100; q >= PHOTO_MIN_QUALITY; q -= 1) {
    const lossy = await encode({ quality: q });
    if (lossy.data.byteLength <= limit) return done(lossy, "lossy", q);
  }
  throw new PhotoError("PHOTO_TOO_LARGE");
}
