import { readFileSync } from "node:fs";
import { join } from "node:path";
import demoStyles from "@/components/demo/demo.module.css";
import profileStyles from "@/components/demo/profile/profile.module.css";
import sectionStyles from "@/components/demo/profile/sections.module.css";
import { FIRST_VIEWS, GROUNDS, HEADING_STYLES, SECTION_VARIANTS, TYPE_SCALES, type DesignProfile, type Layout, type LayoutSection } from "@/lib/design-agent/profile";
import type { DemoView } from "@/lib/sales/demo-content";
import { AMERICAN_EDITORIAL, SHOP } from "./fixtures";

// Stage 1 (DEV-071a) test data: fictional shops, hand-written layouts (Codex
// does not write layouts until DEV-071b) and the page CSS for Chromium.

function moduleCss(file: string, names: Record<string, string>): string {
  const css = readFileSync(join(process.cwd(), file), "utf8");
  return css.replace(/\.(-?[_a-zA-Z][\w-]*)/g, (whole, name: string) => (names[name] ? `.${names[name]}` : whole));
}

/** The renderer's module CSS as written, with class names mapped to the ones the components render in tests. */
export const PAGE_CSS = [
  "*, *::before, *::after { box-sizing: border-box; } body { margin: 0; }",
  // The site's Japanese faces come from the app's layout; here, installed Japanese faces with
  // vertical metrics (a face without them sets vertical text overlapping, which no visitor sees).
  ':root { --font-body: "IPAGothic", "Noto Sans CJK JP", sans-serif; --font-display: "IPAMincho", "IPAGothic", "Noto Serif CJK JP", serif; }',
  moduleCss("components/demo/demo.module.css", demoStyles as Record<string, string>),
  moduleCss("components/demo/profile/profile.module.css", profileStyles as Record<string, string>),
  moduleCss("components/demo/profile/sections.module.css", sectionStyles as Record<string, string>),
].join("\n");

export const pageHtml = (body: string) =>
  `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${PAGE_CSS}</style></head><body>${body}</body></html>`;

export const VIEWPORTS = {
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
  narrow: { viewport: { width: 360, height: 780 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1440, height: 900 } },
} as const;

/**
 * Widths every Stage 1 layout is checked at (DEV-071b: a phone number overflowed at
 * 720–760px while only 360 / 390 / 1440 were tested): small and common screens, and
 * each breakpoint of profile.module.css / sections.module.css (720 and 1100) ±1px.
 */
