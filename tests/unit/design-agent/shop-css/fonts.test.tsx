import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { demoFacts } from "@/lib/design-agent/shop-css/apply";
import { guardShopCss, type GuardedShopCss } from "@/lib/design-agent/shop-css/guard";
import { checkShopCssRender, type ShopCssPageBuilder } from "@/lib/design-agent/shop-css/render-check";
import { AMERICAN_EDITORIAL, SHOP } from "../fixtures";
import { THREE_SHOPS } from "../stage1-fixtures";
import { launch, lcdFontconfig, OTHER_FACES, pageBuilder } from "./support";

// DEV-072 (CI 118792775207): the render check must not depend on the font
// environment. CI rendered with other antialiasing than this container and the
// pixel proof failed the examples there. Here a second environment — subpixel
// (LCD) antialiasing with full hinting, and other faces — must still pass the
// example stylesheets and still fail the covers.

vi.setConfig({ testTimeout: 600_000 });

const guarded = (css: string): GuardedShopCss => {
  const r = guardShopCss(css);
  if (!r.ok) throw new Error(`guard rejected the test stylesheet: ${r.problems.join(", ")}`);
  return r.css;
};
const example = (name: string) => readFileSync(join(process.cwd(), "tests/unit/design-agent/shop-css/examples", `${name}.css`), "utf8");

let dir: string;
let browser: Browser;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "shop-css-fonts-"));
  browser = await launch({ FONTCONFIG_FILE: lcdFontconfig(dir) });
});
afterAll(async () => {
  await browser?.close();
  rmSync(dir, { recursive: true, force: true });
});

const PAGES: Array<[string, typeof SHOP, typeof AMERICAN_EDITORIAL, string | undefined]> = [
  ["latin shop, other faces", SHOP, AMERICAN_EDITORIAL, OTHER_FACES],
  ["Stage 1 cafe, other faces", THREE_SHOPS.cafe!.demo, THREE_SHOPS.cafe!.profile, OTHER_FACES],
  // vertical text needs the IPA stand-in (WenQuanYi has no vertical metrics)
  ["Stage 1 bakery (vertical)", THREE_SHOPS.bakery!.demo, THREE_SHOPS.bakery!.profile, undefined],
];

describe("render check under LCD antialiasing and other faces", () => {
  for (const [label, demo, profile, faces] of PAGES)
    for (const name of ["kissa-retro", "atelier-mono", "sakura-wagashi", "stage1-hooks"])
      it(`${name} passes (${label})`, async () => {
        const r = await checkShopCssRender({ browser, build: pageBuilder(demo, profile, faces), css: guarded(example(name)), facts: demoFacts(demo) });
        expect(r.problems).toEqual([]);
      });

  it("covers still fail: a stretched neighbour and an outer shadow past the guard, a decoration over the name", async () => {
    const base = pageBuilder(SHOP, AMERICAN_EDITORIAL, OTHER_FACES);
    const bypass =
      (raw: string): ShopCssPageBuilder =>
      (css) =>
        css === null ? base(null) : base(css).replace("</head>", `<style>${raw}</style></head>`);
    const plain = guarded("#shop-css { color: var(--p-text); }");
    const stretched = await checkShopCssRender({ browser, build: bypass("#shop-css dl > div > dt { transform: scaleY(2); background-color: #f4e8d2; }"), css: plain, facts: demoFacts(SHOP) });
    expect(stretched.problems.some((p) => /:(fact_ink|fact_covered)$/.test(p)), stretched.problems.join(" ")).toBe(true);
    const shadowed = await checkShopCssRender({ browser, build: bypass("#shop-css dl > div > dt { position: relative; z-index: 1; box-shadow: 0 0 0 14px #f4e8d2; }"), css: plain, facts: demoFacts(SHOP) });
    expect(shadowed.problems.some((p) => p.endsWith(":fact_ink")), shadowed.problems.join(" ")).toBe(true);
    const raised = await checkShopCssRender({ browser, build: base, css: guarded('#shop-css header > span[aria-hidden="true"] { z-index: 5; } #shop-css header > span[aria-hidden="true"]::before { content: ""; display: block; width: 100%; height: 2400px; background-color: var(--p-bg); }'), facts: demoFacts(SHOP) });
    expect(raised.problems.some((p) => /:(fact_ink|fact_covered)$/.test(p)), raised.problems.join(" ")).toBe(true);
  });
});
