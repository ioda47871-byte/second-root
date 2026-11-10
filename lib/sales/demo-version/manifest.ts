/**
 * DEV-196b (spec docs/design/DEV-196-demo-admin-spec.md §4.1・§4.2・§5.2・§6.4 step 5・§7.1・T9・T10・T11): the manifest of
 * one uploaded demo version (B方式 page + photos + renders), the URL path ↔ manifest name mapping, the size limits,
 * the normalised bundle hash and the byte checks the server's finalize runs on every object.
 *
 * PRODUCER CONTRACT (review round 2 L2): every photo and render must be packaged as sRGB with NO ICC profile and NO
 * metadata — the worker converts to sRGB and strips ICC, EXIF, XMP, IPTC and comments before packaging (e.g. sharp
 * `.toColorspace("srgb")` without `.withMetadata()` / `.keepIccProfile()`). The server does not convert anything: a
 * JPEG with APP2 (ICC) or any segment other than those decoding needs, any byte after EOI, or a WebP with an ICCP /
 * EXIF / XMP chunk or their VP8X flags is refused (`FILE_IMAGE_METADATA`), fail closed.
 *
 * Pure: no I/O, no env, no network. The caller reads the bytes (Storage, upload body) and passes them in.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { readPhotoHeader } from "@/lib/design-agent/quality-pipeline/photo-rights";

export const MANIFEST_VERSION = 1;

/** §5.2: sizes. A file larger than the bucket's per-object limit is never accepted. */
export const ARTIFACT_LIMITS = {
  fileBytes: 4 * 1024 * 1024,
  htmlBytes: 384 * 1024,
  cssBytes: 256 * 1024,
  photoBytes: 2_000_000,
  imageSidePx: 4096,
  files: 40,
  totalBytes: 15 * 1024 * 1024,
} as const;

export const ARTIFACT_ROLES = ["html", "css", "photo", "render"] as const;
export type ArtifactRole = (typeof ARTIFACT_ROLES)[number];

export const ARTIFACT_CONTENT_TYPES = ["text/html", "text/css", "image/webp", "image/jpeg"] as const;
export type ArtifactContentType = (typeof ARTIFACT_CONTENT_TYPES)[number];

export const PHOTO_RANGES = ["desktop", "tablet", "mobile"] as const;
export const RENDER_VIEWPORTS = ["desktop_1440", "tablet_768", "mobile_390"] as const;
export type RenderViewport = (typeof RENDER_VIEWPORTS)[number];
/** §7.2: a version without these two renders cannot be quality-approved. */
export const REQUIRED_RENDERS: readonly RenderViewport[] = ["desktop_1440", "mobile_390"];

export const HTML_NAME = "page/index.html";
export const CSS_NAME = "page/style.css";
/** `page/photos/<slot>-<range>.<webp|jpg>`; the slot has no hyphen, so the range is unambiguous. */
export const PHOTO_NAME = /^page\/photos\/([a-z][a-z0-9_]{0,39})-(desktop|tablet|mobile)\.(webp|jpg)$/;
export const RENDER_NAME = /^renders\/(desktop_1440|tablet_768|mobile_390)\.webp$/;

/** The role and content type a manifest name must have (§5.2 is the only source of these names). null: not allowed. */
export function roleOfName(name: string): { role: ArtifactRole; contentType: ArtifactContentType } | null {
  if (name === HTML_NAME) return { role: "html", contentType: "text/html" };
  if (name === CSS_NAME) return { role: "css", contentType: "text/css" };
  const p = PHOTO_NAME.exec(name);
  if (p) return { role: "photo", contentType: p[3] === "webp" ? "image/webp" : "image/jpeg" };
  if (RENDER_NAME.test(name)) return { role: "render", contentType: "image/webp" };
  return null;
}

export type ViewScope = "a" | "p";

/**
 * §5.2 (the one mapping, owner decision 2026-11-10): the path after `/demo-frame/<scope>/<token>/` → the manifest name.
 * The page's files are served with `page/` dropped; renders keep their name and are served in scope `a` only.
 * Anything else (`..`, percent-encoding, query, backslash, `page/…` in the URL, an empty segment) → null (404).
 * The result is only a candidate: the caller must still find it in the version's manifest.
 */
