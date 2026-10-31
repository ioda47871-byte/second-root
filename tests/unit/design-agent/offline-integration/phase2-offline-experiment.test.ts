/**
 * DEV-131 (Issue #159): an OFFLINE experiment on a fictional shop, with the real modules wired together in a TEST
 * (never in lib: the modules stay unwired until a separate approval):
 *
 *   design page (fictional wagashi, two directions)  → real Chromium renders at PC 1440 / SP 390
 *   → structure descriptors (2b): the two directions are different skeletons; a recolour is the same skeleton
 *   → Identity Lock on the visible text (2c): the right shop passes, a reference shop's name is refused
 *   → implementation renders compared with the design (2e compare): an exact implementation shows no difference;
 *     a sloppy one shows named causes
 *   → the mock repair loop (2g) driven by those real comparisons: it fixes one cause at a time and ends at the
 *     owner's review, never as an approval.
 *
 * Every page is local fictional HTML/CSS; no Codex, no image tool, no network (every request aborted), JS off.
 * Passing numbers here prove the pipeline runs, not that a design is good.
 */
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditPageText } from "@/lib/design-agent/identity/identity-lock";
import { compareRenders, type RenderSide, type Viewport } from "@/lib/design-agent/impl-lane/compare";
import { runLoop, type Ports } from "@/lib/design-agent/loop/controller";
import { structuralSimilarity, structureFindings } from "@/lib/design-agent/structure/descriptor";
import { describe as describeStructure, measurePage, VIEWPORTS } from "@/lib/design-agent/structure/measure";

type Page = { html: string; css: string };
const doc = (body: string) => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body>${body}</body></html>`;

/** Direction A (fictional): one day of the shop on a vertical axis; vertical type, sections running into each other. */
const directionA = (o: { accent?: string; dropInfoOnPhone?: boolean; ground?: string } = {}): Page => ({
  html: doc(`<section data-section="hero" class="hero"><h1 class="v">架空菓庵</h1><p class="v lead">毎朝炊く粒あん</p><svg class="sweet" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg></section>
<section data-section="steps" class="steps"><div class="a v">毎朝炊く粒あん</div><div class="b"></div><div class="c v">一つずつお包みしています</div></section>
<section data-section="info" class="info"><p>9:00〜18:00（売り切れ次第終了）</p><p>水曜・第2火曜</p><p>名古屋市東区</p><p>実在の店舗ではありません</p></section>`),
  css: `body{margin:0;background:${o.ground ?? "#f4efe4"};color:#2b2622;font:16px serif}.v{writing-mode:vertical-rl}
.hero{position:relative;height:900px}.hero h1{font-size:96px;margin:80px}.lead{position:absolute;left:260px;top:120px;font-size:28px}.sweet{position:absolute;right:120px;top:160px;width:520px;height:520px;fill:${o.accent ?? "#6b2e2e"}}
.steps{position:relative;height:760px;margin-top:-120px}.steps>div{position:absolute;width:420px;height:380px}.a{left:120px;top:0;font-size:40px}.b{left:380px;top:160px;background:${o.accent ?? "#6b2e2e"}}.c{left:760px;top:240px;font-size:40px}
.info{padding:80px;background:#e2d6c0;height:420px}
@media (max-width:600px){.hero{height:760px}.hero h1{font-size:64px;margin:40px}.lead{left:150px}.sweet{right:20px;top:420px;width:300px;height:300px}.steps{height:900px;margin-top:-60px}.steps>div{width:260px;height:300px}.a{left:20px}.b{left:80px;top:260px}.c{left:150px;top:520px}.info{padding:32px;height:520px${o.dropInfoOnPhone ? ";display:none" : ""}}}`,
});

/** Direction B (fictional): the small shop front as a map of stations; big horizontal signage type. */
const directionB = (): Page => ({
  html: doc(`<header><nav><a href="#counter">店頭</a><a href="#sweets">お菓子</a><a href="#info">営業</a></nav></header>
<section data-section="counter" class="counter"><h1>架空菓庵</h1><div class="row"><div class="sign">季節の上生菓子</div><div class="sign">粒あんのどら焼き</div><div class="sign">一つずつお包み</div></div></section>
<section data-section="info" class="info"><p>9:00〜18:00（売り切れ次第終了）・水曜・第2火曜・名古屋市東区・実在の店舗ではありません</p></section>`),
  css: `body{margin:0;background:#fff;font:16px sans-serif}nav{display:flex;gap:24px;padding:20px 40px;border-bottom:2px solid #000}.counter{padding:60px 40px}.counter h1{font-size:120px;margin:0}
.row{display:flex;gap:24px;margin-top:40px}.sign{flex:1;height:300px;background:#eee;font-size:28px;padding:24px}.info{padding:40px;border-top:2px solid #000}`,
});

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
});
afterAll(async () => {
  await browser.close();
});

