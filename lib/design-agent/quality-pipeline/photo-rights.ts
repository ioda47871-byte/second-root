/**
 * DEV-163 (Issue #193 comment 6601921731, decision 3): the rights record of a real photo that may one day replace a
 * placeholder board in a research fidelity page (C), and the checks that refuse it before it is ever drawn.
 *
 * Nothing here acquires, generates or fetches a photo. A photo is handed over privately by a person and stored only in
 * the git-ignored `.intake/photos/` folder of the quality pipeline (design-library/research/quality-pipeline/.intake,
 * the same private folder as the reference originals). The public repository keeps only the derived record
 * (`toPublicPhotoRecord`): hash, size, format, kind of source, the rights as booleans, dates. Never the bytes, the
 * owner's name, the consent record or the path.
 *
 * Only two kinds of photo may enter at all:
 *  (a) photos the owner or a shop provides with permission to use them;
 *  (b) material whose terms clearly allow editing, cropping and commercial use (pinned by a hash of the terms).
 * Never a photo from another site, never one of the success cases, never a paid stock photo, never a picture of an
 * identifiable person or a real shop (the shops are fictional).
 *
 * DEV-185 (owner approval, 2026-11-05): a third kind, `ai_generated_demo`, for the AI demo pictures of a FICTIONAL
 * shop made by the owner-approved one-shot run (scripts/sales-design-worker/run-tsugute-photos-once.sh). It requires
 * `ai_provenance` (generator, model as reported, generated_at, prompt_sha256, approval_id, demo_only: true), is
 * refused unless the caller allows AI demo pictures for that shop (`aiDemoAllowed`: only the つぐ手 swap does), is
 * never allowed for a public site, and its public record says it is a demo image, not a real product, workshop or
 * craftsperson. Every other check applies to it unchanged.
 *
 * The record proves nothing about the bytes by itself: `checkPhotoRights` compares it with what was measured from the
 * file (`measurePhotoBytes`), and `resolvePrivatePhoto` refuses any path outside `.intake/photos/`, through a link
 * (symbolic or hard), or under a pipeline root that is itself a link.
 */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { z } from "zod";

/** The private folder, relative to the quality-pipeline root (design-library/research/quality-pipeline). */
export const PHOTO_INTAKE_DIR = ".intake/photos";
/** A plain file name directly in `.intake/photos/`: no sub-folder, no `..`, no leading dot. */
export const PRIVATE_PHOTO_PATH = /^\.intake\/photos\/[A-Za-z0-9][A-Za-z0-9_-]{0,80}\.(png|jpg|jpeg|webp)$/;
export const PHOTO_FORMATS = ["png", "jpeg", "webp"] as const;
export type PhotoFormat = (typeof PHOTO_FORMATS)[number];

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-](\d{2}):(\d{2})))?$/;
/**
 * A real calendar date (and, if given, a real time with its zone): 2026-02-31 or 9999-99-99 is not a date. The date
 * is round-tripped through Date.UTC, so a day that does not exist in its month is refused.
 */
