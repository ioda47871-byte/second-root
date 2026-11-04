import type { Browser, BrowserContext, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cssProblems, htmlSourceProblems } from "@/lib/design-agent/comp-impl/page";
import type { PageCssOptions } from "@/lib/design-agent/comp-impl/page-css";
import { legibilityCheck, widthRanges } from "@/lib/design-agent/comp-impl/checks";
import { displayWordsOf, phaseBCheck, phaseBCodes, TYPE_ROLE_CAPS } from "@/lib/design-agent/comp-impl/phase-b";
import { displaySweepPass, legibilityPass, openCompPage, pageWidths, phaseBScan, sweepWidths } from "@/lib/design-agent/comp-impl/render";
import { APPROVED_CAPABILITIES, COMP_UI_LABELS, pageCssOptionsOf } from "@/lib/design-agent/comp-impl/spec";
import { POC_DISCLOSURE } from "@/lib/design-agent/design-image/prompt";
import { launch } from "./support";
import { allCodes, NOWRAP_WIDTHS, rawDoc, SHOPS, shopFacts, widthCodes, type ShopKey } from "./nowrap-harness";
import { C_PRIME_BIG, cPrimePage, fitPx, SCALE_NAME_PX, scalePage } from "./scale-harness";

// DEV-171 (Issue #193 comment 6628165899): the safety verification of display_scale
// (docs/design/display-scale-decision.md). The capability stays OFF: APPROVED_CAPABILITIES is empty and these tests turn
// the flag on only in their own calls (phaseBScan, displaySweepPass, legibilityPass), as phase-b.test.ts and
// display-nowrap.test.ts do. They hold, against the production checker (phase-b.ts through render.ts):
// 1. flag off: every text above 256px computed fails TYPE_ABOVE_ROLE_CAP, however the size is reached;
// 2. flag on: above 256px only a display word (the full shop name, a fixed UI label) passes; facts, sentences, dt / dd /
//    the disclosure, the short name, the decorative words, hidden text and inherited sizes still fail;
// 3. the caps are exact (256 / 640, ±1px), in px and in rem;
// 4. the widths: a large display word fails exactly where it does not fit (the 1px sweep, ±1px) and passes above; text
//    over text, clipping and contrast are still checked;
// 5. the three shops: the strict pages are unchanged; the full name above 256px does not fit at 1440; the words C′ draws
//    above 256px are none of them display words, so ON gives them nothing.

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const ON: PageCssOptions = { displayScale: true };
const OFF: PageCssOptions = {};
const SHOP_KEYS = Object.keys(SHOPS) as ShopKey[];

let browser: Browser;
let raw: BrowserContext;
let tab: Page;
beforeAll(async () => {
  browser = await launch();
  raw = await browser.newContext({ viewport: { width: 1920, height: 900 }, deviceScaleFactor: 1 });
  await raw.route("**/*", (route) => route.abort());
  tab = await raw.newPage();
});
afterAll(async () => {
  await raw?.close();
  await browser?.close();
});

