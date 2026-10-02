import { z } from "zod";
import { withoutMeta } from "../profile";
import { analysisForbids, FocalSchema, type PhotoAnalysis } from "./analysis";
import { assetUsableIn, findAsset, MAX_ASSETS_PER_JOB, type AssetManifest, type ConsentScope } from "./manifest";
import { ASSET_ID } from "./types";

// Image direction (DEV-029): which photos the page uses, in which role, and
// how the page is laid out around them. Codex chooses it together with the
// DesignProfile (which stays version 1, unchanged). Like the profile it holds
// ids and enum values only, never text.
//
// MVP layouts keep photo and type in separate areas, so they cannot collide:
// - none:                    the typographic page of DEV-028
// - split_hero:              photo and name side by side (stacked on phones)
// - framed_hero:             the photo framed in the hero, the name beside or under it
// - type_hero_feature_band:  typographic hero, photos as bands beside About / Visit
// Not in the MVP: type over a full-bleed photo, galleries, editorial stacks.
//
// Feature slots are About and Visit only: no photo is ever placed as the
// picture of a menu item.

export const IMAGE_LAYOUTS = ["none", "split_hero", "framed_hero", "type_hero_feature_band"] as const;
export const FITS = ["cover", "contain"] as const;
export const ASPECTS = ["4:5", "3:4", "1:1", "4:3", "3:2"] as const;
export const TREATMENTS = ["natural", "warm", "mono"] as const;
export const FEATURE_SLOTS = ["about", "visit"] as const;
export const REJECT_REASONS = ["low_quality", "near_duplicate", "off_brand", "people", "text_heavy", "not_needed"] as const;

const assetId = z.string().regex(ASSET_ID);
const placement = {
  assetId,
  fit: z.enum(FITS),
  focal: FocalSchema,
  mobileFocal: FocalSchema,
  aspect: z.strictObject({ desktop: z.enum(ASPECTS), mobile: z.enum(ASPECTS) }),
  treatment: z.enum(TREATMENTS),
};

export const ImageDirectionSchema = z.strictObject({
  version: z.literal(1),
  layout: z.enum(IMAGE_LAYOUTS),
  hero: z.union([z.strictObject(placement), z.null()]),
  features: z.array(z.strictObject({ ...placement, slot: z.enum(FEATURE_SLOTS), side: z.enum(["left", "right"]) })).max(2),
  rejected: z.array(z.strictObject({ assetId, reason: z.enum(REJECT_REASONS) })).max(MAX_ASSETS_PER_JOB),
  /** How well the profile's palette sits with the photos used (1 poor – 5 strong). */
  paletteFit: z.number().int().min(1).max(5),
});

export type ImageDirection = z.infer<typeof ImageDirectionSchema>;

export const NO_IMAGES: ImageDirection = { version: 1, layout: "none", hero: null, features: [], rejected: [], paletteFit: 3 };

export function imageDirectionJsonSchema(): object {
  return withoutMeta(z.toJSONSchema(ImageDirectionSchema));
}

export type DirectionCheck = { ok: true; direction: ImageDirection } | { ok: false; problems: string[] };

/**
 * Parses a direction and checks it against the job's photos. Anything that
 * fails means the page is drawn without photos (the DEV-028 path).
 */
export function checkImageDirection(value: unknown, manifest: AssetManifest, analyses: readonly PhotoAnalysis[], scope: ConsentScope = "local_preview"): DirectionCheck {
  const parsed = ImageDirectionSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "(root)"}: ${i.code}`) };
  }
  const d = parsed.data;
  const problems: string[] = [];
  const used = [...(d.hero ? [d.hero.assetId] : []), ...d.features.map((f) => f.assetId)];
  const mentioned = [...used, ...d.rejected.map((r) => r.assetId)];

  if (new Set(mentioned).size !== mentioned.length) problems.push("an asset appears twice");
  if (used.length > MAX_ASSETS_PER_JOB) problems.push("too many photos");

  switch (d.layout) {
    case "none":
      if (used.length > 0) problems.push("layout none uses photos");
      break;
    case "split_hero":
    case "framed_hero":
      if (!d.hero) problems.push(`${d.layout} needs a hero photo`);
      break;
    case "type_hero_feature_band":
      if (d.hero) problems.push("type_hero_feature_band has no hero photo");
      if (d.features.length === 0) problems.push("type_hero_feature_band needs a feature photo");
      break;
  }
  const slots = d.features.map((f) => f.slot);
  if (new Set(slots).size !== slots.length) problems.push("two photos in one slot");

  for (const id of mentioned) {
    const asset = findAsset(manifest, id);
    if (!asset) problems.push(`unknown asset ${id}`);
    if (!analyses.some((a) => a.assetId === id)) problems.push(`no analysis for ${id}`);
  }
  // Every photo of the job is decided: used or rejected, none silently dropped.
  for (const asset of manifest.assets) if (!mentioned.includes(asset.assetId)) problems.push(`${asset.assetId} is neither used nor rejected`);
  for (const id of used) {
    const asset = findAsset(manifest, id);
    if (asset && !assetUsableIn(asset, scope)) problems.push(`${id} is not allowed in ${scope}`);
    const analysis = analyses.find((a) => a.assetId === id);
    if (analysis && analysisForbids(analysis)) problems.push(`${id} shows people`);
    const twin = analysis?.nearDuplicateOf;
    if (twin && used.includes(twin)) problems.push(`${id} and ${twin} are near duplicates`);
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, direction: d };
}
