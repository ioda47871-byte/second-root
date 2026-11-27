/**
 * PR (4) photos: the format and pixel size of a picture, read from its header only (PNG IHDR, JPEG SOFn, WebP
 * VP8 / VP8L / VP8X), with no dependency and without decoding. Used by the build's photo limits (photos.ts).
 */

export type ImageMeta = { format: "png" | "jpeg" | "webp"; width: number; height: number };

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function png(b: Buffer): ImageMeta | null {
  if (b.length < 24 || !b.subarray(0, 8).equals(PNG_SIGNATURE) || b.toString("latin1", 12, 16) !== "IHDR") return null;
  return { format: "png", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/** JPEG: walk the markers to the first start-of-frame (SOF0–SOF15 except DHT C4, JPG C8, DAC CC). */
function jpeg(b: Buffer): ImageMeta | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end of image / start of scan before any frame
    if (marker >= 0xd0 && marker <= 0xd7) {
      i += 2;
      continue;
    }
    const len = b.readUInt16BE(i + 2);
    if (len < 2) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 9 > b.length) return null;
      return { format: "jpeg", height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

function webp(b: Buffer): ImageMeta | null {
  if (b.length < 30 || b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WEBP") return null;
  const chunk = b.toString("latin1", 12, 16);
  if (chunk === "VP8 ") {
    // key frame: 3-byte frame tag, start code 9d 01 2a, then 14-bit width and height
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { format: "webp", width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    if (b[20] !== 0x2f) return null;
    const bits = b.readUInt32LE(21);
    return { format: "webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    const w = b.readUIntLE(24, 3) + 1;
    const h = b.readUIntLE(27, 3) + 1;
    return { format: "webp", width: w, height: h };
  }
  return null;
}

/** The picture's format and size from its header, or null when it is none of PNG / JPEG / WebP (or is cut short). */
export function imageMeta(bytes: Buffer): ImageMeta | null {
  return png(bytes) ?? jpeg(bytes) ?? webp(bytes);
}

/**
 * Issue #380 (phone photos): whether the bytes are a HEIF-family file (an iPhone's HEIC, or AVIF) — an ISO-BMFF `ftyp`
 * box at the start whose major or a compatible brand is a HEIF brand. The build does not accept these (JPEG / PNG /
 * WebP only); this only lets it say so by name (CONTENT_PHOTO_HEIC) instead of the generic CONTENT_PHOTO_TYPE, so the
 * customer can be told what to change on the phone (docs/design/pages-cms-phone-photos.md).
 */
const HEIF_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "hevm", "hevs", "mif1", "msf1", "avif", "avis"]);
export function isHeif(b: Buffer): boolean {
  if (b.length < 16 || b.toString("latin1", 4, 8) !== "ftyp") return false;
  const size = b.readUInt32BE(0);
  const end = Math.min(b.length, size >= 16 ? size : 16);
  for (let i = 8; i + 4 <= end; i += 4) {
    if (i === 12) continue; // the minor version, not a brand
    if (HEIF_BRANDS.has(b.toString("latin1", i, i + 4))) return true;
  }
  return false;
}
