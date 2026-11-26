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
 *   CONTENT_GENERATED_AS_SHOP  review #365 M1, DEV-364 PR 2a: an item marked B (`shop_provided`) or C (`customer_cms`)
 *                              shows a picture whose SHA-256 is in the handover record of delivered generated materials
 *                              (content/generated-materials.json) — the イメージ label cannot be dropped by relabelling
 *                              a generated picture
 *   CONTENT_PHOTO_RIGHTS_MISSING  DEV-364 PR 2a: a B picture without a valid rights record (provenance.ts)
 *
 * The handover record is written at delivery (Second Root lists every generated material it hands over, by file and
 * SHA-256). It is not in .pages.yml, so the CMS cannot edit it; a shop's own photo has another SHA-256 and is free.
 * Limits: it matches exact bytes only (a re-encoded or edited copy of a generated picture is not caught), and it
 * guards against a relabel in the CMS, not against edits made in the repository itself. A shop whose profile says
 * generated materials were delivered (ShopProfile.generatedDelivered) must have the record, or the build stops.
 *
 * A stopped build keeps the last good publish (Cloudflare Pages, Q2). The same limits are written as hints in the
 * CMS (pages-config.ts PHOTO_HINT); Pages CMS itself has no size limit option, so the build is what enforces them.
 * The page frames crop with object-fit: cover, so any ratio within the limit keeps the layout.
 */
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { ContentError, type ShopContent, type ShopProfile, viewOf } from "./content-model";
import { imageMeta, type ImageMeta } from "./image-meta";
import { CLASS_OF, customerRecord, loadProvenanceIndex, loadRightsRecord, PROVENANCE_SCHEMA, type Provenance } from "./provenance";

export const PHOTO_LIMITS = { bytes: 2 * 1024 * 1024, maxSide: 4096, maxPixels: 16_000_000, minSide: 320, maxRatio: 3 } as const;

const EXT_FORMAT: Record<string, ImageMeta["format"]> = { png: "png", jpg: "jpeg", jpeg: "jpeg", webp: "webp" };

