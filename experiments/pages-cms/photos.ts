/**
 * PR (4) photos (owner decision 2026-11-26: consider size limits and build-time optimisation; test operability and
 * display quality). The build checks every picture the shown content names, from its bytes and header only
 * (image-meta.ts; no dependency, nothing decoded or changed), and stops with a named code:
 *
 *   CONTENT_PHOTO_MISSING      the file named in the content is not in media/
 *   CONTENT_PHOTO_TYPE         not PNG / JPEG / WebP by its bytes, or its bytes disagree with its extension
 *   CONTENT_PHOTO_TOO_LARGE    more than PHOTO_LIMITS.bytes (a phone's full-size photo: ask for a smaller copy)
 *   CONTENT_PHOTO_DIMENSIONS   a side longer than PHOTO_LIMITS.maxSide, or more than PHOTO_LIMITS.maxPixels
 *   CONTENT_PHOTO_TOO_SMALL    a side shorter than PHOTO_LIMITS.minSide (it would show blurred in the frame)
 *   CONTENT_PHOTO_RATIO        longer side more than PHOTO_LIMITS.maxRatio times the shorter (a strip, not a photo)
 *
 * A stopped build keeps the last good publish (Cloudflare Pages, Q2). The same limits are written as hints in the
 * CMS (pages-config.ts PHOTO_HINT); Pages CMS itself has no size limit option, so the build is what enforces them.
 * The page frames crop with object-fit: cover, so any ratio within the limit keeps the layout.
 */
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ContentError, type ShopContent, viewOf } from "./content-model";
import { imageMeta, type ImageMeta } from "./image-meta";

export const PHOTO_LIMITS = { bytes: 2 * 1024 * 1024, maxSide: 4096, maxPixels: 16_000_000, minSide: 320, maxRatio: 3 } as const;

const EXT_FORMAT: Record<string, ImageMeta["format"]> = { png: "png", jpg: "jpeg", jpeg: "jpeg", webp: "webp" };

export type PhotoCheck = { file: string; bytes: number; format: ImageMeta["format"]; width: number; height: number };

/** Checks one picture's bytes against the limits; throws ContentError with the photo code. */
export function checkPhoto(file: string, bytes: Buffer): PhotoCheck {
  const meta = imageMeta(bytes);
  const ext = file.split(".").pop()!.toLowerCase();
  if (!meta || EXT_FORMAT[ext] !== meta.format) throw new ContentError("CONTENT_PHOTO_TYPE", file);
  if (bytes.length > PHOTO_LIMITS.bytes) throw new ContentError("CONTENT_PHOTO_TOO_LARGE", file);
  const { width, height } = meta;
  if (Math.max(width, height) > PHOTO_LIMITS.maxSide || width * height > PHOTO_LIMITS.maxPixels) throw new ContentError("CONTENT_PHOTO_DIMENSIONS", file);
  if (Math.min(width, height) < PHOTO_LIMITS.minSide) throw new ContentError("CONTENT_PHOTO_TOO_SMALL", file);
  if (Math.max(width, height) > PHOTO_LIMITS.maxRatio * Math.min(width, height)) throw new ContentError("CONTENT_PHOTO_RATIO", file);
  return { file, bytes: bytes.length, format: meta.format, width, height };
}

/** Every picture the page shows (visible items in visible categories), checked; the media/ file names in order. */
export async function checkPhotos(repo: string, content: ShopContent): Promise<PhotoCheck[]> {
  const names = [...new Set(viewOf(content).sections.flatMap((s) => s.items).filter((m) => m.image).map((m) => m.image.replace(/^\/media\//, "")))].sort();
  const out: PhotoCheck[] = [];
  for (const n of names) {
    const path = join(repo, "media", n);
    const st = await lstat(path).catch(() => null);
    if (!st || !st.isFile()) throw new ContentError("CONTENT_PHOTO_MISSING", n);
    if (st.size > PHOTO_LIMITS.bytes) throw new ContentError("CONTENT_PHOTO_TOO_LARGE", n);
    out.push(checkPhoto(n, await readFile(path)));
  }
  return out;
}
