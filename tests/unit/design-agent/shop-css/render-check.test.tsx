import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { demoFacts, shopCssOrFallback } from "@/lib/design-agent/shop-css/apply";
import { guardShopCss, type GuardedShopCss } from "@/lib/design-agent/shop-css/guard";
import { checkShopCssRender, checkWidths, inkOf, type ShopCssPageBuilder } from "@/lib/design-agent/shop-css/render-check";
import type { DemoView } from "@/lib/sales/demo-content";
import { AMERICAN_EDITORIAL, SHOP } from "../fixtures";
import { launch, pageBuilder } from "./support";

// DEV-072: the Chromium render check of a per-shop stylesheet, at 360, 390 and
// 1440 px, against the same page without it. Stylesheets that pass the static
// guard but hide, cover, shrink, fade or wash out facts must fail; the example
// shop stylesheets must pass. Fictional shops only; nothing is fetched.

vi.setConfig({ testTimeout: 240_000 });

const JA_SHOP: DemoView = { ...SHOP, template: "cafe_v1", category: "cafe", name: "架空の喫茶室", description: "昔ながらのナポリタンとクリームソーダの店です。", menuItems: ["ナポリタン", "クリームソーダ", "ホットケーキ"], ward: "中区" };
const guarded = (css: string): GuardedShopCss => {
  const r = guardShopCss(css);
  if (!r.ok) throw new Error(`guard rejected the test stylesheet: ${r.problems.join(", ")}`);
  return r.css;
};
const example = (name: string) => readFileSync(join(process.cwd(), "tests/unit/design-agent/shop-css/examples", `${name}.css`), "utf8");

let browser: Browser;
beforeAll(async () => {
  browser = await launch();
});
afterAll(async () => {
  await browser?.close();
});

const check = (css: GuardedShopCss, demo: DemoView = SHOP, build: ShopCssPageBuilder = pageBuilder(demo, AMERICAN_EDITORIAL)) => checkShopCssRender({ browser, build, css, facts: demoFacts(demo) });
const codes = (problems: string[]) => [...new Set(problems.map((p) => p.split(":")[1]))];

