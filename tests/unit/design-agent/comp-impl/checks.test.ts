import { readFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { parseShop } from "@/lib/design-agent/compare/shops";
import { antiTemplateCheck, fingerprintDistance, ruleBodies } from "@/lib/design-agent/comp-impl/anti-template";
import {
  disclosureCheck,
  factsCheck,
  geometryCheck,
  imagesCheck,
  linksCheck,
  mobileOrderCheck,
  overflowCheck,
  paletteCheck,
  requiredDisclosure,
  spacingCheck,
  textCheck,
  typeCheck,
} from "@/lib/design-agent/comp-impl/checks";
import type { PageAsset } from "@/lib/design-agent/comp-impl/page";
import { cssProblems, htmlSourceProblems, isFlatPng } from "@/lib/design-agent/comp-impl/page";
import type { CompMeasure, Fingerprint } from "@/lib/design-agent/comp-impl/page-scripts";
import { compSimilarity, similarityStatus } from "@/lib/design-agent/comp-impl/similarity";
import type { CompSpec } from "@/lib/design-agent/comp-impl/spec";
import { POC_DISCLOSURE, POC_DISCLOSURE_V2 } from "@/lib/design-agent/design-image/prompt";
import type { Measure } from "@/lib/design-agent/shop-css/page-scripts";
import { FACTS_SOURCE, FIXTURE, flatPng } from "./support";

// DEV-082: each check of the comp implementation, pass and fail, on measured
// data written out here (the Chromium end-to-end test measures real pages).

const spec = JSON.parse(readFileSync(join(FIXTURE, "layout-spec.json"), "utf8")) as CompSpec;
const demo = parseShop(JSON.parse(readFileSync(FACTS_SOURCE, "utf8")) as unknown)!.demo;
const box = (left: number, top: number, width: number, height: number) => ({ left, top, width, height });

/** A measure of a page that follows the synthetic spec at 1440 × 2050. */
function good(): CompMeasure {
  const H = 2050;
  return {
    width: 1440,
    height: H,
    overflow: 0,
    texts: [
      { text: "架空菓庵", shown: true, fontSize: 56 },
      { text: "季節の上生菓子と、毎朝炊く粒あんのどら焼き", shown: true, fontSize: 16 },
      { text: "店舗情報を見る", shown: true, fontSize: 14 },
      { text: "営業時間", shown: true, fontSize: 14 },
      { text: demo.hours!, shown: true, fontSize: 16 },
      { text: demo.closedDays!, shown: true, fontSize: 16 },
      { text: demo.address!, shown: true, fontSize: 16 },
      { text: demo.access!, shown: true, fontSize: 16 },
      { text: demo.phone!, shown: true, fontSize: 16 },
      { text: demo.description!, shown: true, fontSize: 16 },
      { text: POC_DISCLOSURE, shown: true, fontSize: 13 },
    ],
    attrTexts: [{ kind: "title", text: `架空菓庵｜${POC_DISCLOSURE}` }],
    sections: spec.sections.map((s) => ({ id: s.id, shown: true, box: box(s.box.x * 1440, s.box.y * H, s.box.w * 1440, s.box.h * H), paddingTop: s.role === "header" || s.role === "footer" ? 0 : 80, paddingBottom: s.role === "header" || s.role === "footer" ? 0 : 80 })),
    types: [
      { role: "display", fontSize: 56, fontWeight: 400 },
      { role: "heading", fontSize: 32, fontWeight: 400 },
      { role: "caption", fontSize: 18, fontWeight: 400 },
      { role: "body", fontSize: 16, fontWeight: 400 },
      { role: "label", fontSize: 14, fontWeight: 400 },
    ],
    colours: [
      { kind: "ground", rgba: [244, 238, 227, 1], count: 3 },
      { kind: "text", rgba: [31, 29, 27, 1], count: 20 },
      { kind: "border", rgba: [180, 71, 46, 1], count: 4 },
    ],
    links: [
      { text: "商品・こだわり", href: "#products", hasHref: true, target: true, shown: true },
      { text: "店舗情報", href: "#info", hasHref: true, target: true, shown: true },
      { text: "店舗情報を見る", href: "#info", hasHref: true, target: true, shown: true },
    ],
    nav: [
      { text: "商品・こだわり", href: "#products" },
      { text: "店舗情報", href: "#info" },
    ],
    ctas: [{ tag: "a", text: "店舗情報を見る", href: "#info", shown: true }],
    slots: spec.image_slots.map((s) => {
      const w = 300 * s.aspect_w_per_h;
      return { id: s.id, section: s.section, tag: "div", shown: true, box: box(0, 0, w, 300), naturalWidth: 0, naturalHeight: 0, complete: true, objectFit: "fill", placeholder: true, src: "" };
    }),
    imgs: [],
    disclosures: [{ text: POC_DISCLOSURE, shown: true, fontSize: 13, section: "footer" }],
    containers: [{ width: 1200 }],
  };
}
const facts = (m: CompMeasure) => factsCheck(m, { spec, demo, disclosure: POC_DISCLOSURE });
const AI_ASSET: PageAsset = { id: "hero", file: "assets/hero.png", sha256: "a".repeat(64), kind: "ai_concept_local", approval: { approved_by: "owner", approved_at: "2026-10-22T00:00:00+09:00", record_id: "rev-1" }, published: false };

describe("facts", () => {
  it("passes facts, declared fact phrases, fixed labels and the disclosure", () => {
    expect(facts(good())).toMatchObject({ ok: true, codes: [] });
  });
  it.each<[string, (m: CompMeasure) => void, string]>([
    ["an invented price", (m) => m.texts.push({ text: "どら焼き 280円", shown: true, fontSize: 16 }), "FACTS_UNKNOWN_TEXT"],
    ["an invented claim hidden from view", (m) => m.texts.push({ text: "創業百年", shown: false, fontSize: 16 }), "FACTS_UNKNOWN_TEXT"],
    ["a sales word", (m) => m.texts.push({ text: "予約", shown: true, fontSize: 16 }), "FACTS_SALES_WORD"],
    ["a changed phone number", (m) => (m.texts[8]!.text = "052-000-0732"), "FACTS_UNKNOWN_TEXT"],
    ["a required fact missing", (m) => m.texts.splice(8, 1), "FACTS_REQUIRED_MISSING"],
    ["a required fact only in hidden text", (m) => (m.texts[8]!.shown = false), "FACTS_REQUIRED_MISSING"],
    ["an alt text that claims a photo", (m) => m.attrTexts.push({ kind: "alt", text: "当店のどら焼き" }), "FACTS_ALT_NOT_ALLOWED"],
    ["an aria-label outside the labels", (m) => m.attrTexts.push({ kind: "aria", text: "公式サイト" }), "FACTS_ARIA_NOT_ALLOWED"],
    ["a title outside the allowed ones", (m) => (m.attrTexts[0]!.text = "架空菓庵 公式サイト"), "FACTS_TITLE_NOT_ALLOWED"],
  ])("fails %s", (_n, mutate, code) => {
    const m = good();
    mutate(m);
    expect(facts(m).codes).toContain(code);
  });
});

describe("disclosure", () => {
  it("needs the AI disclosure exactly when an AI concept asset is drawn", () => {
    const m = good();
    expect(requiredDisclosure([AI_ASSET], m)).toBe(POC_DISCLOSURE);
    m.imgs.push({ src: "assets/hero.png", inSlot: true });
    expect(requiredDisclosure([AI_ASSET], m)).toBe(POC_DISCLOSURE_V2);
    expect(disclosureCheck(m, spec, POC_DISCLOSURE_V2).codes).toEqual(["DISCLOSURE_SPEC_MISMATCH", "DISCLOSURE_TEXT"]);
    m.disclosures[0]!.text = POC_DISCLOSURE_V2;
    expect(disclosureCheck(m, { ...spec, disclosure: { section: "footer", text: POC_DISCLOSURE_V2 } }, POC_DISCLOSURE_V2).ok).toBe(true);
  });
  it.each<[string, (m: CompMeasure) => void, string]>([
    ["missing", (m) => (m.disclosures = []), "DISCLOSURE_COUNT"],
    ["hidden", (m) => (m.disclosures[0]!.shown = false), "DISCLOSURE_HIDDEN"],
    ["too small", (m) => (m.disclosures[0]!.fontSize = 9), "DISCLOSURE_TOO_SMALL"],
    ["elsewhere than the spec says", (m) => (m.disclosures[0]!.section = "hero"), "DISCLOSURE_PLACEMENT"],
  ])("fails when %s", (_n, mutate, code) => {
    const m = good();
    expect(disclosureCheck(m, spec, POC_DISCLOSURE).ok).toBe(true);
    mutate(m);
    expect(disclosureCheck(m, spec, POC_DISCLOSURE).codes).toContain(code);
  });
});

describe("layout", () => {
  it("passes the spec's own geometry, order, palette, type, spacing, links and slots", () => {
    const m = good();
    for (const r of [geometryCheck(m, spec), mobileOrderCheck(m, spec), paletteCheck(m, spec), typeCheck(m, spec, { desktop: true }), spacingCheck(m, spec), linksCheck(m, spec), imagesCheck(m, spec, [])]) expect(r).toMatchObject({ ok: true, codes: [] });
  });
  it.each<[string, (m: CompMeasure) => void, (m: CompMeasure) => { codes: string[] }, string]>([
    ["sections swapped", (m) => ([m.sections[2]!.box.top, m.sections[3]!.box.top] = [m.sections[3]!.box.top, m.sections[2]!.box.top]), (m) => geometryCheck(m, spec), "SECTION_ORDER"],
    ["a section out of place", (m) => (m.sections[1]!.box.width = 700), (m) => geometryCheck(m, spec), "SECTION_GEOMETRY"],
    ["a section missing", (m) => m.sections.pop(), (m) => geometryCheck(m, spec), "SECTION_MISSING"],
    ["the mobile order changed", (m) => (m.sections[0]!.box.top = 99999), (m) => mobileOrderCheck(m, spec), "MOBILE_ORDER"],
    ["a colour outside the palette", (m) => m.colours.push({ kind: "ground", rgba: [0, 120, 255, 1], count: 1 }), (m) => paletteCheck(m, spec), "PALETTE_OUTSIDE"],
    ["the heading as large as the display", (m) => (m.types[1]!.fontSize = 56), (m) => typeCheck(m, spec, { desktop: true }), "TYPE_HIERARCHY"],
    ["a display size far from the spec", (m) => (m.types[0]!.fontSize = 90), (m) => typeCheck(m, spec, { desktop: true }), "TYPE_SIZE"],
    ["tiny text", (m) => (m.texts[3]!.fontSize = 9), (m) => typeCheck(m, spec, { desktop: false }), "TEXT_TOO_SMALL"],
    ["a cramped section", (m) => (m.sections[2]!.paddingTop = 20), (m) => spacingCheck(m, spec), "SPACING_SECTION_PADDING"],
    ["a dead anchor", (m) => (m.links[0]!.target = false), (m) => linksCheck(m, spec), "LINK_DEAD"],
    ["an external link", (m) => m.links.push({ text: "x", href: "https://example.com", hasHref: true, target: false, shown: true }), (m) => linksCheck(m, spec), "LINK_NOT_ANCHOR"],
    ["a nav that differs", (m) => m.nav.pop(), (m) => linksCheck(m, spec), "NAV_MISMATCH"],
    ["a CTA with other words", (m) => (m.ctas[0]!.text = "詳しく見る"), (m) => linksCheck(m, spec), "CTA_MISMATCH"],
    ["an empty slot", (m) => m.slots.pop(), (m) => imagesCheck(m, spec, []), "SLOT_EMPTY"],
    ["a slot at another aspect", (m) => (m.slots[0]!.box.height = 600), (m) => imagesCheck(m, spec, []), "SLOT_ASPECT"],
    [
      "a stretched image",
      (m) => {
        Object.assign(m.slots[0]!, { tag: "img", placeholder: false, naturalWidth: 1000, naturalHeight: 1000, src: "assets/hero.png" });
        m.imgs.push({ src: "assets/hero.png", inSlot: true });
      },
      (m) => imagesCheck(m, spec, [{ ...AI_ASSET, kind: "placeholder", approval: null }]),
      "IMAGE_DISTORTED",
    ],
    ["an image the asset list does not hold", (m) => m.imgs.push({ src: "assets/other.png", inSlot: false }), (m) => imagesCheck(m, spec, []), "IMAGE_NOT_LISTED"],
  ])("fails %s", (_n, mutate, check, code) => {
    const m = good();
    mutate(m);
    expect(check(m).codes).toContain(code);
  });
});

describe("overflow and text soundness", () => {
  it("fails any width that scrolls sideways", () => {
    expect(overflowCheck([{ width: 320, overflow: 0 }, { width: 1920, overflow: 0 }]).ok).toBe(true);
    expect(overflowCheck([{ width: 320, overflow: 14 }, { width: 1920, overflow: 0 }])).toMatchObject({ ok: false, codes: ["OVERFLOW_HORIZONTAL"], overflowing: [320] });
  });
  const node = (over: Partial<Measure["nodes"][number]> = {}): Measure["nodes"][number] => ({
    kind: "label",
    owner: 0,
    text: "営業時間",
    hidden: false,
    offscreen: false,
    clipped: false,
    covered: false,
    opacity: 1,
    fontSize: 14,
    vertical: false,
    squeezed: false,
    overflow: false,
    color: [0, 0, 0, 1],
    rects: [],
    chars: [box(0, 0, 14, 14)],
    ...over,
  });
  const measure = (nodes: Measure["nodes"]): Measure => ({ scope: true, scripts: 0, overflow: 0, height: 100, present: [], notice: null, footer: null, noticeCovered: false, footerCovered: false, nodes });
  it("uses the shop-CSS render check's measurement and text-on-text test", () => {
    expect(textCheck(measure([node()])).ok).toBe(true);
    expect(textCheck(measure([node({ clipped: true })])).codes).toEqual(["TEXT_CLIPPED"]);
    expect(textCheck(measure([node({ hidden: true })])).ok).toBe(true);
    expect(textCheck(measure([node({ hidden: true, kind: "fact" })])).codes).toEqual(["TEXT_FACT_HIDDEN"]);
    expect(textCheck(measure([node(), node({ owner: 1 })])).codes).toEqual(["TEXT_OVERLAP"]);
    // the notice / footer copies of body text are not counted twice
    expect(textCheck(measure([node(), node({ kind: "footer" })])).ok).toBe(true);
  });
});

describe("page source", () => {
  it("refuses script, handlers, external URLs, inline style and forms", () => {
    expect(htmlSourceProblems(readFileSync(join(FIXTURE, "page/index.html"), "utf8"))).toEqual([]);
    expect(htmlSourceProblems("<script>x</script>")).toContain("HTML_SCRIPT");
    expect(htmlSourceProblems('<img src="a.png" onerror="x">')).toContain("HTML_EVENT_HANDLER");
    expect(htmlSourceProblems('<img src="https://example.com/a.png">')).toContain("HTML_EXTERNAL_URL");
    expect(htmlSourceProblems('<a href="//example.com">')).toContain("HTML_EXTERNAL_URL");
    expect(htmlSourceProblems('<img src="data:image/png;base64,AA">')).toContain("HTML_URL_SCHEME");
    expect(htmlSourceProblems('<p style="color:red">')).toContain("HTML_INLINE_STYLE");
    expect(htmlSourceProblems("<form><input></form>")).toContain("HTML_ELEMENT");
    // bidi controls (re-review of PR #96: an invented phone number drawn from a fact's digits)
    expect(htmlSourceProblems("<dd>\u202e052-000-0731</dd>")).toContain("HTML_BIDI_CONTROL");
    expect(htmlSourceProblems("<dd>&#x202E;052-000-0731</dd>")).toContain("HTML_BIDI_CONTROL");
    expect(htmlSourceProblems("<dd>&#8238;052-000-0731</dd>")).toContain("HTML_BIDI_CONTROL");
    expect(htmlSourceProblems('<dd dir="rtl">052-000-0731</dd>')).toContain("HTML_BIDI_CONTROL");
    expect(htmlSourceProblems("<bdo>052-000-0731</bdo>")).toContain("HTML_BIDI_CONTROL");
  });
  it("accepts the synthetic page's stylesheet under the allowlist", () => {
    expect(cssProblems(readFileSync(join(FIXTURE, "page/style.css"), "utf8"))).toEqual([]);
  });

  it("keeps the shop-CSS tokenizer's refusals", () => {
    expect(cssProblems("a { background: url(https://example.com/x.png); }")).toEqual(["CSS_SYNTAX_URL"]);
    expect(cssProblems('p::after { content: "人気"; }')).toEqual(["CSS_SYNTAX_NON_ASCII"]);
    expect(cssProblems("a { color: #000; } }")).toEqual(["CSS_SYNTAX_UNBALANCED"]);
    expect(cssProblems("a { color: \\72 ed; }")).toEqual(["CSS_SYNTAX_ESCAPE"]);
  });

  // Fresh Review of PR #96 (9daac92 and b94c61b): every probe the reviewers used, one by one.
  // The stylesheet is now an allowlist (page-css.ts): anything not listed is refused.
  it.each<[string, string, string]>([
    // strings and drawn text
    ["list-style with a string marker", 'li { display: list-item; list-style: "SALE 50% OFF" inside; }', "CSS_VALUE"],
    ["list-style-type with a string", 'li { list-style-type: "$9.80"; }', "CSS_VALUE"],
    ["list-style other than none", "ul { list-style: disc; }", "CSS_VALUE"],
    ["list-style-type decimal", "ol { list-style-type: decimal; }", "CSS_VALUE"],
    ["display: list-item", "li { display: list-item; }", "CSS_VALUE"],
    ["quotes", 'q { quotes: "BEST" "SELLER"; }', "CSS_PROPERTY"],
    ["hyphenate-character", 'p { hyphenate-character: "$9.80"; }', "CSS_PROPERTY"],
    ["text-overflow", 'p { text-overflow: " - 50% OFF"; }', "CSS_PROPERTY"],
    ["content", 'p { content: "x"; }', "CSS_PROPERTY"],
    ["counter-reset (shifts list numbers)", "ol { counter-reset: list-item 279; }", "CSS_PROPERTY"],
    ["counter-set", "li { counter-set: list-item 280; }", "CSS_PROPERTY"],
    ["counter-increment", "li { counter-increment: list-item 100; }", "CSS_PROPERTY"],
    ["-webkit-text-security", "dd { -webkit-text-security: disc; }", "CSS_PROPERTY"],
    ["@counter-style", "@counter-style price { system: cyclic; }", "CSS_AT_RULE"],
    ["@import", '@import "x.css";', "CSS_AT_RULE"],
    ["@font-face", "@font-face { font-family: x; }", "CSS_AT_RULE"],
    // every pseudo-element, both spellings
    ["::first-letter", "p::first-letter { font-size: 12px; }", "CSS_PSEUDO_ELEMENT"],
    [":first-letter (legacy)", "p:first-letter { font-size: 12px; }", "CSS_PSEUDO_ELEMENT"],
    ["::first-line", "p::first-line { color: transparent; }", "CSS_PSEUDO_ELEMENT"],
    ["::marker", "li::marker { color: #000; }", "CSS_PSEUDO_ELEMENT"],
    ["::selection", "p::selection { color: #000; }", "CSS_PSEUDO_ELEMENT"],
    ["::before", "p::before { color: #000; }", "CSS_PSEUDO_ELEMENT"],
    ["::after", "p::after { color: #000; }", "CSS_PSEUDO_ELEMENT"],
    [":before (legacy)", "p:before { color: #000; }", "CSS_PSEUDO_ELEMENT"],
    // bidi and mirroring
    ["unicode-bidi", "dd { unicode-bidi: bidi-override; }", "CSS_PROPERTY"],
    ["direction", "dd { direction: rtl; }", "CSS_PROPERTY"],
    ["scaleX(-1)", "dd { transform: scaleX(-1); }", "CSS_VALUE"],
    ["scale(-1, 1)", "dd { transform: scale(-1, 1); }", "CSS_VALUE"],
    ["rotate(180deg)", "dd { transform: rotate(180deg); }", "CSS_VALUE"],
    ["translate", "dd { transform: translateX(-9999px); }", "CSS_VALUE"],
    // decoration, shadow, stroke, spacing
    ["text-decoration line-through", "dd { text-decoration: line-through; }", "CSS_VALUE"],
    ["text-decoration overline", "dd { text-decoration: overline; }", "CSS_VALUE"],
    ["text-decoration-thickness", "dd { text-decoration-thickness: 20px; }", "CSS_PROPERTY"],
    ["text-decoration-style", "dd { text-decoration-style: wavy; }", "CSS_PROPERTY"],
    ["text-decoration-color", "dd { text-decoration-color: #000; }", "CSS_PROPERTY"],
    ["text-underline-offset", "dd { text-underline-offset: -10px; }", "CSS_PROPERTY"],
    ["text-shadow", "dd { text-shadow: 1px 0 #000, -1px 0 #000; }", "CSS_PROPERTY"],
    ["-webkit-text-stroke", "dd { -webkit-text-stroke: 4px #000; }", "CSS_PROPERTY"],
    ["-webkit-text-fill-color", "dd { -webkit-text-fill-color: transparent; }", "CSS_PROPERTY"],
    ["negative letter-spacing", "dd { letter-spacing: -0.5em; }", "CSS_VALUE"],
    ["negative letter-spacing in px", "dd { letter-spacing: -1px; }", "CSS_VALUE"],
    // filters, blending, clipping, hiding
    ["filter on an image", "img { filter: contrast(10); }", "CSS_PROPERTY"],
    ["backdrop-filter", "div { backdrop-filter: blur(4px); }", "CSS_PROPERTY"],
    ["mix-blend-mode", "dd { mix-blend-mode: difference; }", "CSS_PROPERTY"],
    ["clip-path", "dd { clip-path: inset(50%); }", "CSS_PROPERTY"],
    ["mask-image", "dd { mask-image: linear-gradient(#000, transparent); }", "CSS_PROPERTY"],
    ["zoom", "dd { zoom: 0.1; }", "CSS_PROPERTY"],
    ["visibility", "dd { visibility: hidden; }", "CSS_PROPERTY"],
    ["display: none", "dd { display: none; }", "CSS_VALUE"],
    ["overflow: hidden", "dd { overflow: hidden; }", "CSS_PROPERTY"],
    ["low opacity", "dd { opacity: 0.05; }", "CSS_VALUE"],
    ["position: absolute", "dd { position: absolute; }", "CSS_VALUE"],
    ["an offset", "dd { left: -9999px; }", "CSS_PROPERTY"],
    ["a tiny font size", "dd { font-size: 1px; }", "CSS_VALUE"],
    ["a background image or gradient", "dd { background: linear-gradient(#000, #fff); }", "CSS_VALUE"],
    ["order (visual reordering)", "li { order: -1; }", "CSS_PROPERTY"],
    ["a reversed flex direction", "ul { flex-direction: row-reverse; }", "CSS_VALUE"],
    ["a grid line number (moves a label beside another value)", "dt { grid-row: 1; grid-column: 2; }", "CSS_VALUE"],
    ["a grid line range", "dt { grid-column: 1 / 3; }", "CSS_VALUE"],
    ["dense grid packing", "dl { grid-auto-flow: dense; }", "CSS_VALUE"],
    ["a large text-indent", "p { text-indent: 200px; }", "CSS_VALUE"],
    ["!important", "dd { color: #000 !important; }", "CSS_IMPORTANT"],
    ["a custom property", "dd { --x: 1px; }", "CSS_PROPERTY"],
    // media: width only, 320 … 1920
    ["@media scripting", "@media (scripting: none) { dd { color: #000; } }", "CSS_MEDIA"],
    ["@media prefers-reduced-motion", "@media (prefers-reduced-motion: reduce) { dd { color: #000; } }", "CSS_MEDIA"],
    ["@media prefers-color-scheme", "@media (prefers-color-scheme: dark) { dd { color: #000; } }", "CSS_MEDIA"],
    ["@media print", "@media print { dd { color: #000; } }", "CSS_MEDIA"],
    ["@media screen and", "@media screen and (min-width: 400px) { dd { color: #000; } }", "CSS_MEDIA"],
    ["@media orientation", "@media (orientation: portrait) { dd { color: #000; } }", "CSS_MEDIA"],
    ["@media below 320px", "@media (max-width: 300px) { dd { color: #000; } }", "CSS_MEDIA"],
    ["@media above 1920px", "@media (min-width: 2000px) { dd { color: #000; } }", "CSS_MEDIA"],
    ["@media in em", "@media (min-width: 40em) { dd { color: #000; } }", "CSS_MEDIA"],
    ["nested @media", "@media (min-width: 400px) { @media (min-width: 500px) { dd { color: #000; } } }", "CSS_MEDIA_NESTED"],
    ["@supports", "@supports (display: grid) { dd { color: #000; } }", "CSS_AT_RULE"],
    // selectors
    ["an attribute selector", 'a[href="#info"] { color: #000; }', "CSS_SELECTOR"],
    [":hover", "a:hover { color: #000; }", "CSS_SELECTOR"],
    [":not()", "p:not(.x) { color: #000; }", "CSS_SELECTOR"],
    [":has()", "p:has(a) { color: #000; }", "CSS_SELECTOR"],
    ["a sibling combinator", "p + p { color: #000; }", "CSS_SELECTOR"],
    ["an element outside the page's list", "svg { color: #000; }", "CSS_SELECTOR"],
    // fonts: a face outside the list (a symbol font could draw a fact's digits as other glyphs)
    ["an unknown font family", 'dd { font-family: "Wingdings", serif; }', "CSS_VALUE"],
    ["a monospace / fantasy generic family", "dd { font-family: fantasy; }", "CSS_VALUE"],
    ["an unquoted multi-word family", "dd { font-family: Noto Serif JP, serif; }", "CSS_VALUE"],
  ])("refuses %s", (_n, css, code) => {
    expect(cssProblems(css)).toContain(code);
  });

  it("allows a page's ordinary vocabulary", () => {
    for (const css of [
      'body { font-family: "Noto Serif JP", IPAMincho, "Hiragino Mincho ProN", serif; }',
      "main > section .card:first-child h2 { color: #1f1d1b; }",
      "li:nth-child(2n+1) { background: #eae1d2; }",
      ".g { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 32px; }",
      "img { width: 100%; aspect-ratio: 3 / 2; object-fit: cover; border-radius: 4px; }",
      "@media (min-width: 760px) and (max-width: 1200px) { .g { grid-template-columns: 1fr; } }",
      "a { text-decoration: underline; letter-spacing: 0.1em; } ul { list-style: none; }",
      "#hero { padding: 80px 0; transform: rotate(-2deg); opacity: 0.9; }",
      ".wide { grid-column: span 2; grid-row: auto; } p { text-indent: 1em; }",
    ])
      expect(cssProblems(css), css).toEqual([]);
  });
});

describe("anti-template", () => {
  const fp = (blocks: string[], features: Record<string, number>): Fingerprint => ({ blocks, features });
  const a = fp(["header(div)", "section(h,p)"], { "p:body>header": 1, "p:body>section": 1 });
  const b = fp(["nav(ul)", "main(section,section)", "footer(p)"], { "p:body>nav": 1, "p:body>main": 1 });
  it("measures a distance of 0 for the same structure and 1 for nothing in common", () => {
    expect(fingerprintDistance(a, a)).toBe(0);
    expect(fingerprintDistance(a, b)).toBe(1);
  });
  const templateCss = [".hero_wrapper { display: grid; gap: 24px; padding: 40px; } .x { color: red; }"];
  const ok = { html: '<body class="lead"></body>', css: ".lead { margin: 0; }", fingerprint: b, references: [{ id: "template:x", fingerprint: a }], templateCss };
  it("passes a page that is far from every reference and reuses nothing", () => {
    expect(antiTemplateCheck(ok)).toMatchObject({ ok: true, codes: [], nearest: "template:x", min_distance: 1 });
  });
  it.each<[string, Partial<typeof ok>, string]>([
    ["a structure too close to a template", { fingerprint: a }, "TEMPLATE_STRUCTURE_TOO_CLOSE"],
    ["the renderer's hooks", { html: '<div id="shop-css" data-kind="menu"></div>' }, "TEMPLATE_RENDERER_MARKER"],
    ["the renderer's selectors", { css: "#shop-css section { color: red; }" }, "TEMPLATE_RENDERER_MARKER"],
    ["a template class name", { html: '<div class="hero_wrapper"></div>' }, "TEMPLATE_CLASS_NAME"],
    ["copied rule bodies", { css: ".mine { padding: 40px;  gap: 24px; display: grid }" }, "TEMPLATE_CSS_REUSE"],
    ["no references at all", { references: [] }, "TEMPLATE_NO_REFERENCES"],
  ])("fails %s", (_n, change, code) => {
    expect(antiTemplateCheck({ ...ok, ...change }).codes).toContain(code);
  });
  it("normalizes rule bodies (order, case, spacing) and skips short generic ones", () => {
    expect(ruleBodies(".a { Gap: 24px; display:grid; padding: 40px } .b { margin: 0 }")).toEqual(["display:grid;gap: 24px;padding: 40px"]);
  });
});

describe("comp similarity", () => {
  const png = flatPng(720, 1024, [244, 238, 227]);
  it("is reported but never passes, and a synthetic comp is always synthetic_only", () => {
    const s = compSimilarity({ bytes: png, width: 720, height: 1024, kind: "synthetic" }, false, { bytes: png, width: 720, height: 1024 });
    expect(s).toMatchObject({ status: "synthetic_only", passing: false, ssim: 1, colour_blocks: 1 });
  });
  it("even an approved real comp needs a person; an unapproved one is no_real_comp", () => {
    expect(similarityStatus("real", true)).toBe("real_comp_human_review_required");
    expect(similarityStatus("real", false)).toBe("no_real_comp");
    expect(similarityStatus("synthetic", true)).toBe("synthetic_only");
    const s = compSimilarity({ bytes: png, width: 720, height: 1024, kind: "real" }, true, { bytes: flatPng(720, 1024, [10, 10, 10]), width: 720, height: 1024 });
    expect(s.passing).toBe(false);
    expect(s.colour_blocks!).toBeLessThan(0.5);
  });
  it("reports an undecodable image instead of guessing", () => {
    const s = compSimilarity({ bytes: Buffer.from("not a png"), width: 720, height: 1024, kind: "synthetic" }, false, { bytes: png, width: 720, height: 1024 });
    expect(s).toMatchObject({ code: "SIMILARITY_DECODE_UNSUPPORTED", passing: false, ssim: null });
  });
});

describe("placeholder images", () => {
  it("a placeholder must be one flat colour; anything else (text, a photo, a gradient) is not", () => {
    expect(isFlatPng(flatPng(40, 30, [234, 225, 210]))).toBe(true);
    const marked = flatPng(40, 30, [234, 225, 210]);
    // a placeholder with one dark pixel in it (a drawn mark) is no longer flat
    const idatAt = marked.indexOf(Buffer.from("IDAT"));
    const len = marked.readUInt32BE(idatAt - 4);
    const raw = inflateSync(marked.subarray(idatAt + 4, idatAt + 4 + len));
    raw[1 + 3 * 20] = 0;
    const data = deflateSync(raw);
    const chunk = Buffer.alloc(12 + data.length);
    chunk.writeUInt32BE(data.length, 0);
    chunk.write("IDAT", 4, "latin1");
    data.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(Buffer.concat([Buffer.from("IDAT"), data])) >>> 0, 8 + data.length);
    const changed = Buffer.concat([marked.subarray(0, idatAt - 4), chunk, marked.subarray(idatAt + 8 + len)]);
    expect(isFlatPng(changed)).toBe(false);
    // re-review: one level is enough (text in near-identical pixels could be revealed by a filter elsewhere)
    raw[1 + 3 * 20] = 233;
    const data1 = deflateSync(raw);
    const chunk1 = Buffer.alloc(12 + data1.length);
    chunk1.writeUInt32BE(data1.length, 0);
    chunk1.write("IDAT", 4, "latin1");
    data1.copy(chunk1, 8);
    chunk1.writeUInt32BE(crc32(Buffer.concat([Buffer.from("IDAT"), data1])) >>> 0, 8 + data1.length);
    expect(isFlatPng(Buffer.concat([marked.subarray(0, idatAt - 4), chunk1, marked.subarray(idatAt + 8 + len)]))).toBe(false);
    expect(isFlatPng(Buffer.from("not a png"))).toBe(false);
  });
});