export function urlPathToManifestName(scope: ViewScope, urlPath: string): string | null {
  if (typeof urlPath !== "string" || urlPath.length === 0 || urlPath.length > 120) return null;
  // the route receives decoded segments; anything outside this plain alphabet is not one of our names
  if (!/^[a-z0-9_./-]+$/.test(urlPath)) return null;
  if (urlPath === "index.html") return HTML_NAME;
  if (urlPath === "style.css") return CSS_NAME;
  if (urlPath.startsWith("photos/")) {
    const name = `page/${urlPath}`;
    return PHOTO_NAME.test(name) ? name : null;
  }
  if (urlPath.startsWith("renders/")) return scope === "a" && RENDER_NAME.test(urlPath) ? urlPath : null;
  return null;
}

/** The inverse: the URL path (relative to the token) a manifest name is served at in a scope; null if not served there. */
export function manifestNameToUrlPath(scope: ViewScope, name: string): string | null {
  const role = roleOfName(name);
  if (!role) return null;
  if (role.role === "render") return scope === "a" ? name : null;
  return name.slice("page/".length);
}

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const ManifestFile = z.strictObject({
  name: z.string().min(1).max(120),
  role: z.enum(ARTIFACT_ROLES),
  sha256: Sha256,
  bytes: z.number().int().positive().max(ARTIFACT_LIMITS.fileBytes),
  content_type: z.enum(ARTIFACT_CONTENT_TYPES),
  width: z.number().int().positive().max(ARTIFACT_LIMITS.imageSidePx).optional(),
  height: z.number().int().positive().max(ARTIFACT_LIMITS.imageSidePx).optional(),
});
export type ManifestFile = z.infer<typeof ManifestFile>;

export const ArtifactManifest = z.strictObject({
  version: z.literal(MANIFEST_VERSION),
  files: z.array(ManifestFile).min(2).max(ARTIFACT_LIMITS.files),
});
export type ArtifactManifest = z.infer<typeof ArtifactManifest>;

export type ManifestCode =
  | "MANIFEST_SCHEMA"
  | "MANIFEST_NAME_NOT_ALLOWED"
  | "MANIFEST_ROLE_MISMATCH"
  | "MANIFEST_CONTENT_TYPE_MISMATCH"
  | "MANIFEST_DUPLICATE_NAME"
  | "MANIFEST_HTML_COUNT"
  | "MANIFEST_CSS_COUNT"
  | "MANIFEST_FILE_TOO_LARGE"
  | "MANIFEST_TOTAL_TOO_LARGE"
  | "MANIFEST_IMAGE_DIMENSIONS_MISSING"
  | "MANIFEST_DIMENSIONS_ON_TEXT";

export type ManifestResult = { ok: true; manifest: ArtifactManifest } | { ok: false; codes: ManifestCode[] };

/**
 * Validates an untrusted manifest (from the worker's package). Every problem is returned as a fixed code, never free
 * text. The array length is checked before zod sees the elements (an oversized array is refused without walking it).
 */
