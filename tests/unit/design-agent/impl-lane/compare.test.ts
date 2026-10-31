import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compareRenders, type RenderSide, type Viewport } from "@/lib/design-agent/impl-lane/compare";

// DEV-131: the branches of the render comparison, on small synthetic pages drawn by Chromium (JS off, no network).

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
});
afterAll(async () => {
  await browser.close();
});

const WIDTH: Record<Viewport, number> = { desktop_1440: 1440, mobile_390: 390 };
/** Sections as coloured bands of the given heights, top to bottom. */
const bands = (list: [string, string, number][]) => list.map(([id, colour, h]) => `<section data-section="${id}" style="height:${h}px;background:${colour}"><p style="margin:0;padding:20px">${id}</p></section>`).join("");

async function render(body: string, v: Viewport, width = WIDTH[v]): Promise<RenderSide> {
  const ctx = await browser.newContext({ javaScriptEnabled: false, viewport: { width, height: 800 }, deviceScaleFactor: 1 });
  try {
    await ctx.route("**/*", (r) => r.abort());
    const p = await ctx.newPage();
    await p.setContent(`<!doctype html><html><body style="margin:0">${body}</body></html>`, { waitUntil: "load" });
    const m = (await p.evaluate(`(() => ({ sections: [...document.querySelectorAll("[data-section]")].map((el) => { const r = el.getBoundingClientRect(); return { id: el.getAttribute("data-section"), box: { x: r.left, y: r.top + scrollY, w: r.width, h: r.height } }; }), height: document.documentElement.scrollHeight }))()`)) as { sections: RenderSide["sections"]; height: number };
    return { png: await p.screenshot({ fullPage: true, clip: { x: 0, y: 0, width, height: m.height } }), sections: m.sections };
  } finally {
    await ctx.close();
  }
}
const pair = async (design: string, impl: string, implWidth?: Partial<Record<Viewport, number>>) => ({
  desktop_1440: { design: await render(design, "desktop_1440"), impl: await render(impl, "desktop_1440", implWidth?.desktop_1440) },
  mobile_390: { design: await render(design, "mobile_390"), impl: await render(impl, "mobile_390", implWidth?.mobile_390) },
});

const design = bands([["hero", "#c33", 600], ["menu", "#3c3", 400], ["info", "#33c", 300]]);

describe("render comparison (report only)", () => {
  it("identical renders: no difference, never passing", async () => {
    const r = compareRenders(await pair(design, design));
    expect(r).toMatchObject({ differences: [], passing: false });
  }, 60_000);

  it("M1: a reordered page is named (order and layout), not 'no difference'", async () => {
    const r = compareRenders(await pair(design, bands([["info", "#33c", 300], ["menu", "#3c3", 400], ["hero", "#c33", 600]])));
    expect(r.differences).toEqual(expect.arrayContaining(["PC_SECTION_ORDER", "SP_SECTION_ORDER", "PC_PAGE_LAYOUT"]));
  }, 60_000);

  it("a section moved down by a spacer is named by its position", async () => {
    const r = compareRenders(await pair(design, `<div style="height:200px"></div>${design}`));
    expect(r.differences).toEqual(expect.arrayContaining(["PC_SECTION_POSITION_HERO"]));
  }, 60_000);

  it("M2: a section outside the captured page, and a design box that is unknown, are named; never dropped", async () => {
    const d = await pair(design, design);
    for (const v of ["desktop_1440", "mobile_390"] as const) {
      d[v].impl.sections = d[v].impl.sections.map((s) => (s.id === "info" ? { ...s, box: { ...s.box!, y: 99_999 } } : s));
      d[v].design.sections = d[v].design.sections.map((s) => (s.id === "menu" ? { ...s, box: null } : s));
    }
    const r = compareRenders(d);
    expect(r.differences).toEqual(expect.arrayContaining(["PC_SECTION_NOT_VISIBLE_INFO", "SP_SECTION_NOT_VISIBLE_INFO", "PC_DESIGN_BOX_UNKNOWN_MENU"]));
  }, 60_000);

  it("a missing section, an undecodable image and a wrong width are named per viewport", async () => {
    const missing = compareRenders(await pair(design, bands([["hero", "#c33", 600], ["menu", "#3c3", 400]])));
    expect(missing.differences).toEqual(expect.arrayContaining(["PC_SECTION_MISSING_INFO", "SP_SECTION_MISSING_INFO"]));
    const d = await pair(design, design);
    d.mobile_390.impl.png = Buffer.from("not a png");
    expect(compareRenders(d).differences).toEqual(["SP_DECODE_FAILED"]);
    const wide = compareRenders(await pair(design, design, { desktop_1440: 1280 }));
    expect(wide.differences).toEqual(["PC_WIDTH_MISMATCH"]);
  }, 60_000);

  it("L2: two ids that make the same code part stay two codes", async () => {
    const twins = bands([["a-b", "#c33", 400], ["a_b", "#3c3", 400]]);
    const r = compareRenders(await pair(twins, bands([["a-b", "#c33", 400]])));
    expect(r.differences).toEqual(expect.arrayContaining(["PC_SECTION_MISSING_A_B_2"]));
    for (const c of r.differences) expect(c).toMatch(/^[A-Z][A-Z0-9_]{0,60}$/);
  }, 60_000);
});
