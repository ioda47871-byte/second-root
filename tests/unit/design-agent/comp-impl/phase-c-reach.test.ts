import type { Browser, BrowserContext, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { widthRanges } from "@/lib/design-agent/comp-impl/checks";
import { openCompPage } from "@/lib/design-agent/comp-impl/render";
import { APPROVED_CAPABILITIES, CAPABILITY_NAMES } from "@/lib/design-agent/comp-impl/spec";
import { launch } from "./support";
import { rawDoc } from "./nowrap-harness";
import { overlapCodes, overlapScan, overlapSweep, pixelPass, type Opener, type OverlapPlan } from "./overlap-harness";

// DEV-180 (Issue #193 comment 6654178698 B.5): what phase C (layered_decoration, docs/design/phase-c-design.md) must not
// miss before it can be asked for — 1px lines, pseudo-elements, SVG, and ordinary body text, not only protected facts.
// TEST-ONLY, on the DEV-173 prototype (overlap-harness.ts); lib/ is unchanged and nothing is enabled. DEV-173's probes
// held these forms against the protected fact; this file holds the full grid: every thin / generated / SVG form, above
// and below, against the protected fact AND an ordinary paragraph, with the pixel pass agreeing text by text. It also
// pins the three prototype misses DEV-180 found and closed in overlap-harness.ts (protection only):
// - an SVG miter join drew past the box grown by half the stroke width (a sharp vertex reaches miterlimit × half);
// - SVG markers are drawn outside the shape's box and outside isPointInStroke / isPointInFill (now fail closed);
// - ::first-letter / ::first-line restyle text that the ink boxes measure at the element's font (now fail closed).

vi.setConfig({ testTimeout: 900_000, hookTimeout: 300_000 });

let browser: Browser;
let raw: BrowserContext;
let tab: Page;
beforeAll(async () => {
  browser = await launch();
  raw = await browser.newContext({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1, javaScriptEnabled: false });
  await raw.route("**/*", (route) => route.abort());
  tab = await raw.newPage();
});
afterAll(async () => {
  await raw?.close();
  await browser?.close();
});

const BASE = '* { margin: 0; padding: 0; } body { font-family: "IPAGothic", sans-serif; font-size: 20px; line-height: 1.6; color: #1F1D1B; background: #fff; } .wrap { position: relative; padding: 40px; }';
const FACT = "000-0000-0712";
const PLAN: OverlapPlan = { protect: [FACT], ordinary: "plate" };
async function load(body: string, css: string, width = 800) {
  await tab.setViewportSize({ width, height: 600 });
  await tab.setContent(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>${BASE}\n${css}</style></head><body>${body}</body></html>`);
}
const TARGET = { fact: `<p class="f">${FACT}</p>`, ordinary: `<p class="o">線の引き方を相談します</p>` } as const;
type Target = keyof typeof TARGET;
const D = `<div class="d" aria-hidden="true"></div>`;
/** above: z-index 1 over the text; below: z-index -1 in an isolated wrapper (under the text, over the wrapper's ground). */
const z = (above: boolean) => `${above ? "" : ".wrap { isolation: isolate; } "}`;
const zi = (above: boolean) => (above ? 1 : -1);
/** An SVG decoration at the left of the text (its shapes in its own 40×60 user space, 1:1 unless a viewBox scales it). */
const svgAt = (inner: string, extra = "", viewBox = "0 0 40 60") => (t: string, above: boolean): [string, string] => [`<div class="wrap">${t}<svg class="s" viewBox="${viewBox}" width="40" height="60" aria-hidden="true">${inner}</svg></div>`, `${z(above)}.s { position: absolute; z-index: ${zi(above)}; left: 0; top: 23px; overflow: visible; ${extra} }`];
const svgAcross = (inner: string) => (t: string, above: boolean): [string, string] => [`<div class="wrap">${t}<svg class="s" viewBox="0 0 300 40" width="300" height="40" aria-hidden="true">${inner}</svg></div>`, `${z(above)}.s { position: absolute; z-index: ${zi(above)}; left: 40px; top: 36px; }`];
const box = (css: string) => (t: string, above: boolean): [string, string] => [`<div class="wrap">${t}${D}</div>`, `${z(above)}.d { position: absolute; z-index: ${zi(above)}; ${css} }`];
const pseudo = (which: "before" | "after", css: string) => (t: string, above: boolean): [string, string] => [`<div class="wrap">${t}</div>`, `${z(above)}.wrap::${which} { position: absolute; z-index: ${zi(above)}; ${css} }`];

type Form = { name: string; kind: "paint" | "text" | "unproven"; make: (t: string, above: boolean) => [string, string] };
/** Every form reaches the text's glyphs (by a pixel or less where it is thin). kind: paint (a decoration), text (other
 * text, in either order), unproven (the prototype cannot measure it and fails closed). */
const FORMS: Form[] = [
  // 1px lines
  { name: "a 1px horizontal line", kind: "paint", make: box("left: 40px; top: 55px; width: 300px; height: 1px; background: #c79a45;") },
  { name: "a 1px vertical line", kind: "paint", make: box("left: 75px; top: 30px; width: 1px; height: 60px; background: #c79a45;") },
  { name: "a 0.6px line at a fractional position", kind: "paint", make: box("left: 40.3px; top: 55.4px; width: 300px; height: 0.6px; background: #c79a45;") },
  { name: "a 1px line turned 30deg", kind: "paint", make: box("left: 40px; top: 55px; width: 200px; height: 1px; background: #c79a45; transform: rotate(30deg); transform-origin: 0 0;") },
  { name: "a 1px top border on a box of no height (no ground)", kind: "paint", make: box("left: 40px; top: 55px; width: 300px; height: 0; border-top: 1px solid #c79a45;") },
  { name: "a 1px dashed border", kind: "paint", make: box("left: 40px; top: 50px; width: 300px; height: 0; border-top: 1px dashed #c79a45;") },
  // pseudo-elements
  { name: "::before, a 1px line", kind: "paint", make: pseudo("before", 'content: ""; left: 40px; top: 55px; width: 300px; height: 1px; background: #c79a45;') },
  { name: "::after, a 1px border box with no ground", kind: "paint", make: pseudo("after", 'content: ""; left: 60px; top: 46px; width: 60px; height: 14px; border: 1px solid #c79a45;') },
  { name: "::before, a generated glyph", kind: "text", make: pseudo("before", 'content: "※"; left: 60px; top: 40px; color: #c79a45;') },
  // SVG
  { name: "an SVG 1px stroke", kind: "paint", make: svgAcross('<path d="M0 20 L300 20" fill="none" stroke="#c79a45" stroke-width="1"/>') },
  { name: "an SVG 0.5px hairline", kind: "paint", make: svgAcross('<line x1="0" y1="20" x2="300" y2="20" stroke="#c79a45" stroke-width="0.5"/>') },
  { name: "an SVG dashed 1px stroke", kind: "paint", make: svgAcross('<path d="M0 20 L300 20" stroke="#c79a45" stroke-width="1" stroke-dasharray="1 3"/>') },
  { name: "an SVG filled rect", kind: "paint", make: svgAcross('<rect x="20" y="10" width="20" height="14" fill="#c79a45"/>') },
  { name: "an SVG pattern fill", kind: "paint", make: svgAcross('<defs><pattern id="p" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="2" height="2" fill="#c79a45"/></pattern></defs><rect x="20" y="10" width="60" height="14" fill="url(#p)"/>') },
  { name: "an SVG use of a defined shape", kind: "paint", make: svgAcross('<defs><rect id="r" width="20" height="14" fill="#c79a45"/></defs><use href="#r" x="20" y="10"/>') },
  { name: "an SVG path outside its viewBox (overflow visible)", kind: "paint", make: (t, a) => [`<div class="wrap">${t}<svg class="s" viewBox="0 0 300 40" width="300" height="40" aria-hidden="true"><path d="M20 -20 L120 -20" stroke="#c79a45" stroke-width="2"/></svg></div>`, `${z(a)}.s { position: absolute; z-index: ${zi(a)}; left: 40px; top: 76px; overflow: visible; }`] },
  { name: "an SVG square cap reaching in", kind: "paint", make: svgAt('<path d="M0 33 L34 33" stroke="#c79a45" stroke-width="12" stroke-linecap="square" fill="none"/>') },
  { name: "an SVG stroke scaled 4× by its viewBox", kind: "paint", make: svgAt('<path d="M0 8.25 L9.6 8.25" stroke="#c79a45" stroke-width="1" stroke-linecap="square"/>', "", "0 0 10 15") },
  // DEV-180: closed in the prototype (it missed these)
  { name: "an SVG miter join whose tip passes the box grown by half the stroke", kind: "paint", make: svgAt('<polyline points="0,23 30,33 0,43" fill="none" stroke="#c79a45" stroke-width="10" stroke-linejoin="miter" stroke-miterlimit="10"/>') },
  { name: "an SVG marker past the path's end", kind: "unproven", make: svgAt('<defs><marker id="m" viewBox="0 0 14 14" refX="0" refY="7" markerWidth="14" markerHeight="14" orient="auto" markerUnits="userSpaceOnUse"><rect width="14" height="14" fill="#c79a45"/></marker></defs><path d="M0 33 L30 33" stroke="#c79a45" stroke-width="1" fill="none" marker-end="url(#m)"/>') },
  // DEV-180 review M1: the marker check ran after the skips for a shape that paints nothing and for a zero-size box
  { name: "an SVG marker on a path with no stroke and no fill", kind: "unproven", make: svgAt('<defs><marker id="m" viewBox="0 0 14 14" refX="0" refY="7" markerWidth="14" markerHeight="14" orient="auto" markerUnits="userSpaceOnUse"><rect width="14" height="14" fill="#c79a45"/></marker></defs><path d="M0 33 L30 33" stroke="none" fill="none" marker-end="url(#m)"/>') },
  { name: "an SVG marker on a one-point path", kind: "unproven", make: svgAt('<defs><marker id="m" viewBox="0 0 14 14" refX="0" refY="7" markerWidth="14" markerHeight="14" orient="auto" markerUnits="userSpaceOnUse"><rect width="14" height="14" fill="#c79a45"/></marker></defs><path d="M44 33 L44 33" stroke="#c79a45" stroke-width="1" fill="none" marker-start="url(#m)"/>') },
  { name: "an SVG filter offsetting a shape", kind: "unproven", make: svgAt('<defs><filter id="f" x="-1" y="-1" width="3" height="3"><feOffset dx="12" dy="0"/></filter></defs><rect x="24" y="26" width="8" height="12" fill="#c79a45" filter="url(#f)"/>') },
  // SVG text and an image
  { name: "SVG text", kind: "text", make: svgAcross('<text x="20" y="28" font-size="20" fill="#c79a45">装飾</text>') },
  { name: "text in an SVG foreignObject", kind: "text", make: svgAcross('<foreignObject x="10" y="4" width="200" height="30"><div xmlns="http://www.w3.org/1999/xhtml" style="font-size: 20px">装飾の文字</div></foreignObject>') },
  { name: "an image", kind: "paint", make: (t, a) => [`<div class="wrap">${t}<img class="d" alt="" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10'%3E%3Crect width='10' height='10' fill='%23c79a45'/%3E%3C/svg%3E"></div>`, `${z(a)}.d { position: absolute; z-index: ${zi(a)}; left: 60px; top: 46px; width: 40px; height: 14px; }`] },
];

const expected = (f: Form, t: Target, above: boolean): string => {
  const p = t === "fact";
  if (f.kind === "text") return p ? "OVERLAP_PROTECTED_TEXT_ON_TEXT" : "OVERLAP_TEXT_ON_TEXT";
  if (f.kind === "unproven") return p ? "OVERLAP_PROTECTED_ORDER_UNPROVEN" : "OVERLAP_ORDER_UNPROVEN";
  if (above) return p ? "OVERLAP_PAINT_ABOVE_PROTECTED" : "OVERLAP_PAINT_ABOVE_TEXT";
  return p ? "OVERLAP_PROTECTED_ON_DECORATION" : "OVERLAP_TEXT_ON_DECORATION";
};

const GRID = FORMS.flatMap((f) => (["fact", "ordinary"] as const).flatMap((t) => [true, false].map((above) => ({ f, t, above, label: `${f.name} | ${t} | ${above ? "above" : "below"}` }))));

describe("DEV-180 phase C reach: thin, generated and SVG paint over and under the fact and ordinary text", () => {
  const rows: string[] = [];
  afterAll(() => console.log(`DEV-180 reach grid (form | text | order | prototype | pixel)\n${rows.join("\n")}`));

  it("capabilities stay off: APPROVED_CAPABILITIES is empty and no phase C name exists", () => {
    expect(APPROVED_CAPABILITIES).toEqual([]);
    expect(CAPABILITY_NAMES as readonly string[]).not.toContain("layered_decoration");
  });

  it.each(GRID)("fails: $label", async ({ f, t, above }) => {
    const [body, css] = f.make(TARGET[t], above);
    await load(body, css);
    const g = overlapCodes(await overlapScan(tab, PLAN));
    expect(g, `${f.name} ${t}`).toContain(expected(f, t, above));
    // text by text, every cover the pixels see is named by the geometry (pixelPass disagreements)
    await load(body, css);
    const px = await pixelPass(tab, PLAN);
    expect(px.disagreements, `${f.name} ${t} pixels vs geometry`).toEqual([]);
    rows.push(`${f.name} | ${t} | ${above ? "above" : "below"} | ${g.join(",")} | ${Object.keys(px.codes).sort().join(",") || "-"}`);
  });

  it("the same forms clear of the text pass (fact and ordinary): a 1px rule in the leading, an SVG hairline in the gutter, a ::before line beside", async () => {
    const both = `<div class="wrap">${TARGET.fact}${TARGET.ordinary}`;
    const clear: Array<[string, string, string]> = [
      ["a 1px rule between the two lines", `${both}${D}</div>`, ".d { position: absolute; z-index: 1; left: 40px; top: 72px; width: 300px; height: 1px; background: #c79a45; }"],
      ["an SVG hairline below both", `${both}<svg class="s" viewBox="0 0 300 4" width="300" height="4" aria-hidden="true"><path d="M0 2 L300 2" stroke="#c79a45" stroke-width="0.5"/></svg></div>`, ".s { position: absolute; z-index: 1; left: 40px; top: 112px; }"],
      ["a ::before line to the left of both", `${both}</div>`, '.wrap::before { content: ""; position: absolute; z-index: 1; left: 20px; top: 40px; width: 1px; height: 64px; background: #c79a45; }'],
      ["an SVG miter join whose tip stops short", `${both}<svg class="s" viewBox="0 0 40 60" width="40" height="60" aria-hidden="true"><polyline points="-12,23 18,33 -12,43" fill="none" stroke="#c79a45" stroke-width="6" stroke-miterlimit="10"/></svg></div>`, ".s { position: absolute; z-index: 1; left: 0; top: 23px; overflow: visible; }"],
    ];
    for (const [name, body, css] of clear) {
      await load(body, css);
      expect(overlapCodes(await overlapScan(tab, PLAN)), name).toEqual([]);
      await load(body, css);
      expect(Object.keys((await pixelPass(tab, PLAN)).codes).filter((c) => c.startsWith("PIXEL_COVER")), name).toEqual([]);
    }
  });

  it("::first-letter and ::first-line fail closed (the ink boxes are measured at the element's font, not the pseudo-element's)", async () => {
    // an 80px first letter drawn over the next line: before DEV-180 no geometric code at all (only the pixel pass at a
    // checked width saw ink outside the glyph boxes)
    for (const [name, css] of [
      ["::first-letter", ".o::first-letter { font-size: 80px; line-height: 1; } .o { line-height: 20px; height: 20px; }"],
      [":first-letter (one colon)", ".o:first-letter { font-size: 80px; } .o { line-height: 20px; height: 20px; }"],
      ["::first-line", ".o::first-line { font-size: 60px; } .o { line-height: 20px; height: 20px; }"],
      ["::first-letter inside @media", "@media (min-width: 320px) { .o::first-letter { font-size: 80px; } } .o { line-height: 20px; height: 20px; }"],
    ] as const) {
      await load(`<div class="wrap">${TARGET.ordinary}<p class="o2">次の段落の本文です</p></div>`, css);
      expect(overlapCodes(await overlapScan(tab, PLAN)), name).toContain("OVERLAP_PSEUDO_UNPROVEN");
    }
    // ::before / ::after are materialized and measured (not unproven); ::marker stays OVERLAP_MARKER_UNMEASURED
    await load(`<div class="wrap">${TARGET.ordinary}</div>`, '.wrap::before { content: ""; position: absolute; left: 500px; top: 0; width: 4px; height: 4px; background: #c79a45; }');
    expect(overlapCodes(await overlapScan(tab, PLAN))).toEqual([]);
  });

  it("ordinary text printed over ordinary text (the production gap of DEV-173 §10: height: 0) is named by the prototype at every width it happens, between checked widths too", async () => {
    // the paragraph's box is 0 tall from 1100 to 1108px only: the next paragraph prints over it there
    const body = `<div class="wrap"><div class="h"><p class="o">線の引き方を相談します</p></div><p class="o">次の段落の本文です</p></div>`;
    const css = `${BASE} @media (min-width: 1100px) and (max-width: 1108px) { .h { height: 0; } }`;
    const open: Opener = async (b, p, w) => {
      const o = await openCompPage(b, p, { width: w, height: 900, scale: 1, mobile: false });
      return { page: o.page, close: () => o.context.close() };
    };
    const s = await overlapSweep(browser, rawDoc(body, css), PLAN, 1090, 1120, open, "real");
    const hit = s.failing.filter((f) => f.codes.some((c) => c.endsWith(":: OVERLAP_TEXT_ON_TEXT"))).map((f) => f.w);
    console.log(`DEV-180 ordinary overprint 1090–1120: ${widthRanges(hit) || "none"}`);
    expect(hit).toEqual(Array.from({ length: 9 }, (_, i) => 1100 + i));
  });
});
