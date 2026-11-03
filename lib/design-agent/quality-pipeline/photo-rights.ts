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
 * The record proves nothing about the bytes by itself: `checkPhotoRights` compares it with what was measured from the
 * file (`measurePhotoBytes`), and `resolvePrivatePhoto` refuses any path outside `.intake/photos/` or through a link.
 */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { z } from "zod";

/** The private folder, relative to the quality-pipeline root (design-library/research/quality-pipeline). */
export const PHOTO_INTAKE_DIR = ".intake/photos";
/** A plain file name directly in `.intake/photos/`: no sub-folder, no `..`, no leading dot. */
export const PRIVATE_PHOTO_PATH = /^\.intake\/photos\/[A-Za-z0-9][A-Za-z0-9_-]{0,80}\.(png|jpg|jpeg|webp)$/;
export const PHOTO_FORMATS = ["png", "jpeg", "webp"] as const;
export type PhotoFormat = (typeof PHOTO_FORMATS)[number];

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2}))?$/);
const Ref = z.string().trim().min(1).max(300);

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
    source_kind: z.enum(["owner_provided", "shop_provided", "licensed_stock_with_terms"]),
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
    expiry: IsoDate.optional(),
    private_path: z.string().regex(PRIVATE_PHOTO_PATH, "the photo must be a plain file directly under .intake/photos/"),
    /** the shops are fictional: a photo of a real, recognisable shop or person is never used */
    depicts_identifiable_person: z.boolean(),
    depicts_real_shop: z.boolean(),
    /** public use of a real shop's photo needs the client's written confirmation */
    client_confirmation_ref: Ref.optional(),
  })
  .superRefine((r, ctx) => {
    const ext = r.private_path.split(".").pop();
    const fmt = ext === "jpg" ? "jpeg" : ext;
    if (fmt !== r.format) ctx.addIssue({ code: "custom", path: ["private_path"], message: "FORMAT_EXTENSION_MISMATCH" });
  });
export type PhotoRights = z.infer<typeof PhotoRights>;

export type PhotoBytesInfo = { sha256: string; bytes: number; width: number; height: number; format: PhotoFormat };
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
  | "FORMAT_MISMATCH";

/** A missing or malformed rights field is named by what is missing, never folded into SCHEMA_INVALID. */
const MISSING: Record<string, PhotoRightsCode> = {
  source_kind: "RIGHTS_MISSING_SOURCE",
  owner: "RIGHTS_MISSING_OWNER",
  license: "RIGHTS_MISSING_LICENSE",
  terms_sha256: "RIGHTS_MISSING_TERMS_SNAPSHOT",
  allowed_uses: "RIGHTS_MISSING_ALLOWED_USES",
  consent_record_ref: "RIGHTS_MISSING_CONSENT",
  received_at: "RIGHTS_MISSING_RECEIVED_AT",
  paid: "RIGHTS_MISSING_PAID",
  depicts_identifiable_person: "RIGHTS_MISSING_SUBJECT",
  depicts_real_shop: "RIGHTS_MISSING_SUBJECT",
  private_path: "PATH_NOT_PRIVATE",
};

export type PhotoRightsResult = { ok: true; record: PhotoRights } | { ok: false; codes: PhotoRightsCode[]; issues: string[] };

export type PhotoRightsOptions = {
  /** what the photo is for. quality_verification: private renders only. public_site: also public web + client confirmation */
  purpose?: PhotoPurpose;
  /** the date the check is made (ISO), for the expiry */
  now?: string;
  /** hashes that must never enter (the success-case pictures, the reference originals…) */
  forbiddenSha256?: ReadonlySet<string>;
};

/**
 * Refuses a photo whose rights record is incomplete, does not allow what the pipeline does with it (edit, crop,
 * commercial; and public web for a public site), or does not describe the bytes that were measured.
 * Every reason is returned, not only the first.
 */
