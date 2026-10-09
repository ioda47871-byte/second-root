import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bakedGoodsStyles from "@/components/demo/bakedGoods.module.css";
import bakeryStyles from "@/components/demo/bakery.module.css";
import cafeStyles from "@/components/demo/cafe.module.css";
import demoStyles from "@/components/demo/demo.module.css";
import ProfileRenderer from "@/components/demo/profile/ProfileRenderer";
import profileStyles from "@/components/demo/profile/profile.module.css";
import { renderDemo } from "@/components/demo/renderDemo";
import type { DemoView } from "@/lib/sales/demo-content";
import { AMERICAN_EDITORIAL, SHOP } from "./fixtures";

// The public /demo keeps the notice bar and footer it had before DEV-028.
// DEV-028 gave DemoFrame a class / style hook for the local design preview
// and first put its palette (and a reset margin and a hairline) on the shared
// notice and footer rules, which moved the public notice. Those rules now live
// only in profile.module.css, under the profile renderer's own frame class.
// All module CSS is loaded together here, as the app bundles it.

vi.setConfig({ testTimeout: 120_000 });

function moduleCss(file: string, names: Record<string, string>): string {
  const css = readFileSync(join(process.cwd(), file), "utf8");
  return css.replace(/\.(-?[_a-zA-Z][\w-]*)/g, (whole, name: string) => (names[name] ? `.${names[name]}` : whole));
}
const CSS = [
  "*, *::before, *::after { box-sizing: border-box; } body { margin: 0; }",
  moduleCss("components/demo/demo.module.css", demoStyles as Record<string, string>),
  moduleCss("components/demo/bakery.module.css", bakeryStyles as Record<string, string>),
  moduleCss("components/demo/bakedGoods.module.css", bakedGoodsStyles as Record<string, string>),
  moduleCss("components/demo/cafe.module.css", cafeStyles as Record<string, string>),
  moduleCss("components/demo/profile/profile.module.css", profileStyles as Record<string, string>),
].join("\n");

const DEMO: DemoView = {
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
const TEMPLATES: Array<[DemoView["template"], DemoView["category"]]> = [
  ["bakery_v1", "bakery"],
  ["baked_goods_v1", "baked_goods"],
  ["cafe_v1", "cafe"],
];

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
});
afterAll(async () => {
  await browser?.close();
});

type Frame = { notice: Record<string, string>; noticeHeight: number; noticeTop: number; footer: Record<string, string>; muted: string };

async function measure(body: string, width: number): Promise<Frame> {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  try {
    await page.setContent(`<!doctype html><html lang="ja"><head><style>${CSS}</style></head><body>${body}</body></html>`);
    // a source string: no named functions reach the page whatever compiles this file
    return (await page.evaluate(`(() => {
      const n = document.querySelector('[role="note"]');
      const f = document.querySelector("footer");
      const pick = (s) => ({ marginTop: s.marginTop, marginBottom: s.marginBottom, borderTopWidth: s.borderTopWidth, borderBottomWidth: s.borderBottomWidth, backgroundColor: s.backgroundColor, color: s.color, paddingTop: s.paddingTop, paddingBottom: s.paddingBottom, fontSize: s.fontSize, position: s.position });
      const probe = document.createElement("span");
      probe.style.color = "var(--muted)";
      n.parentElement.appendChild(probe);
      const muted = getComputedStyle(probe).color;
      probe.remove();
      return { notice: pick(getComputedStyle(n)), noticeHeight: n.getBoundingClientRect().height, noticeTop: n.getBoundingClientRect().top, footer: pick(getComputedStyle(f)), muted };
    })()`)) as Frame;
  } finally {
    await page.close();
  }
}

describe("public /demo: notice and footer exactly as before DEV-028", () => {
  it("markup: no profile class or inline style on the frame", () => {
    for (const [template, category] of TEMPLATES) {
      const html = renderToStaticMarkup(renderDemo({ ...DEMO, template, category }));
      const root = /^<div class="([^"]*)" data-template="[a-z_0-9]+">/.exec(html);
      expect(root?.[1], template).toBe(demoStyles.page);
      expect(html).not.toMatch(/^<div[^>]*style=/);
      expect(html).not.toContain(profileStyles.root);
    }
  });

  it("computed: the browser's paragraph margins, no border, the dark bar, the muted footer", async () => {
    for (const [template, category] of TEMPLATES) {
      for (const width of [390, 1440]) {
        const m = await measure(renderToStaticMarkup(renderDemo({ ...DEMO, template, category })), width);
        const at = `${template} @ ${width}`;
        // <p> default margins (1em of 0.8rem); DEV-028 had set them to 0 and added a 1px hairline
        expect(m.notice, at).toMatchObject({ marginTop: "12.8px", marginBottom: "12.8px", borderTopWidth: "0px", borderBottomWidth: "0px", backgroundColor: "rgb(43, 38, 34)", color: "rgb(255, 255, 255)", paddingTop: "10px", paddingBottom: "10px", fontSize: "12.8px", position: "sticky" });
        expect(m.noticeTop, at).toBeCloseTo(12.8, 1);
        expect(m.footer, at).toMatchObject({ backgroundColor: "rgba(0, 0, 0, 0)", color: m.muted, paddingTop: "28px", paddingBottom: "40px" });
      }
    }
  });
});

describe("design preview: the profile's notice and footer stay scoped to its frame", () => {
  it("uses the profile palette, no margin, a hairline in the primary colour", async () => {
    const m = await measure(renderToStaticMarkup(<ProfileRenderer demo={SHOP} profile={AMERICAN_EDITORIAL} />), 390);
    const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
    const c = AMERICAN_EDITORIAL.palette;
    expect(m.notice).toMatchObject({ marginTop: "0px", marginBottom: "0px", borderBottomWidth: "1px", backgroundColor: rgb(c.background), color: rgb(c.secondary) });
    expect(m.footer).toMatchObject({ backgroundColor: rgb(c.primary), color: rgb(c.background), paddingTop: "28px", paddingBottom: "40px" });
  });
});
