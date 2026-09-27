import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { renderDemo } from "@/components/demo/renderDemo";
import type { DemoView } from "@/lib/sales/demo-content";

// Templates may only show verified facts plus fixed, generic template copy.
// Any other visible text would be an invented claim (MVP_SPEC §7).

const full: DemoView = {
  template: "bakery_v1",
  name: "テスト工房",
  category: "bakery",
  ward: "中区",
  address: "名古屋市中区栄1-1-1",
  hours: "8:00〜17:00",
  closedDays: "月曜",
  access: "栄駅から徒歩5分",
  phone: "052-000-0000",
  description: "小さなパン屋です。",
  menuItems: ["食パン", "クロワッサン"],
};

// Fixtures are bakery; each case below swaps in the matching template/category.
const minimal: DemoView = {
  ...full,
  ward: null,
  address: null,
  hours: null,
  closedDays: null,
  access: null,
  phone: null,
  description: null,
  menuItems: [],
};

function visibleText(html: string): string[] {
  return html
    .replace(/<(svg)[\s\S]*?<\/\1>/g, " ")
    .replace(/<[^>]+>/g, "\n")
    .split("\n")
    .map((t) => t.replace(/&amp;/g, "&").trim())
    .filter(Boolean);
}

/** Visible text left after removing every fact value and every allowed phrase. */
function leftover(demo: DemoView, allowed: string[]): string {
  const facts = [demo.name, demo.ward, demo.address, demo.hours, demo.closedDays, demo.access, demo.phone, demo.description, ...demo.menuItems]
    .filter((v): v is string => Boolean(v));
  const byLength = (a: string, b: string) => b.length - a.length;
  const strip = (text: string, phrases: string[]) => [...phrases].sort(byLength).reduce((s, p) => s.split(p).join(""), text);
  // Facts first (they can sit inside template phrases), then template copy.
  const text = visibleText(renderToStaticMarkup(renderDemo(demo))).join("\n");
  return strip(strip(text, facts), allowed).replace(/\s+/g, "");
}

const ALLOWED_COPY = [
  // DemoFrame (notice + footer)
  "これは", "Second Root", "が作成した", "ご提案用のデモページ", "です。", "様の公式サイトではありません。",
  "このページは、", "様に向けて Second Root が公開情報をもとに作成したデモです。",
  "掲載内容は確認できた公開情報のみで、公式サイト・公式情報ではありません。",
  "Second Root（セカンドルート）｜名古屋の小さなお店のホームページ制作",
  // Section headings and labels
  "営業時間", "定休日", "住所", "アクセス", "電話",
  // Neutral headings only: "メニュー" never claims what kind of item a fact is.
  "お店の情報", "店舗のご案内", "メニュー", "店舗情報",
  "名古屋市の", "名古屋のパン屋", "パン屋", "名古屋の焼菓子店", "焼菓子店", "名古屋のカフェ", "カフェ",
];

const CASES = [
  ["bakery_v1", "bakery"],
  ["baked_goods_v1", "baked_goods"],
  ["cafe_v1", "cafe"],
] as const;

describe.each(CASES)("%s", (template, category) => {
  it("shows only verified facts and fixed template copy", () => {
    for (const demo of [full, minimal]) {
      expect(leftover({ ...demo, template, category }, ALLOWED_COPY)).toBe("");
    }
  });

  it("omits sections without facts and never prints empty placeholders", () => {
    const html = renderToStaticMarkup(renderDemo({ ...minimal, template, category }));
    expect(html).not.toMatch(/undefined|null|NaN/);
    for (const label of ["営業時間", "定休日", "電話", "メニュー", "ご紹介", "お店の情報", "店舗のご案内", "お店について", "店舗情報"]) {
      expect(html).not.toContain(label);
    }
    expect(html).toContain("公式サイトではありません");
  });

  it("hides no text in SVG, attributes or CSS content", () => {
    const html = renderToStaticMarkup(renderDemo({ ...full, template, category }));
    expect(html).not.toMatch(/<(text|title|desc)\b/);
    const attrs = [...html.matchAll(/\s(alt|title|aria-label|placeholder)="([^"]*)"/g)].map((m) => m[2]);
    expect(attrs).toEqual([]);
  });

  it("escapes shop text", () => {
    const html = renderToStaticMarkup(renderDemo({ ...full, template, category, name: "<script>alert(1)</script>" }));
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});

describe("template CSS", () => {
  it("adds no text through CSS content", () => {
    const dir = join(process.cwd(), "components/demo");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".css"))) {
      const values = [...readFileSync(join(dir, file), "utf8").matchAll(/(?<![-\w])content\s*:\s*([^;}]+)/g)].map((m) => m[1].trim());
      expect(values.filter((v) => v !== '""' && v !== "''"), file).toEqual([]);
    }
  });
});