const BASE = 'body { margin: 0; font-family: "IPAGothic", sans-serif; font-size: 16px; line-height: 1.5; color: #1F1D1B; }';
/** Phase B codes of a raw body at a width (the allowlist is NOT applied: raw HTML can do what the allowlist refuses). */
async function scan(body: string, css: string, words: readonly string[], o: { width?: number; css?: PageCssOptions } = {}) {
  await tab.setViewportSize({ width: o.width ?? 1920, height: 900 });
  await tab.setContent(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>${BASE}\n${css}</style></head><body>${body}</body></html>`);
  return phaseBScan(tab, { css: o.css ?? ON, displayWords: words });
}
const codes = async (body: string, css: string, words: readonly string[], o: { width?: number; css?: PageCssOptions } = {}) => phaseBCodes(await scan(body, css, words, o));
const CAP = ["TYPE_ABOVE_ROLE_CAP"];

describe("DEV-171 display_scale stays OFF", () => {
  it("approves nothing and turns the flag on for no spec", () => {
    expect(APPROVED_CAPABILITIES).toEqual([]);
    expect(pageCssOptionsOf({ capabilities: ["display_scale"] })).toEqual({});
    expect(TYPE_ROLE_CAPS).toEqual({ text: 256, display: 640 });
  });

  it("the static grammar: 256px / 16rem without the flag, 640px / 40rem with it; never calc / clamp / max / min above 256, em, %, vw, keywords", () => {
    for (const ok of ["256px", "16rem", "12px", "0.75rem"]) expect(cssProblems(`.x { font-size: ${ok}; }`), ok).toEqual([]);
    for (const bad of ["257px", "256.5px", "16.0625rem", "300px", "640px", "40rem"]) expect(cssProblems(`.x { font-size: ${bad}; }`), bad).toEqual(["CSS_VALUE"]);
    for (const ok of ["257px", "640px", "40rem", "300px"]) expect(cssProblems(`.x { font-size: ${ok}; }`, ON), ok).toEqual([]);
    for (const bad of ["640.5px", "641px", "40.0625rem", "calc(300px)", "max(12px, 300px)", "clamp(12px, 300px, 600px)", "20em", "300%", "xxx-large", "larger"]) {
      expect(cssProblems(`.x { font-size: ${bad}; }`, ON).length, bad).toBeGreaterThan(0);
    }
    for (const bad of ["30vw", "clamp(12px, 40vw, 600px)", "min(600px, 50vw)"]) expect(cssProblems(`.x { font-size: ${bad}; }`, ON), bad).toContain("CSS_VIEWPORT_UNIT");
  });

  it("the static grammar does not know roles: with the flag a fact's selector, body and html take 640px too (only the render limits the role)", () => {
    for (const sel of [".address-fact", "dd", "body", "html", "*"]) expect(cssProblems(`${sel} { font-size: 640px; }`, ON), sel).toEqual([]);
    expect(cssProblems("html { font-size: 40rem; } .x { font-size: 40rem; }", ON)).toEqual([]); // 25,600px in the page
  });

  it("the size tricks the render cap does NOT see are refused before the render: zoom, transforms, the font shorthand, pseudo-elements, style attributes and foreign elements", () => {
    for (const o of [OFF, ON]) {
      for (const d of ["zoom: 3", "transform: scale(3)", "scale: 3", "font: 600px serif", "font-size-adjust: 2"]) expect(cssProblems(`.x { ${d}; }`, o), d).toContain("CSS_PROPERTY");
      expect(cssProblems(".x::first-letter { font-size: 200px; }", o).length).toBeGreaterThan(0);
    }
    expect(htmlSourceProblems('<p style="zoom:3">x</p>').length + htmlSourceProblems("<svg><text>x</text></svg>").length + htmlSourceProblems("<math><mi>x</mi></math>").length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------- 1. flag off

describe("DEV-171 flag off: above 256px fails for every text", () => {
  describe.each(SHOP_KEYS)("%s", (shop) => {
    const { name, facts, words } = shopFacts(shop);
    const short = name.split(/\s+/).pop()!;

    it("the full name, a label, the short name, every fact, the decorative words: 256px passes, 257px fails", async () => {
      const texts = [name, "店舗情報", "電話", short, ...Object.values(facts).filter((v) => v !== name), ...C_PRIME_BIG[shop].map((b) => b.word)];
      for (const t of texts) {
        expect(await codes(`<p class="w">${t}</p>`, ".w { font-size: 256px; }", words, { css: OFF }), t).toEqual([]);
        expect(await codes(`<p class="w">${t}</p>`, ".w { font-size: 257px; }", words, { css: OFF }), t).toEqual(CAP);
      }
    });
  });

  it("however the size is reached: rem × the root, em, %, the h1's own 2em, inheritance, keywords, vw, clamp, calc (raw)", async () => {
    const { name, facts, words } = shopFacts("sento");
    const tricks: Array<[string, string]> = [
      [`<p class="w">${facts.phone}</p>`, "html { font-size: 20px; } .w { font-size: 13rem; }"], // 260
      [`<div class="a"><p class="b">${facts.phone}</p></div>`, ".a { font-size: 130px; } .b { font-size: 2em; }"], // 260
      [`<div class="a"><p class="b">${facts.phone}</p></div>`, ".a { font-size: 130px; } .b { font-size: 200%; }"],
      [`<div class="a"><h1>${name}</h1></div>`, ".a { font-size: 130px; }"], // the UA's h1 { font-size: 2em }: 260
      [`<section class="a"><p>${facts.address}</p></section>`, ".a { font-size: 300px; }"],
      [`<p>${facts.hours}</p>`, "body { font-size: 300px; }"],
      [`<p>${facts.hours}</p>`, "html { font-size: 300px; } body { font-size: 1rem; }"],
      [`<p class="w">${facts.phone}</p>`, "html { font-size: 256px; } body { font-size: 1rem; } .w { font-size: larger; }"],
      [`<p class="w">${facts.phone}</p>`, ".w { font-size: 14vw; }"], // 268.8 at 1920
      [`<p class="w">${facts.phone}</p>`, ".w { font-size: clamp(12px, 20vw, 600px); }"],
      [`<p class="w">${facts.phone}</p>`, ".w { font-size: calc(200px + 4rem); }"],
      [`<p class="w">${name}</p>`, ".w { font-size: 16rem; } html { font-size: 17px; }"], // 272: 16rem is in the grammar
    ];
    for (const [body, css] of tricks) expect(await codes(body, css, words, { css: OFF }), css).toEqual(CAP);
  });

  it("hidden and aria-hidden text is capped too", async () => {
    const { facts, words } = shopFacts("bicycle");
    expect(await codes(`<p class="w" style="display:none">${facts.address}</p>`, ".w { font-size: 300px; }", words, { css: OFF })).toEqual(CAP);
    expect(await codes(`<p class="w" aria-hidden="true">まわる</p>`, ".w { font-size: 300px; }", words, { css: OFF })).toEqual(CAP);
  });

  it("known limit, recorded: zoom, transform / scale and ::first-letter enlarge the drawing without changing the computed size (the render cap passes them; the grammar above refuses them)", async () => {
    const { facts, words } = shopFacts("sento");
    expect(await codes(`<p class="w">${facts.phone}</p>`, ".w { font-size: 200px; zoom: 3; }", words, { css: OFF })).toEqual([]);
    expect(await codes(`<p class="w">${facts.phone}</p>`, ".w { font-size: 200px; transform: scale(3); }", words, { css: OFF })).toEqual([]);
    expect(await codes(`<p class="w">${facts.phone}</p>`, ".w::first-letter { font-size: 600px; }", words, { css: OFF })).toEqual([]);
  });
});

// ---------------------------------------------------------------- 2. flag on: the scope

describe("DEV-171 flag on: above 256px only for a display word", () => {
  describe.each(SHOP_KEYS)("%s", (shop) => {
    const { name, facts, words } = shopFacts(shop);
    const short = name.split(/\s+/).pop()!;

    it("accepts the full name (h1, p, a, full-width space, newline) and every fixed label at 300px and at 640px", async () => {
      for (const px of [300, 640]) {
        for (const t of [name, name.replace(/\s+/, "　"), name.replace(/\s+/, "\n")]) {
          for (const tag of ["h1", "p", "a"]) expect((await scan(`<${tag} class="w">${t}</${tag}>`, `.w { font-size: ${px}px; }`, words)).type.above, `${tag} ${px} ${JSON.stringify(t)}`).toBe(0);
        }
        for (const label of COMP_UI_LABELS) expect((await scan(`<h2 class="w">${label}</h2>`, `.w { font-size: ${px}px; }`, words)).type.above, label).toBe(0);
      }
      // the name inherited from a wrapper whose one text is the name
      expect((await scan(`<header class="w"><h1>${name}</h1></header>`, ".w { font-size: 320px; } h1 { font-size: 1em; }", words)).type.above).toBe(0);
    });

    it("refuses every fact value, the short name, the decorative words and a fact sentence at 257px", async () => {
      const texts = [...Object.entries(facts).filter(([k]) => k !== "name").map(([, v]) => v), short, `${short}${short}`, "まわる", "継ぐ", "待つ", "熱い", "ぬるい", "外の小さな庭に、水風呂があります"];
      expect(texts.length).toBeGreaterThan(10);
      for (const t of texts) expect(await codes(`<p class="w">${t}</p>`, ".w { font-size: 257px; }", words), t).toEqual(CAP);
    });

    it("refuses the name or a label inside a dt, a dd or the disclosure, and the disclosure itself", async () => {
      for (const body of [`<dl><dt>店名</dt><dd class="w">${name}</dd></dl>`, `<dl><dt class="w">住所</dt><dd>${facts.address}</dd></dl>`, `<p data-comp-disclosure class="w">${name}</p>`, `<footer data-comp-disclosure><p class="w">店舗情報</p></footer>`, `<p data-comp-disclosure class="w">${POC_DISCLOSURE}</p>`]) {
        expect(await codes(body, ".w { font-size: 300px; }", words), body).toEqual(CAP);
      }
    });

    it("refuses mixed text, child elements, aria-label tricks and normalisation tricks", async () => {
      const [a, b] = name.split(/\s+/);
      for (const inner of [`${name}は架空の店です。`, `${name} ${facts.phone}`, `${name}店舗情報`, `${name}。`, `${a}<br>${b}`, `${a} <span>${b}</span>`, `${name}<span></span>`, `${a}​${b}`]) {
        expect((await scan(`<h1 class="w">${inner}</h1>`, ".w { font-size: 300px; }", words)).type.above, inner).toBeGreaterThan(0);
      }
      expect(await codes(`<p class="w" aria-label="${name}">${facts.address}</p>`, ".w { font-size: 300px; }", words)).toEqual(CAP);
    });

    it("refuses inherited sizes that reach anything but a display word, and a display word multiplied past 640", async () => {
      expect(await codes(`<section class="w"><h1>${name}</h1><p>${facts.hours}</p></section>`, ".w { font-size: 600px; } h1 { font-size: 1em; }", words)).toContain("TYPE_ABOVE_ROLE_CAP");
      const above = async (body: string, css: string) => (await scan(body, css, words)).type.list.map((x) => [x.px, x.cap, x.display]);
      expect(await above(`<h1>${name}</h1><p>${facts.address}</p>`, "html { font-size: 40rem; } h1 { font-size: 1rem; } p { font-size: 16px; }")).toEqual([]);
      expect(await above(`<h1>${name}</h1><p>${facts.address}</p>`, "html { font-size: 40rem; } body, h1 { font-size: 1rem; }")).toEqual([[640, 256, false]]); // the p inherits 640
      expect(await above(`<h1>${name}</h1>`, "html { font-size: 17px; } h1 { font-size: 40rem; }")).toEqual([[680, 640, true]]);
      expect(await above(`<div class="a"><h1>${name}</h1></div>`, ".a { font-size: 330px; }")).toEqual([[660, 640, true]]); // the h1's 2em
    });

    it("hidden text: a hidden fact is still refused; a hidden display word is accepted (it is a display word)", async () => {
      expect(await codes(`<p class="w" style="display:none">${facts.phone}</p>`, ".w { font-size: 300px; }", words)).toEqual(CAP);
      expect(await codes(`<h1 class="w" aria-hidden="true">${name}</h1>`, ".w { font-size: 300px; }", words, { width: 1920 })).not.toContain("TYPE_ABOVE_ROLE_CAP");
    });
  });

  it("the role is the text's, not the selector's: the same rule passes a label and fails a fact in the same page", async () => {
    const { facts, words } = shopFacts("tsugute");
    const s = await scan(`<h2 class="w">店舗情報</h2><p class="w">${facts.phone}</p>`, ".w { font-size: 400px; }", words);
    expect(s.type.above).toBe(1);
    expect(s.type.list).toEqual([{ px: 400, cap: 256, display: false, text: facts.phone.replace(/\s+/g, "") }]);
  });
});

// ---------------------------------------------------------------- 3. the exact caps

describe("DEV-171 the caps are exact", () => {
  const { name, words } = shopFacts("bicycle");
  const [, b] = name.split(/\s+/); // 輪: one glyph, fits at 1920 up to 640px
  it("text: 256 / 256.01 pass, 256.03 / 256.5 / 257 fail (flag on and off)", async () => {
    for (const o of [OFF, ON]) {
      for (const px of ["256px", "256.01px", "16rem"]) expect(await codes(`<p class="w">${b}</p>`, `.w { font-size: ${px}; }`, words, { css: o }), px).toEqual([]);
      for (const px of ["256.03px", "256.5px", "257px", "16.0625rem"]) expect(await codes(`<p class="w">${b}</p>`, `.w { font-size: ${px}; }`, words, { css: o }), px).toEqual(CAP);
    }
  });

  it("display word: 640 / 40rem pass, 640.03 / 640.5 / 641 / 40.0625rem fail; without the flag the same word fails from 256.03", async () => {
    for (const px of ["640px", "640.01px", "40rem", "300px"]) expect((await scan(`<p class="w">${name}</p>`, `.w { font-size: ${px}; }`, words)).type.above, px).toBe(0);
    for (const px of ["640.03px", "640.5px", "641px", "40.0625rem", "700px"]) {
      const s = await scan(`<p class="w">${name}</p>`, `.w { font-size: ${px}; }`, words);
      expect(s.type.above, px).toBe(1);
      expect(s.type.list[0]).toMatchObject({ cap: 640, display: true });
    }
    expect((await scan(`<p class="w">${name}</p>`, ".w { font-size: 256.03px; }", words, { css: OFF })).type.list[0]).toMatchObject({ cap: 256, display: true });
  });

  it("the same caps at every checked width, desktop and phone (the cap does not depend on the width)", async () => {
    const page = rawDoc(`<h2 class="w">電話</h2><p class="f">${shopFacts("bicycle").facts.phone}</p>`, `${BASE}\n.w { font-size: 640px; line-height: 1; margin: 0; } .f { font-size: 257px; margin: 0; }`);
    for (const width of [1440, 768, 390, 320]) {
      const o = await openCompPage(browser, page, { width, height: 900, scale: 1, mobile: width <= 390 });
      try {
        const s = await phaseBScan(o.page, { css: ON, displayWords: words });
        expect(s.type.list.map((x) => [x.px, x.cap, x.display]), `${width}`).toEqual([[257, 256, false]]);
      } finally {
        await o.context.close();
      }
    }
  });

  it("phaseBCheck reports the largest size and the list (the report the run writes)", async () => {
    const s = await scan(`<p class="w">電話</p><p class="f">待つ</p>`, ".w { font-size: 640px; } .f { font-size: 300px; }", words);
    const c = phaseBCheck([{ width: 1920, phaseB: s }]);
    expect(c).toMatchObject({ ok: false, codes: CAP, max_font_px: 640 });
  });
});

// ---------------------------------------------------------------- 4. the widths

const GUTTER = 16;
/** A one-word page: the display word in an h1 inside a box with a 16px gutter each side, and a fact under it. */
const wordPage = (word: string, css: string) => rawDoc(`<div class="box"><h1 class="n">${word}</h1></div><p class="t">${shopFacts("tsugute").facts.hours}</p>`, `${BASE}\n.box { margin: 0 ${GUTTER}px; } .n { margin: 0; line-height: 1; ${css} } .t { margin: 8px ${GUTTER}px; }`);

/** The drawn width (px) of the widest run (between spaces) of the h1's text, unwrapped, at 1920. */
async function runWidth(word: string, css: string, whole = false): Promise<number> {
  const o = await openCompPage(browser, wordPage(word, `${css} white-space: nowrap;`), { width: 1920, height: 900, scale: 1, mobile: false });
  try {
    return (await o.page.evaluate(`((whole) => {
      const n = document.querySelector(".n").firstChild;
      const out = [];
      const re = whole ? /[^]+/g : /\\S+/g;
      for (let m = re.exec(n.data); m; m = re.exec(n.data)) { const r = document.createRange(); r.setStart(n, m.index); r.setEnd(n, m.index + m[0].length); out.push(r.getBoundingClientRect().width); }
      return Math.max(...out);
    })(${whole})`)) as number;
  } finally {
    await o.context.close();
  }
}

const shopFactList = (shop: ShopKey) => Object.values(shopFacts(shop).facts).map((v) => v.replace(/\s+/g, ""));

async function sweepOf(page: ReturnType<typeof rawDoc>, words: readonly string[], css: PageCssOptions = ON) {
  const s = (await displaySweepPass(browser, page, { css, displayWords: words }))!;
  expect(s.failing.some((f) => f.codes.includes("PHASE_B_UNMEASURED"))).toBe(false);
  return s;
}

/**
 * A large display word: the 1px sweep fails exactly below the width its widest run needs (±1px) with `expect` codes,
 * and passes above; the checked widths never show TYPE_ABOVE_ROLE_CAP (in scope) and below the threshold fail the box.
 */
async function fitsExactly(word: string, css: string, o: { nowrap?: boolean; allowed: string[] }) {
  const words = displayWordsOf(word);
  const flags: PageCssOptions = o.nowrap ? { displayScale: true, displayNowrap: true } : ON;
  const page = wordPage(word, `${css}${o.nowrap ? " white-space: nowrap;" : ""}`);
  const need = (await runWidth(word, css, o.nowrap === true)) + 2 * GUTTER;
  const sweep = await sweepOf(page, words, flags);
  const failing = sweep.failing.map((f) => f.w);
  for (const f of sweep.failing) expect(f.codes.every((c) => o.allowed.includes(c)), `${f.w} ${f.codes}`).toBe(true);
  if (need > 321) expect(Math.max(...failing)).toBeGreaterThanOrEqual(Math.min(1920, Math.floor(need) - 2));
  expect(failing.every((w) => w <= Math.ceil(need) + 1), widthRanges(failing)).toBe(true);
  expect(failing.length).toBeGreaterThanOrEqual(Math.max(0, Math.min(1920, Math.floor(need) - 2) - 320));
  expect(phaseBCheck([], sweep).ok).toBe(failing.length === 0);
  const rows: string[] = [];
  for (const width of NOWRAP_WIDTHS) {
    const r = await widthCodes(browser, page, width, { css: flags, displayWords: words, facts: shopFactList("tsugute") });
    rows.push(`${width}:[${allCodes(r).join(" ")}]`);
    expect(r.phaseB, `${width}`).not.toContain("TYPE_ABOVE_ROLE_CAP");
    if (width > need + 2) expect(allCodes(r), `${width}`).toEqual([]);
  }
  console.log(`DEV-171 ${word} (${css}${o.nowrap ? " nowrap" : ""}) needs ${need.toFixed(1)}px; 1px sweep fails ${widthRanges(failing) || "-"} [${[...new Set(sweep.failing.flatMap((f) => f.codes))].join(" ")}]; ${rows.join(" ")}`);
  return { need, failing, sweep, rows };
}

describe("DEV-171 widths: a large display word fails exactly where it does not fit", () => {
  it("a four-glyph label (店舗情報, 300px): breaks inside the word below its width (DISPLAY_WORD_BROKEN), passes above", async () => {
    const r = await fitsExactly("店舗情報", "font-size: 300px;", { allowed: ["DISPLAY_WORD_BROKEN", "DISPLAY_OUT_OF_BOX", "DISPLAY_OFFSCREEN"] });
    expect(r.need).toBeGreaterThan(1200);
    expect(r.need).toBeLessThan(1300);
    const broken = r.sweep.failing.filter((f) => f.codes.includes("DISPLAY_WORD_BROKEN")).map((f) => f.w);
    expect(broken).toContain(1024);
    expect(broken).toContain(390);
  });

  it("the same label with nowrap (display_scale + display_nowrap): the same threshold, now DISPLAY_OUT_OF_BOX / DISPLAY_OFFSCREEN instead of a broken word", async () => {
    const alone = await fitsExactly("店舗情報", "font-size: 300px;", { allowed: ["DISPLAY_WORD_BROKEN", "DISPLAY_OUT_OF_BOX", "DISPLAY_OFFSCREEN"] });
    const both = await fitsExactly("店舗情報", "font-size: 300px;", { nowrap: true, allowed: ["DISPLAY_OUT_OF_BOX", "DISPLAY_OFFSCREEN"] });
    expect(Math.abs(both.need - alone.need)).toBeLessThan(2);
    expect(both.sweep.failing.some((f) => f.codes.includes("DISPLAY_WORD_BROKEN"))).toBe(false);
    for (const width of [1024, 768, 390]) expect(both.rows.find((x) => x.startsWith(`${width}:`)), `${width}`).toContain("TEXT_BOX_OVERFLOW");
  });

  it("the cap itself: a two-glyph label (電話) at 640px needs about 1312px; one glyph alone does not fit below about 672px (DISPLAY_OUT_OF_BOX)", async () => {
    const r = await fitsExactly("電話", "font-size: 640px;", { allowed: ["DISPLAY_WORD_BROKEN", "DISPLAY_OUT_OF_BOX", "DISPLAY_OFFSCREEN"] });
    expect(r.need).toBeGreaterThan(1300);
    expect(r.need).toBeLessThan(1320);
    const out = r.sweep.failing.filter((f) => f.codes.includes("DISPLAY_OUT_OF_BOX")).map((f) => f.w);
    expect(Math.max(...out)).toBeGreaterThanOrEqual(640 + 2 * GUTTER - 2);
    expect(Math.max(...out)).toBeLessThanOrEqual(640 + 2 * GUTTER + 1);
  });

  it("a full name with a space (架空銭湯 ゆげ湯, 400px) may break at its space: it fails only below its longest run", async () => {
    const r = await fitsExactly("架空銭湯 ゆげ湯", "font-size: 400px;", { allowed: ["DISPLAY_WORD_BROKEN", "DISPLAY_OUT_OF_BOX", "DISPLAY_OFFSCREEN"] });
    expect(r.need).toBeGreaterThan(1600);
    expect(r.need).toBeLessThan(1700);
    // with nowrap it must fit on one line: a wider threshold than 1920, so it fails at every width
    const one = await fitsExactly("架空銭湯 ゆげ湯", "font-size: 400px;", { nowrap: true, allowed: ["DISPLAY_OUT_OF_BOX", "DISPLAY_OFFSCREEN"] });
    expect(one.need).toBeGreaterThan(1920);
    expect(one.failing).toHaveLength(1601);
  });

  it("text over text: a large name spilling into the next grid column overprints the fact there (TEXT_OVERLAP) and leaves its box", async () => {
    const { name, facts } = shopFacts("bicycle");
    const [, b] = name.split(/\s+/);
    const page = rawDoc(`<div class="g"><h1 class="n">${b}</h1><p class="t">${facts.address}${facts.access}</p></div>`, `${BASE}\n.g { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px; margin: 0 ${GUTTER}px; } .n { margin: 0; font-size: 600px; line-height: 1; } .t { margin: 0; font-size: 40px; line-height: 1.5; }`);
    const wordsB = displayWordsOf(b!);
    const narrow = await widthCodes(browser, page, 1024, { css: ON, displayWords: wordsB, facts: shopFactList("bicycle") });
    expect(narrow.text).toContain("TEXT_OVERLAP");
    expect(narrow.box).toEqual(["TEXT_BOX_OVERFLOW"]);
    expect(narrow.phaseB).toEqual([]); // 輪 alone is passed as the display word here (a stand-in), under 640
    const sweep = await sweepOf(page, wordsB);
    expect(sweep.failing.find((f) => f.w === 1024)!.codes).toContain("DISPLAY_OUT_OF_BOX");
    const wide = await widthCodes(browser, page, 1920, { css: ON, displayWords: wordsB, facts: shopFactList("bicycle") });
    expect(allCodes(wide)).toEqual([]);
  });

  it("a two-run name larger than one line breaks inside a run at some widths (Japanese breaks between any glyphs); keep-all (display_nowrap) keeps it to its space", async () => {
    const word = "架空銭湯 ゆげ湯";
    const words = displayWordsOf(word);
    const plain = await sweepOf(wordPage(word, "font-size: 200px;"), words);
    const keep = await sweepOf(wordPage(word, "font-size: 200px; word-break: keep-all;"), words, { displayScale: true, displayNowrap: true });
    const run = (await runWidth(word, "font-size: 200px;")) + 2 * GUTTER;
    const whole = (await runWidth(word, "font-size: 200px;", true)) + 2 * GUTTER;
    const brokenPlain = plain.failing.filter((f) => f.codes.includes("DISPLAY_WORD_BROKEN")).map((f) => f.w);
    expect(brokenPlain.filter((w) => w > run + 1).length).toBeGreaterThan(100); // where both runs could stand on their own lines
    expect(keep.failing.every((f) => f.w <= Math.ceil(run) + 1)).toBe(true);
    console.log(`DEV-171 ${word} 200px: runs need ${run.toFixed(1)}px, one line ${whole.toFixed(1)}px; plain broken ${widthRanges(brokenPlain)}; keep-all fails ${widthRanges(keep.failing.map((f) => f.w)) || "-"}`);
  });

  it("clipped: a large label in a box with overflow hidden fails at the checked widths (TEXT_CLIPPED); the 1px sweep sees the word's own box only (overflow is outside the grammar)", async () => {
    expect(cssProblems(".box { overflow: hidden; }", ON)).toEqual(["CSS_PROPERTY"]);
    const word = "店舗情報";
    const page = rawDoc(`<div class="box"><h1 class="n">${word}</h1></div>`, `${BASE}\n.box { margin: 0 ${GUTTER}px; height: 320px; overflow: hidden; } .n { margin: 0; font-size: 300px; line-height: 1; }`);
    const words = displayWordsOf(word);
    const r = await widthCodes(browser, page, 1024, { css: ON, displayWords: words, facts: shopFactList("tsugute") });
    expect(r.text).toContain("TEXT_CLIPPED");
    expect(r.overflow).toEqual([]);
    const sweep = await sweepOf(page, words);
    // the h1 grows with its lines; the clip is its parent's: the sweep sees the broken word, not the clip
    expect(sweep.failing.find((f) => f.w === 1024)!.codes).toEqual(["DISPLAY_WORD_BROKEN"]);
  });

  it("a fixed height (in the grammar): on the word's own box the sweep fails it exactly where it wraps (DISPLAY_OUT_OF_BOX); on a parent only text over text sees it", async () => {
    const word = "架空銭湯 ゆげ湯";
    const words = displayWordsOf(word);
    const own = rawDoc(`<div class="box"><h1 class="n">${word}</h1></div>`, `${BASE}\n.box { margin: 0 ${GUTTER}px; } .n { margin: 0; font-size: 200px; line-height: 1; height: 220px; }`);
    expect(cssProblems(".n { font-size: 200px; line-height: 1; height: 220px; }", ON)).toEqual([]);
    const one = (await runWidth(word, "font-size: 200px;", true)) + 2 * GUTTER;
    const s = await sweepOf(own, words);
    const out = s.failing.filter((f) => f.codes.includes("DISPLAY_OUT_OF_BOX")).map((f) => f.w);
    expect(Math.max(...out)).toBeGreaterThanOrEqual(Math.floor(one) - 2);
    expect(Math.max(...out)).toBeLessThanOrEqual(Math.ceil(one) + 1);
    // keep-all (display_nowrap) so that the name breaks at its space only; the parent's height holds one line
    const both: PageCssOptions = { displayScale: true, displayNowrap: true };
    const parent = rawDoc(`<div class="box"><h1 class="n">${word}</h1></div><p class="t">${shopFacts("sento").facts.address}</p>`, `${BASE}\n.box { margin: 0 ${GUTTER}px; height: 220px; } .n { margin: 0; font-size: 200px; line-height: 1; word-break: keep-all; } .t { margin: 0 ${GUTTER}px; font-size: 40px; }`);
    const p = (await displaySweepPass(browser, parent, { css: both, displayWords: words }))!;
    expect(p.failing.filter((f) => f.w >= 1200).flatMap((f) => f.codes)).toEqual([]); // two runs on two lines: nothing for the sweep
    const r = await widthCodes(browser, parent, 1440, { css: both, displayWords: words, facts: shopFactList("sento") });
    expect(r.text).toContain("TEXT_OVERLAP");
    console.log(`DEV-171 fixed height: own box fails ${widthRanges(out)} (one line needs ${one.toFixed(1)}px); parent box: sweep silent from 1200, 1440 ${allCodes(r).join(" ")}`);
  });

  it("contrast and ink are still checked on a large protected name (FACT_LOW_CONTRAST); a dark one passes them", async () => {
    const { name, facts } = shopFacts("sento");
    const flat = name.replace(/\s+/g, "");
    const words = displayWordsOf(name);
    const list = shopFactList("sento");
    const page = (colour: string) => rawDoc(`<h1 class="n">${name}</h1><p>${facts.address}</p>`, `${BASE}\nbody { background: #ffffff; } .n { margin: 0 ${GUTTER}px; font-size: 400px; line-height: 1.1; color: ${colour}; }`);
    const factCodes = async (colour: string) => {
      const l = await legibilityPass(browser, page(colour), 1920, list, [flat], { pairs: [], facts: list, css: ON, displayWords: words });
      expect(l.phaseB!.type.above).toBe(0);
      return legibilityCheck(l, { required: [flat], disclosure: POC_DISCLOSURE }).codes.filter((c) => c.startsWith("FACT_"));
    };
    expect(await factCodes("#dddddd")).toContain("FACT_LOW_CONTRAST");
    expect(await factCodes("#1f1d1b")).toEqual([]);
  });

  it("phone and tablet: the checked widths and the 32px sweep apply the same cap (a rule only below 600px)", async () => {
    const { name, facts, words } = shopFacts("tsugute");
    const css = `${BASE}\n@media (max-width: 600px) { .f { font-size: 260px; } .n { font-size: 300px; } }`;
    const page = rawDoc(`<h1 class="n">${name}</h1><p class="f">${facts.phone}</p>`, css);
    const widths = [...new Set([...pageWidths(css), ...sweepWidths()])].sort((a, b) => a - b);
    const failing: number[] = [];
    for (const width of widths.filter((w) => w <= 640)) {
      const o = await openCompPage(browser, page, { width, height: 900, scale: 1, mobile: width <= 390 });
      try {
        const s = await phaseBScan(o.page, { css: ON, displayWords: words });
        if (s.type.above > 0) failing.push(width);
        expect(s.type.list.every((x) => !x.display), `${width}`).toBe(true);
      } finally {
        await o.context.close();
      }
    }
    expect(failing.length).toBeGreaterThan(5);
    expect(Math.max(...failing)).toBe(600);
  });
});

