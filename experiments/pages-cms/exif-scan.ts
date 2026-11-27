/**
 * Issue #380 live trial: what metadata a picture carries, read from its bytes with no dependency and without decoding
 * — EXIF (and whether it holds a GPS block with entries, and the orientation), and XMP (and whether it mentions a GPS
 * position). JPEG (APP1 Exif / XMP), PNG (eXIf, iTXt / tEXt XMP), WebP (EXIF / XMP chunks). Bounds-checked: a cut or
 * malformed block reads as "not found", never as a crash. Used by live-trial-measure.ts to tell the published (fitted,
 * stripped) pictures from the originals in the repository.
 *
 * Kit review L3: also read — PNG compressed XMP (iTXt with the compression flag, zTXt) and ImageMagick's hex "Raw profile
 * type exif / APP1 / xmp" text chunks (inflated with node:zlib, bounded), and JPEG Extended XMP (its parts joined). What
 * it cannot read is reported in `unknown` — never as "no GPS": a HEIF / HEIC file, any other non-JPEG / PNG / WebP
 * bytes, a compressed chunk that does not inflate, an oversized one.
 * Kit re-review Low: also a damaged file — an Exif block whose TIFF does not parse ("exif unreadable"), and a JPEG /
 * PNG / WebP whose segments or chunks end before the image data / IEND / the end of the file ("<format> truncated"):
 * metadata after the damage cannot be ruled out, so such a file is never read as "no GPS".
 */
import { inflateSync } from "node:zlib";

export type MetaScan = { exif: boolean; gps: boolean; orientation: number | null; xmp: boolean; xmpGps: boolean; unknown: string[] };

const NONE: MetaScan = { exif: false, gps: false, orientation: null, xmp: false, xmpGps: false, unknown: [] };
const fresh = (): MetaScan => ({ ...NONE, unknown: [] });
const INFLATE_MAX = 4 * 1024 * 1024;
const inflate = (b: Buffer): Buffer | null => {
  try {
    return inflateSync(b, { maxOutputLength: INFLATE_MAX });
  } catch {
    return null;
  }
};
/** ImageMagick's "Raw profile type <x>" text: "\n<type>\n<length>\n<hex lines>" → the bytes. */
function rawProfile(text: string): Buffer | null {
  const m = /^\s*\n?\s*[A-Za-z0-9]+\s*\n\s*(\d+)\s*\n([\s0-9a-fA-F]*)$/.exec(text);
  if (!m) return null;
  const hex = m[2]!.replace(/\s+/g, "");
  if (hex.length % 2 || hex.length / 2 !== Number(m[1])) return null;
  return Buffer.from(hex, "hex");
}
const XMP_GPS = /exif:GPS(Latitude|Longitude)|GPSLatitude|GPSLongitude/;

/** A TIFF block (the body of an Exif segment): orientation, and whether the GPS IFD has any entry. */
export function scanTiff(t: Buffer): { orientation: number | null; gps: boolean } | null {
  if (t.length < 8) return null;
  const order = t.toString("latin1", 0, 2);
  if (order !== "II" && order !== "MM") return null;
  const le = order === "II";
  const u16 = (o: number) => (o + 2 <= t.length ? (le ? t.readUInt16LE(o) : t.readUInt16BE(o)) : -1);
  const u32 = (o: number) => (o + 4 <= t.length ? (le ? t.readUInt32LE(o) : t.readUInt32BE(o)) : -1);
  if (u16(2) !== 42) return null;
  const ifd0 = u32(4);
  const entries = (at: number) => {
    const n = u16(at);
    if (n < 0 || n > 512) return [] as { tag: number; type: number; value: number }[];
    const out: { tag: number; type: number; value: number }[] = [];
    for (let i = 0; i < n; i++) {
      const e = at + 2 + i * 12;
      if (e + 12 > t.length) break;
      const type = u16(e + 2);
      out.push({ tag: u16(e), type, value: type === 3 ? u16(e + 8) : u32(e + 8) });
    }
    return out;
  };
  if (ifd0 < 8 || ifd0 >= t.length) return null;
  const first = entries(ifd0);
  const o = first.find((e) => e.tag === 0x0112);
  const gpsAt = first.find((e) => e.tag === 0x8825)?.value ?? -1;
  const gps = gpsAt >= 8 && gpsAt < t.length && entries(gpsAt).length > 0;
  return { orientation: o ? o.value : null, gps };
}

function merge(scan: MetaScan, tiff: Buffer | null, xmpText: string | null): MetaScan {
  const out = { ...scan, unknown: [...scan.unknown] };
  if (tiff) {
    const t = scanTiff(tiff);
    if (t) {
      out.exif = true;
      out.gps ||= t.gps;
      out.orientation ??= t.orientation;
    } else out.unknown.push("exif unreadable");
  }
  if (xmpText !== null) {
    out.xmp = true;
    out.xmpGps ||= XMP_GPS.test(xmpText);
  }
  return out;
}

