import type { Browser, BrowserContext, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cssProblems } from "@/lib/design-agent/comp-impl/page";
import type { PageCssOptions } from "@/lib/design-agent/comp-impl/page-css";
import { widthRanges } from "@/lib/design-agent/comp-impl/checks";
import { displayWordsOf, phaseBCheck, phaseBCodes } from "@/lib/design-agent/comp-impl/phase-b";
import { displaySweepPass, openCompPage, phaseBScan } from "@/lib/design-agent/comp-impl/render";
import { APPROVED_CAPABILITIES, COMP_UI_LABELS, pageCssOptionsOf } from "@/lib/design-agent/comp-impl/spec";
import { POC_DISCLOSURE } from "@/lib/design-agent/design-image/prompt";
import { launch } from "./support";
import { allCodes, NOWRAP_WIDTHS, rawDoc, SHOPS, shopFacts, strictPage, widthCodes, type ShopKey } from "./nowrap-harness";

// DEV-170 (Issue #193 comment 6628165899, item 1): the safety verification of display_nowrap
// (docs/design/display-nowrap-decision.md). The capability stays OFF: APPROVED_CAPABILITIES is empty and these tests turn
// the flag on only in their own calls (phaseBScan, displaySweepPass), as phase-b.test.ts does. They hold:
// 1. the scope: nowrap / keep-all is accepted only on a display word (the full shop name or a fixed UI label) and refused
//    (NOWRAP_NOT_DISPLAY) everywhere else, adversarial cases included;
// 2. the widths: a nowrap display word that does not fit fails (the 1px sweep's DISPLAY_*, TEXT_BOX_OVERFLOW,
//    OVERFLOW_HORIZONTAL, text over text) exactly where it does not fit, and passes where it does;
// 3. the three shops' strict B pages with nowrap on the full name: nothing new fails; nowrap outside the scope is refused.

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const ON: PageCssOptions = { displayNowrap: true };
const SHOP_KEYS = Object.keys(SHOPS) as ShopKey[];

let browser: Browser;
let raw: BrowserContext;
let tab: Page;
beforeAll(async () => {
  browser = await launch();
  raw = await browser.newContext({ viewport: { width: 1000, height: 800 }, deviceScaleFactor: 1 });
  await raw.route("**/*", (route) => route.abort());
  tab = await raw.newPage();
});
afterAll(async () => {
  await raw?.close();
  await browser?.close();
});

