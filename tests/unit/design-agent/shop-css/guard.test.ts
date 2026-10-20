import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { guardShopCss, isGuardedShopCss, SHOP_CSS_LIMITS } from "@/lib/design-agent/shop-css/guard";

// DEV-072: the static guard of a per-shop stylesheet. Fails closed: each
// forbidden construct, encoding trick and bypass below must be rejected, the
// allowed vocabulary accepted, and the output is always re-serialized.

const rejects = (css: string) => {
  const r = guardShopCss(css);
  expect(r.ok, css).toBe(false);
  return r.ok ? [] : r.problems;
};
const accepts = (css: string) => {
  const r = guardShopCss(css);
  if (!r.ok) throw new Error(`${css}\n→ ${r.problems.join(", ")}`);
  return r.css;
};

const ADVERSARIAL: Array<[string, string]> = [
  // external loads and code
  ["url", "#shop-css { background-image: url(https://evil.example/x.png); }"],
  ["url uppercase", "#shop-css { background-image: URL(x); }"],
  ["url mixed case", "#shop-css { background-image: Url('x'); }"],
  ["url quoted", '#shop-css { background-image: url("x"); }'],
  ["url in gradient", "#shop-css { background-image: linear-gradient(url(x), #fff); }"],
  ["url as custom ident fallback", "#shop-css { color: var(--p-bg, url(x)); }"],
  ["image-set", '#shop-css { background-image: image-set("x.png" 1x); }'],
  ["image()", '#shop-css { background-image: image("x.png"); }'],
  ["element()", "#shop-css { background-image: element(#notice); }"],
  ["cross-fade", "#shop-css { background-image: cross-fade(#fff, #000); }"],
  ["expression", "#shop-css { width: expression(alert(1)); }"],
  ["expression uppercase", "#shop-css { width: EXPRESSION(alert(1)); }"],
  ["javascript: ident", "#shop-css { background-image: javascript:alert(1); }"],
  ["behavior", "#shop-css { behavior: something; }"],
  ["-moz-binding", "#shop-css { -moz-binding: x; }"],
  ["attr()", "#shop-css p::before { content: attr(data-kind); }"],
  ["env()", "#shop-css { padding: env(safe-area-inset-top); }"],
  ["src()", '#shop-css { background-image: src("x"); }'],
  ["unknown function", "#shop-css { width: foo(1px); }"],
  // at-rules
  ["@import", '@import "https://evil.example/x.css";'],
  ["@import url", "@import url(x.css);"],
  ["@IMPORT uppercase", '@IMPORT "x.css";'],
  ["@import inside @media", '@media (min-width: 720px) { @import "x.css"; }'],
  ["@font-face", "@font-face { font-family: x; src: local(Arial); }"],
  ["@charset", '@charset "utf-8";'],
  ["@namespace", "@namespace svg x;"],
  ["@keyframes", "@keyframes spin { from { opacity: 1; } }"],
  ["@page", "@page { margin: 0; }"],
  ["@layer", "@layer base { #shop-css { color: #000; } }"],
  ["@property", "@property --x { syntax: '*'; inherits: false; }"],
  ["@container", "@container (min-width: 1px) { #shop-css p { color: #000; } }"],
  ["@supports", "@supports (display: grid) { #shop-css p { color: #000; } }"],
  ["@document", "@document url-prefix() { #shop-css p { color: #000; } }"],
  ["@media nested", "@media (min-width: 1px) { @media (max-width: 9px) { #shop-css p { color: #000; } } }"],
  ["@media screen", "@media screen { #shop-css p { color: #000; } }"],
  ["@media print", "@media print { #shop-css p { color: #000; } }"],
  ["@media hover", "@media (hover: hover) { #shop-css p { color: #000; } }"],
  ["@media vh", "@media (min-height: 10px) { #shop-css p { color: #000; } }"],
  // escapes, encodings, comment and markup tricks
  ["escaped url", "#shop-css { background-image: u\\72l(x); }"],
  ["escaped hex", "#shop-css { background-image: \\75 rl(x); }"],
  ["escaped property", "#shop-css { pos\\ition: fixed; }"],
  ["escape in string", '#shop-css p::before { content: "\\41"; }'],
  ["closing style", "#shop-css { color: #000; } </style><script>alert(1)</script>"],
  ["closing style in comment", "/* </style><script>alert(1)</script> */ #shop-css { color: #000; }"],
  ["html comment open", "<!-- #shop-css { color: #000; } -->"],
  ["angle in string", '#shop-css p::before { content: "<b>"; }'],
  ["unterminated comment", "#shop-css { color: #000; } /* unterminated"],
  ["unterminated string", '#shop-css p::before { content: "x; }'],
  ["string with newline", '#shop-css p::before { content: "a\nb"; }'],
  ["NUL", "#shop-css { color: #000;\u0000 }"],
  ["control char", "#shop-css { color: #000;\u0008 }"],
  ["fullwidth letters", "#shop-css { ｃｏｌｏｒ: #000; }"],
  ["non-ASCII in value", "#shop-css { font-family: ﾒｲﾘｵ; }"],
  ["non-ASCII in selector", "#shop-css section[aria-labelledby=\"pr-ménu\"] { color: #000; }"],
  ["exponent number", "#shop-css { width: 1e9px; }"],
  ["unbalanced brace", "#shop-css { color: #000; "],
  ["extra closing brace", "#shop-css { color: #000; } }"],
  ["unbalanced paren", "#shop-css { width: calc(1px + 2px; }"],
  ["stray semicolon", "; #shop-css { color: #000; }"],
  ["nested rule", "#shop-css { p { color: #000; } }"],
  ["nesting &", "#shop-css { & p { color: #000; } }"],
  ["!important", "#shop-css p { color: #000 !important; }"],
  ["!IMPORTANT spaced", "#shop-css p { color: #000 ! IMPORTANT; }"],
  ["custom property", "#shop-css { --p-text: #fff; }"],
  ["custom property notice", "#shop-css { --notice-bg: transparent; }"],
  ["var outside palette", "#shop-css { color: var(--notice-ink); }"],
  ["var in length", "#shop-css { width: var(--pad); }"],
  ["css-wide keyword", "#shop-css p { display: revert; }"],
  // selectors: scope, notices, exfiltration
  ["unscoped", "p { color: #000; }"],
  ["unscoped universal", "* { color: #000; }"],
  ["html", "html #shop-css p { color: #000; }"],
  ["notice", '[role="note"] { display: none; }'],
  ["notice from scope sibling", "#shop-css ~ [role=note] { color: #000; }"],
  ["footer sibling", "#shop-css + footer { display: none; }"],
  ["footer descendant", "#shop-css footer { color: #000; }"],
  ["second selector unscoped", "#shop-css p, footer p { color: #000; }"],
  ["other id", "#pr-menu { color: #000; }"],
  ["root twice", "#shop-css #shop-css p { color: #000; }"],
  ["class selector", "#shop-css .x { color: #000; }"],
  ["has()", "#shop-css section:has(p) { color: #000; }"],
  ["is()", "#shop-css :is(p) { color: #000; }"],
  ["where()", "#shop-css :where(p) { color: #000; }"],
  ["visited", "#shop-css a:visited { color: #000; }"],
  ["hover", "#shop-css p:hover { color: #000; }"],
  ["link element", "#shop-css a { color: #000; }"],
  ["img element", "#shop-css img { display: none; }"],
  ["figure element", "#shop-css figure { display: none; }"],
  ["attribute prefix", '#shop-css [data-kind^="m"] { color: #000; }'],
  ["attribute substring", '#shop-css [aria-labelledby*="menu"] { color: #000; }'],
  ["attribute presence", "#shop-css [data-kind] { color: #000; }"],
  ["attribute unknown value", '#shop-css [data-kind="secret"] { color: #000; }'],
  ["attribute unknown name", '#shop-css [value="a"] { background-color: #000; }'],
  ["attribute href", '#shop-css [href="https://secondroot.jp"] { color: #000; }'],
  ["attribute case flag", '#shop-css [data-kind="menu" i] { color: #000; }'],
  ["attribute data-asset", '#shop-css [data-asset="x"] { color: #000; }'],
  ["nested not", "#shop-css p:not(:not(p)) { color: #000; }"],
  ["not with list", "#shop-css p:not(p, li) { color: #000; }"],
  ["first-letter", "#shop-css p::first-letter { color: #000; }"],
  ["single-colon before", '#shop-css p:before { content: ""; }'],
  ["pseudo-element not last", '#shop-css p::before span { content: ""; }'],
  ["pseudo after pseudo-element", '#shop-css p::before:first-child { content: ""; }'],
  ["mixed pseudo rule", '#shop-css p, #shop-css p::before { content: ""; }'],
  ["nth-child big", "#shop-css li:nth-child(1000n) { color: #000; }"],
  ["nth-child of", "#shop-css li:nth-child(2n of p) { color: #000; }"],
  // properties that hide, cover or fake
  ["display none", "#shop-css p { display: none; }"],
  ["display contents", "#shop-css p { display: contents; }"],
  ["visibility", "#shop-css p { visibility: hidden; }"],
  ["content text", '#shop-css p::before { content: "公式サイト"; }'],
  ["content text single quote", "#shop-css p::after { content: 'sale'; }"],
  ["content on element", '#shop-css p { content: ""; }'],
  ["content counter", "#shop-css p::before { content: counter(x); }"],
  ["position fixed", "#shop-css div { position: fixed; inset: 0; }"],
  ["position sticky", "#shop-css div { position: sticky; top: 0; }"],
  ["position absolute", "#shop-css div { position: absolute; top: 0; }"],
  ["huge top", "#shop-css div { position: relative; top: -2000px; }"],
  ["huge z-index", "#shop-css div { position: relative; z-index: 99999; }"],
  ["negative margin", "#shop-css main { margin-top: -200px; }"],
  ["negative margin calc", "#shop-css main { margin-top: calc(0px - 200px); }"],
  ["negative text-indent", "#shop-css p { text-indent: -9999px; }"],
  ["huge width", "#shop-css div { width: 99999px; }"],
  ["huge calc", "#shop-css div { width: calc(4000px * 10); }"],
  ["huge font", "#shop-css h1 { font-size: 9999px; }"],
  ["opacity low", "#shop-css p { opacity: 0.1; }"],
  ["opacity zero", "#shop-css p { opacity: 0; }"],
  ["scale zero", "#shop-css p { transform: scale(0); }"],
  ["translate far", "#shop-css p { transform: translateX(-9999px); }"],
  ["rotate far", "#shop-css p { transform: rotate(180deg); }"],
  ["matrix", "#shop-css p { transform: matrix(0, 0, 0, 0, 0, 0); }"],
  ["clip-path", "#shop-css p { clip-path: inset(50%); }"],
  ["clip", "#shop-css p { clip: rect(0 0 0 0); }"],
  ["mask", "#shop-css p { mask: linear-gradient(#000, #000); }"],
  ["filter", "#shop-css p { filter: opacity(0); }"],
  ["backdrop-filter", "#shop-css p { backdrop-filter: blur(4px); }"],
  ["mix-blend-mode", "#shop-css p { mix-blend-mode: difference; }"],
  ["overflow hidden", "#shop-css p { overflow: hidden; }"],
  ["text-fill transparent", "#shop-css p { -webkit-text-fill-color: transparent; }"],
  ["text-shadow", "#shop-css p { text-shadow: 0 0 9px #000; }"],
  ["line-through", "#shop-css li { text-decoration: line-through; }"],
  ["direction rtl", "#shop-css p { direction: rtl; unicode-bidi: bidi-override; }"],
  ["animation", "#shop-css p { animation: x 1s; }"],
  ["transition", "#shop-css p { transition: color 1s; }"],
  ["pointer-events", "#shop-css p { pointer-events: none; }"],
  ["cursor", "#shop-css p { cursor: url(x), auto; }"],
  ["content-visibility", "#shop-css p { content-visibility: hidden; }"],
  ["background shorthand", "#shop-css p { background: #000; }"],
  ["background-clip text", "#shop-css p { background-clip: text; }"],
  ["font-family name", '#shop-css p { font-family: "Comic Sans MS"; }'],
  ["font-family ident", "#shop-css p { font-family: Arial; }"],
  ["list-style string", '#shop-css li { list-style-type: "★"; }'],
  ["quotes", '#shop-css p { quotes: "a" "b"; }'],
  ["named colour", "#shop-css p { color: red; }"],
  ["bad hex", "#shop-css p { color: #12345; }"],
  ["rgb out of range", "#shop-css p { color: rgb(300, 0, 0); }"],
  ["gradient one stop", "#shop-css p { background-image: linear-gradient(#fff); }"],
  ["line-height tiny", "#shop-css p { line-height: 0.2; }"],
  ["letter-spacing negative", "#shop-css p { letter-spacing: -1em; }"],
  ["pseudo positioned", '#shop-css p::before { content: ""; position: relative; top: 4px; }'],
  ["pseudo placed in grid", '#shop-css p::before { content: ""; grid-area: 1 / 1; }'],
  ["pseudo transform", '#shop-css p::after { content: ""; transform: translateY(-10px); }'],
  // DEV-072 Fresh Review (security) findings
  ["outer box-shadow (Critical 1)", "#shop-css li:first-child { position: relative; box-shadow: 0 16px 0 16px var(--p-bg); }"],
  ["outer box-shadow over the footer (Critical 2)", "#shop-css main { position: relative; z-index: 1; padding-bottom: 0; margin-bottom: 0; box-shadow: 0 16px 0 16px #761D27; }"],
  ["two outer shadows", "#shop-css dl > div:nth-child(3) { position: relative; z-index: 1; box-shadow: 0 16px 0 16px var(--p-bg), 0 16px 0 16px var(--p-bg); }"],
  ["inset and outer shadows mixed", "#shop-css p { box-shadow: inset 0 0 0 1px #000, 0 8px 0 8px #fff; }"],
  ["outline (Medium 2)", "#shop-css dl > div > dt { outline: 4px solid var(--p-bg); outline-offset: 4px; }"],
  ["outline-offset", "#shop-css li { outline-offset: 4px; }"],
  ["font-size 1px (High 1)", "@media (min-width: 400px) and (max-width: 1400px) { #shop-css p, #shop-css dd, #shop-css li, #shop-css span, #shop-css h1 { font-size: 1px; } }"],
  ["font-size 0.1px", "#shop-css p { font-size: 0.1px; }"],
  ["font-size vw alone", "#shop-css p { font-size: 1vw; }"],
  ["font-size calc vw", "#shop-css p { font-size: calc(1vw / 100); }"],
  ["font-size % compounding (Low 2)", "#shop-css section p { font-size: 140%; }"],
  ["font-size em compounding", "#shop-css section p { font-size: 1.4em; }"],
  ["font-size 11px", "#shop-css h2 { font-size: 11px; }"],
  ["font-size clamp below the floor", "#shop-css p { font-size: clamp(4px, 2vw, 40px); }"],
  ["font-size max without a floor", "#shop-css p { font-size: max(1vw, 8px); }"],
  ["font-size min()", "#shop-css p { font-size: min(12px, 1vw); }"],
  ["list-item markers (Medium 1)", "#shop-css dd { display: list-item; list-style-type: decimal; list-style-position: inside; }"],
  ["list-style decimal on li", "#shop-css li { list-style-type: decimal-leading-zero; }"],
  ["list-style-position", "#shop-css li { list-style-position: inside; }"],
  ["::marker", "#shop-css li::marker { color: #000; }"],
  ["hyphens auto", "#shop-css p { hyphens: auto; }"],
  ["text-overflow", '#shop-css p { text-overflow: "…"; }'],
  ["underline as a mask", "#shop-css p { line-height: 1; text-decoration: underline 4px var(--p-bg); text-underline-offset: 8px; }"],
  ["decoration colour", "#shop-css p { text-decoration-color: var(--p-bg); }"],
  ["relative offset swaps values (dd-swap)", "#shop-css dl > div:nth-child(1) dd { position: relative; top: 48px; }"],
  ["inset offset", "#shop-css p { position: relative; inset: 4px; }"],
  ["translate", "#shop-css dd { transform: translateY(48px); }"],
  ["rotate stacked (rotate-far)", "#shop-css dd { transform: rotate(-20deg) rotate(-20deg) rotate(-20deg); transform-origin: 2400px 0; }"],
  ["rotate twice", "#shop-css dd { transform: rotate(5deg) rotate(5deg); }"],
  ["rotate 20deg", "#shop-css dd { transform: rotate(20deg); }"],
  ["transform-origin far", "#shop-css dd { transform: rotate(5deg); transform-origin: 2400px 0; }"],
  ["universal (Low 1)", "#shop-css * { width: 10px; }"],
  ["universal in a chain", "#shop-css section > * { color: #000; }"],
  [":not() alone (Low 1)", "#shop-css :not(p) { color: #000; }"],
  ["attribute alone reaches svg", '#shop-css [aria-hidden="true"] { display: block; }'],
  ["too many breakpoints", "@media (min-width: 400px) { #shop-css p { color: #000; } } @media (min-width: 500px) { #shop-css p { color: #000; } } @media (min-width: 600px) { #shop-css p { color: #000; } } @media (min-width: 700px) and (max-width: 800px) { #shop-css p { color: #000; } }"],
  // DEV-072 security re-review (364df61)
  ["scaleY a neighbour over the values (High 1)", "#shop-css dl > div > dt { transform: scaleY(2); background-color: var(--p-bg); }"],
  ["scaleY(1.6)", "#shop-css dl > div > dt { transform: scaleY(1.6); background-color: var(--p-bg); }"],
  ["scaleX a heading", "#shop-css h2 { transform: scaleX(2); background-color: var(--p-bg); }"],
  ["scale with rotate", "#shop-css dl > div > dt { transform: rotate(8deg) scale(2); background-color: var(--p-bg); }"],
  ["scale down", "#shop-css main { transform: scale(0.75); }"],
  ["two rotations", "#shop-css h2 { transform: rotate(4deg) rotate(4deg); }"],
  ["a band above the checked widths (Medium 1)", "@media (min-width: 2561px) { #shop-css p, #shop-css dd, #shop-css li, #shop-css span, #shop-css h1, #shop-css h2, #shop-css dt { color: var(--p-bg); } }"],
  ["a band below the checked widths", "@media (max-width: 279px) { #shop-css p, #shop-css dd, #shop-css li, #shop-css span, #shop-css h1, #shop-css h2, #shop-css dt { color: var(--p-bg); } }"],
  ["a breakpoint just above 1920px", "@media (min-width: 1921px) { #shop-css p { color: #000; } }"],
  ["a breakpoint just below 320px", "@media (max-width: 319px) { #shop-css p { color: #000; } }"],
  ["a breakpoint in em above 1920px", "@media (min-width: 121em) { #shop-css p { color: #000; } }"],
  ["sideways values (Low 1)", "#shop-css dd { writing-mode: vertical-lr; text-orientation: sideways; }"],
  ["sideways headings", "#shop-css h2, #shop-css h1 { text-orientation: sideways; }"],
  ["vendor prefix", "#shop-css p { -webkit-box-reflect: below; }"],
  ["unknown property", "#shop-css p { zoom: 0.1; }"],
];

