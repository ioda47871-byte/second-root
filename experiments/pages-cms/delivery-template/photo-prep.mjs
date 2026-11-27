// The customer's photos, fitted for the page (Issue #380): a phone's full-size JPEG (4032×3024, 3–8 MB, or 48 MP) is
// over the photo limits; instead of asking the customer to make it smaller, the build makes it smaller — in the
// working copy only (the repository keeps what was uploaded).
//
// For each picture the page shows:
//   - a delivered generated material or a shop-provided (B) photo (its SHA-256 is in the handover record or the B
//     index) is NEVER touched: the provenance checks compare exact bytes;
//   - a file that is not JPEG / PNG / WebP by its bytes, or whose bytes disagree with its extension (an iPhone HEIC
//     renamed .jpg, say), is left as it is — the build's checks then stop with their own code and advice;
//   - every other picture (the customer's own) is turned upright by its EXIF orientation, fitted inside TARGET_SIDE
//     (never enlarged), and written again in the same format under the same name, WITHOUT metadata (an iPhone JPEG can
//     carry the GPS position where it was taken). If that still does not fit the byte limit, a lower quality and then
//     a smaller side are tried; if nothing fits, the original stays and the build's check refuses it.
//   - HEIC is not converted (sharp's prebuilt binaries cannot read it; see docs in the README).
//
// The output is deterministic for the same input and the same pinned sharp.
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

/** The longest side a fitted photo gets (the page shows photos at most ~1200 CSS px wide; 2× for sharp screens). */
export const TARGET_SIDE = 2560;
/** The largest picture this step will open (pixels): more is refused by the build's own check. */
export const INTAKE_MAX_PIXELS = 64_000_000;
const STEPS = [
  { side: TARGET_SIDE, quality: 82 },
  { side: TARGET_SIDE, quality: 70 },
  { side: 2048, quality: 70 },
  { side: 1600, quality: 65 },
];
const EXT = { jpg: "jpeg", jpeg: "jpeg", png: "png", webp: "webp" };
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

function encode(img, format, quality) {
  if (format === "jpeg") return img.jpeg({ quality, mozjpeg: true });
  if (format === "webp") return img.webp({ quality, effort: 4 });
  return img.png({ compressionLevel: 9, effort: 7 });
}

/**
 * Fits the named pictures in <media> in place. Returns one entry per name: what was done, the size before and after.
 * `limits` are the site's photo limits (site/photos.ts PHOTO_LIMITS: bytes, maxSide, maxPixels).
 */
export async function preparePhotos({ media, names, protectedShas, limits }) {
  const report = [];
  for (const name of names) {
    const path = join(media, name);
    const st = await stat(path).catch(() => null);
    if (!st || !st.isFile()) {
      report.push({ file: name, action: "kept", reason: "missing" });
      continue;
    }
    const original = await readFile(path);
    const before = { bytes: original.length, sha256: sha256(original) };
    if (protectedShas.has(before.sha256)) {
      report.push({ file: name, action: "kept", reason: "protected", before });
      continue;
    }
    const format = EXT[name.split(".").pop().toLowerCase()];
    let meta;
    try {
      meta = await sharp(original, { limitInputPixels: INTAKE_MAX_PIXELS }).metadata();
    } catch {
      report.push({ file: name, action: "kept", reason: "unreadable", before });
      continue;
    }
    if (!format || meta.format !== format) {
      report.push({ file: name, action: "kept", reason: "format", before: { ...before, format: meta.format } });
      continue;
    }
    let fitted = null;
    for (const step of STEPS) {
      const img = sharp(original, { limitInputPixels: INTAKE_MAX_PIXELS }).rotate().resize({ width: step.side, height: step.side, fit: "inside", withoutEnlargement: true });
      const { data, info } = await encode(img, format, step.quality).toBuffer({ resolveWithObject: true });
      if (data.length <= limits.bytes && Math.max(info.width, info.height) <= limits.maxSide && info.width * info.height <= limits.maxPixels) {
        fitted = { data, info, step };
        break;
      }
    }
    if (!fitted) {
      report.push({ file: name, action: "kept", reason: "does_not_fit", before: { ...before, width: meta.width, height: meta.height } });
      continue;
    }
    await writeFile(path, fitted.data);
    const resized = fitted.info.width !== meta.width || fitted.info.height !== meta.height;
    report.push({
      file: name,
      action: resized ? "fitted" : "re-encoded",
      before: { ...before, width: meta.width, height: meta.height, orientation: meta.orientation ?? 1, metadata: Boolean(meta.exif || meta.xmp || meta.iptc) },
      after: { bytes: fitted.data.length, sha256: sha256(fitted.data), width: fitted.info.width, height: fitted.info.height, quality: fitted.step.quality },
    });
  }
  return report;
}