export function isIsoDate(s: string): boolean {
  const m = ISO_DATE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (y < 1900 || t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return false;
  if (m[4] !== undefined) {
    if (Number(m[4]) > 23 || Number(m[5]) > 59 || (m[6] !== undefined && Number(m[6]) > 59)) return false;
    if (m[8] !== undefined && (Number(m[8]) > 23 || Number(m[9]) > 59)) return false;
  }
  return true;
}
/** The UTC day (YYYY-MM-DD) of a valid ISO date: a date alone is that day; a time with a zone is moved to UTC first. */
export const utcDay = (s: string) => (s.length === 10 ? s : new Date(s).toISOString().slice(0, 10));
const IsoDate = z.string().refine(isIsoDate, "INVALID_DATE");
const Ref = z.string().trim().min(1).max(300);

/** DEV-185: how an AI demo picture was made (private; the public record keeps only the demo label and the hashes). */
export const AiProvenance = z.strictObject({
  /** the means, e.g. "codex-cli image_generation (owner WSL, sr-designgen jail, one run)" */
  generator: Ref,
  /** the model name as the tool reported it (session log); "unknown" is not accepted */
  model: z.string().regex(/^[0-9A-Za-z._-]{1,60}$/).refine((m) => m.toLowerCase() !== "unknown", "MODEL_UNKNOWN"),
  generated_at: z.string().refine((s) => isIsoDate(s) && s.length > 10, "INVALID_DATE"),
  prompt_sha256: Sha256,
  approval_id: z.string().regex(/^[a-z0-9][a-z0-9._-]{3,95}$/),
  demo_only: z.literal(true),
  /**
   * DEV-185 (owner approval (a)): set only when the import enlarged the picture to reach its slot's target — the
   * smallest factor that does, never more than 2×, with the existing sharp (lanczos3). The record's sha256, width and
   * height are the enlarged file's; this keeps the original's. Real photos are never enlarged (no such field for them).
   */
  upscale: z
    .strictObject({
      original_width: z.number().int().positive(),
      original_height: z.number().int().positive(),
      original_sha256: Sha256,
      factor: z.number().gt(1).max(2),
      method: z.literal("sharp-lanczos3"),
    })
    .optional(),
});
export type AiProvenance = z.infer<typeof AiProvenance>;

export const PhotoRights = z
  .strictObject({
    schema: z.literal("photo_rights_v0"),
    asset_id: z.string().regex(/^photo-[a-z0-9][a-z0-9-]{1,60}$/),
    sha256: Sha256,
    bytes: z.number().int().positive().max(50_000_000),
    width: z.number().int().positive().max(20_000),
    height: z.number().int().positive().max(20_000),
    format: z.enum(PHOTO_FORMATS),
    /** owner_provided / shop_provided: (a). licensed_stock_with_terms: (b), free material whose terms are pinned. */
    source_kind: z.enum(["owner_provided", "shop_provided", "licensed_stock_with_terms", "ai_generated_demo"]),
    /** who holds the rights (private; never copied into the public record) */
    owner: Ref,
    /** a licence id (e.g. CC0-1.0) or a reference to the written permission or terms */
    license: Ref,
    /** sha256 of the terms text as received, required for licensed_stock_with_terms */
    terms_sha256: Sha256.optional(),
    /** paid material needs a separate approval (Issue #193): any paid photo is refused here */
    paid: z.boolean(),
    allowed_uses: z.strictObject({ edit: z.boolean(), crop: z.boolean(), commercial: z.boolean(), public_web: z.boolean() }),
    /** where the permission is kept (private): an e-mail id, a signed form id… */
    consent_record_ref: Ref,
    received_at: IsoDate,
    /** the last day the photo may be used, or null for "no end date": the field must be there either way */
    expiry: IsoDate.nullable(),
    private_path: z.string().regex(PRIVATE_PHOTO_PATH, "the photo must be a plain file directly under .intake/photos/"),
    /** the shops are fictional: a photo of a real, recognisable shop or person is never used */
    depicts_identifiable_person: z.boolean(),
    depicts_real_shop: z.boolean(),
    /** public use of a real shop's photo needs the client's written confirmation */
    client_confirmation_ref: Ref.optional(),
    /** DEV-185: required for (and only for) ai_generated_demo */
    ai_provenance: AiProvenance.optional(),
  })
  .superRefine((r, ctx) => {
    const ext = r.private_path.split(".").pop();
    const fmt = ext === "jpg" ? "jpeg" : ext;
    if (fmt !== r.format) ctx.addIssue({ code: "custom", path: ["private_path"], message: "FORMAT_EXTENSION_MISMATCH" });
  });
export type PhotoRights = z.infer<typeof PhotoRights>;

/**
 * What the file's header says. width and height are as the photo is SHOWN: a JPEG whose EXIF orientation is 5–8
 * (a phone held upright) has its stored width and height swapped. orientation is the EXIF value (1 when absent, and
 * always 1 for PNG and WebP).
 */
export type PhotoBytesInfo = { sha256: string; bytes: number; width: number; height: number; format: PhotoFormat; orientation: number };
export type PhotoPurpose = "quality_verification" | "public_site";

export type PhotoRightsCode =
  | "SCHEMA_INVALID"
  | "RIGHTS_MISSING_SOURCE"
  | "RIGHTS_MISSING_OWNER"
  | "RIGHTS_MISSING_LICENSE"
  | "RIGHTS_MISSING_TERMS_SNAPSHOT"
  | "RIGHTS_MISSING_ALLOWED_USES"
  | "RIGHTS_MISSING_CONSENT"
  | "RIGHTS_MISSING_RECEIVED_AT"
  | "RIGHTS_MISSING_EXPIRY"
  | "RIGHTS_DATE_INVALID"
  | "RIGHTS_RECEIVED_IN_FUTURE"
  | "RIGHTS_MISSING_PAID"
  | "RIGHTS_MISSING_SUBJECT"
  | "NOT_ALLOWED_FOR_EDIT"
  | "NOT_ALLOWED_FOR_CROP"
  | "NOT_ALLOWED_FOR_COMMERCIAL"
  | "NOT_ALLOWED_FOR_PUBLIC_WEB"
  | "CLIENT_CONFIRMATION_MISSING"
  | "PAID_SOURCE_NOT_APPROVED"
  | "IDENTIFIABLE_PERSON"
  | "REAL_SHOP_DEPICTED"
  | "FORBIDDEN_SOURCE_HASH"
  | "RIGHTS_EXPIRED"
  | "PATH_NOT_PRIVATE"
  | "FORMAT_EXTENSION_MISMATCH"
  | "HASH_MISMATCH"
  | "SIZE_MISMATCH"
  | "DIMENSION_MISMATCH"
  | "FORMAT_MISMATCH"
  | "RIGHTS_MISSING_AI_PROVENANCE"
  | "AI_PROVENANCE_ON_NON_AI_SOURCE"
  | "AI_DEMO_NOT_ALLOWED"
  | "AI_DEMO_NOT_FOR_PUBLIC_SITE"
  | "AI_GENERATED_IN_FUTURE"
  | "UPSCALE_RECORD_INVALID";

/** A missing or malformed rights field is named by what is missing, never folded into SCHEMA_INVALID. */
const MISSING: Record<string, PhotoRightsCode> = {
  source_kind: "RIGHTS_MISSING_SOURCE",
  owner: "RIGHTS_MISSING_OWNER",
  license: "RIGHTS_MISSING_LICENSE",
  terms_sha256: "RIGHTS_MISSING_TERMS_SNAPSHOT",
  allowed_uses: "RIGHTS_MISSING_ALLOWED_USES",
  consent_record_ref: "RIGHTS_MISSING_CONSENT",
  received_at: "RIGHTS_MISSING_RECEIVED_AT",
  expiry: "RIGHTS_MISSING_EXPIRY",
  paid: "RIGHTS_MISSING_PAID",
  depicts_identifiable_person: "RIGHTS_MISSING_SUBJECT",
  depicts_real_shop: "RIGHTS_MISSING_SUBJECT",
  private_path: "PATH_NOT_PRIVATE",
  ai_provenance: "RIGHTS_MISSING_AI_PROVENANCE",
};

export type PhotoRightsResult = { ok: true; record: PhotoRights } | { ok: false; codes: PhotoRightsCode[]; issues: string[] };

export type PhotoRightsOptions = {
  /** what the photo is for. quality_verification: private renders only. public_site: also public web + client confirmation */
  purpose?: PhotoPurpose;
  /** the date the check is made (ISO). Defaults to today (UTC): an expired record is always refused. Tests pin it. */
  now?: string;
  /**
   * Hashes that must never enter: the success-case pictures and the reference originals. Required, so that no caller
   * can forget it; `loadForbiddenSha256` reads them from the originals inventory.
   */
  forbiddenSha256: ReadonlySet<string>;
  /**
   * DEV-185: whether an `ai_generated_demo` record may pass at all. Off unless the caller is the swap of a fictional
   * shop it lists (photo-swap.ts AI_DEMO_SHOPS); every other caller refuses it (AI_DEMO_NOT_ALLOWED).
   */
  aiDemoAllowed?: boolean;
};

/** The originals inventory: every success-case picture the repository records (originals and registered previews). */
export const ORIGINALS_INVENTORY = "design-library/research/quality-pipeline/originals-inventory.json";

/**
 * The forbidden hashes, from the originals inventory (the one source of truth for the success-case pictures): the
 * picture files in the repository and every original and preview each case records. Throws on an empty or malformed
 * inventory: a gate with an empty list would let a success-case picture through.
 */
export function loadForbiddenSha256(repoRoot: string): ReadonlySet<string> {
  const inv = z
    .object({
      repo_files: z.array(z.object({ sha256: Sha256 })),
      cases: z.array(z.object({ originals: z.array(z.object({ sha256: Sha256 })) })).min(1),
    })
    .parse(JSON.parse(readFileSync(join(repoRoot, ORIGINALS_INVENTORY), "utf8")));
  const set = new Set([...inv.repo_files.map((f) => f.sha256), ...inv.cases.flatMap((c) => c.originals.map((o) => o.sha256))]);
  if (set.size === 0) throw new Error(`${ORIGINALS_INVENTORY}: no hash to forbid`);
  return set;
}

/**
 * Refuses a photo whose rights record is incomplete, does not allow what the pipeline does with it (edit, crop,
 * commercial; and public web for a public site), or does not describe the bytes that were measured.
 * Every reason is returned, not only the first.
 */
export function checkPhotoRights(record: unknown, bytesInfo: PhotoBytesInfo | null, opts: PhotoRightsOptions): PhotoRightsResult {
  const purpose = opts.purpose ?? "quality_verification";
  if (opts.now !== undefined && !isIsoDate(opts.now)) throw new Error(`checkPhotoRights: now is not a date: ${opts.now}`);
  const today = opts.now === undefined ? new Date().toISOString().slice(0, 10) : utcDay(opts.now);
  const codes = new Set<PhotoRightsCode>();
  const issues: string[] = [];
  const parsed = PhotoRights.safeParse(record);
  if (!parsed.success) {
    for (const i of parsed.error.issues) {
      const key = String(i.path[0] ?? "");
      if (i.message === "FORMAT_EXTENSION_MISMATCH") codes.add("FORMAT_EXTENSION_MISMATCH");
      else if (i.message === "INVALID_DATE" && key !== "ai_provenance") codes.add("RIGHTS_DATE_INVALID");
      else codes.add(MISSING[key] ?? "SCHEMA_INVALID");
      issues.push(`${i.path.join(".") || "(root)"}: ${i.message}`);
    }
    return { ok: false, codes: [...codes], issues };
  }
  const r = parsed.data;
  if (r.source_kind === "licensed_stock_with_terms" && !r.terms_sha256) codes.add("RIGHTS_MISSING_TERMS_SNAPSHOT");
  if (r.source_kind === "ai_generated_demo") {
    if (!r.ai_provenance) codes.add("RIGHTS_MISSING_AI_PROVENANCE");
    else if (utcDay(r.ai_provenance.generated_at) > today) codes.add("AI_GENERATED_IN_FUTURE");
    const up = r.ai_provenance?.upscale;
    // the enlarged size must be the original × the recorded factor (±1 px of rounding)
    if (up && (Math.abs(r.width - up.original_width * up.factor) > 1 || Math.abs(r.height - up.original_height * up.factor) > 1)) codes.add("UPSCALE_RECORD_INVALID");
    if (!opts.aiDemoAllowed) codes.add("AI_DEMO_NOT_ALLOWED");
    if (purpose === "public_site") codes.add("AI_DEMO_NOT_FOR_PUBLIC_SITE");
  } else if (r.ai_provenance) codes.add("AI_PROVENANCE_ON_NON_AI_SOURCE");
  if (r.paid) codes.add("PAID_SOURCE_NOT_APPROVED");
  if (!r.allowed_uses.edit) codes.add("NOT_ALLOWED_FOR_EDIT");
  if (!r.allowed_uses.crop) codes.add("NOT_ALLOWED_FOR_CROP");
  if (!r.allowed_uses.commercial) codes.add("NOT_ALLOWED_FOR_COMMERCIAL");
  if (purpose === "public_site") {
    if (!r.allowed_uses.public_web) codes.add("NOT_ALLOWED_FOR_PUBLIC_WEB");
    if (!r.client_confirmation_ref) codes.add("CLIENT_CONFIRMATION_MISSING");
  }
  if (r.depicts_identifiable_person) codes.add("IDENTIFIABLE_PERSON");
  if (r.depicts_real_shop) codes.add("REAL_SHOP_DEPICTED");
  if (opts.forbiddenSha256.has(r.sha256) || (bytesInfo && opts.forbiddenSha256.has(bytesInfo.sha256))) codes.add("FORBIDDEN_SOURCE_HASH");
  if (utcDay(r.received_at) > today) codes.add("RIGHTS_RECEIVED_IN_FUTURE");
  if (r.expiry !== null && utcDay(r.expiry) < today) codes.add("RIGHTS_EXPIRED");
  if (r.expiry !== null && utcDay(r.expiry) < utcDay(r.received_at)) {
    codes.add("SCHEMA_INVALID");
    issues.push("expiry: before received_at");
  }
  if (!bytesInfo) codes.add("HASH_MISMATCH");
  else {
    if (bytesInfo.sha256 !== r.sha256) codes.add("HASH_MISMATCH");
    if (bytesInfo.bytes !== r.bytes) codes.add("SIZE_MISMATCH");
    if (bytesInfo.width !== r.width || bytesInfo.height !== r.height) codes.add("DIMENSION_MISMATCH");
    if (bytesInfo.format !== r.format) codes.add("FORMAT_MISMATCH");
  }
  return codes.size ? { ok: false, codes: [...codes], issues } : { ok: true, record: r };
}

/** DEV-185: the label every public record of an AI demo picture carries. */
export const AI_DEMO_PUBLIC_LABEL = "AI-generated demo image (fictional shop). Not a real product, workshop or craftsperson. / デモ用のイメージ（AI 生成）。実在の商品・工房・職人ではありません。";

/** What may be written to the public repository about a photo: no bytes, no owner, no consent record, no path. */
export function toPublicPhotoRecord(r: PhotoRights) {
  return {
    schema: "photo_public_record_v0" as const,
    asset_id: r.asset_id,
    sha256: r.sha256,
    bytes: r.bytes,
    width: r.width,
    height: r.height,
    format: r.format,
    source_kind: r.source_kind,
    allowed_uses: { ...r.allowed_uses },
    received_at: r.received_at,
    expiry: r.expiry,
    client_confirmed: Boolean(r.client_confirmation_ref),
    bytes_committed: false as const,
    // DEV-185: an AI demo picture is labelled as such wherever its record is shown
    ...(r.source_kind === "ai_generated_demo"
      ? { demo_image: true as const, ai_generated: true as const, label: AI_DEMO_PUBLIC_LABEL,
          prompt_sha256: r.ai_provenance?.prompt_sha256 ?? null,
          upscale: r.ai_provenance?.upscale ? { original_width: r.ai_provenance.upscale.original_width, original_height: r.ai_provenance.upscale.original_height, factor: r.ai_provenance.upscale.factor, method: r.ai_provenance.upscale.method } : null }
      : {}),
  };
}

export type PhotoHeader = { ok: true; info: PhotoBytesInfo } | { ok: false; code: "NOT_A_PHOTO" | "PHOTO_EXIF_UNREADABLE" };

/**
 * Size, format and orientation from the file's own header (PNG IHDR, JPEG SOF + EXIF, WebP VP8/VP8L/VP8X). The
 * extension and the record are not trusted. A JPEG whose EXIF block is there but cannot be read is refused
 * (`PHOTO_EXIF_UNREADABLE`): its shown shape is unknown, and a crop computed on the wrong shape would be wrong.
 */
export function readPhotoHeader(buf: Buffer): PhotoHeader {
  const dims = readDims(buf);
  if (dims === null) return { ok: false, code: "NOT_A_PHOTO" };
  if ("error" in dims) return { ok: false, code: dims.error };
  const sha256 = createHash("sha256").update(buf).digest("hex");
  return { ok: true, info: { sha256, bytes: buf.length, ...dims } };
}

/** `readPhotoHeader`, null for anything that is not a readable photo. */
export function measurePhotoBytes(buf: Buffer): PhotoBytesInfo | null {
  const h = readPhotoHeader(buf);
  return h.ok ? h.info : null;
}

type Dims = { width: number; height: number; format: PhotoFormat; orientation: number };

function readDims(b: Buffer): Dims | { error: "PHOTO_EXIF_UNREADABLE" } | null {
  // PNG: signature, then the IHDR chunk
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a && b.toString("latin1", 12, 16) === "IHDR")
    return positive(b.readUInt32BE(16), b.readUInt32BE(20), "png");
  // JPEG: walk the segments to a start-of-frame, reading the EXIF orientation (APP1) on the way
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let orientation = 1;
    let exifSeen = false;
    let i = 2;
    while (i + 4 <= b.length) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1]!;
      if (m === 0xff) {
        i += 1;
        continue;
      }
      if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) {
        i += 2;
        continue;
      }
      const len = b.readUInt16BE(i + 2);
      if (len < 2) return null;
      if (m === 0xe1 && i + 10 <= b.length && b.toString("latin1", i + 4, i + 10) === "Exif\0\0") {
        // browsers read the first EXIF block; a second one could make the record disagree with what is shown, so refuse
        if (exifSeen) return { error: "PHOTO_EXIF_UNREADABLE" };
        exifSeen = true;
        const o = exifOrientation(b, i + 10, Math.min(b.length, i + 2 + len));
        if (o === null) return { error: "PHOTO_EXIF_UNREADABLE" };
        orientation = o;
      }
      const sof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
      if (sof) {
        if (i + 9 > b.length) return null;
        const [w, h] = [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
        const dims = orientation >= 5 ? positive(h, w, "jpeg") : positive(w, h, "jpeg");
        return dims && { ...dims, orientation };
      }
      if (m === 0xd9 || m === 0xda) return null;
      i += 2 + len;
    }
    return null;
  }
  // WebP: RIFF....WEBP and the first chunk
  if (b.length >= 30 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
    const chunk = b.toString("latin1", 12, 16);
    if (chunk === "VP8X") return positive(1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3), "webp");
    if (chunk === "VP8L" && b[20] === 0x2f) {
      const bits = b.readUInt32LE(21);
      return positive((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1, "webp");
    }
    if (chunk === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return positive(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff, "webp");
  }
  return null;
}

