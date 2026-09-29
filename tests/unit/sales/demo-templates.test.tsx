import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { areaLabel, nameUnits } from "@/components/demo/info";
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

/**
 * Visible text left after removing every fact value and every allowed
 * phrase. Short tokens (English labels, list numbers) count only when they
 * are a whole text node, so they cannot be combined into a claim such as
 * "12 Hours".
 */
function leftover(demo: DemoView, allowed: string[], wholeNodes: string[] = WHOLE_NODE_COPY): string {
  const facts = [demo.name, demo.ward, demo.address, demo.hours, demo.closedDays, demo.access, demo.phone, demo.description, ...demo.menuItems]
    .filter((v): v is string => Boolean(v));
  const byLength = (a: string, b: string) => b.length - a.length;
  const strip = (text: string, phrases: string[]) => [...phrases].sort(byLength).reduce((s, p) => s.split(p).join(""), text);
  // Facts first (they can sit inside template phrases), then template copy.
  const text = visibleText(renderToStaticMarkup(renderDemo(demo)))
    .filter((node) => !wholeNodes.includes(node))
    .join("\n");
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
  "お店の情報", "店舗のご案内", "お店について", "メニュー", "店舗情報",
  "名古屋市の", "名古屋のパン屋", "パン屋", "名古屋の焼菓子店", "焼菓子店", "名古屋のカフェ", "カフェ",
  "名古屋市", "名古屋",
];

// Allowed only as a complete text node (see leftover).
const ORDINALS = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0"));
const WHOLE_NODE_COPY = [
  // Decorative English labels: translations of the category, the city and
  // the generic headings above, never claims about the shop.
  "Bakery", "Baked Goods", "Cafe", "Nagoya",
  "About", "Menu", "Information", "Hours", "Closed", "Address", "Access", "Tel",
  // Menu numbering.
  ...ORDINALS,
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

  it("uses English labels and list numbers only as standalone text", () => {
    const nodes = visibleText(renderToStaticMarkup(renderDemo({ ...full, template, category })));
    const words = WHOLE_NODE_COPY.filter((t) => !ORDINALS.includes(t));
    for (const node of nodes.filter((n) => !words.includes(n))) {
      for (const word of words) expect(node, node).not.toContain(word);
    }
    // Numbers appear once per verified menu item, in order, and nowhere else.
    expect(nodes.filter((n) => /\d/.test(n) && ORDINALS.includes(n))).toEqual(ORDINALS.slice(0, full.menuItems.length));
  });

  it("omits sections without facts and never prints empty placeholders", () => {
    const html = renderToStaticMarkup(renderDemo({ ...minimal, template, category }));
    expect(html).not.toMatch(/undefined|null|NaN/);
    for (const label of ["営業時間", "定休日", "電話", "メニュー", "ご紹介", "お店の情報", "店舗のご案内", "お店について", "店舗情報", "About", "Menu", "Information", "Hours", "Closed", "Address", "Access", "Tel"]) {
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

const cssDir = join(process.cwd(), "components/demo");
const cssFiles = readdirSync(cssDir).filter((f) => f.endsWith(".css"));

describe("template CSS", () => {
  it("adds no text through CSS content", () => {
    for (const file of cssFiles) {
      const values = [...readFileSync(join(cssDir, file), "utf8").matchAll(/(?<![-\w])content\s*:\s*([^;}]+)/g)].map((m) => m[1].trim());
      expect(values.filter((v) => v !== '""' && v !== "''"), file).toEqual([]);
    }
  });
});

describe("template visuals", () => {
  it("load no images or fonts from anywhere (no url() except in-page SVG references)", () => {
    for (const file of cssFiles) {
      const urls = [...readFileSync(join(cssDir, file), "utf8").matchAll(/url\(([^)]*)\)/g)].map((m) => m[1].trim());
      expect(urls.filter((u) => !u.startsWith("#")), file).toEqual([]);
    }
    for (const [template, category] of CASES) {
      const html = renderToStaticMarkup(renderDemo({ ...full, template, category }));
      expect(html).not.toMatch(/<img\b|<image\b|href="(?!https:\/\/secondroot\.jp)/);
    }
  });

  it("animate only when the visitor has not asked for reduced motion", () => {
    for (const file of cssFiles) {
      const css = readFileSync(join(cssDir, file), "utf8");
      const allowed = css.split("@media (prefers-reduced-motion: no-preference)");
      // Everything before the first no-preference block, and after its end, must not animate.
      const outside = [allowed[0], ...allowed.slice(1).map((part) => part.slice(closingBrace(part)))].join("\n");
      expect(outside, file).not.toMatch(/(?<![-\w])animation(-name)?\s*:/);
    }
  });
});

/** Index just past the brace that closes the block starting at the first "{". */
function closingBrace(css: string): number {
  let depth = 0;
  for (let i = css.indexOf("{"); i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return i + 1;
  }
  return css.length;
}

describe("cafe_v1 hours card", () => {
  it("shows closed days in the information section when hours are unknown", () => {
    const html = renderToStaticMarkup(renderDemo({ ...minimal, template: "cafe_v1", category: "cafe", closedDays: "月曜" }));
    expect(html).toContain("定休日");
    expect(html.match(/月曜/g)).toHaveLength(1);
    expect(html).not.toContain("営業時間");
  });

  it("puts closed days on the hours card, once, when hours are known", () => {
    const html = renderToStaticMarkup(renderDemo({ ...full, template: "cafe_v1", category: "cafe" }));
    expect(html.match(/月曜/g)).toHaveLength(1);
    expect(html.match(/8:00〜17:00/g)).toHaveLength(1);
  });
});

describe("template helpers", () => {
  it("builds the area label only from the verified ward", () => {
    expect(areaLabel({ ...full, ward: "中区" })).toBe("名古屋市中区のパン屋");
    expect(areaLabel({ ...full, ward: null, category: "cafe", template: "cafe_v1" })).toBe("名古屋のカフェ");
  });

  it("measures names so short names are set larger than long ones", () => {
    expect(nameUnits("喫茶テスト")).toBeLessThan(nameUnits("EXAMPLE BAKE STUDIO NAGOYA"));
    expect(nameUnits("EXAMPLE BAKE")).toBeLessThan(12);
    expect(nameUnits("x".repeat(500))).toBe(40);
    expect(nameUnits("")).toBe(3);
  });
});