describe("guardShopCss rejects (DEV-072)", () => {
  for (const [name, css] of ADVERSARIAL) it(name, () => rejects(css));

  it("reports fixed codes", () => {
    expect(rejects("#shop-css { background-image: URL(x) }")).toEqual(["url"]);
    expect(rejects('@import "x.css";')).toEqual(["at_import"]);
    expect(rejects("#shop-css p { color: #000 !important }")).toEqual(["important"]);
    expect(rejects("#shop-css { pos\\ition: fixed }")).toEqual(["escape"]);
    expect(rejects("#shop-css p { visibility: hidden }")).toEqual(["property_forbidden"]);
    expect(rejects("#shop-css p { display: none }")).toEqual(["value_forbidden:display"]);
    expect(rejects('#shop-css p::before { content: "x" }')).toEqual(["value_forbidden:content"]);
    expect(rejects("p { color: #000 }")).toEqual(["selector_scope"]);
    expect(rejects("#shop-css ~ footer { color: #000 }")).toEqual(["selector_combinator"]);
    expect(rejects('#shop-css [data-kind^="m"] { color: #000 }')).toEqual(["selector_attribute"]);
    expect(rejects("#shop-css p::before { position: relative }")).toEqual(["pseudo_property:position"]);
    expect(rejects("#shop-css * { color: #000 }")).toEqual(["selector_element"]);
    expect(rejects("#shop-css p { box-shadow: 0 4px 0 #000 }")).toEqual(["value_forbidden:box-shadow"]);
    expect(rejects("#shop-css p { font-size: 1px }")).toEqual(["value_forbidden:font-size"]);
    // never the author's words in a code
    expect(rejects("#shop-css p { secret-words-here: 1 }")).toEqual(["property_forbidden"]);
  });

  it("caps size, rules and declarations", () => {
    expect(rejects(`#shop-css p { color: #000; }\n`.repeat(1200))).toEqual(["too_large"]);
    expect(rejects(`#shop-css p{color:#000}`.repeat(SHOP_CSS_LIMITS.rules + 1))).toContain("too_many_rules");
    expect(rejects(`#shop-css p {${"color:#000;".repeat(SHOP_CSS_LIMITS.declarationsPerRule + 1)}}`)).toContain("too_many_declarations");
    expect(rejects(`#shop-css ${"div ".repeat(SHOP_CSS_LIMITS.compoundsPerSelector)}p { color: #000 }`)).toContain("selector_too_long");
    expect(rejects(`#shop-css { width: ${"calc(".repeat(12)}1px${")".repeat(12)} }`).length).toBeGreaterThan(0);
    expect(rejects("")).toEqual(["empty"]);
    expect(rejects("/* only a comment */")).toEqual(["empty"]);
  });

  it("does not throw on garbage", () => {
    for (const css of ["{", "}", "((((", "[[", "@", "#", "::", " ", "#shop-css { color: #000; } @", "@media", "#shop-css", "#shop-css {"]) {
      expect(() => guardShopCss(css)).not.toThrow();
      expect(guardShopCss(css).ok, css).toBe(false);
    }
  });
});

