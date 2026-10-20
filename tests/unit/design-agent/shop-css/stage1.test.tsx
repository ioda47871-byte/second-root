import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "playwright";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import ProfileRenderer from "@/components/demo/profile/ProfileRenderer";
import { FIRST_VIEWS, GROUNDS, HEADING_STYLES, SECTION_KINDS, SECTION_VARIANTS, TYPE_SCALES } from "@/lib/design-agent/profile";
import { demoFacts } from "@/lib/design-agent/shop-css/apply";
import { guardShopCss, SHOP_CSS_ATTRIBUTES, TEXT_FREE_ELEMENTS, type GuardedShopCss } from "@/lib/design-agent/shop-css/guard";
import { MEASURE_SCRIPT, MeasureSchema } from "@/lib/design-agent/shop-css/page-scripts";
import { checkShopCssRender, checkWidths, containerSwitchWidths } from "@/lib/design-agent/shop-css/render-check";
import { AMERICAN_EDITORIAL, SHOP } from "../fixtures";
import { BASE_PROFILE, coverageLayouts, FULL_SHOP, SPARSE_JP_SHOP, THREE_SHOPS } from "../stage1-fixtures";
import { launch, pageBuilder } from "./support";

// DEV-072 on the Stage 1 renderer (DEV-071a): the allowlisted hooks are the
// renderer's real attributes and values, the example stylesheets pass on
// Stage 1 layouts (vertical name, vertical headings, first-view excerpts), and
// the measurement covers the new headings and excerpts, vertical ones included.

vi.setConfig({ testTimeout: 300_000 });

const guarded = (css: string): GuardedShopCss => {
  const r = guardShopCss(css);
  if (!r.ok) throw new Error(`guard rejected the test stylesheet: ${r.problems.join(", ")}`);
  return r.css;
};
const example = (name: string) => readFileSync(join(process.cwd(), "tests/unit/design-agent/shop-css/examples", `${name}.css`), "utf8");

describe("the allowlisted Stage 1 hooks are the renderer's", () => {
  it("values equal the profile schema's", () => {
    const sorted = (v: readonly string[]) => [...v].sort();
    expect(sorted(SHOP_CSS_ATTRIBUTES["data-kind"]!)).toEqual(sorted(SECTION_KINDS));
    expect(sorted(SHOP_CSS_ATTRIBUTES["data-variant"]!)).toEqual(sorted([...new Set(Object.values(SECTION_VARIANTS).flat())]));
    expect(sorted(SHOP_CSS_ATTRIBUTES["data-ground"]!)).toEqual(sorted(GROUNDS));
    expect(sorted(SHOP_CSS_ATTRIBUTES["data-first-view"]!)).toEqual(sorted(FIRST_VIEWS));
    expect(sorted(SHOP_CSS_ATTRIBUTES["data-scale"]!)).toEqual(sorted(TYPE_SCALES));
    expect(sorted(SHOP_CSS_ATTRIBUTES["data-headings"]!)).toEqual(sorted(HEADING_STYLES));
  });

  it("every allowlisted attribute value appears in the rendered markup", () => {
    const pages = [
      ...coverageLayouts().map(({ layout }) => renderToStaticMarkup(<ProfileRenderer demo={FULL_SHOP} profile={{ ...BASE_PROFILE, layout }} />)),
      ...Object.values(THREE_SHOPS).map(({ demo, profile }) => renderToStaticMarkup(<ProfileRenderer demo={demo} profile={profile} />)),
      ...(["name_lead", "name_hours", "name_menu"] as const).map((firstView) => renderToStaticMarkup(<ProfileRenderer demo={FULL_SHOP} profile={{ ...BASE_PROFILE, layout: { firstView, sections: [{ kind: "visit", variant: "ledger", ground: "plain" }], type: { scale: "standard", headings: "en_ja" } } }} />)),
    ].join("\n");
    const missing: string[] = [];
    for (const [name, values] of Object.entries(SHOP_CSS_ATTRIBUTES)) for (const value of values) if (!pages.includes(`${name}="${value}"`)) missing.push(`${name}="${value}"`);
    expect(missing).toEqual([]);
  });
});