const BASE = 'body { margin: 0; font-family: "IPAGothic", sans-serif; font-size: 16px; line-height: 1.5; color: #1F1D1B; }';
/** Phase B codes of a raw body (the allowlist is NOT applied: raw HTML can do what the allowlist refuses). */
async function scopeCodes(body: string, css: string, words: readonly string[], o: { width?: number; css?: PageCssOptions } = {}): Promise<string[]> {
  await tab.setViewportSize({ width: o.width ?? 1000, height: 800 });
  await tab.setContent(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>${BASE}\n${css}</style></head><body>${body}</body></html>`);
  return phaseBCodes(await phaseBScan(tab, { css: o.css ?? ON, displayWords: words }));
}

describe("DEV-170 display_nowrap stays OFF", () => {
  it("approves nothing and turns the flag on for no spec", () => {
    expect(APPROVED_CAPABILITIES).toEqual([]);
    expect(pageCssOptionsOf({ capabilities: ["display_nowrap"] })).toEqual({});
  });

  it("the static grammar refuses nowrap and keep-all without the flag, and does not know roles with it (the scope is the render's)", () => {
    for (const d of ["white-space: nowrap;", "word-break: keep-all;"]) {
      expect(cssProblems(`.x { ${d} }`).length).toBeGreaterThan(0);
      // with the flag the grammar admits it on ANY selector: only the render check (NOWRAP_NOT_DISPLAY) limits the role
      expect(cssProblems(`.address-fact { ${d} }`, ON)).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------- 1. the scope

describe("DEV-170 scope: only the full shop name and the fixed labels may be nowrap", () => {
  const NOWRAP = ".w { white-space: nowrap; }";
  const KEEP = ".w { word-break: keep-all; }";

  describe.each(SHOP_KEYS)("%s", (shop) => {
    const { name, facts, words } = shopFacts(shop);
    const short = name.split(/\s+/).pop()!; // つぐ手 / 輪 / ゆげ湯: an excerpt of the name

    it("accepts the full name (nowrap and keep-all), whatever whitespace separates its parts", async () => {
      for (const css of [NOWRAP, KEEP]) {
        expect(await scopeCodes(`<h1 class="w">${name}</h1>`, css, words)).toEqual([]);
        expect(await scopeCodes(`<p class="w">${name.replace(/\s+/, "　")}</p>`, css, words)).toEqual([]);
        expect(await scopeCodes(`<p class="w">${name.replace(/\s+/, "\n")}</p>`, css, words)).toEqual([]);
      }
      // inherited onto the name only (a wrapper whose one text is the name)
      expect(await scopeCodes(`<header class="w"><h1>${name}</h1></header>`, NOWRAP, words)).toEqual([]);
      expect(await scopeCodes(`<h1 class="w"><span>${name}</span></h1>`, NOWRAP, words)).toEqual([]);
    });

    it("refuses every fact value (address, phone, hours, closed days, access, and the rest of the pack)", async () => {
      const values = Object.entries(facts).filter(([k]) => k !== "name").map(([, v]) => v);
      expect(values.length).toBeGreaterThanOrEqual(6);
      for (const key of ["address", "phone", "hours", "closed_days", "access"]) expect(facts[key], key).toBeTruthy();
      for (const v of values) {
        expect(await scopeCodes(`<p class="w">${v}</p>`, NOWRAP, words), v).toEqual(["NOWRAP_NOT_DISPLAY"]);
        expect(await scopeCodes(`<p class="w">${v}</p>`, KEEP, words), v).toEqual(["NOWRAP_NOT_DISPLAY"]);
      }
    });

    it("refuses the short name, a decorative big word and a fact sentence (the losses まわ/る, ありま/す, つぐ/手 of the strict pages)", async () => {
      expect(short).not.toBe(name.replace(/\s+/g, ""));
      for (const t of [short, "まわる", "継ぐ", "熱い", "外の小さな庭に、水風呂があります"]) {
        expect(await scopeCodes(`<h1 class="w">${t}</h1>`, NOWRAP, words), t).toEqual(["NOWRAP_NOT_DISPLAY"]);
        expect(await scopeCodes(`<p class="w" aria-hidden="true">${t}</p>`, KEEP, words), t).toEqual(["NOWRAP_NOT_DISPLAY"]);
      }
    });

    it("refuses the name inside a dt, a dd or the disclosure, and a label in a dt", async () => {
      expect(await scopeCodes(`<dl><dt>店名</dt><dd class="w">${name}</dd></dl>`, NOWRAP, words)).toEqual(["NOWRAP_NOT_DISPLAY"]);
      expect(await scopeCodes(`<dl><dt class="w">住所</dt><dd>${facts.address}</dd></dl>`, NOWRAP, words)).toEqual(["NOWRAP_NOT_DISPLAY"]);
      expect(await scopeCodes(`<p data-comp-disclosure class="w">${name}</p>`, NOWRAP, words)).toEqual(["NOWRAP_NOT_DISPLAY"]);
      expect(await scopeCodes(`<p data-comp-disclosure class="w">${POC_DISCLOSURE}</p>`, NOWRAP, words)).toEqual(["NOWRAP_NOT_DISPLAY"]);
      expect(await scopeCodes(`<footer data-comp-disclosure><p class="w">${name}</p></footer>`, NOWRAP, words)).toEqual(["NOWRAP_NOT_DISPLAY"]);
    });

    it("refuses running text and mixed content that contain the name", async () => {
      for (const t of [`${name}は架空の店です。`, `${name} ${facts.phone}`, `${name}店舗情報`, `${name}。`, `${short}${short}`]) expect(await scopeCodes(`<p class="w">${t}</p>`, NOWRAP, words), t).toEqual(["NOWRAP_NOT_DISPLAY"]);
    });

    it("refuses an element with child elements (the name split by a br or a span, or with an empty span)", async () => {
      const [a, b] = name.split(/\s+/);
      for (const inner of [`${a}<br>${b}`, `${a} <span>${b}</span>`, `${name}<span></span>`]) expect(await scopeCodes(`<h1 class="w">${inner}</h1>`, NOWRAP, words), inner).toEqual(["NOWRAP_NOT_DISPLAY"]);
    });

    it("refuses inherited nowrap that reaches anything but a display word", async () => {
      expect(await scopeCodes(`<section class="w"><h1>${name}</h1><p>${facts.hours}</p></section>`, NOWRAP, words)).toEqual(["NOWRAP_NOT_DISPLAY"]);
      expect(await scopeCodes(`<h1>${name}</h1><p>${facts.address}</p>`, "body { white-space: nowrap; }", words)).toEqual(["NOWRAP_NOT_DISPLAY"]);
      expect(await scopeCodes(`<h1>${name}</h1><p>${facts.address}</p>`, "html { word-break: keep-all; }", words)).toEqual(["NOWRAP_NOT_DISPLAY"]);
    });

    it("an aria-label does not make a display word (the text decides)", async () => {
      expect(await scopeCodes(`<p class="w" aria-label="${name}">${facts.address}</p>`, NOWRAP, words)).toEqual(["NOWRAP_NOT_DISPLAY"]);
      expect(await scopeCodes(`<p class="w" aria-label="店舗情報">${facts.phone}</p>`, NOWRAP, words)).toEqual(["NOWRAP_NOT_DISPLAY"]);
    });
  });

  it("accepts every fixed label alone (nav items, a link, a heading) and refuses a longer or joined label", async () => {
    const words = shopFacts("tsugute").words;
    for (const label of COMP_UI_LABELS) expect(await scopeCodes(`<a class="w" href="#x">${label}</a>`, ".w { white-space: nowrap; }", words), label).toEqual([]);
    expect(await scopeCodes(`<ul class="w"><li>店舗情報</li><li>メニュー</li><li>お店について</li></ul>`, ".w { white-space: nowrap; }", words)).toEqual([]);
    for (const t of ["店舗情報を見る店舗情報を見る", "店舗情報・メニュー", "店舗情報を見る→", "店舗情報を見る(地図)"]) expect(await scopeCodes(`<a class="w" href="#x">${t}</a>`, ".w { white-space: nowrap; }", words), t).toEqual(["NOWRAP_NOT_DISPLAY"]);
  });

  it("does not normalise: full-width against half-width digits, a zero-width space or a soft hyphen is not the name", async () => {
    const full = displayWordsOf("架空喫茶 ３丁目２号店");
    expect(await scopeCodes(`<h1 class="w">架空喫茶 ３丁目２号店</h1>`, ".w { white-space: nowrap; }", full)).toEqual([]);
    expect(await scopeCodes(`<h1 class="w">架空喫茶 3丁目2号店</h1>`, ".w { white-space: nowrap; }", full)).toEqual(["NOWRAP_NOT_DISPLAY"]);
    const half = displayWordsOf("架空喫茶 3丁目2号店");
    expect(await scopeCodes(`<h1 class="w">架空喫茶 ３丁目２号店</h1>`, ".w { white-space: nowrap; }", half)).toEqual(["NOWRAP_NOT_DISPLAY"]);
    const { words } = shopFacts("tsugute");
    for (const t of ["架空金継ぎ工房 つぐ​手", "架空金継ぎ工房 つぐ­手", "架空金継ぎ工房 つぐ⁠手"]) expect(await scopeCodes(`<h1 class="w">${t}</h1>`, ".w { white-space: nowrap; }", words), JSON.stringify(t)).toEqual(["NOWRAP_NOT_DISPLAY"]);
    // the phone in full-width digits is still a fact, not a word
    expect(await scopeCodes(`<p class="w">０００-００００-０７１２</p>`, ".w { white-space: nowrap; }", words)).toEqual(["NOWRAP_NOT_DISPLAY"]);
  });

  it("counts nowrap from raw HTML and other properties too (nobr, pre, text-wrap-mode, white-space: pre), hidden text included", async () => {
    const { facts, words } = shopFacts("bicycle");
    expect(await scopeCodes(`<nobr>${facts.address}</nobr>`, "", words)).toEqual(["NOWRAP_NOT_DISPLAY"]);
    expect(await scopeCodes(`<pre>${facts.address}</pre>`, "", words)).toEqual(["NOWRAP_NOT_DISPLAY"]);
    expect(await scopeCodes(`<p class="w">${facts.address}</p>`, ".w { text-wrap-mode: nowrap; }", words)).toEqual(["NOWRAP_NOT_DISPLAY"]);
    expect(await scopeCodes(`<p class="w">${facts.address}</p>`, ".w { white-space: pre; }", words)).toEqual(["NOWRAP_NOT_DISPLAY"]);
    expect(await scopeCodes(`<p class="w" style="display:none">${facts.address}</p>`, ".w { white-space: nowrap; }", words)).toEqual(["NOWRAP_NOT_DISPLAY"]);
  });

  it("the scope check runs with the flag off too (the grammar refuses the declaration first)", async () => {
    const { facts, words } = shopFacts("sento");
    expect(await scopeCodes(`<p class="w">${facts.address}</p>`, ".w { white-space: nowrap; }", words, { css: {} })).toEqual(["NOWRAP_NOT_DISPLAY"]);
  });
});

// ---------------------------------------------------------------- 2. the widths

const GUTTER = 16;
/** A one-word page: the display word in an h1 inside a box with a 16px gutter each side. */
const wordPage = (word: string, css: string) => rawDoc(`<div class="box"><h1 class="n">${word}</h1></div><p class="t">${shopFacts("tsugute").facts.hours}</p>`, `${BASE}\n.box { margin: 0 ${GUTTER}px; } .n { margin: 0; line-height: 1.2; ${css} } .t { margin: 8px ${GUTTER}px; }`);

/** The drawn width (px) of the h1's text, unwrapped, at 1920. */
async function naturalWidth(word: string, css: string): Promise<number> {
  const o = await openCompPage(browser, wordPage(word, `${css} white-space: nowrap;`), { width: 1920, height: 900, scale: 1, mobile: false });
  try {
    return (await o.page.evaluate(`(() => { const r = document.createRange(); r.selectNodeContents(document.querySelector(".n")); return r.getBoundingClientRect().width; })()`)) as number;
  } finally {
    await o.context.close();
  }
}

/** The failing widths of the 1px sweep (flag on), per code. */
async function sweepOf(page: ReturnType<typeof rawDoc>, words: readonly string[]) {
  const s = (await displaySweepPass(browser, page, { css: ON, displayWords: words }))!;
  expect(s.failing.some((f) => f.codes.includes("PHASE_B_UNMEASURED"))).toBe(false);
  return s;
}

const facts = (shop: ShopKey) => Object.values(shopFacts(shop).facts).map((v) => v.replace(/\s+/g, ""));

/**
 * The checked widths and the 1px sweep for one nowrap display word: every width narrower than the word (+ gutters)
 * fails, every wider one passes. Returns the threshold for the record.
 */
async function fitsExactly(word: string, css: string, extra: string[] = []) {
  const words = displayWordsOf(word);
  const page = wordPage(word, `${css} white-space: nowrap;`);
  const need = (await naturalWidth(word, css)) + 2 * GUTTER;
  const sweep = await sweepOf(page, words);
  const failing = sweep.failing.map((f) => f.w);
  // the sweep fails exactly below the width the word needs (-2/+1px for sub-pixel rounding)
  for (const f of sweep.failing) expect(f.codes.every((c) => ["DISPLAY_OUT_OF_BOX", "DISPLAY_OFFSCREEN"].includes(c)), `${f.w}`).toBe(true);
  if (need > 321) expect(Math.max(...failing)).toBeGreaterThanOrEqual(Math.floor(need) - 2);
  expect(failing.every((w) => w <= Math.ceil(need) + 1)).toBe(true);
  expect(failing.length).toBeGreaterThanOrEqual(Math.max(0, Math.floor(need) - 2 - 320));
  // no gaps: the failing widths are exactly 320..max, one per px
  if (failing.length > 0) expect(failing).toEqual(Array.from({ length: failing.length }, (_, i) => 320 + i));
  expect(phaseBCheck([], sweep).ok).toBe(failing.length === 0);
  // the checked widths: below, the run's own checks fail too (box, page); above, nothing
  const rows: Array<{ width: number; codes: string[] }> = [];
  for (const width of NOWRAP_WIDTHS) {
    const r = await widthCodes(browser, page, width, { css: ON, displayWords: words, facts: facts("tsugute") });
    rows.push({ width, codes: allCodes(r) });
    if (width < need - 2) {
      expect(r.box, `${width}`).toEqual(["TEXT_BOX_OVERFLOW"]);
      // the page scrolls only once the word passes the right gutter too; inside the gutter only the box checks see it
      if (width < need - GUTTER - 2) expect(r.overflow, `${width}`).toEqual(["OVERFLOW_HORIZONTAL"]);
      for (const c of extra) expect(allCodes(r), `${width}`).toContain(c);
    }
    if (width > need + 2) expect(allCodes(r), `${width}`).toEqual([]);
    expect(r.phaseB, `${width}`).toEqual([]); // in scope: no NOWRAP_NOT_DISPLAY; nowrap cannot break: no DISPLAY_WORD_BROKEN
  }
  console.log(`DEV-170 ${word} (${css}) needs ${need.toFixed(1)}px; 1px sweep fails ${widthRanges(failing) || "-"}; ${rows.map((x) => `${x.width}:[${x.codes.join(" ")}]`).join(" ")}`);
  return { need, rows, failing };
}

describe("DEV-170 widths: a nowrap display word fails exactly where it does not fit", () => {
  it("a long shop name (40px): fails below its width at every check, passes above", async () => {
    const r = await fitsExactly("架空金継ぎと漆の修理工房 つぐ手 本店", "font-size: 40px;");
    expect(r.need).toBeGreaterThan(601);
    expect(r.need).toBeLessThan(1024);
  });

  it("a mixed Japanese / English name (Café つぐ手 Kintsugi Studio, 44px)", async () => {
    const r = await fitsExactly("Café つぐ手 Kintsugi Studio", "font-size: 44px;");
    expect(r.need).toBeGreaterThan(390);
  });

  it("full-width digits are wider than half-width ones (the same check, each at its own width)", async () => {
    const full = await fitsExactly("架空喫茶 ３丁目２号店", "font-size: 48px;");
    const half = await fitsExactly("架空喫茶 3丁目2号店", "font-size: 48px;");
    expect(full.need).toBeGreaterThan(half.need);
  });

  it("the longest fixed label (店舗情報を見る) at 64px fails on the phone widths and passes from 600", async () => {
    const r = await fitsExactly("店舗情報を見る", "font-size: 64px;");
    expect(r.failing).toContain(320);
    expect(r.failing).toContain(390);
    expect(r.failing).not.toContain(600);
  });

  it("a name sized to need about 370px fails at 320 / 340 / 360 and passes at 375 / 390", async () => {
    const word = "架空金継ぎ工房 つぐ手";
    const at100 = await naturalWidth(word, "font-size: 100px;");
    const size = Math.floor((100 * (370 - 2 * GUTTER)) / at100);
    const r = await fitsExactly(word, `font-size: ${size}px;`);
    expect(r.need).toBeGreaterThan(361);
    expect(r.need).toBeLessThan(374);
    for (const w of [320, 340, 360]) expect(r.rows.find((x) => x.width === w)!.codes, `${w}`).toContain("TEXT_BOX_OVERFLOW");
    for (const w of [375, 390]) expect(r.rows.find((x) => x.width === w)!.codes, `${w}`).toEqual([]);
  });

  it("keep-all instead of nowrap breaks at the spaces: the same mixed name passes everywhere while each run fits", async () => {
    const word = "Café つぐ手 Kintsugi Studio";
    const page = wordPage(word, "font-size: 44px; word-break: keep-all;");
    expect((await sweepOf(page, displayWordsOf(word))).failing).toEqual([]);
    for (const width of NOWRAP_WIDTHS) expect(allCodes(await widthCodes(browser, page, width, { css: ON, displayWords: displayWordsOf(word), facts: facts("tsugute") })), `${width}`).toEqual([]);
    // a run wider than the box still fails (keep-all does not break inside a run)
    const big = wordPage(word, "font-size: 96px; word-break: keep-all;");
    const sweep = await sweepOf(big, displayWordsOf(word));
    expect(sweep.failing.map((f) => f.w)).toContain(320);
    expect(sweep.failing.map((f) => f.w)).not.toContain(1440);
  });

  it("without nowrap the same long name breaks inside a run: DISPLAY_WORD_BROKEN (the loss nowrap is for)", async () => {
    const word = "架空金継ぎと漆の修理工房 つぐ手 本店";
    const sweep = await sweepOf(wordPage(word, "font-size: 40px;"), displayWordsOf(word));
    const broken = sweep.failing.filter((f) => f.codes.includes("DISPLAY_WORD_BROKEN")).map((f) => f.w);
    expect(broken).toContain(390);
    expect(broken).not.toContain(1440);
  });

  it("text over text: a nowrap name that spills into the next grid column overprints its text (TEXT_OVERLAP) and leaves its box", async () => {
    const word = "架空金継ぎ工房 つぐ手";
    const { facts: f } = shopFacts("tsugute");
    const page = rawDoc(`<div class="g"><h1 class="n">${word}</h1><p class="t">${f.address}${f.access}</p></div>`, `${BASE}\n.g { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px; margin: 0 ${GUTTER}px; } .n { margin: 0; font-size: 48px; line-height: 1.5; white-space: nowrap; } .t { margin: 0; font-size: 32px; line-height: 1.5; }`);
    const words = displayWordsOf(word);
    const narrow = await widthCodes(browser, page, 768, { css: ON, displayWords: words, facts: facts("tsugute") });
    expect(narrow.text).toContain("TEXT_OVERLAP");
    expect(narrow.box).toEqual(["TEXT_BOX_OVERFLOW"]);
    const sweep = await sweepOf(page, words);
    expect(sweep.failing.map((f) => f.w)).toContain(768);
    expect(sweep.failing.find((f) => f.w === 768)!.codes).toContain("DISPLAY_OUT_OF_BOX");
    const wide = await widthCodes(browser, page, 1440, { css: ON, displayWords: words, facts: facts("tsugute") });
    expect(allCodes(wide)).toEqual([]);
  });

  it("a nowrap name clipped by its box (overflow: hidden) fails (TEXT_CLIPPED, DISPLAY_OUT_OF_BOX), though the page does not scroll", async () => {
    const word = "架空金継ぎと漆の修理工房 つぐ手 本店";
    const page = rawDoc(`<div class="box"><h1 class="n">${word}</h1></div>`, `${BASE}\n.box { margin: 0 ${GUTTER}px; overflow: hidden; } .n { margin: 0; font-size: 40px; white-space: nowrap; }`);
    const words = displayWordsOf(word);
    const r = await widthCodes(browser, page, 390, { css: ON, displayWords: words, facts: facts("tsugute") });
    expect(r.text).toContain("TEXT_CLIPPED");
    expect(r.overflow).toEqual([]);
    const sweep = await sweepOf(page, words);
    expect(sweep.failing.find((f) => f.w === 390)!.codes).toContain("DISPLAY_OUT_OF_BOX");
  });

  it("phone emulation (≤390) and the desktop sweep agree on a page with a viewport meta", async () => {
    const word = "Café つぐ手 Kintsugi Studio";
    const page = wordPage(word, "font-size: 44px; white-space: nowrap;");
    const sweep = await sweepOf(page, displayWordsOf(word));
    for (const width of [320, 340, 360, 375, 390]) {
      const r = await widthCodes(browser, page, width, { css: ON, displayWords: displayWordsOf(word), facts: facts("tsugute") });
      expect(r.overflow.length > 0, `${width}`).toBe(sweep.failing.some((f) => f.w === width));
    }
  });
});

// ---------------------------------------------------------------- 3. the three shops' strict pages

describe("DEV-170 the three shops' strict B pages with nowrap", () => {
  it.each(SHOP_KEYS)("%s: nowrap on the full name adds no code at any checked width and passes the 1px sweep", async (shop) => {
    const { words } = shopFacts(shop);
    const f = facts(shop);
    const strict = strictPage(shop, "strict");
    const nowrap = strictPage(shop, "nowrap");
    expect(cssProblems(strict.css)).toEqual([]);
    expect(cssProblems(nowrap.css).length).toBeGreaterThan(0); // refused while the flag is off
    expect(cssProblems(nowrap.css, ON)).toEqual([]);
    const table: string[] = [];
    for (const width of NOWRAP_WIDTHS) {
      const a = await widthCodes(browser, strict, width, { css: ON, displayWords: words, facts: f });
      const b = await widthCodes(browser, nowrap, width, { css: ON, displayWords: words, facts: f });
      // the same codes but DISPLAY_WORD_BROKEN, which nowrap removes; never NOWRAP_NOT_DISPLAY
      expect(allCodes(b), `${shop} ${width}`).toEqual(allCodes(a).filter((c) => c !== "DISPLAY_WORD_BROKEN"));
      expect(b.phaseB, `${shop} ${width}`).toEqual([]);
      expect(b.overflowPx, `${shop} ${width}`).toBe(a.overflowPx);
      table.push(`${width}: strict [${allCodes(a).join(" ")}] ${a.overflowPx}px / nowrap [${allCodes(b).join(" ")}] ${b.overflowPx}px`);
    }
    const sweepStrict = (await displaySweepPass(browser, strict, { css: ON, displayWords: words }))!;
    const sweepNowrap = (await displaySweepPass(browser, nowrap, { css: ON, displayWords: words }))!;
    expect(sweepStrict.targets).toBe(1);
    expect(sweepNowrap.targets).toBe(1);
    expect(new Set(sweepStrict.failing.flatMap((x) => x.codes)).size <= 1).toBe(true);
    for (const x of sweepStrict.failing) expect(x.codes).toEqual(["DISPLAY_WORD_BROKEN"]);
    expect(sweepNowrap.failing).toEqual([]);
    console.log(`DEV-170 ${shop}\n${table.join("\n")}\n1px sweep (flag on) strict DISPLAY_WORD_BROKEN: ${widthRanges(sweepStrict.failing.map((x) => x.w)) || "-"} / nowrap: -`);
  });

  it.each(SHOP_KEYS)("%s: nowrap on the short name and the big decorative words (outside the scope) is refused at every checked width", async (shop) => {
    const { words } = shopFacts(shop);
    const page = strictPage(shop, "nowrap_wide");
    expect(cssProblems(page.css, ON)).toEqual([]); // the grammar alone would let it through
    for (const width of NOWRAP_WIDTHS) expect((await widthCodes(browser, page, width, { css: ON, displayWords: words, facts: facts(shop) })).phaseB, `${shop} ${width}`).toContain("NOWRAP_NOT_DISPLAY");
  });

  it("word-break: auto-phrase is already in the allowlist with every flag off (for the comparison in the decision sheet)", () => {
    for (const shop of SHOP_KEYS) expect(cssProblems(strictPage(shop, "auto_phrase").css)).toEqual([]);
  });
});