// ---------------------------------------------------------------- 5. the three shops

describe("DEV-171 the three shops", () => {
  it.each(SHOP_KEYS)("%s: the strict page draws nothing above 256px; the flag changes no code of it at any checked width but adds the sweep", async (shop) => {
    const { words } = shopFacts(shop);
    const page = scalePage(shop, "strict");
    expect(cssProblems(page.css)).toEqual([]);
    for (const width of NOWRAP_WIDTHS) {
      const o = await openCompPage(browser, page, { width, height: 900, scale: 1, mobile: width <= 390 });
      try {
        const off = await phaseBScan(o.page, { css: OFF, displayWords: words });
        const on = await phaseBScan(o.page, { css: ON, displayWords: words });
        expect(off.type.max, `${width}`).toBeLessThanOrEqual(256);
        expect(phaseBCodes(off), `${width}`).toEqual([]);
        expect(on.type).toEqual(off.type);
      } finally {
        await o.context.close();
      }
    }
  });

  it.each(SHOP_KEYS)("%s: the full name at 300px (inside the scope) passes the cap but does not fit at 1440: it breaks inside a run", async (shop) => {
    const { words, name } = shopFacts(shop);
    const page = scalePage(shop, "scale_name");
    expect(cssProblems(page.css)).toEqual(["CSS_VALUE"]);
    expect(cssProblems(page.css, ON)).toEqual([]);
    const fit = await fitPx(browser, scalePage(shop, "strict"), SHOPS[shop].fullName, 1440);
    expect(fit.px).toBeLessThan(256); // the largest size that would fit at 1440 needs no display_scale
    const r = await widthCodes(browser, page, 1440, { css: ON, displayWords: words, facts: shopFactList(shop) });
    expect(r.phaseB).toEqual(["DISPLAY_WORD_BROKEN"]);
    const s = (await displaySweepPass(browser, page, { css: ON, displayWords: words }))!;
    expect(s.failing.map((f) => f.w)).toEqual(expect.arrayContaining([1024, 1440, 1920]));
    const fit1920 = await fitPx(browser, scalePage(shop, "strict"), SHOPS[shop].fullName, 1920);
    console.log(`DEV-171 ${shop} ${name}: fits on its runs up to ${fit.px}px at 1440, ${fit1920.px}px at 1920 (box ${fit.box.toFixed(0)} / ${fit1920.box.toFixed(0)}px); ${SCALE_NAME_PX}px: sweep fails ${widthRanges(s.failing.map((f) => f.w))}`);
  });

  it.each(SHOP_KEYS)("%s: the words C′ draws above 256px are not display words: with the flag on they still fail (C′ and the strict page with C′'s sizes)", async (shop) => {
    const { words } = shopFacts(shop);
    const cp = await openCompPage(browser, cPrimePage(shop), { width: 1440, height: 900, scale: 1, mobile: false });
    try {
      const s = await phaseBScan(cp.page, { css: ON, displayWords: words });
      expect(phaseBCodes(s)).toContain("TYPE_ABOVE_ROLE_CAP");
      expect(s.type.list.length).toBeGreaterThan(0);
      expect(s.type.list.every((x) => !x.display && x.cap === 256)).toBe(true);
      console.log(`DEV-171 ${shop} C′ at 1440 above 256: ${s.type.list.map((x) => `${x.text} ${x.px}px`).join(", ")}`);
    } finally {
      await cp.context.close();
    }
    const wide = scalePage(shop, "scale_wide");
    expect(cssProblems(wide.css, ON)).toEqual([]); // the grammar alone would let it through
    for (const width of [1440, 1280, 1024]) expect((await widthCodes(browser, wide, width, { css: ON, displayWords: words, facts: shopFactList(shop) })).phaseB, `${width}`).toContain("TYPE_ABOVE_ROLE_CAP");
  });
});