let browser: Browser;
beforeAll(async () => {
  browser = await launch();
});
afterAll(async () => {
  await browser?.close();
});

describe("the guard can tell which elements hold no text (grid and flex only on them)", () => {
  it("header, main, section, div, ol, ul and dl never hold text directly, on any layout", async () => {
    const pages = [
      renderToStaticMarkup(<ProfileRenderer demo={SHOP} profile={AMERICAN_EDITORIAL} />),
      renderToStaticMarkup(<ProfileRenderer demo={SPARSE_JP_SHOP} profile={AMERICAN_EDITORIAL} />),
      ...coverageLayouts().map(({ layout }) => renderToStaticMarkup(<ProfileRenderer demo={FULL_SHOP} profile={{ ...BASE_PROFILE, layout }} />)),
      ...Object.values(THREE_SHOPS).map(({ demo, profile }) => renderToStaticMarkup(<ProfileRenderer demo={demo} profile={profile} />)),
      ...(["name_lead", "name_hours", "name_menu", "vertical_name"] as const).map((firstView) => renderToStaticMarkup(<ProfileRenderer demo={FULL_SHOP} profile={{ ...BASE_PROFILE, layout: { firstView, sections: [{ kind: "visit", variant: "ledger", ground: "plain" }], type: { scale: "standard", headings: "en_ja" } } }} />)),
    ];
    const page = await browser.newPage();
    try {
      for (const html of pages) {
        await page.setContent(`<!doctype html><html><body>${html}</body></html>`);
        const found = await page.evaluate(`(() => Array.from(document.querySelectorAll(${JSON.stringify(TEXT_FREE_ELEMENTS.join(","))})).filter((el) => el.closest('[role="note"], footer') === null && Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.data.trim() !== "")).map((el) => el.tagName + "." + el.className))()`);
        expect(found).toEqual([]);
      }
    } finally {
      await page.close();
    }
  });
});

