import { infoRows } from "@/components/demo/info";
import type { DemoView } from "@/lib/sales/demo-content";
import { PhotoAnalysesSchema } from "./analysis";
import { checkImageDirection, type ImageDirection } from "./direction";
import { findAsset, type AssetManifest, type ConsentScope, type SourceKind } from "./manifest";
import { toPublicAssetId, type PublicAssetId } from "./types";

// From a job's checked inputs to what the profile renderer draws (DEV-029).
// Every check that decides whether a photo may appear happens here, before
// rendering; anything wrong means no photos at all (the DEV-028 page), never
// a half-drawn one. A photo counted as "used" is always on the page: a
// feature photo needs its section (About needs a description, Visit needs
// at least one visit row).

type Placement = NonNullable<ImageDirection["hero"]>;

export type RenderPhoto = {
  assetId: PublicAssetId;
  /** Built by the caller from the asset id only (the local preview's asset route). */
  src: string;
  sourceKind: SourceKind;
  width: number;
  height: number;
  fit: Placement["fit"];
  focal: Placement["focal"];
  mobileFocal: Placement["mobileFocal"];
  aspect: Placement["aspect"];
  treatment: Placement["treatment"];
};

export type RenderFeature = RenderPhoto & { slot: ImageDirection["features"][number]["slot"]; side: ImageDirection["features"][number]["side"] };

export type RenderPhotos = {
  layout: Exclude<ImageDirection["layout"], "none">;
  hero: RenderPhoto | null;
  features: RenderFeature[];
};

/** The sections a feature photo can sit in, as the renderer draws them. */
export function sectionsPresent(demo: DemoView): Record<ImageDirection["features"][number]["slot"], boolean> {
  return { about: Boolean(demo.description), visit: infoRows(demo).length > 0 };
}

export type ResolveInput = {
  demo: DemoView;
  manifest: AssetManifest | null;
  analyses: unknown;
  direction: unknown;
  src: (id: PublicAssetId) => string;
  scope?: ConsentScope;
};

export function resolvePhotos(input: ResolveInput): { photos: RenderPhotos | null; problems: string[] } {
  if (input.direction === undefined || input.direction === null) return { photos: null, problems: [] };
  if (!input.manifest) return { photos: null, problems: ["NO_MANIFEST"] };
  const analyses = PhotoAnalysesSchema.safeParse(input.analyses);
  if (!analyses.success) return { photos: null, problems: ["NO_ANALYSES"] };
  const check = checkImageDirection(input.direction, input.manifest, analyses.data.photos, input.scope ?? "local_preview");
  if (!check.ok) return { photos: null, problems: check.problems };
  const d = check.direction;
  if (d.layout === "none") return { photos: null, problems: [] };

  const present = sectionsPresent(input.demo);
  const problems = d.features.filter((f) => !present[f.slot]).map((f) => `slot ${f.slot} has no section`);
  if (problems.length > 0) return { photos: null, problems };

  const manifest = input.manifest;
  const toPhoto = (p: Placement): RenderPhoto | null => {
    const id = toPublicAssetId(p.assetId);
    const asset = id ? findAsset(manifest, id) : undefined;
    if (!id || !asset) return null;
    return { assetId: id, src: input.src(id), sourceKind: asset.sourceKind, width: asset.width, height: asset.height, fit: p.fit, focal: p.focal, mobileFocal: p.mobileFocal, aspect: p.aspect, treatment: p.treatment };
  };
  const hero = d.hero ? toPhoto(d.hero) : null;
  const features = d.features.map((f) => {
    const photo = toPhoto(f);
    return photo ? { ...photo, slot: f.slot, side: f.side } : null;
  });
  if ((d.hero && !hero) || features.some((f) => f === null)) return { photos: null, problems: ["ASSET_UNRESOLVED"] };
  return { photos: { layout: d.layout, hero, features: features as RenderFeature[] }, problems: [] };
}
