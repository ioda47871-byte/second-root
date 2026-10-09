import type { DesignProfile } from "@/lib/design-agent/profile";
import type { VisualReview } from "@/lib/design-agent/review";
import type { DemoView } from "@/lib/sales/demo-content";

// Fictional shop and profiles for the design agent tests. No real shop data.

export const SHOP: DemoView = {
  template: "baked_goods_v1",
  name: "EXAMPLE TEST",
  category: "baked_goods",
  ward: "北区",
  address: "名古屋市北区テスト町1-2-3",
  hours: "10:00〜17:00",
  closedDays: "月曜",
  access: "テスト駅から徒歩5分",
  phone: "052-000-0000",
  description: "テスト用の架空の紹介文です。",
  menuItems: ["テストマフィン", "テストスコーン"],
};

export const MINIMAL_SHOP: DemoView = { ...SHOP, ward: null, address: null, hours: null, closedDays: null, access: null, phone: null, description: null, menuItems: [] };
export const ADDRESS_ONLY_SHOP: DemoView = { ...MINIMAL_SHOP, ward: "北区", address: "名古屋市北区テスト町1-2-3" };

export const AMERICAN_EDITORIAL: DesignProfile = {
  version: 1,
  direction: "american_editorial",
  palette: { background: "#F4E8D2", surface: "#FBF4E6", text: "#2A1916", primary: "#761D27", secondary: "#17284E", accent: "#B08A5A" },
  typography: { display: "editorial_serif", body: "sans", displayCase: "uppercase", displayWeight: "regular", tracking: "tight" },
  heroLayout: { layout: "split_crop", height: "full", alignment: "left" },
  composition: { grid: "editorial_12", infoStyle: "colophon", divider: "double_rule" },
  motifs: ["monogram", "location_labels", "muffin_paper_svg", "corner_marks"],
  spacing: { scale: "generous" },
  motion: { intro: "fade_rise", sectionFade: false },
  confidence: 0.82,
  rationale: ["fixture"],
};

export function review(over: Partial<VisualReview> = {}): VisualReview {
  return {
    verdict: "accept",
    brand_fit: 4,
    visual_quality: 4,
    hierarchy: 4,
    mobile_quality: 4,
    generic_template_feel: 2,
    problems: [],
    recommended_profile_changes: { summary: [], revised_profile: null },
    needs_renderer_change: false,
    renderer_change_note: "",
    ...over,
  };
}