/**
 * The orientation tag (0x0112) of IFD0 in an EXIF TIFF block that starts at `t` and ends at `end` (little "II" or
 * big "MM" endian). 1 when the block has no such tag; null when the block is malformed or the value is not 1–8.
 */
function exifOrientation(b: Buffer, t: number, end: number): number | null {
  if (t + 8 > end) return null;
  const order = b.toString("latin1", t, t + 2);
  if (order !== "II" && order !== "MM") return null;
  const le = order === "II";
  const u16 = (at: number) => (le ? b.readUInt16LE(at) : b.readUInt16BE(at));
  const u32 = (at: number) => (le ? b.readUInt32LE(at) : b.readUInt32BE(at));
  if (u16(t + 2) !== 42) return null;
  const ifd = t + u32(t + 4);
  if (ifd < t + 8 || ifd + 2 > end) return null;
  const n = u16(ifd);
  if (ifd + 2 + n * 12 > end) return null;
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12;
    if (u16(e) !== 0x0112) continue;
    // type SHORT, one value, stored in the first two bytes of the value field
    if (u16(e + 2) !== 3 || u32(e + 4) !== 1) return null;
    const v = u16(e + 8);
    return v >= 1 && v <= 8 ? v : null;
  }
  return 1;
}

const positive = (width: number, height: number, format: PhotoFormat): Dims | null => (width > 0 && height > 0 ? { width, height, format, orientation: 1 } : null);