describe("guardShopCss accepts the allowed vocabulary and re-serializes", () => {
  it("normalizes case, whitespace, numbers and comments; never returns the input", () => {
    const input = "/* 喫茶 */ #shop-css P {COLOR:#ABCDEF;Padding:+8PX 0;;}";
    const css = accepts(input);
    expect(css).toBe("#shop-css p {\n  color: #abcdef;\n  padding: 8px 0;\n}");
    expect(css).not.toBe(input);
    // ids are case-sensitive: only the exact scope id is the root
    expect(rejects("#SHOP-CSS p { color: #000 }")).toEqual(["selector_forbidden"]);
  });

  it("output is stable (guard of the output is the output)", () => {
    const css = accepts(`
      #shop-css{color:var(--p-text);background-color:var(--p-bg)}
      #shop-css   section[aria-labelledby=pr-menu]>ol   li:nth-child( 2n + 1 ) { background-color : rgb( 255 250 240 / 0.9 ) }
      @media (MIN-WIDTH:720PX) and (max-width: 1199.98px){#shop-css main{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:24px}}
      #shop-css h2>span:first-child::before{content:'';display:inline-block;width:10px;height:10px;background-color:#d2451e}
    `);
    expect(css).toContain('section[aria-labelledby="pr-menu"] > ol li:nth-child(2n+1)');
    expect(css).toContain("@media (min-width: 720px) and (max-width: 1199.98px)");
    expect(css).toContain('content: "";');
    expect(guardShopCss(css)).toEqual({ ok: true, css });
    expect(isGuardedShopCss(css)).toBe(true);
    expect(isGuardedShopCss(`${css} `)).toBe(false);
  });

  it("accepts the Stage 1 data hooks with their fixed values", () => {
    accepts('#shop-css[data-first-view="vertical_name"] h1 { writing-mode: vertical-rl; }');
    accepts('#shop-css section[data-kind="menu"][data-variant="chips"] li { border-radius: 999px; }');
    accepts('#shop-css section[data-ground="inverted"] { background-color: var(--p-primary); color: var(--p-bg); }');
    accepts('#shop-css div[data-key="closedDays"] dd { font-weight: 700; }');
    accepts('#shop-css li:not([lang="en"]) { font-style: normal; }');
  });

  it("accepts typical design declarations", () => {
    accepts(`#shop-css h1 {
      font-family: var(--font-ja-editorial), var(--serif), serif;
      font-size: clamp(2.5rem, 9vw, 7rem); font-weight: 900; line-height: 1.1; letter-spacing: 0.04em;
      color: color-mix(in srgb, var(--p-primary) 80%, #000);
      transform: rotate(-3deg); transform-origin: left center;
      text-decoration: underline wavy;
    }`);
    accepts(`#shop-css header {
      background-image: repeating-linear-gradient(45deg, #fff 0 8px, #f3e7d3 8px 16px), radial-gradient(circle at top left, #fff, #eee 60%);
      border-bottom: 4px double var(--p-primary); box-shadow: inset 0 -2px 0 #000, inset 0 0 0 2px var(--p-accent);
      padding: 24px clamp(16px, 4vw, 64px); min-height: 60vw; position: relative; z-index: 1;
    }`);
    accepts("#shop-css main { display: grid; grid-template-columns: 1fr minmax(0, 32em) 1fr; } #shop-css main > section { grid-column: 2 / 3; }");
    accepts("#shop-css ol { display: flex; flex-flow: row wrap; gap: 8px 12px; list-style: none; padding: 0; }");
    // breakpoints at the ends of the checked widths, in px and em
    accepts("@media (min-width: 320px) and (max-width: 1920px) { #shop-css p { color: #000; } } @media (min-width: 20em) and (max-width: 120em) { #shop-css li { color: #000; } }");
    accepts("#shop-css h1 { writing-mode: vertical-rl; text-orientation: upright; }");
  });

  it("the example shop stylesheets pass", () => {
    const dir = join(process.cwd(), "tests/unit/design-agent/shop-css/examples");
    const files = readdirSync(dir).filter((f) => f.endsWith(".css"));
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const f of files) accepts(readFileSync(join(dir, f), "utf8"));
  });
});

