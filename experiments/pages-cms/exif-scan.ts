/**
 * Issue #380 live trial: what metadata a picture carries, read from its bytes with no dependency and without decoding
 * — EXIF (and whether it holds a GPS block with entries, and the orientation), and XMP (and whether it mentions a GPS
 * position). JPEG (APP1 Exif / XMP), PNG (eXIf, iTXt / tEXt XMP), WebP (EXIF / XMP chunks). Bounds-checked: a cut or
 * malformed block reads as "not found", never as a crash. Used by live-trial-measure.ts to tell the published (fitted,
 * stripped) pictures from the originals in the repository.
 */

export type MetaScan = { exif: boolean; gps: boolean; orientation: number | null; xmp: boolean; xmpGps: boolean };

const NONE: MetaScan = { exif: false, gps: false, orientation: null, xmp: false, xmpGps: false };
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
  const out = { ...scan };
  if (tiff) {
    const t = scanTiff(tiff);
    if (t) {
      out.exif = true;
      out.gps ||= t.gps;
      out.orientation ??= t.orientation;
    }
  }
  if (xmpText !== null) {
    out.xmp = true;
    out.xmpGps ||= XMP_GPS.test(xmpText);
  }
  return out;
}

function jpeg(b: Buffer): MetaScan {
  let scan = { ...NONE };
  let i = 2;
  for (let guard = 0; guard < 1000 && i + 4 <= b.length; guard++) {
    if (b[i] !== 0xff) break;
    const marker = b[i + 1]!;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break; // image data: no more metadata segments
    const len = b.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > b.length) break;
    const body = b.subarray(i + 4, i + 2 + len);
    if (marker === 0xe1 && body.toString("latin1", 0, 6) === "Exif\0\0") scan = merge(scan, body.subarray(6), null);
    else if (marker === 0xe1 && body.toString("latin1", 0, 29) === "http://ns.adobe.com/xap/1.0/\0") scan = merge(scan, null, body.subarray(29).toString("utf8"));
    i += 2 + len;
  }
  return scan;
}

function png(b: Buffer): MetaScan {
  let scan = { ...NONE };
  let i = 8;
  for (let guard = 0; guard < 10000 && i + 12 <= b.length; guard++) {
    const len = b.readUInt32BE(i);
    const type = b.toString("latin1", i + 4, i + 8);
    if (i + 12 + len > b.length) break;
    const body = b.subarray(i + 8, i + 8 + len);
    if (type === "eXIf") scan = merge(scan, body, null);
    else if ((type === "iTXt" || type === "tEXt") && body.toString("latin1", 0, 17) === "XML:com.adobe.xmp") scan = merge(scan, null, body.toString("utf8"));
    if (type === "IEND") break;
    i += 12 + len;
  }
  return scan;
}

function webp(b: Buffer): MetaScan {
  let scan = { ...NONE };
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
  return scan;
}

/** The metadata of a JPEG / PNG / WebP (anything else: nothing found). */
export function scanMeta(b: Buffer): MetaScan {
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) return jpeg(b);
  if (b.length >= 8 && b.toString("latin1", 1, 4) === "PNG") return png(b);
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return webp(b);
  return { ...NONE };
}

/** A position is present in the picture's metadata (EXIF GPS block with entries, or an XMP GPS field). */
export const hasGps = (m: MetaScan) => m.gps || m.xmpGps;