describe("render check on Stage 1 layouts", () => {
  for (const [shop, { demo, profile }] of Object.entries(THREE_SHOPS))
    for (const name of ["kissa-retro", "atelier-mono", "sakura-wagashi", "stage1-hooks"])
      it(`${name} on ${shop} (${profile.layout?.firstView}, ${profile.layout?.type.headings})`, async () => {
        const r = await checkShopCssRender({ browser, build: pageBuilder(demo, profile), css: guarded(example(name)), facts: demoFacts(demo) });
        expect(r.problems).toEqual([]);
      });

  it("the measurement covers the vertical name, the vertical headings and the first-view excerpts", async () => {
    const measure = async (shop: keyof typeof THREE_SHOPS, width: number) => {
      const { demo, profile } = THREE_SHOPS[shop]!;
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
      try {
        await page.setContent(pageBuilder(demo, profile)(guarded(example("stage1-hooks"))));
        return MeasureSchema.parse(await page.evaluate(`(${MEASURE_SCRIPT})(${JSON.stringify({ facts: demoFacts(demo) })})`));
      } finally {
        await page.close();
      }
    };
    const bakery = await measure("bakery", 1440);
    const name = bakery.nodes.filter((n) => n.kind === "fact" && THREE_SHOPS.bakery!.demo.name.includes(n.text));
    expect(name.length).toBeGreaterThan(0);
    expect(name.every((n) => n.vertical && n.chars.length > 0)).toBe(true);
    for (const heading of ["店について", "メニュー", "営業時間", "店舗のご案内"]) {
      const node = bakery.nodes.find((n) => n.kind === "label" && n.text === heading);
      expect(node, heading).toBeDefined();
      expect(node!.vertical, heading).toBe(true);
      expect(node!.chars.length, heading).toBe(heading.length);
    }
    const cafe = await measure("cafe", 390);
    // the first-view menu excerpt: facts, with its fixed label
    const firstItem = THREE_SHOPS.cafe!.demo.menuItems[0]!;
    expect(cafe.nodes.filter((n) => n.kind === "fact" && n.text === firstItem).length).toBeGreaterThanOrEqual(2);
    expect(cafe.nodes.some((n) => n.kind === "label" && n.text === "Menu")).toBe(true);
    const patisserie = await measure("patisserie", 390);
    expect(patisserie.nodes.some((n) => n.kind === "fact" && THREE_SHOPS.patisserie!.demo.description!.startsWith(n.text.slice(0, 10)))).toBe(true);
  });

  it("a footer moved by a fraction of a pixel is the same footer (CI 118754174929: the text antialiased differently)", async () => {
    const { demo, profile } = THREE_SHOPS.cafe!;
    for (const shift of ["0.25px", "0.5px", "0.75px"]) {
      const r = await checkShopCssRender({ browser, build: pageBuilder(demo, profile), css: guarded(`#shop-css main { padding-bottom: calc(24px + ${shift}); }`), facts: demoFacts(demo), exhaustive: true });
      expect(r.problems, shift).toEqual([]);
    }
  });

  it("container-query switches (DEV-071b split visit) are found and checked on both sides, where the shop CSS moves them", async () => {
    const { demo, profile } = THREE_SHOPS.bakery!;
    const build = pageBuilder(demo, profile);
    const base = await containerSwitchWidths(browser, build(null));
    expect(base, "the split visit's rows switch somewhere in 320–1920px").not.toBeNull();
    expect(base!.length).toBeGreaterThan(0);
    // wider padding around the split block moves the switch to a wider viewport
    const css = guarded('#shop-css section[data-variant="split"] { padding-left: 120px; padding-right: 120px; }');
    const moved = await containerSwitchWidths(browser, build(css));
    expect(moved).not.toEqual(base);
    const r = await checkShopCssRender({ browser, build, css, facts: demoFacts(demo), exhaustive: true });
    for (const w of [...base!, ...moved!]) expect(r.widths, `width ${w}`).toContain(w);
    expect(r.widths.length).toBeGreaterThan(checkWidths(css).length);
  });

  const BAD: Array<[string, keyof typeof THREE_SHOPS, string, string[]]> = [
    ["the vertical name made transparent (pixel proof on vertical text)", "bakery", "#shop-css h1 { color: transparent; }", ["fact_contrast", "fact_ink"]],
    ["vertical headings made transparent", "bakery", "#shop-css section h2 span { color: transparent; }", ["label_contrast", "label_ink"]],
    ["the inverted band's values made transparent (data-ground hook)", "bakery", '#shop-css section[data-ground="inverted"] dd { color: transparent; }', ["fact_contrast", "fact_ink"]],
    ["the first-view menu excerpt washed out (data-fv hook)", "cafe", '#shop-css div[data-fv="menu"] li { color: var(--p-bg); }', ["fact_contrast", "fact_ink"]],
    ["the chips covered by their heading (data-kind hook)", "cafe", '#shop-css section[data-kind="menu"] { display: grid; } #shop-css section[data-kind="menu"] > h2, #shop-css section[data-kind="menu"] > ol { grid-row: 1; grid-column: 1; } #shop-css section[data-kind="menu"] > h2 { order: 2; background-color: var(--p-bg); }', ["fact_covered", "fact_ink"]],
  ];
  for (const [name, shop, css, expected] of BAD)
    it(name, async () => {
      const { demo, profile } = THREE_SHOPS[shop]!;
      const r = await checkShopCssRender({ browser, build: pageBuilder(demo, profile), css: guarded(css), facts: demoFacts(demo) });
      expect(r.ok).toBe(false);
      expect(r.problems.some((p) => expected.includes(p.split(":")[1]!)), r.problems.join(" ")).toBe(true);
    });
});