function jpeg(b: Buffer): MetaScan {
  let scan = fresh();
  const extended: Buffer[] = [];
  let i = 2;
  let ended = false; // reached the image data (SOS) or the end of the image (EOI) normally
  for (let guard = 0; guard < 1000 && i + 2 <= b.length; guard++) {
    if (b[i] !== 0xff) break;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i += 1; // a fill byte before the marker
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) {
      ended = true; // image data: no more metadata segments
      break;
    }
    if (i + 4 > b.length) break;
    const len = b.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > b.length) break;
    const body = b.subarray(i + 4, i + 2 + len);
    if (marker === 0xe1 && body.toString("latin1", 0, 6) === "Exif\0\0") scan = merge(scan, body.subarray(6), null);
    else if (marker === 0xe1 && body.toString("latin1", 0, 29) === "http://ns.adobe.com/xap/1.0/\0") scan = merge(scan, null, body.subarray(29).toString("utf8"));
    // Extended XMP: namespace (35 bytes incl. NUL), GUID (32), full length (4), offset (4), then the part
    else if (marker === 0xe1 && body.toString("latin1", 0, 35) === "http://ns.adobe.com/xmp/extension/\0") extended.push(body.subarray(75));
    i += 2 + len;
  }
  if (extended.length) scan = merge(scan, null, Buffer.concat(extended).toString("utf8"));
  if (!ended) scan.unknown.push("jpeg truncated");
  return scan;
}

/** A PNG text chunk (tEXt / zTXt / iTXt): its keyword and text, inflated when compressed (null text: could not read). */
function pngText(type: string, body: Buffer): { keyword: string; text: string | null } | null {
  const nul = body.indexOf(0);
  if (nul < 1) return null;
  const keyword = body.toString("latin1", 0, nul);
  if (type === "tEXt") return { keyword, text: body.subarray(nul + 1).toString("latin1") };
  if (type === "zTXt") {
    const z = inflate(body.subarray(nul + 2));
    return { keyword, text: z ? z.toString("latin1") : null };
  }
  // iTXt: keyword NUL, compression flag, method, language NUL, translated keyword NUL, text
  const flag = body[nul + 1];
  const lang = body.indexOf(0, nul + 3);
  const trans = lang < 0 ? -1 : body.indexOf(0, lang + 1);
  if (trans < 0) return { keyword, text: null };
  const raw = body.subarray(trans + 1);
  const t = flag === 1 ? inflate(raw) : raw;
  return { keyword, text: t ? t.toString("utf8") : null };
}

function png(b: Buffer): MetaScan {
  let scan = fresh();
  let i = 8;
  for (let guard = 0; guard < 10000 && i + 12 <= b.length; guard++) {
    const len = b.readUInt32BE(i);
    const type = b.toString("latin1", i + 4, i + 8);
    if (i + 12 + len > b.length) break;
    const body = b.subarray(i + 8, i + 8 + len);
    if (type === "eXIf") scan = merge(scan, body, null);
    else if (type === "iTXt" || type === "tEXt" || type === "zTXt") {
      const t = pngText(type, body);
      const key = t?.keyword ?? "";
      const isXmp = key === "XML:com.adobe.xmp" || key === "Raw profile type xmp";
      const isExif = key === "Raw profile type exif" || key === "Raw profile type APP1";
      if (t && (isXmp || isExif)) {
        if (t.text === null) scan.unknown.push(`png ${type} ${key}`);
        else if (key === "XML:com.adobe.xmp") scan = merge(scan, null, t.text);
        else {
          const bytes = rawProfile(t.text);
          if (!bytes) scan.unknown.push(`png ${key}`);
          else if (isXmp) scan = merge(scan, null, bytes.toString("utf8"));
          else scan = merge(scan, bytes.toString("latin1", 0, 6) === "Exif\0\0" ? bytes.subarray(6) : bytes, null);
        }
      }
    }
    if (type === "IEND") return scan;
    i += 12 + len;
  }
  scan.unknown.push("png truncated");
  return scan;
}

function webp(b: Buffer): MetaScan {
  let scan = fresh();
  let i = 12;
  for (let guard = 0; guard < 10000 && i + 8 <= b.length; guard++) {
    const type = b.toString("latin1", i, i + 4);
    const len = b.readUInt32LE(i + 4);
    if (i + 8 + len > b.length) break;
    const body = b.subarray(i + 8, i + 8 + len);
    if (type === "EXIF") scan = merge(scan, body.toString("latin1", 0, 6) === "Exif\0\0" ? body.subarray(6) : body, null);
    else if (type === "XMP ") scan = merge(scan, null, body.toString("utf8"));
    i += 8 + len + (len % 2);
  }
  if (i < b.length) scan.unknown.push("webp truncated");
  return scan;
}

/** The metadata of a JPEG / PNG / WebP; anything else is `unknown` (not scanned — never read as "no GPS"). */
export function scanMeta(b: Buffer): MetaScan {
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) return jpeg(b);
  if (b.length >= 8 && b.toString("latin1", 1, 4) === "PNG") return png(b);
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return webp(b);
  if (b.length >= 12 && b.toString("latin1", 4, 8) === "ftyp") return { ...fresh(), unknown: ["heif"] };
  return { ...fresh(), unknown: ["format"] };
}

/** A position is present in the picture's metadata (EXIF GPS block with entries, or an XMP GPS field). */
export const hasGps = (m: MetaScan) => m.gps || m.xmpGps;