export type ResolvedPhoto =
  | { ok: true; file: string; info: PhotoBytesInfo }
  | { ok: false; code: "PATH_NOT_PRIVATE" | "PATH_SYMLINK" | "PHOTO_HARDLINK" | "FILE_UNREADABLE" | "NOT_A_PHOTO" | "PHOTO_EXIF_UNREADABLE" };

/**
 * Opens a private photo by its record path, relative to the quality-pipeline root. Refuses a path that is not a plain
 * file directly in `.intake/photos/`, and a path any part of which (the pipeline root, `.intake`, `photos`, the file) is
 * a symbolic link, or whose file has more than one name (a hard link): a link could point anywhere (another site's
 * download folder, a success-case asset). The folders above the root are resolved (realpath) first.
 *
 * Known limit: the checks (lstat) and the read are two steps; a file swapped between them is not caught. The folder
 * is the owner's own machine, not a shared one.
 */
export function resolvePrivatePhoto(pipelineRoot: string, privatePath: string): ResolvedPhoto {
  if (!PRIVATE_PHOTO_PATH.test(privatePath)) return { ok: false, code: "PATH_NOT_PRIVATE" };
  let root: string;
  try {
    if (lstatSync(pipelineRoot).isSymbolicLink()) return { ok: false, code: "PATH_SYMLINK" };
    root = realpathSync(pipelineRoot);
  } catch {
    return { ok: false, code: "FILE_UNREADABLE" };
  }
  const parts = privatePath.split("/");
  let at = root;
  for (const [i, part] of parts.entries()) {
    at = join(at, part);
    let st;
    try {
      st = lstatSync(at);
    } catch {
      return { ok: false, code: "FILE_UNREADABLE" };
    }
    if (st.isSymbolicLink()) return { ok: false, code: "PATH_SYMLINK" };
    const last = i === parts.length - 1;
    if (last ? !st.isFile() : !st.isDirectory()) return { ok: false, code: last ? "FILE_UNREADABLE" : "PATH_NOT_PRIVATE" };
    if (last && st.nlink > 1) return { ok: false, code: "PHOTO_HARDLINK" };
  }
  if (!(at + sep).startsWith(join(root, PHOTO_INTAKE_DIR) + sep)) return { ok: false, code: "PATH_NOT_PRIVATE" };
  let buf: Buffer;
  try {
    buf = readFileSync(at);
  } catch {
    return { ok: false, code: "FILE_UNREADABLE" };
  }
  const h = readPhotoHeader(buf);
  return h.ok ? { ok: true, file: at, info: h.info } : { ok: false, code: h.code };
}