export function checkPhotoRights(record: unknown, bytesInfo: PhotoBytesInfo | null, opts: PhotoRightsOptions = {}): PhotoRightsResult {
  const purpose = opts.purpose ?? "quality_verification";
  const codes = new Set<PhotoRightsCode>();
  const issues: string[] = [];
  const parsed = PhotoRights.safeParse(record);
  if (!parsed.success) {
    for (const i of parsed.error.issues) {
      const key = String(i.path[0] ?? "");
      if (i.message === "FORMAT_EXTENSION_MISMATCH") codes.add("FORMAT_EXTENSION_MISMATCH");
      else codes.add(MISSING[key] ?? "SCHEMA_INVALID");
      issues.push(`${i.path.join(".") || "(root)"}: ${i.message}`);
    }
    return { ok: false, codes: [...codes], issues };
  }
  const r = parsed.data;
  if (r.source_kind === "licensed_stock_with_terms" && !r.terms_sha256) codes.add("RIGHTS_MISSING_TERMS_SNAPSHOT");
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
  if (opts.forbiddenSha256?.has(r.sha256) || (bytesInfo && opts.forbiddenSha256?.has(bytesInfo.sha256))) codes.add("FORBIDDEN_SOURCE_HASH");
  if (r.expiry && opts.now && r.expiry.slice(0, 10) < opts.now.slice(0, 10)) codes.add("RIGHTS_EXPIRED");
  if (r.expiry && r.expiry.slice(0, 10) < r.received_at.slice(0, 10)) {
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
    ...(r.expiry ? { expiry: r.expiry } : {}),
    client_confirmed: Boolean(r.client_confirmation_ref),
    bytes_committed: false as const,
  };
}

/**
 * Size and format from the file's own header (PNG IHDR, JPEG SOF, WebP VP8/VP8L/VP8X). The extension and the
 * record are not trusted. Returns null for anything else.
 */
export function measurePhotoBytes(buf: Buffer): PhotoBytesInfo | null {
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const dims = readDims(buf);
  return dims ? { sha256, bytes: buf.length, ...dims } : null;
}

function readDims(b: Buffer): { width: number; height: number; format: PhotoFormat } | null {
  // PNG: signature, then the IHDR chunk
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a && b.toString("latin1", 12, 16) === "IHDR")
    return positive(b.readUInt32BE(16), b.readUInt32BE(20), "png");
  // JPEG: walk the segments to a start-of-frame
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
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
      const sof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
      if (sof) return i + 9 <= b.length ? positive(b.readUInt16BE(i + 7), b.readUInt16BE(i + 5), "jpeg") : null;
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

const positive = (width: number, height: number, format: PhotoFormat) => (width > 0 && height > 0 ? { width, height, format } : null);

export type ResolvedPhoto = { ok: true; file: string; info: PhotoBytesInfo } | { ok: false; code: "PATH_NOT_PRIVATE" | "PATH_SYMLINK" | "FILE_UNREADABLE" | "NOT_A_PHOTO" };

/**
 * Opens a private photo by its record path, relative to the quality-pipeline root. Refuses a path that is not a plain
 * file directly in `.intake/photos/`, and a path any part of which (`.intake`, `photos`, the file) is a link: a link
 * could point anywhere (another site's download folder, a success-case asset).
 */
export function resolvePrivatePhoto(pipelineRoot: string, privatePath: string): ResolvedPhoto {
  if (!PRIVATE_PHOTO_PATH.test(privatePath)) return { ok: false, code: "PATH_NOT_PRIVATE" };
  const parts = privatePath.split("/");
  let at = pipelineRoot;
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
  }
  if (!(at + sep).startsWith(join(pipelineRoot, PHOTO_INTAKE_DIR) + sep)) return { ok: false, code: "PATH_NOT_PRIVATE" };
  let buf: Buffer;
  try {
    buf = readFileSync(at);
  } catch {
    return { ok: false, code: "FILE_UNREADABLE" };
  }
  const info = measurePhotoBytes(buf);
  return info ? { ok: true, file: at, info } : { ok: false, code: "NOT_A_PHOTO" };
}