export const SWEEP_WIDTHS = [320, 360, 390, 719, 720, 721, 760, 768, 1024, 1099, 1100, 1101, 1440] as const;
/** The renderer's desktop rules start here (vertical writing included). */
export const DESKTOP_MIN = 720;
export const sweepViewport = (width: number) =>
  width < DESKTOP_MIN ? { viewport: { width, height: 800 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true } : { viewport: { width, height: 900 } };

/** Many facts, long ones included. */
export const FULL_SHOP: DemoView = {
  ...SHOP,
  name: "EXAMPLE TEST BAKE HOUSE",
  address: "名古屋市北区架空町九丁目テスト通り9-99-99 テストビルディング2F",
  hours: "平日 8:00〜18:00\n土日祝 7:30〜17:00（売り切れ次第終了）",
  closedDays: "月曜・第3火曜",
  access: "テスト線テスト駅 2番出口から徒歩5分（テスト公園の向かい）",
  description: "テスト用の架空の紹介文です。小さな店で、毎朝焼いたパンと焼菓子を並べています。\n二行目の架空の文です。",
  menuItems: ["テストクロワッサン", "テストバゲット", "季節のテストタルト", "テストスコーン（プレーン）", "テストブリオッシュ", "とても長い名前の架空のテスト用ハード系パン"],
};

/** Few facts, a Japanese name that may be set vertically. */
export const SPARSE_JP_SHOP: DemoView = {
  template: "cafe_v1",
  name: "架空珈琲店",
  category: "cafe",
  ward: "千種区",
  address: "名古屋市千種区テスト町2-3",
  hours: "11:00〜19:00",
  closedDays: null,
  access: null,
  phone: null,
  description: null,
  menuItems: ["テストブレンド"],
};

const pick = <T>(list: readonly T[], i: number): T => list[i % list.length];

/**
 * Layouts that together use every kind × variant × ground at least once, with
 * the first views, scales and heading styles rotated among them.
 */
export function coverageLayouts(): { key: string; layout: Layout }[] {
  const out: { key: string; layout: Layout }[] = [];
  let n = 0;
  for (const [g, ground] of GROUNDS.entries()) {
    for (let i = 0; i < 4; i++) {
      // the other sections of the page take the other grounds, so bands meet plain sections and each other
      const other = (k: number) => GROUNDS[(g + k) % GROUNDS.length];
      const sections: LayoutSection[] = [
        { kind: "about", variant: pick(SECTION_VARIANTS.about, i), ground },
        { kind: "menu", variant: pick(SECTION_VARIANTS.menu, i), ground: i % 2 === 0 ? ground : other(1) },
        { kind: "hours", variant: pick(SECTION_VARIANTS.hours, i), ground: i % 2 === 1 ? ground : other(2) },
        { kind: "visit", variant: pick(SECTION_VARIANTS.visit, i), ground },
      ];
      // a different order on each page
      const order = sections.map((s, k) => ({ s, k: (k * 3 + i + g) % 4 })).sort((a, b) => a.k - b.k).map((x) => x.s);
      // name_lead takes the about section into the hero: it gets pages of its own below
      const layout: Layout = { firstView: pick(FIRST_VIEWS.filter((v) => v !== "name_lead"), n), sections: order, type: { scale: pick(TYPE_SCALES, n), headings: pick(HEADING_STYLES, n + g) } };
      out.push({ key: `${ground}-${i}`, layout });
      n++;
    }
  }
  for (const [g, ground] of GROUNDS.entries()) {
    out.push({
      key: `lead-${ground}`,
      layout: {
        firstView: "name_lead",
        sections: [
          { kind: "visit", variant: pick(SECTION_VARIANTS.visit, g + 1), ground },
          { kind: "menu", variant: pick(SECTION_VARIANTS.menu, g + 1), ground: GROUNDS[(g + 1) % 3] },
        ],
        type: { scale: pick(TYPE_SCALES, g), headings: pick(HEADING_STYLES, g + 1) },
      },
    });
  }
  return out;
}

/**
 * Palettes checkProfile accepts in which every pair it does NOT guarantee reads
 * badly (primary or secondary on the surface, accent anywhere), so a word set in an
 * unguaranteed pair shows up in the colour-pair test.
 */
export const PALETTES: Record<string, DesignProfile["palette"]> = {
  // DEV-067's adversarial palette: a mid-brown surface
  adverse: { background: "#FBF7EF", surface: "#B07A4F", text: "#000000", primary: "#8A4B22", secondary: "#6E5A44", accent: "#D4A017" },
  // a dark page with a light primary
  dark: { background: "#16130F", surface: "#4A4033", text: "#FFFFFF", primary: "#E9B44C", secondary: "#D8CDB8", accent: "#7A5C2E" },
  // the surface equals the background, a grey primary
  flat: { background: "#FFFFFF", surface: "#FFFFFF", text: "#111111", primary: "#5E5E5E", secondary: "#4A4A4A", accent: "#E0E0E0" },
};

/** A profile whose palette exercises the contrast pairs (dark primary, light background). */
export const BASE_PROFILE: DesignProfile = {
  ...AMERICAN_EDITORIAL,
  heroLayout: { layout: "stacked_oversized", height: "medium", alignment: "left" },
  motion: { intro: "none", sectionFade: false },
};

// ------------------------------------------------------------ three shops

/**
 * Three fictional shops of different categories and brands, each with a
 * hand-written Design Spec (Stage 1 shows what the renderer can express; the
 * specs Codex writes come with DEV-071b).
 */
export const THREE_SHOPS: Record<string, { demo: DemoView; profile: DesignProfile }> = {
  // A quiet Japanese bakery: vertical name, Japanese headings set vertically, a green ink.
  bakery: {
    demo: {
      template: "bakery_v1",
      name: "麦と灯",
      category: "bakery",
      ward: "昭和区",
      address: "名古屋市昭和区架空町3-14-1",
      hours: "8:00〜売り切れまで",
      closedDays: "日曜・月曜",
      access: "テスト駅から徒歩6分",
      phone: "052-000-3141",
      description: "テスト用の架空のパン屋です。国産小麦の食パンと、季節の果物を使ったパンを少しずつ焼いています。朝の焼き上がりから順に店頭に並べ、売り切れたらその日の営業を終えます。",
      menuItems: ["テスト食パン", "テストカンパーニュ", "季節の果物のテストデニッシュ", "テストあんぱん", "テストクリームパン"],
    },
    profile: {
      ...AMERICAN_EDITORIAL,
      direction: "japanese_modern",
      palette: { background: "#F5F1E8", surface: "#E9E2D2", text: "#1F2420", primary: "#2F4A3A", secondary: "#3F4A42", accent: "#B4873F" },
      typography: { display: "mincho", body: "serif", displayCase: "as_is", displayWeight: "regular", tracking: "wide" },
      heroLayout: { layout: "stacked_oversized", height: "tall", alignment: "left" },
      composition: { grid: "single_column", infoStyle: "ruled_list", divider: "hairline" },
      motifs: ["corner_marks"],
      spacing: { scale: "generous" },
      motion: { intro: "none", sectionFade: false },
      layout: {
        firstView: "vertical_name",
        sections: [
          { kind: "about", variant: "side_heading", ground: "plain" },
          { kind: "menu", variant: "columns", ground: "surface" },
          { kind: "hours", variant: "block", ground: "plain" },
          { kind: "visit", variant: "split", ground: "inverted" },
        ],
        type: { scale: "quiet", headings: "vertical_ja" },
      },
    },
  },
  // A loud coffee stand: the menu first in the hero and as chips on a dark band, big type.
  cafe: {
    demo: {
      template: "cafe_v1",
      name: "EXAMPLE COFFEE STAND",
      category: "cafe",
      ward: "中区",
      address: "名古屋市中区テスト栄1-2-3 テストビル1F",
      hours: "7:00〜16:00",
      closedDays: "不定休",
      access: null,
      phone: "052-000-1234",
      description: "テスト用の架空のコーヒースタンドです。",
      menuItems: ["テストエスプレッソ", "テストラテ", "テストコールドブリュー", "テストドーナツ"],
    },
    profile: {
      ...AMERICAN_EDITORIAL,
      direction: "american_editorial",
      palette: { background: "#FFF8EE", surface: "#FFFFFF", text: "#1C1916", primary: "#B23A12", secondary: "#3B2F27", accent: "#F2B33D" },
      typography: { display: "condensed_grotesk", body: "sans", displayCase: "uppercase", displayWeight: "black", tracking: "tight" },
      heroLayout: { layout: "split_crop", height: "medium", alignment: "left" },
      composition: { grid: "editorial_12", infoStyle: "ledger_columns", divider: "thick_rule" },
      motifs: ["location_labels", "dot_grid"],
      spacing: { scale: "standard" },
      motion: { intro: "none", sectionFade: false },
      layout: {
        firstView: "name_menu",
        sections: [
          { kind: "visit", variant: "cards", ground: "plain" },
          { kind: "menu", variant: "chips", ground: "inverted" },
          { kind: "about", variant: "statement", ground: "surface" },
        ],
        type: { scale: "dramatic", headings: "en_ja" },
      },
    },
  },
  // A soft pâtisserie: the description in the first view, one item set large, a centred colophon.
  patisserie: {
    demo: {
      template: "baked_goods_v1",
      name: "Atelier Exemple",
      category: "baked_goods",
      ward: "千種区",
      address: "名古屋市千種区テスト通り4-5-6",
      hours: "11:00〜18:00",
      closedDays: "火曜・水曜",
      access: "テスト駅から徒歩3分",
      phone: "052-000-5678",
      description: "テスト用の架空の焼菓子店です。\nフィナンシェとマドレーヌを中心に、小さな焼菓子を作っています。",
      menuItems: ["テストフィナンシェ", "テストマドレーヌ", "テストサブレ", "テストガレット", "テストカヌレ", "テストパウンドケーキ"],
    },
    profile: {
      ...AMERICAN_EDITORIAL,
      direction: "editorial_luxury",
      palette: { background: "#FBF6F2", surface: "#F2E5DE", text: "#2A2225", primary: "#6E2B3D", secondary: "#4A3A40", accent: "#C7A07C" },
      typography: { display: "editorial_serif", body: "serif", displayCase: "as_is", displayWeight: "light", tracking: "normal" },
      heroLayout: { layout: "centered_cover", height: "tall", alignment: "center" },
      composition: { grid: "asymmetric_7_5", infoStyle: "colophon", divider: "double_rule" },
      motifs: ["ruled_frame"],
      spacing: { scale: "generous" },
      motion: { intro: "none", sectionFade: false },
      layout: {
        firstView: "name_lead",
        sections: [
          { kind: "menu", variant: "feature_first", ground: "surface" },
          { kind: "hours", variant: "strip", ground: "plain" },
          { kind: "visit", variant: "stacked", ground: "plain" },
        ],
        type: { scale: "quiet", headings: "ja_en" },
      },
    },
  },
};