describe("render check: guard-passing stylesheets that break facts fail (DEV-072)", () => {
  const BAD: Array<[string, string, string[]]> = [
    ["white text on the page ground", "#shop-css p, #shop-css li, #shop-css dd { color: #fefefe; }", ["fact_contrast"]],
    ["a ground the colour of the text", "#shop-css main { background-color: #2a1916; }", ["fact_contrast"]],
    ["a gradient the colour of the text", "#shop-css main { background-image: linear-gradient(#2a1916, #2b1a17); }", ["fact_contrast"]],
    ["shrunk by a transform", "#shop-css dd { font-size: 12px; } #shop-css main { transform: scale(0.75); }", ["fact_small"]],
    ["faded through two ancestors", "#shop-css main { opacity: 0.9; } #shop-css section { opacity: 0.9; }", ["fact_faded"]],
    ["covered by a heading moved over them", "#shop-css section { display: grid; } #shop-css section > h2, #shop-css section > p, #shop-css section > ol, #shop-css section > div { grid-row: 1; grid-column: 1; } #shop-css section > h2 { order: 2; background-color: var(--p-bg); }", ["fact_covered"]],
    ["clipped by the hero", "#shop-css header { min-height: 0; max-height: 80px; }", ["fact_clipped"]],
    ["squeezed into a narrow column", "#shop-css section p { max-width: 20px; }", ["fact_squeezed"]],
    ["wider than the screen (the canvas clips it)", "#shop-css main { min-width: 2400px; }", ["overflow_x", "fact_clipped", "fact_offscreen"]],
    ["a page made very tall", "#shop-css li, #shop-css dd, #shop-css p { min-height: 2400px; }", ["page_too_tall"]],
    ["a rotated block raised over its neighbours", "#shop-css main { position: relative; z-index: 2; transform: rotate(8deg); background-color: #761d27; }", ["fact_covered", "fact_ink", "label_covered", "label_ink", "fact_contrast"]],
    // DEV-072 Fresh Review (security): what the guard still lets through and the render check must stop
    ["fixed labels and headings made transparent (High 2)", "#shop-css dt, #shop-css h2 { color: transparent; }", ["label_contrast", "label_ink"]],
    ["one label made transparent", "#shop-css dt { color: transparent; }", ["label_contrast", "label_ink"]],
    ["values in a faint colour (alpha-text)", "#shop-css dd { color: rgb(42 25 22 / 0.2); }", ["fact_contrast"]],
    ["an almost transparent colour-mix", "#shop-css p { color: color-mix(in srgb, transparent, #000 10%); }", ["fact_contrast"]],
    ["a decoration raised over the name (corners-cover, on top)", '#shop-css header > span[aria-hidden="true"] { z-index: 5; } #shop-css header > span[aria-hidden="true"]::before { content: ""; display: block; width: 100%; height: 2400px; background-color: var(--p-bg); }', ["fact_covered", "fact_ink", "label_covered", "label_ink"]],
  ];
  for (const [name, css, expected] of BAD)
    it(name, async () => {
      const r = await check(guarded(css));
      if (process.env.SR_SHOP_CSS_DEBUG) console.log(name, r.problems.join(" "));
      expect(r.ok).toBe(false);
      expect(codes(r.problems).some((c) => expected.includes(c!)), r.problems.join(" ")).toBe(true);
      // fixed codes only, at a checked viewport
      for (const p of r.problems) expect(p).toMatch(/^\d+:[a-z_]+$/);
    });

  it("checks the widths inside the stylesheet's own breakpoints (High 1: tablet band)", async () => {
    const css = guarded("@media (min-width: 400px) and (max-width: 1400px) { #shop-css p, #shop-css dd, #shop-css li { color: var(--p-bg); } }");
    const r = await checkShopCssRender({ browser, build: pageBuilder(SHOP, AMERICAN_EDITORIAL), css, facts: demoFacts(SHOP), exhaustive: true });
    expect(r.widths).toEqual(expect.arrayContaining([320, 360, 390, 399, 400, 401, 768, 1024, 1399, 1400, 1401, 1440, 1920]));
    const failing = new Set(r.problems.filter((p) => p.endsWith(":fact_contrast")).map((p) => Number(p.split(":")[0])));
    expect([...failing].sort((a, b) => a - b)).toEqual([400, 401, 768, 1024, 1399, 1400]);
  });

  it("is a second line of defence: CSS that reached the notice bar (a guard bypass, simulated) fails", async () => {
    const base = pageBuilder(SHOP, AMERICAN_EDITORIAL);
    const bypass =
      (raw: string): ShopCssPageBuilder =>
      (css) =>
        css === null ? base(null) : base(css).replace("</head>", `<style>${raw}</style></head>`);
    const changed = await check(guarded("#shop-css { color: var(--p-text); }"), SHOP, bypass('[role="note"] { background: transparent !important; color: #f4e8d2 !important; }'));
    expect(codes(changed.problems)).toContain("notice_changed");
    const covered = await check(guarded("#shop-css { color: var(--p-text); }"), SHOP, bypass("#shop-css { position: relative; z-index: 20; margin-top: -60px; }"));
    expect(codes(covered.problems)).toContain("notice_covered");
    const footer = await check(guarded("#shop-css { color: var(--p-text); }"), SHOP, bypass("footer { display: none !important; }"));
    expect(codes(footer.problems)).toContain("footer_changed");
    // a notice line painted over (a shadow from outside the scope): the pixel proof, not hit-testing, sees it
    const shadow = await check(guarded("#shop-css { color: var(--p-text); }"), SHOP, bypass("#shop-css { position: relative; z-index: 20; box-shadow: 0 -24px 0 0 #f4e8d2; overflow: visible !important; }"));
    expect(codes(shadow.problems).some((c) => c === "notice_ink" || c === "notice_changed" || c === "notice_contrast"), shadow.problems.join(" ")).toBe(true);
    const footerShadow = await check(guarded("#shop-css { color: var(--p-text); }"), SHOP, bypass("#shop-css main { position: relative; z-index: 1; box-shadow: 0 16px 0 16px #761D27; } #shop-css { overflow: visible !important; }"));
    expect(codes(footerShadow.problems).some((c) => c === "footer_ink" || c === "footer_changed"), footerShadow.problems.join(" ")).toBe(true);
    // a page with a script is never accepted
    const script = await check(guarded("#shop-css { color: var(--p-text); }"), SHOP, (css) => base(css).replace("</body>", "<script>void 0</script></body>"));
    expect(codes(script.problems)).toContain("page_script");
  });
});

