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
import { parse, type DefaultTreeAdapterTypes } from "parse5";
import sharp, { type Metadata, type OutputInfo, type WebpOptions } from "sharp";
import { cssTokens } from "@/lib/sales/demo-version/css-scan";
import { ARTIFACT_LIMITS, PHOTO_NAME } from "@/lib/sales/demo-version/manifest";

/** A photo of the swap's copy, as its HTML references it. The slot id is the swap's (`ph-…`, hyphens allowed). */
export const SWAP_PHOTO_URL = /^photos\/(ph-[a-z0-9-]{1,36})-(desktop|tablet|mobile)\.(png|jpg)$/;
/** A `photos/…` reference, for the marker proof (the rewrite itself works on parsed positions). */
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

const PHOTOS = "photos/";
const indexesOf = (text: string, needle: string) => {
  const out: number[] = [];
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) out.push(i);
  return out;
};
const ASCII_WS = /[\t\n\f\r ]/;

export type Rewritten = { text: string; refs: string[] };
type Span = { start: number; end: number; from: string };

/** Applies the spans (each exactly a map key) and checks that they cover EVERY `photos/` of the raw text. */
function applySpans(text: string, spans: Span[], map: ReadonlyMap<string, string>, where: string): Rewritten {
  const starts = new Set(spans.map((s) => s.start));
  for (const i of indexesOf(text, PHOTOS)) if (!starts.has(i)) throw new PhotoError("PHOTO_REF_POSITION", [where, String(i)]);
  let out = text;
  for (const s of [...spans].sort((a, b) => b.start - a.start)) {
    const to = map.get(s.from);
    if (!to || text.slice(s.start, s.end) !== s.from) throw new PhotoError("PHOTO_REF_UNKNOWN", [s.from]);
    out = out.slice(0, s.start) + to + out.slice(s.end);
  }
  return { text: out, refs: spans.map((s) => s.from) };
}

/**
 * DEV-196s (review round 1 L3): rewrites the photo URLs of the PARSED HTML only where a browser loads a picture from
 * them — `<img src>`, `<img srcset>` and `<source srcset>` (each srcset candidate's URL) — and refuses (fail closed)
 * a `photos/` anywhere else: a text node, a comment, `alt`, `title`, `data-*`, any other attribute, a srcset
 * descriptor, a URL that is not exactly one of the copy's photos (`myphotos/…`), or a value written with character
 * references. Every `photos/` of the raw bytes must be one of the rewritten URLs.
 */
export function rewriteHtmlPhotoUrls(html: string, map: ReadonlyMap<string, string>): Rewritten {
  const doc = parse(html, { sourceCodeLocationInfo: true });
  const spans: Span[] = [];
  const stack: DefaultTreeAdapterTypes.Node[] = [doc];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.nodeName === "#text" || node.nodeName === "#comment") {
      const v = node.nodeName === "#text" ? (node as DefaultTreeAdapterTypes.TextNode).value : (node as DefaultTreeAdapterTypes.CommentNode).data;
      if (v.includes(PHOTOS)) throw new PhotoError("PHOTO_REF_POSITION", [node.nodeName]);
    }
    if ("tagName" in node) {
      const el = node as DefaultTreeAdapterTypes.Element;
      for (const a of el.attrs) {
        const name = a.prefix ? `${a.prefix}:${a.name}` : a.name;
        if (!a.value.includes(PHOTOS)) continue;
        const allowed = (el.tagName === "img" && (name === "src" || name === "srcset")) || (el.tagName === "source" && name === "srcset");
        if (!allowed || el.namespaceURI !== "http://www.w3.org/1999/xhtml") throw new PhotoError("PHOTO_REF_POSITION", [`${el.tagName} ${name}`]);
        const loc = el.sourceCodeLocation?.attrs?.[name];
        if (!loc) throw new PhotoError("PHOTO_REF_POSITION", [`${el.tagName} ${name}`]);
        let vs = html.indexOf("=", loc.startOffset) + 1;
        let ve = loc.endOffset;
        if (vs <= 0 || vs > ve) throw new PhotoError("PHOTO_REF_POSITION", [`${el.tagName} ${name}`]);
        while (vs < ve && ASCII_WS.test(html[vs]!)) vs += 1;
        if ((html[vs] === '"' || html[vs] === "'") && html[ve - 1] === html[vs]) {
          vs += 1;
          ve -= 1;
        }
        if (html.slice(vs, ve) !== a.value) throw new PhotoError("PHOTO_REF_ENCODED", [`${el.tagName} ${name}`]);
        if (name === "src") {
          spans.push({ start: vs, end: ve, from: a.value });
          continue;
        }
        // srcset: comma-separated candidates "<url> [descriptor]"; only the URL may hold photos/
        let at = 0;
        for (const cand of a.value.split(",")) {
          let i = 0;
          while (i < cand.length && ASCII_WS.test(cand[i]!)) i += 1;
          let j = i;
          while (j < cand.length && !ASCII_WS.test(cand[j]!)) j += 1;
          const url = cand.slice(i, j);
          if (cand.slice(j).includes(PHOTOS)) throw new PhotoError("PHOTO_REF_POSITION", [`${el.tagName} srcset descriptor`]);
          if (url.includes(PHOTOS)) spans.push({ start: vs + at + i, end: vs + at + j, from: url });
          at += cand.length + 1;
        }
      }
      if (el.tagName === "template") stack.push(...(el as DefaultTreeAdapterTypes.Template).content.childNodes);
    }
    if ("childNodes" in node) stack.push(...(node as DefaultTreeAdapterTypes.ParentNode).childNodes);
  }
  return applySpans(html, spans, map, "html");
}