const WIDTH: Record<Viewport, { width: number; height: number }> = { desktop_1440: { width: 1440, height: 900 }, mobile_390: { width: 390, height: 844 } };

/** A full-page render at one width (JS off, every request aborted) with its [data-section] boxes. */
async function render(page: Page, v: Viewport): Promise<RenderSide & { text: string }> {
  const ctx = await browser.newContext({ javaScriptEnabled: false, viewport: WIDTH[v], deviceScaleFactor: 1 });
  try {
    await ctx.route("**/*", (r) => r.abort());
    const p = await ctx.newPage();
    await p.setContent(page.html.replace('<link rel="stylesheet" href="style.css">', `<style>${page.css}</style>`), { waitUntil: "load" });
    const m = (await p.evaluate(`(() => {
      const sections = [...document.querySelectorAll("[data-section]")].map((el) => { const r = el.getBoundingClientRect(); const shown = getComputedStyle(el).display !== "none" && r.width > 0 && r.height > 0; return { id: el.getAttribute("data-section"), box: shown ? { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height } : null }; });
      return { sections, text: document.body.innerText, height: document.documentElement.scrollHeight };
    })()`)) as { sections: RenderSide["sections"]; text: string; height: number };
    // DEV-135: the page is shot at its own height, not by stitching a full-page capture: under load on CI, Chromium
    // refused the tall full-page capture once ("Unable to capture screenshot", develop 1220d3e). The boxes are measured
    // above, at the real viewport; the fixture pages size nothing by the viewport height.
    await p.setViewportSize({ width: WIDTH[v].width, height: Math.max(WIDTH[v].height, Math.ceil(m.height)) });
    const png = await p.screenshot({ clip: { x: 0, y: 0, width: WIDTH[v].width, height: m.height } });
    return { png, sections: m.sections, text: m.text };
  } finally {
    await ctx.close();
  }
}

const renderBoth = async (page: Page) => ({ desktop_1440: await render(page, "desktop_1440"), mobile_390: await render(page, "mobile_390") });
const compare = async (design: Page, impl: Page) => {
  const [d, i] = [await renderBoth(design), await renderBoth(impl)];
  return compareRenders({ desktop_1440: { design: d.desktop_1440, impl: i.desktop_1440 }, mobile_390: { design: d.mobile_390, impl: i.mobile_390 } });
};

const identityInput = {
  schema_version: 1,
  case_id: "CP-900",
  attempt_id: "fictional-wagashi-offline",
  target: { official_name: "架空菓庵", allowed_aliases: [], category_code: "wagashi", official_source_url: "design-library/phase2f/wagashi-facts-pack.json" },
  prompt: { shop_name: "架空菓庵", category_code: "wagashi", is_research_only: true },
  other_shop_names: ["NAGOYA BEANS", "なごやビーンズ", "豆＊豆", "ズールー工作所"],
};

