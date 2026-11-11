/**
 * DEV-196s (owner approval 2026-11-11): the image records (`p_images` of sales_ingest_demo_version) of a FICTIONAL
 * shop's AI demo photos, built from the photo swap's private rights file — fail closed.
 *
 * Inputs (all read-only, outside the repository; nothing here reads a file — the caller passes the bytes):
 *  - `rights.private.json` (photo-swap.ts, schema photo_swap_rights_private_v0): per slot, its photos (`pc`, and `sp`
 *    when the slot has a separate SP photo), each with its photo_rights_v0 record;
 *  - `swap-summary.json` (photo_swap_summary_v0): which photo each crop was cut from (`crops["<slot>/<range>"]`), the
 *    crops' sha256 and the copy's HTML/CSS hashes — checked against the bytes, so the crop ↔ record link is the swap's;
 *  - the ORIGINAL photos (the run's bundle): each record must describe one of them byte for byte, so the existing
 *    checkPhotoRights runs exactly as the swap ran it (quality_verification, AI demo allowed for this fictional shop,
 *    the success-case hashes forbidden) plus the swap's prompt pin (AI_DEMO_PROMPT_NOT_APPROVED).
 *
 * Every record must be `ai_generated_demo`, depict nothing real, allow no public web use and carry full provenance;
 * anything missing or different → SwapRightsError. The image record says only what the database needs: the converted
 * file's sha256 / size / pixel size, `ai_generated_demo`, every depicts_* false, `public_web` false, the expiry and the
 * provenance in the database's shape (AiConceptProvenance: `admin_preview_only: true` in place of `demo_only`). The
 * owner, consent record, private path and focal box never leave the rights file.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { checkPhotoRights, measurePhotoBytes, utcDay, type PhotoRights } from "@/lib/design-agent/quality-pipeline/photo-rights";
import { swapShopSpec } from "@/lib/design-agent/quality-pipeline/photo-swap-shops";
import { AiConceptProvenance } from "@/lib/sales/demo-version/ai-concept-rights";
import { SWAP_PHOTO_URL } from "./photos";

export class SwapRightsError extends Error {
  constructor(
    public readonly code: string,
    public readonly details: readonly string[] = [],
  ) {
    super(details.length ? `${code}: ${details.join(",")}` : code);
  }
}

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const SwapRightsFile = z.strictObject({
  schema: z.literal("photo_swap_rights_private_v0"),
  warning: z.string(),
  slots: z
    .array(
      z.strictObject({
        slot_id: z.string().regex(/^ph-[a-z0-9-]{1,40}$/),
        scale_exception: z.unknown(),
        photos: z.array(z.strictObject({ which: z.enum(["pc", "sp"]), focal_box: z.unknown(), rights: z.unknown() })).min(1).max(2),
      }),
    )
    .min(1)
    .max(20),
});

/** The parts of swap-summary.json this needs (other keys are allowed: it is the swap's public summary). */
export const SwapSummaryFile = z.object({
  schema: z.literal("photo_swap_summary_v0"),
  shop: z.string(),
  copy_hashes: z.strictObject({ html: Sha256, css: Sha256 }),
  crops: z.record(z.string(), z.object({ source: z.enum(["pc", "sp"]), asset_id: z.string() })),
  files: z.record(z.string(), Sha256),
});

/** One element of p_images (the database's allowed keys only). */
export type PackageImage = {
  sha256: string;
  bytes: number;
  width: number;
  height: number;
  format: "webp";
  record_schema: "photo_rights_v0";
  source_kind: "ai_generated_demo";
  rights_status: "ai_demo_internal";
  depicts_real_shop: false;
  depicts_identifiable_person: false;
  depicts_real_product: false;
  depicts_real_interior: false;
  depicts_real_equipment: false;
  allowed_uses: { edit: boolean; crop: boolean; commercial: boolean; public_web: false };
  rights_expiry: string | null;
  provenance: z.infer<typeof AiConceptProvenance>;
};

const IMAGE_KEYS = ["allowed_uses", "bytes", "depicts_identifiable_person", "depicts_real_equipment", "depicts_real_interior", "depicts_real_product", "depicts_real_shop", "format", "height", "provenance", "record_schema", "rights_expiry", "rights_status", "sha256", "source_kind", "width"];

