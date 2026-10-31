import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderPrototype } from "@/lib/design-agent/phase2f/render-prototype";

// DEV-134: the phone (SP 390) checks of a Phase 2f prototype, on small synthetic pages drawn by Chromium (JS off,
// network shut). Report-only: the codes are what a run records, never a stop.

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
});
afterAll(async () => {
  await browser.close();
});

const NAME = "架空菓庵";
const FACTS = [NAME, "9:00〜18:00", "名古屋市東区架空町一丁目2-3"];
const page = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body>${body}</body></html>`;
const BASE = "body{margin:0;font:16px/1.6 sans-serif} section{padding:24px}";
const SOUND = `<section data-section="hero"><h1>${NAME}</h1><p>9:00〜18:00</p></section><section data-section="info"><p>名古屋市東区架空町一丁目2-3</p><nav><a href="#hero" style="display:inline-block;padding:14px 20px">営業時間</a></nav></section>`;

async function sp(body: string, css = BASE) {
  const r = await renderPrototype(browser, { html: page(body), css }, new Map(), ["hero", "info"], { facts: FACTS, shopName: NAME });
  return r.mobile_390.mobileQuality!;
}

describe("phone checks (report-only)", () => {
  it("a sound phone page has no findings, and the checks never run at PC 1440", async () => {
    const r = await renderPrototype(browser, { html: page(SOUND), css: BASE }, new Map(), ["hero", "info"], { facts: FACTS, shopName: NAME });
    expect(r.mobile_390.mobileQuality).toMatchObject({ viewport: "mobile_390", findings: [], advisory: true });
    expect(r.mobile_390.mobileQuality!.counts.text_nodes).toBeGreaterThan(2);
    expect(r.desktop_1440.mobileQuality).toBeUndefined();
  }, 60_000);

  it("is not run unless asked (every existing caller is unchanged)", async () => {
    const r = await renderPrototype(browser, { html: page(SOUND), css: BASE }, new Map(), ["hero", "info"]);
    expect(r.mobile_390.mobileQuality).toBeUndefined();
  }, 60_000);

  it("leaves the SP picture unchanged (the checks run after the screenshot)", async () => {
    const plain = await renderPrototype(browser, { html: page(SOUND), css: BASE }, new Map(), ["hero", "info"]);
    const checked = await renderPrototype(browser, { html: page(SOUND), css: BASE }, new Map(), ["hero", "info"], { facts: FACTS, shopName: NAME });
    expect(checked.mobile_390.png.equals(plain.mobile_390.png)).toBe(true);
  }, 60_000);

  it("names text too small to read on a phone", async () => {
    expect((await sp(SOUND, `${BASE} p{font-size:9px}`)).findings).toContain("SP_TEXT_TOO_SMALL");
  }, 60_000);

  it("names text cut off by its box", async () => {
    const body = SOUND.replace("<p>名古屋市東区架空町一丁目2-3</p>", '<div style="height:8px;overflow:hidden"><p style="margin:0">名古屋市東区架空町一丁目2-3</p></div>');
    expect((await sp(body)).findings).toContain("SP_TEXT_CLIPPED");
  }, 60_000);

  it("names text a decoration lies on (a drawn line over the shop name)", async () => {
    const body = SOUND.replace(`<h1>${NAME}</h1>`, `<h1 style="position:relative">${NAME}<span style="position:absolute;left:0;top:0;width:100%;height:100%;background:#c9a44c"></span></h1>`);
    expect((await sp(body)).findings).toContain("SP_TEXT_COVERED");
  }, 60_000);

  it("names text pushed off the side of the phone even when the page hides the overflow", async () => {
    expect((await sp(SOUND, `${BASE} body{overflow-x:hidden} h1{margin-left:300px;white-space:nowrap}`)).findings).toContain("SP_TEXT_OFFSCREEN");
  }, 60_000);

  it("names tap targets under the 24 px floor, and under 44 px separately; a link in running text is exempt", async () => {
    const tiny = SOUND.replace('style="display:inline-block;padding:14px 20px"', 'style="display:inline-block;font-size:12px;line-height:14px"');
    const r = await sp(tiny);
    expect(r.findings).toContain("SP_TAP_TARGET_TOO_SMALL");
    expect(r.counts.tap_targets_below_minimum).toBe(1);
    const mid = SOUND.replace('style="display:inline-block;padding:14px 20px"', 'style="display:inline-block;padding:4px 8px"');
    expect((await sp(mid)).findings).toEqual(["SP_TAP_TARGET_BELOW_44"]);
    const inline = SOUND.replace(/<nav>.*<\/nav>/, '<p>営業時間は<a href="#hero">こちら</a>をご覧ください</p>');
    expect((await sp(inline)).findings).not.toContain("SP_TAP_TARGET_TOO_SMALL");
  }, 60_000);

  it("names a shop name that the phone's first screen does not show", async () => {
    const late = `<section data-section="hero" style="height:1200px"><p>9:00〜18:00</p></section><section data-section="info"><h1>${NAME}</h1></section>`;
    expect((await sp(late)).findings).toContain("SP_SHOP_NAME_NOT_IN_FIRST_SCREEN");
  }, 60_000);

  // false alarms found on the 12 real prototypes of the DEV-133 evaluation, kept as tests
  it("does not flag a skip link placed off the page, a letter-spaced label in a flex item, a name set in two parts, or a repeated name hidden once", async () => {
    const body = `<a href="#info" style="position:absolute;left:-9999px">本文へ移動</a>
<section data-section="hero"><h1><span>架空</span><span style="margin-left:.5em">菓庵</span></h1><p>9:00〜18:00</p>
<nav style="display:flex;gap:16px"><a href="#info" style="display:flex;align-items:center;min-height:44px;min-width:44px;letter-spacing:.4em">修理</a></nav></section>
<section data-section="info"><p>名古屋市東区架空町一丁目2-3</p><p style="display:none">${NAME}</p></section>`;
    expect((await sp(body)).findings).toEqual([]);
  }, 60_000);

  it("still names text that really leaves its flex item", async () => {
    const body = SOUND.replace("<p>9:00〜18:00</p>", '<div style="display:flex;width:60px">9:00〜18:00 定休 水曜 と 第二火曜</div>').replace("<h1>", '<h1 style="white-space:nowrap">');
    expect((await sp(body, `${BASE} div{white-space:nowrap;overflow:visible}`)).findings).toContain("SP_TEXT_OUT_OF_BOX");
  }, 60_000);

  it("does not measure a page that already uses the measuring scope's id (never a silent pass)", async () => {
    const r = await sp(`<div id="shop-css">${SOUND}</div>`);
    expect(r.findings).toEqual(["SP_CHECK_SCOPE_CONFLICT"]);
  }, 60_000);
});
