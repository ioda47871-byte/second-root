import { createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import ProfileRenderer from "@/components/demo/profile/ProfileRenderer";
import type { RenderFeature, RenderPhoto, RenderPhotos } from "@/lib/design-agent/assets/resolve";
import type { DesignProfile } from "@/lib/design-agent/profile";
import type { DemoView } from "@/lib/sales/demo-content";
import { ADDRESS_ONLY_SHOP, AMERICAN_EDITORIAL, MINIMAL_SHOP, SHOP } from "./fixtures";

// DEV-071a: the markup of the profile renderer before Stage 1, as hashes, for
// a matrix of fictional shops × profiles × photos. A profile without `layout`
// must keep rendering exactly this markup (renderer-baseline.test.tsx).

export const BASELINE_SHOPS: Record<string, DemoView> = {
  full: SHOP,
  minimal: MINIMAL_SHOP,
  address_only: ADDRESS_ONLY_SHOP,
  no_description: { ...SHOP, description: null },
  no_menu: { ...SHOP, menuItems: [] },
  hours_only: { ...MINIMAL_SHOP, hours: "9:00〜18:00", closedDays: "火曜" },
  japanese: { ...SHOP, name: "架空の焼菓子とコーヒーのテスト店", ward: "千種区", description: "テスト用の架空の紹介文です。\n二行目の文です。" },
  long_name: { ...SHOP, name: "EXAMPLE TEST BAKE HOUSE", menuItems: ["テストマフィン", "テストスコーン", "テストクッキー", "テストタルト", "テストパイ"] },
};

const p = (over: Partial<DesignProfile>): DesignProfile => ({ ...AMERICAN_EDITORIAL, ...over });
export const BASELINE_PROFILES: Record<string, DesignProfile> = {
  american: AMERICAN_EDITORIAL,
  single_ruled: p({
    direction: "nordic_minimal",
    composition: { grid: "single_column", infoStyle: "ruled_list", divider: "hairline" },
    heroLayout: { layout: "stacked_oversized", height: "medium", alignment: "left" },
    motifs: [],
    spacing: { scale: "tight" },
    motion: { intro: "none", sectionFade: true },
  }),
  asym_ledger: p({
    direction: "kissaten_retro",
    typography: { display: "mincho", body: "serif", displayCase: "as_is", displayWeight: "bold", tracking: "wide" },
    composition: { grid: "asymmetric_7_5", infoStyle: "ledger_columns", divider: "thick_rule" },
    heroLayout: { layout: "centered_cover", height: "tall", alignment: "center" },
    motifs: ["stamp_ring", "dot_grid", "ruled_frame"],
    spacing: { scale: "standard" },
    motion: { intro: "letter_reveal", sectionFade: false },
  }),
  condensed: p({
    direction: "pop_bakeshop",
    typography: { display: "condensed_grotesk", body: "sans", displayCase: "uppercase", displayWeight: "black", tracking: "normal" },
    composition: { grid: "editorial_12", infoStyle: "ruled_list", divider: "none" },
    heroLayout: { layout: "split_crop", height: "medium", alignment: "left" },
    motifs: ["muffin_paper_svg", "location_labels", "monogram"],
    motion: { intro: "rule_expand", sectionFade: true },
  }),
};

const photo = (id: string, over: Partial<RenderPhoto> = {}): RenderPhoto => ({
  assetId: id as RenderPhoto["assetId"],
  src: `/design-preview/asset/${id}`,
  sourceKind: "approved_real",
  width: 900,
  height: 600,
  fit: "cover",
  focal: { x: 0.3, y: 0.25 },
  mobileFocal: { x: 0.7, y: 0.6 },
  aspect: { desktop: "4:5", mobile: "1:1" },
  treatment: "natural",
  ...over,
});
const feature = (id: string, slot: RenderFeature["slot"], side: RenderFeature["side"]): RenderFeature => ({ ...photo(id), slot, side });
export const BASELINE_PHOTOS: Record<string, RenderPhotos | null> = {
  none: null,
  split_features: {
    layout: "split_hero",
    hero: photo("asset-111111111111111111111111", { sourceKind: "generated_concept" }),
    features: [feature("asset-222222222222222222222222", "about", "left"), feature("asset-333333333333333333333333", "visit", "right")],
  },
  framed_visit: { layout: "framed_hero", hero: photo("asset-444444444444444444444444", { treatment: "warm" }), features: [feature("asset-555555555555555555555555", "visit", "left")] },
};

export function baselineCases(): { key: string; html: () => string }[] {
  const cases: { key: string; html: () => string }[] = [];
  for (const [shopKey, demo] of Object.entries(BASELINE_SHOPS)) {
    for (const [profileKey, profile] of Object.entries(BASELINE_PROFILES)) {
      for (const [photoKey, photos] of Object.entries(BASELINE_PHOTOS)) {
        cases.push({ key: `${shopKey}/${profileKey}/${photoKey}`, html: () => renderToStaticMarkup(<ProfileRenderer demo={demo} profile={profile} photos={photos} />) });
      }
    }
  }
  return cases;
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
