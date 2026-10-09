import type { ImageDirection } from "./direction";
import { assetUsableIn, findAsset, type AssetManifest } from "./manifest";

// The mechanical check of a rendered candidate (DEV-029 stage 4): the page
// shows exactly the photos its ImageDirection uses, in their places, on both
// devices; each is visible, labelled when generated, allowed for the local
// preview, and covers no text. Done in code before any review, so a review
// never has to be trusted for any of this.

export type PhotoRole = "hero" | "about" | "visit";
export type PlacedPhoto = {
  assetId: string;
  role: PhotoRole;
  device: "desktop" | "mobile";
  visible: boolean;
  labelled: boolean;
  overlapsText: boolean;
  /** The figure's page box in CSS pixels (from capturePage; used to check the screenshot itself). */
  box?: { top: number; bottom: number; left: number; right: number };
};

export function checkRenderedPhotos(direction: ImageDirection, manifest: AssetManifest, placed: readonly PlacedPhoto[]): string[] {
  const expected = [...(direction.hero ? [{ assetId: direction.hero.assetId, role: "hero" as PhotoRole }] : []), ...direction.features.map((f) => ({ assetId: f.assetId, role: f.slot as PhotoRole }))];
  const key = (p: { assetId: string; role: PhotoRole }) => `${p.assetId}@${p.role}`;
  const want = expected.map(key).sort();
  const problems: string[] = [];
  for (const device of ["desktop", "mobile"] as const) {
    const shown = placed.filter((p) => p.device === device);
    const got = shown.map(key).sort();
    if (got.join(" ") !== want.join(" ")) problems.push(`${device}: shows [${got.join(", ")}], directed [${want.join(", ")}]`);
    if (new Set(shown.map((p) => p.assetId)).size !== shown.length) problems.push(`${device}: a photo appears twice`);
    for (const p of shown) {
      const asset = findAsset(manifest, p.assetId);
      if (!asset || !assetUsableIn(asset, "local_preview")) problems.push(`${device}: ${p.assetId} is not allowed`);
      if (!p.visible) problems.push(`${device}: ${p.assetId} not visible`);
      if (asset && p.labelled !== (asset.sourceKind === "generated_concept")) problems.push(`${device}: ${p.assetId} label`);
      if (p.overlapsText) problems.push(`${device}: ${p.assetId} covers text`);
    }
  }
  return problems;
}