/**
 * Checks one p_images element (in a package being read back, or just built): exactly the keys above, the fixed values,
 * and the provenance in the database's shape. Returns the problems (empty when it is in order).
 */
export function packageImageProblems(e: unknown): string[] {
  if (typeof e !== "object" || e === null || Array.isArray(e)) return ["not_object"];
  const r = e as Record<string, unknown>;
  const out: string[] = [];
  if (Object.keys(r).sort().join(",") !== IMAGE_KEYS.join(",")) out.push("keys");
  if (typeof r.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(r.sha256)) out.push("sha256");
  for (const k of ["bytes", "width", "height"]) if (!Number.isInteger(r[k]) || (r[k] as number) < 1) out.push(k);
  if (r.format !== "webp") out.push("format");
  if (r.record_schema !== "photo_rights_v0") out.push("record_schema");
  if (r.source_kind !== "ai_generated_demo") out.push("source_kind");
  if (r.rights_status !== "ai_demo_internal") out.push("rights_status");
  for (const k of ["depicts_real_shop", "depicts_identifiable_person", "depicts_real_product", "depicts_real_interior", "depicts_real_equipment"]) if (r[k] !== false) out.push(k);
  const u = r.allowed_uses as Record<string, unknown> | null;
  if (typeof u !== "object" || u === null || Object.keys(u).sort().join(",") !== "commercial,crop,edit,public_web" || Object.values(u).some((v) => typeof v !== "boolean") || u.public_web !== false) out.push("allowed_uses");
  if (!(r.rights_expiry === null || (typeof r.rights_expiry === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.rights_expiry)))) out.push("rights_expiry");
  if (!AiConceptProvenance.safeParse(r.provenance).success) out.push("provenance");
  return out;
}

export type ConvertedForImage = { swapUrl: string; storedUrl: string; webp: { sha256: string; bytes: number; width: number; height: number } };

export type SwapImagesInput = {
  rights: unknown;
  summary: unknown;
  /** the copy's HTML and CSS as the swap wrote them (before any rewrite) */
  pageHtml: string;
  pageCss: string;
  /** swap URL (photos/<slot>-<range>.<ext>) → sha256 of the bytes in the copy */
  pagePhotoSha256: ReadonlyMap<string, string>;
  /** the converted photos, one per swap URL */
  converted: readonly ConvertedForImage[];
  /** the original photos of the run (any file names): their bytes */
  originals: readonly Uint8Array[];
  forbiddenSha256: ReadonlySet<string>;
  /** the check day (ISO date) */
  now: string;
};

export type SwapImages = {
  images: PackageImage[];
  /** for the package's local record only (never the database): which original each stored photo comes from */
  sources: Array<{ stored: string; swap: string; slot_id: string; which: "pc" | "sp"; asset_id: string; original_sha256: string; original_upscaled: boolean }>;
};