describe("offline experiment: fictional wagashi, two directions, implementation and repair (no Codex, no network)", () => {
  it("2b: the two directions are different skeletons; a recolour of A is A's skeleton", async () => {
    const a = describeStructure(await measurePage(browser, directionA(), VIEWPORTS.desktop), { hero: "type_led", flow: "single_axis_scroll", reading_path: "vertical_axis" });
    const b = describeStructure(await measurePage(browser, directionB(), VIEWPORTS.desktop), { hero: "type_led", flow: "map_of_stations", reading_path: "z_pattern" });
    const recolour = describeStructure(await measurePage(browser, directionA({ accent: "#2e4a6b", ground: "#eef2f4" }), VIEWPORTS.desktop), { hero: "type_led", flow: "single_axis_scroll", reading_path: "vertical_axis" });
    expect(structuralSimilarity(a, b)).toBeLessThan(0.6);
    expect(structureFindings(a, { siblings: { b } }).map((f) => f.code)).not.toContain("SIBLINGS_SAME_SKELETON");
    expect(structureFindings(recolour, { siblings: { a } }).map((f) => f.code)).toContain("SIBLINGS_SAME_SKELETON");
  }, 120_000);

  it("2c: the page names this shop and no reference shop; a page carrying a reference's name is refused", async () => {
    const ok = await render(directionA(), "desktop_1440");
    expect(auditPageText(identityInput, ok.text).status).toBe("PASS_IDENTITY_ONLY");
    const copied = await render({ ...directionA(), html: directionA().html.replace("架空菓庵</h1>", "架空菓庵 × NAGOYA BEANS</h1>") }, "desktop_1440");
    expect(auditPageText(identityInput, copied.text)).toMatchObject({ status: "REJECT", errors: expect.arrayContaining(["VISIBLE_WRONG_OR_EXTRA_SHOP_NAME"]) });
  }, 120_000);

  it("2e compare: an exact implementation shows no difference; a sloppy one shows named causes at the right width", async () => {
    const exact = await compare(directionA(), directionA());
    expect(exact).toMatchObject({ differences: [], passing: false });
    expect(exact.viewports.map((v) => v.page?.ssim)).toEqual([1, 1]);
    const sloppy = await compare(directionA(), directionA({ accent: "#1f6b3a", dropInfoOnPhone: true }));
    expect(sloppy.passing).toBe(false);
    expect(sloppy.differences).toContain("SP_SECTION_MISSING_INFO");
    // the accent colour of the main drawing is a local change: it shows on the PC as well as the phone
    expect(sloppy.differences).toEqual(expect.arrayContaining(["PC_SECTION_COLOUR_HERO", "SP_SECTION_COLOUR_HERO"]));
    expect(sloppy.differences.some((d) => d.startsWith("PC_SECTION_MISSING"))).toBe(false);
  }, 120_000);

  it("2g with real comparisons: the mock loop fixes one cause at a time and ends at the owner's review, never an approval", async () => {
    // the implementation has two faults (a wrong accent colour; the shop information dropped on the phone). Each state
    // of the implementation is rendered and compared for real beforehand (the loop's ports are synchronous).
    const states = { both: directionA({ accent: "#1f6b3a", dropInfoOnPhone: true }), colourFixed: directionA({ dropInfoOnPhone: true }), allFixed: directionA() };
    const real: Record<keyof typeof states, string[]> = { both: [], colourFixed: [], allFixed: [] };
    for (const k of Object.keys(states) as (keyof typeof states)[]) real[k] = (await compare(directionA(), states[k])).differences;
    let state: keyof typeof states = "both";
    const fixes: (string | null)[] = [];
    const ports: Ports = {
      approval: () => "approved",
      design: () => ({ ok: true, value: { design_id: "FICTIONAL-A" } }),
      package: () => ({ ok: true, value: { artifact_id: "DA-20261031-wagaa1", state: "render_pair_complete" } }),
      identity: () => ({ ok: true, value: "PASS_IDENTITY_ONLY" }),
      structure: () => ({ ok: true, value: [] }),
      ownerSelection: () => "selected",
      implement: (_a, fix) => {
        fixes.push(fix);
        // a colour fix restores the accent; a phone-layout fix restores the dropped section
        if (fix?.includes("_COLOUR_")) state = state === "both" ? "colourFixed" : state;
        else if (fix?.startsWith("SP_")) state = state === "colourFixed" ? "allFixed" : state;
        return { ok: true, value: { build_id: `B${fixes.length}` } };
      },
      compare: () => ({ ok: true, value: { differences: real[state] } }),
    };
    const r = runLoop("fictional-offline-1", ports);
    expect(real.both.length).toBeGreaterThan(0);
    expect(real.allFixed).toEqual([]);
    expect(fixes).toEqual([null, "PC_SECTION_COLOUR_HERO", "SP_PAGE_HEIGHT"]);
    expect(r).toMatchObject({ status: "owner_review", design_approved: false, implementation_attempts: 3 });
  }, 240_000);
});