export type PhotoCheck = { file: string; bytes: number; format: ImageMeta["format"]; width: number; height: number; sha256: string };

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
  return { file, bytes: bytes.length, format: meta.format, width, height, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** Every picture the page shows (visible items in visible categories), checked; the media/ file names in order. */
export async function checkPhotos(repo: string, content: ShopContent, profile?: ShopProfile): Promise<PhotoCheck[]> {
  const shown = viewOf(content).sections.flatMap((s) => s.items).filter((m) => m.image);
  const names = [...new Set(shown.map((m) => m.image.replace(/^\/media\//, "")))].sort();
  const out: PhotoCheck[] = [];
  for (const n of names) {
    const path = join(repo, "media", n);
    const st = await lstat(path).catch(() => null);
    if (!st || !st.isFile()) throw new ContentError("CONTENT_PHOTO_MISSING", n);
    if (st.size > PHOTO_LIMITS.bytes) throw new ContentError("CONTENT_PHOTO_TOO_LARGE", n);
    out.push(checkPhoto(n, await readFile(path)));
  }
  // review #365 M1: a delivered generated material stays labelled whatever the item says
  const generated = await loadGeneratedRecord(repo, profile?.generatedDelivered === true);
  const shaOf = new Map(out.map((p) => [p.file, p.sha256]));
  for (const m of shown) if (m.imageKind !== "generated" && generated.has(shaOf.get(m.image.replace(/^\/media\//, ""))!)) throw new ContentError("CONTENT_GENERATED_AS_SHOP", `menu/${m.id}`);
  return out;
}

export type PhotoProvenance = { file: string; sha256: string; class: "A" | "B" | "C"; record: Provenance | null };

/**
 * DEV-364 PR 2a: the provenance of every picture the page shows. A: its record from the handover entry when it names the
 * material and the materials approval (else null — the handover did not record them); B: its rights record from the
 * private folder (or CONTENT_PHOTO_RIGHTS_MISSING); C: the record of the automatic checks it passed. Run after
 * checkPhotos (which has refused B / C pictures that are delivered generated materials). delivery: true is Second
 * Root's delivery build, which refuses C (CONTENT_DELIVERY_CUSTOMER_PHOTO); provenanceDir alone does not imply it.
 */
export async function photoProvenance(repo: string, content: ShopContent, photos: readonly PhotoCheck[], o: { provenanceDir?: string; delivery?: boolean } = {}): Promise<PhotoProvenance[]> {
  if (o.provenanceDir) await assertOutsideRepo(o.provenanceDir, repo);
  const handover = await loadGeneratedEntries(repo);
  const index = await loadProvenanceIndex(repo);
  const shaOf = new Map(photos.map((p) => [p.file, p.sha256]));
  const shown = viewOf(content).sections.flatMap((s) => s.items).filter((x) => x.image);
  // review #371 M1 (owner rule: A / B / C never mixed): the class belongs to the picture's bytes, not to the item
  for (const e of handover) if (index.has(e.sha256)) throw new ContentError("CONTENT_PHOTO_CLASS_MIXED", e.file);
  const classOfSha = new Map<string, "A" | "B" | "C">();
  for (const m of shown) {
    const sha256 = shaOf.get(m.image.replace(/^\/media\//, ""))!;
    const cls = CLASS_OF[m.imageKind];
    if (index.has(sha256) && cls !== "B") throw new ContentError("CONTENT_PHOTO_CLASS_MIXED", `menu/${m.id}`);
    const seen = classOfSha.get(sha256);
    if (seen && seen !== cls) throw new ContentError("CONTENT_PHOTO_CLASS_MIXED", `menu/${m.id}`);
    classOfSha.set(sha256, cls);
    // review #371 L3: Second Root's delivery build never places a customer's picture. Delivery is its own explicit
    // option: an audit given the private folder (without delivery) keeps the customer's legitimate C pictures.
    if (o.delivery && cls === "C") throw new ContentError("CONTENT_DELIVERY_CUSTOMER_PHOTO", `menu/${m.id}`);
  }
  const out: PhotoProvenance[] = [];
  for (const m of shown) {
    const file = m.image.replace(/^\/media\//, "");
    const sha256 = shaOf.get(file)!;
    const cls = CLASS_OF[m.imageKind];
    if (out.some((p) => p.file === file && p.class === cls)) continue;
    if (cls === "B") out.push({ file, sha256, class: cls, record: await loadRightsRecord(index, o.provenanceDir, sha256, file) });
    else if (cls === "C") out.push({ file, sha256, class: cls, record: customerRecord(sha256) });
    else {
      const e = handover.find((x) => x.sha256 === sha256);
      out.push({ file, sha256, class: cls, record: e?.material_id && e.materials_approval_sha256 ? { schema: PROVENANCE_SCHEMA, class: "A", sha256, material_id: e.material_id, materials_approval_sha256: e.materials_approval_sha256 } : null });
    }
  }
  return out;
}

/** review #371 L2: the private provenance folder is never inside the shop repository (links resolved). */
async function assertOutsideRepo(dir: string, repo: string): Promise<void> {
  const real = await realpath(resolve(dir)).catch(() => resolve(dir));
  const realRepo = await realpath(resolve(repo)).catch(() => resolve(repo));
  const inside = (p: string, r: string) => {
    const rel = relative(r, p);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  if (inside(real, realRepo) || inside(resolve(dir), resolve(repo))) throw new ContentError("CONTENT_PROVENANCE_IN_REPO", "provenanceDir");
}

/** The handover record of delivered generated materials (written at delivery; not editable in the CMS). */
export const GENERATED_RECORD = "content/generated-materials.json";
const GeneratedRecord = z.strictObject({
  schema: z.literal("generated_materials_v1"),
  files: z
    .array(
      z.strictObject({
        file: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        // DEV-364 PR 2a: the A provenance (optional, so earlier records stay valid): the material and its approval
        material_id: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/).optional(),
        materials_approval_sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
      }),
    )
    .max(500),
});
export type GeneratedRecord = z.infer<typeof GeneratedRecord>;

/**
 * The SHA-256s of the delivered generated materials. Only a file that does not exist (ENOENT) means "no record";
 * a directory, a permission error or any other read error is CONTENT_INVALID (#365 re-review). A shop whose profile
 * says generated materials were delivered must have the record (CONTENT_GENERATED_RECORD_MISSING).
 */
export async function loadGeneratedRecord(repo: string, delivered = false): Promise<Set<string>> {
  let bytes: Buffer;
  try {
    bytes = await readFile(join(repo, GENERATED_RECORD));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ContentError("CONTENT_INVALID", GENERATED_RECORD);
    if (delivered) throw new ContentError("CONTENT_GENERATED_RECORD_MISSING", GENERATED_RECORD);
    return new Set();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ContentError("CONTENT_INVALID", GENERATED_RECORD);
  }
  const r = GeneratedRecord.safeParse(raw);
  if (!r.success) throw new ContentError("CONTENT_INVALID", GENERATED_RECORD);
  return new Set(r.data.files.map((f) => f.sha256));
}

/** The handover record's entries (none when there is no record; errors as loadGeneratedRecord). */
async function loadGeneratedEntries(repo: string): Promise<GeneratedRecord["files"]> {
  if ((await loadGeneratedRecord(repo)).size === 0) return [];
  return GeneratedRecord.parse(JSON.parse((await readFile(join(repo, GENERATED_RECORD))).toString("utf8"))).files;
}

/** The record for a set of delivered generated pictures (what the handover writes). */
export function generatedRecord(files: Record<string, Buffer>): GeneratedRecord {
  return { schema: "generated_materials_v1", files: Object.entries(files).map(([file, b]) => ({ file, sha256: createHash("sha256").update(b).digest("hex") })).sort((a, b) => (a.file < b.file ? -1 : 1)) };
}