describe("the Fresh Review's static probes (DEV-072)", () => {
  // Probes the guard lets through as harmless or leaves to the render check
  // (render-check.test.tsx has the harmful ones): never a throw, never a way out.
  const PASSING = [
    '#shop-css::before { content: ""; display:block; height: 2400px }',
    "#shop-css p { color: rgb(0 0 0 / 0.1) }",
    "#shop-css p { color: color-mix(in srgb, transparent, #000 10%) }",
    "#shop-css p { letter-spacing: -1px; word-spacing: 0 }",
    "#shop-css p { color: VAR(--p-bg) }",
    "#shop-css p { text-indent: 200px }",
    "#shop-css p { height: 0 }",
    "#shop-css p { column-count: 4; height: 20px }",
    "#shop-css dt { color: transparent }",
    "#shop-css p::before { content: '' ; display: block; height: 2400px; background-color: #fff }",
    "#shop-css p { order: -10 }",
    "#shop-css p { float: left; width: 2400px }",
    "#shop-css p { white-space: nowrap }",
    "#shop-css p { color: #0000 }",
  ];
  it("what passes is re-serialized and safe", () => {
    for (const css of PASSING) {
      const out = accepts(css);
      expect(out).not.toMatch(/[<\\]|url|!|@import|expression|attr\(|env\(/i);
      expect(out.startsWith("#shop-css")).toBe(true);
    }
  });
});