describe("render check: usable stylesheets pass", () => {
  for (const name of ["kissa-retro", "atelier-mono", "sakura-wagashi"])
    for (const [shopName, demo] of [
      ["latin", SHOP],
      ["japanese", JA_SHOP],
    ] as const)
      it(`${name} (${shopName} shop)`, async () => {
        const r = await check(guarded(example(name)), demo);
        expect(r.problems).toEqual([]);
        expect(r.ok).toBe(true);
      });
});

describe("shopCssOrFallback", () => {
  const build = pageBuilder(SHOP, AMERICAN_EDITORIAL);
  it("falls back on a guard failure, without rendering", async () => {
    const d = await shopCssOrFallback({ css: "#shop-css { background-image: url(x) }", demo: SHOP, browser, build });
    expect(d).toEqual({ css: null, report: { accepted: false, guard: ["url"], render: [] } });
  });
  it("falls back on a render failure", async () => {
    const d = await shopCssOrFallback({ css: "#shop-css p, #shop-css li, #shop-css dd { color: #fefefe; }", demo: SHOP, browser, build });
    expect(d.css).toBeNull();
    expect(d.report.accepted).toBe(false);
    expect(d.report.render).toContain("390:fact_contrast");
  });
  it("accepts a stylesheet that passes both, normalized", async () => {
    const d = await shopCssOrFallback({ css: example("atelier-mono"), demo: SHOP, browser, build });
    expect(d.report).toEqual({ accepted: true, guard: [], render: [] });
    expect(d.css).toBe(guarded(example("atelier-mono")));
  });
});

describe("pixel proof and widths (pure)", () => {
  const picture = (fill: (x: number, y: number) => number) => {
    const data = Buffer.alloc(20 * 10 * 3);
    for (let y = 0; y < 10; y++) for (let x = 0; x < 20; x++) data.fill(fill(x, y), (y * 20 + x) * 3, (y * 20 + x) * 3 + 3);
    return { width: 20, height: 10, channels: 3, data };
  };
  const node = { kind: "fact" as const, text: "ab", hidden: false, offscreen: false, clipped: false, covered: false, opacity: 1, fontSize: 16, vertical: false, squeezed: false, color: [0, 0, 0, 1] as [number, number, number, number], rects: [], chars: [{ left: 0, top: 0, width: 10, height: 10 }, { left: 10, top: 0, width: 10, height: 10 }] };
  it("a character whose box does not change between the two pictures has no ink", () => {
    const ground = picture(() => 255);
    // ink in the first character only, rows 2..7
    const text = picture((x, y) => (x < 10 && y >= 2 && y <= 7 ? 0 : 255));
    expect(inkOf(text, ground, node)).toEqual({ missing: 1, extent: 0.6 });
    // the top half covered: the ink reaches less far
    const half = picture((x, y) => (y >= 5 && y <= 7 ? 0 : 255));
    expect(inkOf(half, ground, node)).toEqual({ missing: 0, extent: 0.3 });
  });
  it("widths: the fixed set and each side of every breakpoint (em at 16px)", () => {
    expect(checkWidths(guarded("@media (min-width: 45em) { #shop-css p { color: #000; } }"))).toEqual([320, 360, 390, 719, 720, 721, 768, 1024, 1440, 1920]);
    expect(checkWidths(guarded("#shop-css p { color: #000; }"))).toEqual([320, 360, 390, 768, 1024, 1440, 1920]);
  });
});