export function validateManifest(raw: unknown): ManifestResult {
  if (typeof raw !== "object" || raw === null) return { ok: false, codes: ["MANIFEST_SCHEMA"] };
  const files = (raw as { files?: unknown }).files;
  if (!Array.isArray(files) || files.length > ARTIFACT_LIMITS.files) return { ok: false, codes: ["MANIFEST_SCHEMA"] };
  const parsed = ArtifactManifest.safeParse(raw);
  if (!parsed.success) return { ok: false, codes: ["MANIFEST_SCHEMA"] };
  const m = parsed.data;
  const codes = new Set<ManifestCode>();
  const seen = new Set<string>();
  let total = 0;
  for (const f of m.files) {
    if (seen.has(f.name)) codes.add("MANIFEST_DUPLICATE_NAME");
    seen.add(f.name);
    total += f.bytes;
    const expected = roleOfName(f.name);
    if (!expected) {
      codes.add("MANIFEST_NAME_NOT_ALLOWED");
      continue;
    }
    if (expected.role !== f.role) codes.add("MANIFEST_ROLE_MISMATCH");
    if (expected.contentType !== f.content_type) codes.add("MANIFEST_CONTENT_TYPE_MISMATCH");
    const limit = f.role === "html" ? ARTIFACT_LIMITS.htmlBytes : f.role === "css" ? ARTIFACT_LIMITS.cssBytes : f.role === "photo" ? ARTIFACT_LIMITS.photoBytes : ARTIFACT_LIMITS.fileBytes;
    if (f.bytes > limit) codes.add("MANIFEST_FILE_TOO_LARGE");
    const image = f.role === "photo" || f.role === "render";
    if (image && (f.width === undefined || f.height === undefined)) codes.add("MANIFEST_IMAGE_DIMENSIONS_MISSING");
    if (!image && (f.width !== undefined || f.height !== undefined)) codes.add("MANIFEST_DIMENSIONS_ON_TEXT");
  }
  if (m.files.filter((f) => f.name === HTML_NAME).length !== 1) codes.add("MANIFEST_HTML_COUNT");
  if (m.files.filter((f) => f.name === CSS_NAME).length !== 1) codes.add("MANIFEST_CSS_COUNT");
  if (total > ARTIFACT_LIMITS.totalBytes) codes.add("MANIFEST_TOTAL_TOO_LARGE");
  return codes.size ? { ok: false, codes: [...codes] } : { ok: true, manifest: m };
}

/** The manifest's files sorted by name, with only the identity fields (the canonical form behind `bundle_sha256`). */
export function canonicalManifest(m: ArtifactManifest): string {
  const files = [...m.files]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((f) => ({ name: f.name, role: f.role, sha256: f.sha256, bytes: f.bytes, content_type: f.content_type }));
  return JSON.stringify({ version: m.version, files });
}

/** §4.1 `bundle_sha256`: the version's identity. File order and dimensions do not change it; any byte of any file does. */
export function bundleSha256(m: ArtifactManifest): string {
  return sha256Hex(canonicalManifest(m));
}

export const sha256Hex = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

/** §5.2・§7.2: the renders a manifest carries, and whether the required ones (desktop 1440, mobile 390) are there. */
export function manifestRenders(m: ArtifactManifest): { present: RenderViewport[]; missingRequired: RenderViewport[] } {
  const present = RENDER_VIEWPORTS.filter((v) => m.files.some((f) => f.name === `renders/${v}.webp`));
  return { present, missingRequired: REQUIRED_RENDERS.filter((v) => !present.includes(v)) };
}

/** The photos of the page, as the URL paths the HTML/CSS may reference (`photos/<name>`). */
export function photoUrlPaths(m: ArtifactManifest): Set<string> {
  return new Set(m.files.filter((f) => f.role === "photo").map((f) => f.name.slice("page/".length)));
}

export type FileBytesCode =
  | "FILE_HASH_MISMATCH"
  | "FILE_SIZE_MISMATCH"
  | "FILE_NOT_UTF8"
  | "FILE_NOT_AN_IMAGE"
  | "FILE_FORMAT_MISMATCH"
  | "FILE_DIMENSIONS_MISMATCH"
  | "FILE_IMAGE_TOO_LARGE"
  | "FILE_IMAGE_METADATA";

/**
 * T9・T10: the bytes of one object against its manifest entry. Re-hashes, re-measures the size, checks text is UTF-8
 * and an image's magic bytes, format and pixel size (an HTML file named .webp is refused), and refuses image metadata
 * (EXIF / XMP; §5.2 "EXIF・GPS なし").
 */
