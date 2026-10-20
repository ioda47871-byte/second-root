import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ProfileRenderer from "@/components/demo/profile/ProfileRenderer";
import sectionStyles from "@/components/demo/profile/sections.module.css";
import { monogram, nameLines, nameTokens, WARD_ROMAJI } from "@/components/demo/profile/text";
import type { RenderPhotos } from "@/lib/design-agent/assets/resolve";
import { DEFAULT_LAYOUT, FIRST_VIEW_MENU_ITEMS, normalizeLayout } from "@/lib/design-agent/layout";
import { FIRST_VIEWS, type DesignProfile, type Layout } from "@/lib/design-agent/profile";
import type { DemoView } from "@/lib/sales/demo-content";
import { ADDRESS_ONLY_SHOP, MINIMAL_SHOP, SHOP } from "./fixtures";
import { BASELINE_PHOTOS, baselineCases, BASELINE_PROFILES, BASELINE_SHOPS } from "./renderer-baseline-cases";
import { BASE_PROFILE, coverageLayouts, FULL_SHOP, SPARSE_JP_SHOP, THREE_SHOPS } from "./stage1-fixtures";

// Stage 1 (DEV-071a): the renderer's sections drawn from a layout. Every word
// is still a fact or fixed copy, sections follow the normalized layout, and a
// profile without layout is the page before Stage 1. Fictional shops only.

const render = (demo: DemoView, profile: DesignProfile, photos: RenderPhotos | null = null) => renderToStaticMarkup(<ProfileRenderer demo={demo} profile={profile} photos={photos} />);

function visibleText(html: string): string[] {
  return html
    .replace(/<(svg)[\s\S]*?<\/\1>/g, " ")
    .replace(/<span[^>]*data-keep=""[^>]*>([^<]*)<\/span>/g, "$1")
    .replace(/<[^>]+>/g, "\n")
    .split("\n")
    .map((t) => t.replace(/&amp;/g, "&").trim())
    .filter(Boolean);
}