/**
 * The same for the CSS: only the value of a `url(photos/…)` / `url("photos/…")` token is rewritten. A `photos/`
 * anywhere else (a comment, a string outside url(), an escape that a tokenizer would decode into one, a `myphotos/`
 * tail) is refused: every `photos/` of the raw text must be such a url value, and the CSS tokenizer must see exactly
 * as many tokens holding `photos/`.
 */
export function rewriteCssPhotoUrls(css: string, map: ReadonlyMap<string, string>): Rewritten {
  const spans: Span[] = [];
  for (const m of css.matchAll(/url\(([\t\n\f\r ]*)(["']?)(photos\/[^"'()\s\\]*)\2[\t\n\f\r ]*\)/gi)) {
    const before = m.index === 0 ? "" : css[m.index - 1]!;
    if (/[A-Za-z0-9_\\-]/.test(before)) continue; // not a url() token (e.g. xurl(…)): left for the position check
    const start = m.index + 4 + m[1]!.length + m[2]!.length;
    spans.push({ start, end: start + m[3]!.length, from: m[3]! });
  }
  const tokens = cssTokens(css).filter((t) => "v" in t && typeof t.v === "string" && t.v.includes(PHOTOS));
  if (tokens.length !== spans.length) throw new PhotoError("PHOTO_REF_POSITION", ["css tokens"]);
  return applySpans(css, spans, map, "css");
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

export type PhotoOriginal = { sha256: string; bytes: number; format: "png" | "jpeg"; width: number; height: number; icc: boolean; bit_depth: 8 | 16 };
export type ConvertedPhoto = {
  webp: Uint8Array;
  width: number;
  height: number;
  /**
   * lossless: the original's pixels exactly. lossless_after_srgb8_conversion (review round 1 nit): the original was
   * 16-bit or carried an ICC profile, so the pixels were converted to 8-bit sRGB first (then encoded losslessly) —
   * not the original's pixels. lossy: at `quality` (the highest that fits the limit), after that conversion if any.
   */
  mode: "lossless" | "lossless_after_srgb8_conversion" | "lossy";
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
  const bitDepth = meta.depth === "uchar" ? 8 : meta.depth === "ushort" ? 16 : null;
  if (bitDepth === null) throw new PhotoError("PHOTO_DEPTH_UNSUPPORTED");
  const original: PhotoOriginal = { sha256: sha256(bytes), bytes: bytes.byteLength, format: meta.format, width: meta.width, height: meta.height, icc: Boolean(meta.icc), bit_depth: bitDepth };
  const converted = original.icc || bitDepth !== 8;
  // sharp converts an embedded profile to sRGB on output and, without withMetadata / keepIccProfile, writes none
  const encode = (o: WebpOptions) => sharp(bytes, { failOn: "warning" }).toColorspace("srgb").webp({ ...PHOTO_WEBP, ...o }).toBuffer({ resolveWithObject: true });
  const done = (r: { data: Buffer; info: OutputInfo }, mode: ConvertedPhoto["mode"], quality: number | null): ConvertedPhoto => {
    if (r.info.width !== meta.width || r.info.height !== meta.height) throw new PhotoError("PHOTO_SIZE_CHANGED");
    return { webp: new Uint8Array(r.data), width: r.info.width, height: r.info.height, mode, quality, original };
  };
  const lossless = await encode({ lossless: true });
  if (lossless.data.byteLength <= limit) return done(lossless, converted ? "lossless_after_srgb8_conversion" : "lossless", null);
  for (let q = 100; q >= PHOTO_MIN_QUALITY; q -= 1) {
    const lossy = await encode({ quality: q });
    if (lossy.data.byteLength <= limit) return done(lossy, "lossy", q);
  }
  throw new PhotoError("PHOTO_TOO_LARGE");
}