const sha256Hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Builds the image records. Throws SwapRightsError with a fixed code on anything missing or inconsistent. */
export function buildSwapImages(i: SwapImagesInput): SwapImages {
  const rights = SwapRightsFile.safeParse(i.rights);
  if (!rights.success) throw new SwapRightsError("RIGHTS_FILE_INVALID");
  const summary = SwapSummaryFile.safeParse(i.summary);
  if (!summary.success) throw new SwapRightsError("SUMMARY_INVALID");
  const spec = swapShopSpec("bicycle");
  if (summary.data.shop !== spec.shop) throw new SwapRightsError("SUMMARY_NOT_RIN");
  // the copy is the swap's own, unchanged
  if ((sha256Hex(new TextEncoder().encode(i.pageHtml))) !== summary.data.copy_hashes.html || (sha256Hex(new TextEncoder().encode(i.pageCss))) !== summary.data.copy_hashes.css) {
    throw new SwapRightsError("PAGE_NOT_THE_SWAP_COPY");
  }
  const summaryFiles = Object.entries(summary.data.files).filter(([k]) => k.startsWith("photos/"));
  if (summaryFiles.length !== i.pagePhotoSha256.size) throw new SwapRightsError("PAGE_PHOTOS_NOT_THE_SWAP_COPY", ["count"]);
  for (const [name, sha] of summaryFiles) if (i.pagePhotoSha256.get(name) !== sha) throw new SwapRightsError("PAGE_PHOTOS_NOT_THE_SWAP_COPY", [name]);

  // the originals, by sha256
  const originals = new Map<string, Uint8Array>();
  for (const b of i.originals) originals.set(sha256Hex(b), b);

  // every record checked exactly as the swap checked it
  const records = new Map<string, { slot_id: string; which: "pc" | "sp"; record: PhotoRights }>();
  for (const slot of rights.data.slots) {
    for (const p of slot.photos) {
      const asset = (p.rights as { asset_id?: unknown } | null)?.asset_id;
      const label = `${slot.slot_id}/${p.which}`;
      const sha = (p.rights as { sha256?: unknown } | null)?.sha256;
      const bytes = typeof sha === "string" ? originals.get(sha) : undefined;
      if (!bytes) throw new SwapRightsError("ORIGINAL_MISSING", [label]);
      const info = measurePhotoBytes(Buffer.from(bytes));
      const checked = checkPhotoRights(p.rights, info, { purpose: "quality_verification", now: i.now, forbiddenSha256: i.forbiddenSha256, aiDemoAllowed: true });
      if (!checked.ok) throw new SwapRightsError("RIGHTS_REFUSED", [label, ...checked.codes]);
      const r = checked.record;
      if (r.source_kind !== "ai_generated_demo" || !r.ai_provenance) throw new SwapRightsError("NOT_AI_DEMO", [label]);
      if (spec.aiDemoPromptSha256 && r.ai_provenance.prompt_sha256 !== spec.aiDemoPromptSha256) throw new SwapRightsError("AI_DEMO_PROMPT_NOT_APPROVED", [label]);
      if (r.allowed_uses.public_web !== false) throw new SwapRightsError("PUBLIC_WEB_NOT_FALSE", [label]);
      if (typeof asset !== "string" || records.has(asset)) throw new SwapRightsError("ASSET_ID_DUPLICATE", [label]);
      records.set(asset, { slot_id: slot.slot_id, which: p.which, record: r });
    }
  }

  const images: PackageImage[] = [];
  const sources: SwapImages["sources"] = [];
  const seen = new Set<string>();
  for (const c of i.converted) {
    const m = SWAP_PHOTO_URL.exec(c.swapUrl);
    if (!m) throw new SwapRightsError("PHOTO_NAME_UNEXPECTED", [c.swapUrl]);
    const crop = summary.data.crops[`${m[1]}/${m[2]}`];
    if (!crop) throw new SwapRightsError("CROP_NOT_IN_SUMMARY", [c.swapUrl]);
    const src = records.get(crop.asset_id);
    if (!src || src.slot_id !== m[1] || src.which !== crop.source) throw new SwapRightsError("CROP_SOURCE_UNKNOWN", [c.swapUrl]);
    if (seen.has(c.webp.sha256)) throw new SwapRightsError("PHOTO_DUPLICATE", [c.swapUrl]);
    seen.add(c.webp.sha256);
    const r = src.record;
    const p = r.ai_provenance!;
    const image: PackageImage = {
      sha256: c.webp.sha256,
      bytes: c.webp.bytes,
      width: c.webp.width,
      height: c.webp.height,
      format: "webp",
      record_schema: "photo_rights_v0",
      source_kind: "ai_generated_demo",
      rights_status: "ai_demo_internal",
      depicts_real_shop: false,
      depicts_identifiable_person: false,
      depicts_real_product: false,
      depicts_real_interior: false,
      depicts_real_equipment: false,
      allowed_uses: { edit: r.allowed_uses.edit, crop: r.allowed_uses.crop, commercial: r.allowed_uses.commercial, public_web: false },
      rights_expiry: r.expiry === null ? null : utcDay(r.expiry),
      provenance: { generator: p.generator, model: p.model, generated_at: p.generated_at, prompt_sha256: p.prompt_sha256, approval_id: p.approval_id, admin_preview_only: true },
    };
    const problems = packageImageProblems(image);
    if (problems.length) throw new SwapRightsError("IMAGE_RECORD_INVALID", [c.swapUrl, ...problems]);
    images.push(image);
    sources.push({ stored: c.storedUrl, swap: c.swapUrl, slot_id: src.slot_id, which: src.which, asset_id: crop.asset_id, original_sha256: r.sha256, original_upscaled: Boolean(p.upscale) });
  }
  return { images, sources };
}