export function checkFileBytes(entry: ManifestFile, bytes: Uint8Array): { ok: true } | { ok: false; codes: FileBytesCode[] } {
  const codes = new Set<FileBytesCode>();
  if (bytes.byteLength !== entry.bytes) codes.add("FILE_SIZE_MISMATCH");
  if (sha256Hex(bytes) !== entry.sha256) codes.add("FILE_HASH_MISMATCH");
  if (entry.role === "html" || entry.role === "css") {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      codes.add("FILE_NOT_UTF8");
    }
  } else {
    const h = readPhotoHeader(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    if (!h.ok) codes.add("FILE_NOT_AN_IMAGE");
    else {
      const want = entry.content_type === "image/webp" ? "webp" : "jpeg";
      if (h.info.format !== want) codes.add("FILE_FORMAT_MISMATCH");
      if (h.info.width !== entry.width || h.info.height !== entry.height) codes.add("FILE_DIMENSIONS_MISMATCH");
      if (h.info.width > ARTIFACT_LIMITS.imageSidePx || h.info.height > ARTIFACT_LIMITS.imageSidePx) codes.add("FILE_IMAGE_TOO_LARGE");
      if (h.info.orientation !== 1 || hasImageMetadata(bytes)) codes.add("FILE_IMAGE_METADATA");
    }
  }
  return codes.size ? { ok: false, codes: [...codes] } : { ok: true };
}

/**
 * §5.2 "EXIF・GPS なし" (review round 1 L3): true unless the image holds only what decoding needs. An ALLOWLIST:
 *  - JPEG: SOI, APP0 "JFIF", APP14 "Adobe", DQT, DHT, DAC, DRI, SOF*, SOS (+ its entropy-coded data and RSTn), EOI.
 *    Any other segment — APP1 (EXIF / XMP), APP2 (ICC), APP13 (IPTC / Photoshop), other APPn, COM — is metadata.
 *  - WebP: the chunks VP8, VP8L, ALPH and VP8X with at most the alpha flag. EXIF, XMP, ICCP, animation and unknown
 *    chunks (or their VP8X flags) are metadata.
 * A malformed structure also answers true (fail closed). Anything that is neither JPEG nor WebP answers false (the
 * format check refuses it).
 */
export function hasImageMetadata(b: Uint8Array): boolean {
  const ascii = (at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i < b.length) {
      if (b[i] !== 0xff) return true;
      // fill bytes
      while (b[i] === 0xff && b[i + 1] === 0xff) i++;
      if (i + 1 >= b.length) return true;
      const m = b[i + 1]!;
      // EOI ends the file: any byte after it (a trailer, an appended file) is refused (review round 2 L1)
      if (m === 0xd9) return i + 2 !== b.length;
      if (m >= 0xd0 && m <= 0xd7) {
        i += 2;
        continue;
      }
      if (i + 4 > b.length) return true;
      const len = (b[i + 2]! << 8) | b[i + 3]!;
      if (len < 2 || i + 2 + len > b.length) return true;
      const body = i + 4;
      const decodeSegment =
        m === 0xdb || m === 0xc4 || m === 0xcc || m === 0xdd || m === 0xda ||
        (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) ||
        (m === 0xe0 && len >= 7 && ascii(body, 5) === "JFIF\0") ||
        (m === 0xee && len >= 7 && ascii(body, 5) === "Adobe");
      if (!decodeSegment) return true;
      i += 2 + len;
      if (m === 0xda) {
        // entropy-coded data: up to the next marker that is not a stuffed 0x00 or a restart marker
        while (i + 1 < b.length && !(b[i] === 0xff && b[i + 1] !== 0x00 && !(b[i + 1]! >= 0xd0 && b[i + 1]! <= 0xd7))) i++;
        if (i + 1 >= b.length) return false; // truncated after the scan: no metadata seen
      }
    }
    return false;
  }
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    for (let i = 12; i < b.length; ) {
      if (i + 8 > b.length) return true;
      const id = ascii(i, 4);
      const size = (b[i + 4]! | (b[i + 5]! << 8) | (b[i + 6]! << 16) | (b[i + 7]! << 24)) >>> 0;
      if (i + 8 + size > b.length) return true;
      if (id === "VP8X") {
        if (size < 10 || (b[i + 8]! & ~0x10) !== 0) return true; // only the alpha flag (0x10)
      } else if (id !== "VP8 " && id !== "VP8L" && id !== "ALPH") return true;
      i += 8 + size + (size & 1);
    }
    return false;
  }
  return false;
}