const FIXED_COPY = [
  "これは", "Second Root", "が作成した", "ご提案用のデモページ", "です。", "様の公式サイトではありません。",
  "このページは、", "様に向けて Second Root が公開情報をもとに作成したデモです。",
  "掲載内容は確認できた公開情報のみで、公式サイト・公式情報ではありません。",
  "Second Root（セカンドルート）｜名古屋の小さなお店のホームページ制作",
  "営業時間", "定休日", "住所", "アクセス", "電話", "メニュー", "店舗のご案内", "店について",
  "名古屋市の", "名古屋の", "パン屋", "焼菓子店", "カフェ", "名古屋市",
];
const WHOLE_NODES = ["Bakery", "Baked Goods", "Cafe", "About", "Menu", "Visit", "Hours", "Closed", "Address", "Access", "Tel", "NAGOYA",
  ...Object.values(WARD_ROMAJI), ...Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0"))];
// Claim words the renderer must never add (the fictional facts here contain none).
const CLAIMS = /おすすめ|オススメ|人気|看板|名物|自慢|こだわり|限定|一番|No\.?\s?1|best|popular|signature|recommend/i;

function leftover(demo: DemoView, html: string): string {
  const facts = [demo.name, demo.ward, demo.address, demo.hours, demo.closedDays, demo.access, demo.phone, demo.description, ...demo.menuItems].filter((v): v is string => Boolean(v));
  const whole = [...WHOLE_NODES, monogram(demo.name), ...nameLines(demo.name), ...nameTokens(demo.name).map((t) => t.trimEnd())];
  const text = visibleText(html).filter((n) => !whole.includes(n)).join("\n");
  const strip = (s: string, phrases: string[]) => [...phrases].sort((a, b) => b.length - a.length).reduce((acc, p) => acc.split(p).join(""), s);
  return strip(strip(text, facts), FIXED_COPY).replace(/\s+/g, "");
}

const SHOPS: Record<string, DemoView> = {
  full: FULL_SHOP,
  sparse_jp: SPARSE_JP_SHOP,
  fixture: SHOP,
  minimal: MINIMAL_SHOP,
  address_only: ADDRESS_ONLY_SHOP,
  ...Object.fromEntries(Object.entries(THREE_SHOPS).map(([k, v]) => [k, v.demo])),
};
const LAYOUTS: { key: string; layout: Layout }[] = [
  ...coverageLayouts(),
  ...Object.entries(THREE_SHOPS).map(([key, v]) => ({ key, layout: v.profile.layout! })),
  ...FIRST_VIEWS.map((firstView) => ({ key: `fv-${firstView}`, layout: { ...DEFAULT_LAYOUT, firstView } })),
];

const attr = (html: string, name: string) => [...html.matchAll(new RegExp(`<section[^>]*\\s${name}="([^"]*)"`, "g"))].map((m) => m[1]);
const count = (html: string, text: string) => html.split(text).length - 1;

describe("sections from a layout", () => {
  it("shows only facts and fixed copy, and adds no claim words, for every layout and shop", () => {
    for (const [shopKey, demo] of Object.entries(SHOPS)) {
      for (const { key, layout } of LAYOUTS) {
        const html = render(demo, { ...BASE_PROFILE, layout });
        expect(leftover(demo, html), `${shopKey}/${key}`).toBe("");
        expect(visibleText(html).join("\n"), `${shopKey}/${key}`).not.toMatch(CLAIMS);
        expect(html).not.toMatch(/undefined|null|NaN/);
      }
    }
  });

  it("draws the normalized sections in order, each fact where the layout puts it, the description once", () => {
    for (const [shopKey, demo] of Object.entries(SHOPS)) {
      for (const { key, layout } of LAYOUTS) {
        const label = `${shopKey}/${key}`;
        const html = render(demo, { ...BASE_PROFILE, layout });
        const normal = normalizeLayout(layout, demo).layout;
        expect(attr(html, "data-kind"), label).toEqual(normal.sections.map((s) => s.kind));
        expect(attr(html, "data-variant"), label).toEqual(normal.sections.map((s) => s.variant));
        expect(attr(html, "data-ground"), label).toEqual(normal.sections.map((s) => s.ground));
        expect(html, label).toContain(`data-first-view="${normal.firstView}" data-scale="${normal.type.scale}" data-headings="${normal.type.headings}"`);
        // one h1 with the name; the description exactly once (hero or about)
        expect(html.match(/<h1\b/g), label).toHaveLength(1);
        if (demo.description) expect(count(html, demo.description.replace(/&/g, "&amp;")), label).toBe(1);
        // every menu item in the menu section; the hero shows the first three only with name_menu
        const menu = html.match(/<section[^>]*data-kind="menu"[\s\S]*?<\/section>/)?.[0] ?? "";
        for (const item of demo.menuItems) expect(menu, `${label}: ${item}`).toContain(`>${item}<`);
        const hero = html.match(/<header[\s\S]*?<\/header>/)?.[0] ?? "";
        const inHero = demo.menuItems.filter((item) => hero.includes(`>${item}<`));
        expect(inHero, label).toEqual(normal.firstView === "name_menu" ? demo.menuItems.slice(0, FIRST_VIEW_MENU_ITEMS) : []);
        // the hours and closed days: in the hours section when there is one, else in visit
        const home = normal.sections.some((s) => s.kind === "hours") ? "hours" : "visit";
        const section = html.match(new RegExp(`<section[^>]*data-kind="${home}"[\\s\\S]*?</section>`))?.[0] ?? "";
        for (const fact of [demo.hours, demo.closedDays]) if (fact) expect(section.replace(/<[^>]+>/g, ""), `${label}: ${fact}`).toContain(fact.replace(/\n/g, "\n"));
        // nothing but Japanese script is ever marked for vertical writing
        for (const m of html.matchAll(new RegExp(`class="[^"]*${sectionStyles.vertical}[^"]*">([^<]*)<`, "g"))) expect(m[1], label).toMatch(/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー々〆ヶ・]+$/u);
        if (normal.firstView === "vertical_name") expect(html, label).toContain(sectionStyles.vname);
        else expect(html, label).not.toContain(sectionStyles.vname);
      }
    }
  });

  it("draws a feature photo only in a section that is drawn", () => {
    const photos = BASELINE_PHOTOS.split_features!;
    const lead = render(SHOP, { ...BASE_PROFILE, layout: { ...DEFAULT_LAYOUT, firstView: "name_lead" } }, photos);
    expect(lead).not.toContain('data-role="about"');
    expect(lead).toContain('data-role="visit"');
    const both = render(SHOP, { ...BASE_PROFILE, layout: DEFAULT_LAYOUT }, photos);
    expect(both).toContain('data-role="about"');
    expect(both).toMatch(/<section[^>]*data-photo-section="about"[^>]*data-kind="about"|<section[^>]*data-kind="about"[^>]*data-photo-section="about"/);
  });

  it("draws DEFAULT_LAYOUT as the page without layout, apart from the layout's own attributes and classes", () => {
    // sections.module.css's classes all end in the module's own suffix
    const suffix = sectionStyles.sec.slice("_sec".length);
    expect(suffix).toMatch(/^_\w+$/);
    const own = new RegExp(`\\s_[A-Za-z]+${suffix}(?=")|\\s(data-kind|data-variant|data-ground|data-short|data-first-view|data-scale|data-headings)="[^"]*"`, "g");
    for (const c of baselineCases()) {
      const [shopKey, profileKey, photoKey] = c.key.split("/");
      const withDefault = render(BASELINE_SHOPS[shopKey], { ...BASELINE_PROFILES[profileKey], layout: DEFAULT_LAYOUT }, BASELINE_PHOTOS[photoKey]);
      const a = withDefault.replace(own, ""), b = c.html();
      expect(a, c.key).toBe(b);
    }
  });
});

describe("sections CSS", () => {
  it("adds no text, no images, no animation", async () => {
    const text = (await readFile(join(process.cwd(), "components/demo/profile/sections.module.css"), "utf8")).replace(/\/\*[\s\S]*?\*\//g, (c) => (c.includes("---------- desktop") ? c : ""));
    const contents = [...text.matchAll(/(?<![-\w])content\s*:\s*([^;}]+)/g)].map((m) => m[1].trim());
    expect(contents.filter((v) => v !== '""')).toEqual([]);
    expect(text).not.toMatch(/url\(|@import|animation|transition|@keyframes/);
    // vertical writing appears only inside the desktop media query
    const [phoneAndBase, desktop] = text.split("/* ---------- desktop ---------- */");
    expect(phoneAndBase).not.toMatch(/writing-mode/);
    expect(desktop).toMatch(/@media \(min-width: 720px\)/);
  });
});
