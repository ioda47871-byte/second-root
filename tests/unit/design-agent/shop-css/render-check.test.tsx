import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { demoFacts, shopCssOrFallback } from "@/lib/design-agent/shop-css/apply";
import { guardShopCss, type GuardedShopCss } from "@/lib/design-agent/shop-css/guard";
import { checkShopCssRender, type ShopCssPageBuilder } from "@/lib/design-agent/shop-css/render-check";
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
    ["tiny facts", "#shop-css dd, #shop-css li { font-size: 8px; }", ["fact_small"]],
    ["font-size 0", "#shop-css dd { font-size: 0; }", ["fact_hidden", "fact_small"]],
    ["shrunk by a transform", "#shop-css dd { font-size: 12px; } #shop-css main { transform: scale(0.75); }", ["fact_small"]],
    ["faded through two ancestors", "#shop-css main { opacity: 0.9; } #shop-css section { opacity: 0.9; }", ["fact_faded"]],
    ["covered by a heading moved over them", "#shop-css section { display: grid; } #shop-css section > * { grid-row: 1; grid-column: 1; } #shop-css section > h2 { order: 2; background-color: var(--p-bg); }", ["fact_covered"]],
    ["clipped by the hero", "#shop-css header { min-height: 0; max-height: 80px; }", ["fact_clipped"]],
    ["squeezed into a narrow column", "#shop-css section p { max-width: 20px; }", ["fact_squeezed"]],
    ["wider than the screen", "#shop-css main { min-width: 2400px; }", ["overflow_x"]],
    ["a page made very tall", "#shop-css li, #shop-css dd, #shop-css p { min-height: 2400px; }", ["page_too_tall"]],
    ["the canvas pushed over the footer", "#shop-css main { position: relative; top: 48px; z-index: 1; padding-bottom: 0; margin-bottom: 0; }", ["footer_covered"]],
  ];
  for (const [name, css, expected] of BAD)
    it(name, async () => {
      const r = await check(guarded(css));
      expect(r.ok).toBe(false);
      expect(codes(r.problems).some((c) => expected.includes(c!)), r.problems.join(" ")).toBe(true);
      // fixed codes only, at a checked viewport
      for (const p of r.problems) expect(p).toMatch(/^(360|390|1440):[a-z_]+$/);
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
