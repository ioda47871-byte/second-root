import { z } from "zod";
import { ASSET_ID, type PublicAssetId } from "./types";

// Asset manifest (DEV-029): the photos a person put into the asset store for
// one job. Kept outside the repository, next to the files it lists. The
// manifest says where each photo came from and what it may be used for; it
// never holds shop text, and nothing in it is drawn on the page.
//
// MVP rules fixed by people:
// - one source only: approved_real (the shop provided it, or allowed its
//   use, with a consent record). DEV-070 (2026-10-20, people's decision)
//   removed generated_concept: no AI-generated or made-up shop photo is ever
//   drawn. A manifest that still lists one no longer parses, so its job has
//   no photos (the page without photos, as before).
// - a reference screenshot (Instagram, website) is never an asset: it is
//   captured and analysed for colour and mood only, and never republished.
// - no people in any photo (`people` is the literal "none").
// - approved_real carries a consent record with separate scopes for the local
//   preview and the public demo. DEV-029 uses the local preview only, and the
//   public demo shows no photo at all (MVP_SPEC §7 unchanged).
// - at most 3 photos per job.

export const SOURCE_KINDS = ["approved_real"] as const;
export const CONSENT_SCOPES = ["local_preview", "public_demo"] as const;
export const MAX_ASSETS_PER_JOB = 3;
/** The public demo shows no photo in DEV-029 (MVP_SPEC §7), whatever the consent says. */
export const PUBLIC_DEMO_ASSETS_ENABLED = false;

export type SourceKind = (typeof SOURCE_KINDS)[number];
export type ConsentScope = (typeof CONSENT_SCOPES)[number];

export const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/;
/** A handle or role, not a person's full name or a shop name. */
const handle = z.string().regex(/^[A-Za-z0-9._@-]{1,64}$/);
const isoTime = z.string().datetime({ offset: true });

const base = {
  assetId: z.string().regex(ASSET_ID),
  file: z.string().regex(/^asset-[a-f0-9]{24}\.png$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
  bytes: z.number().int().min(1),
  intakeAt: isoTime,
  /** MVP: no people in any photo. A person confirms this at intake. */
  people: z.literal("none"),
};

export const ApprovedRealSchema = z.strictObject({
  ...base,
  sourceKind: z.literal("approved_real"),
  consent: z.strictObject({
    /** Points at the person's own record of the permission (mail, form); not the record itself. */
    consentId: z.string().regex(/^[A-Za-z0-9_-]{3,64}$/),
    approvedBy: handle,
    approvedAt: isoTime,
    scopes: z
      .array(z.enum(CONSENT_SCOPES))
      .min(1)
      .refine((s) => new Set(s).size === s.length, "scopes repeat"),
  }),
});

/** approved_real is the only source kind (DEV-070); any other kind fails to parse. */
export const AssetRecordSchema = ApprovedRealSchema;

export const AssetManifestSchema = z
  .strictObject({
    version: z.literal(1),
    jobId: z.string().regex(JOB_ID),
    assets: z.array(AssetRecordSchema).max(MAX_ASSETS_PER_JOB),
  })
  .superRefine((m, ctx) => {
    const ids = m.assets.map((a) => a.assetId);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "asset ids repeat" });
    const hashes = m.assets.map((a) => a.sha256);
    if (new Set(hashes).size !== hashes.length) ctx.addIssue({ code: "custom", message: "the same image twice" });
    for (const a of m.assets) if (a.file !== `${a.assetId}.png`) ctx.addIssue({ code: "custom", message: "file does not match asset id" });
  });

export type AssetRecord = z.infer<typeof AssetRecordSchema>;
export type AssetManifest = z.infer<typeof AssetManifestSchema>;

export function emptyManifest(jobId: string): AssetManifest {
  return { version: 1, jobId, assets: [] };
}

/** Whether the record's own permission covers this use. */
export function consentAllows(asset: AssetRecord, scope: ConsentScope): boolean {
  return asset.sourceKind === "approved_real" && asset.consent.scopes.includes(scope);
}

/** Whether a photo may be drawn in this place at all (consent and the MVP's public-demo switch). */
export function assetUsableIn(asset: AssetRecord, scope: ConsentScope): boolean {
  if (scope === "public_demo" && !PUBLIC_DEMO_ASSETS_ENABLED) return false;
  return asset.people === "none" && consentAllows(asset, scope);
}

export function findAsset(manifest: AssetManifest, id: PublicAssetId | string): AssetRecord | undefined {
  return manifest.assets.find((a) => a.assetId === id);
}
