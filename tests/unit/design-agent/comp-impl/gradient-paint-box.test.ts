import type { Browser, BrowserContext, Page } from "playwright";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cssProblems } from "@/lib/design-agent/comp-impl/page";
import type { PageCssOptions } from "@/lib/design-agent/comp-impl/page-css";
import { DISPLAY_SWEEP_SCRIPT, PAINT_SCANNER, PHASE_B_SCRIPT, phaseBCodes } from "@/lib/design-agent/comp-impl/phase-b";
import { displaySweepPass, openCompPage, phaseBScan } from "@/lib/design-agent/comp-impl/render";
import { APPROVED_CAPABILITIES } from "@/lib/design-agent/comp-impl/spec";
import { launch } from "./support";
import { gradPage } from "./gradient-harness";
import { NOWRAP_WIDTHS, rawDoc } from "./nowrap-harness";
import { CANDIDATE_PHASE_B_SCRIPT, CANDIDATE_SWEEP_SCRIPT, candidateScan, candidateSweep, PAINT_BOX_FROM, PAINT_BOX_TO, withPaintBox } from "./gradient-box-harness";

// DEV-180 (Issue #193 comment 6654178698 B.5): closing the gradient measuring-box gap (DEV-172 Fresh Review M1) before
// gradient_ground can be asked for. TEST-ONLY: the candidate is the production paint scanner with one patch
// (gradient-box-harness.ts); lib/ is unchanged on this branch and APPROVED_CAPABILITIES stays empty. These tests hold:
// 1. the patch only adds: the candidate's codes are the production codes plus GRADIENT_PAINT_BOX, and a stop code where
//    the padding box is shorter than the border box;
// 2. every reproduction of M1 (DEV-172's four and new ones) passes the grammar, scans [] in production, draws far more
//    than 2 levels per px — and fails the candidate;
// 3. what the candidate passes is drawn as the rule says: on 48 seeded boxes (borders of every style, widths, directions,
//    inline and block), wherever the candidate passes, the drawn padding box steps at most 3 levels per px and every
//    border band is its own flat colour (no repeat shows);
// 4. the three shops' gradient pages (DEV-172 grad / grad_eased): the candidate adds no code at any width of 320–1920.

vi.setConfig({ testTimeout: 900_000, hookTimeout: 300_000 });

const ON: PageCssOptions = { gradientGround: true };

let browser: Browser;
let raw: BrowserContext;
let tab: Page;
beforeAll(async () => {
  browser = await launch();
  raw = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await raw.route("**/*", (route) => route.abort());
  tab = await raw.newPage();
});
afterAll(async () => {
  await raw?.close();
  await browser?.close();
});

const BASE = 'body { margin: 0; background: #fff; font-family: "IPAGothic", sans-serif; font-size: 16px; line-height: 1.5; color: #1F1D1B; }';
async function load(body: string, css: string, width = 1440) {
  await tab.setViewportSize({ width, height: 900 });
  await tab.setContent(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>${BASE}\n${css}</style></head><body>${body}<p style="margin-top: 400px">文字</p></body></html>`);
}
const prod = async () => phaseBCodes(await phaseBScan(tab, { css: ON, displayWords: [] }));

/** The drawn ground of `.g`: the largest step between neighbouring pixels inside its padding box (along both axes, every
 * fragment), and whether every border band is one flat colour. Read from a screenshot of the page. */
async function drawn(): Promise<{ jump: number; bandsFlat: boolean; frags: number }> {
  const r = (await tab.evaluate(`(() => {
    const e = document.querySelector(".g");
    const s = getComputedStyle(e);
    const bw = ["Top", "Right", "Bottom", "Left"].map((k) => parseFloat(s["border" + k + "Width"]) || 0);
    return { rects: Array.from(e.getClientRects()).map((x) => ({ l: x.left, t: x.top, r: x.right, b: x.bottom })), bw };
  })()`)) as { rects: Array<{ l: number; t: number; r: number; b: number }>; bw: number[] };
  const shot = await tab.screenshot({ fullPage: false });
  const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
  const px = (x: number, y: number) => [0, 1, 2].map((c) => data[(y * info.width + x) * info.channels + c]!);
  let jump = 0;
  let bandsFlat = true;
  const [bt, br, bb, bl] = r.bw as [number, number, number, number];
  for (const q of r.rects) {
    // the padding box, shrunk by 1px at each edge (antialiasing where the box meets the border or the page)
    const x0 = Math.ceil(q.l + bl) + 1, x1 = Math.floor(q.r - br) - 2, y0 = Math.ceil(q.t + bt) + 1, y1 = Math.floor(q.b - bb) - 2;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const p = px(x, y);
        if (x < x1) jump = Math.max(jump, ...px(x + 1, y).map((v, c) => Math.abs(v - p[c]!)));
        if (y < y1) jump = Math.max(jump, ...px(x, y + 1).map((v, c) => Math.abs(v - p[c]!)));
      }
    // each border band (inside by 1px from its edges): one colour
    const bands: Array<[number, number, number, number]> = [];
    if (bt >= 3) bands.push([Math.ceil(q.l) + 1, Math.floor(q.r) - 2, Math.ceil(q.t) + 1, Math.floor(q.t + bt) - 2]);
    if (bb >= 3) bands.push([Math.ceil(q.l) + 1, Math.floor(q.r) - 2, Math.ceil(q.b - bb) + 1, Math.floor(q.b) - 2]);
    if (bl >= 3) bands.push([Math.ceil(q.l) + 1, Math.floor(q.l + bl) - 2, Math.ceil(q.t) + 1, Math.floor(q.b) - 2]);
    if (br >= 3) bands.push([Math.ceil(q.r - br) + 1, Math.floor(q.r) - 2, Math.ceil(q.t) + 1, Math.floor(q.b) - 2]);
    for (const [a, b, c, d] of bands) {
      if (a > b || c > d) continue;
      const first = px(a, c);
      for (let y = c; y <= d; y++) for (let x = a; x <= b; x++) if (px(x, y).some((v, k) => Math.abs(v - first[k]!) > 1)) bandsFlat = false;
    }
  }
  return { jump, bandsFlat, frags: r.rects.length };
}

describe("DEV-180 the candidate is the production scanner plus protection only", () => {
  it("capabilities stay off on this branch: APPROVED_CAPABILITIES is empty", () => {
    expect(APPROVED_CAPABILITIES).toEqual([]);
  });

  it("the patch replaces one block, once, in each script that inlines the scanner; nothing else differs", () => {
    for (const src of [PAINT_SCANNER, PHASE_B_SCRIPT, DISPLAY_SWEEP_SCRIPT]) expect(src.split(PAINT_BOX_FROM).length - 1).toBe(1);
    expect(CANDIDATE_PHASE_B_SCRIPT.replace(PAINT_BOX_TO, PAINT_BOX_FROM)).toBe(PHASE_B_SCRIPT);
    expect(CANDIDATE_SWEEP_SCRIPT.replace(PAINT_BOX_TO, PAINT_BOX_FROM)).toBe(DISPLAY_SWEEP_SCRIPT);
    expect(() => withPaintBox("nothing")).toThrow();
    // the replacement keeps every line of the original (only adds lines and narrows the measured box)
    const kept = PAINT_BOX_FROM.split("\n").filter((l) => !l.includes("parseGradient(g, box)"));
    for (const l of kept) expect(PAINT_BOX_TO).toContain(l);
    expect(PAINT_BOX_TO).toContain("parseGradient(g, inner)");
  });
});

/** Reproductions of the measuring-box gap: each passes the grammar, scans [] (or less) in production, is drawn with steps
 * far above 2 levels per px, and must fail the candidate. */
const GAPS: Array<{ name: string; body: string; css: string; expect: string[] }> = [
  // DEV-172's four (gradient-ground.test.ts "known gap before ON (Fresh Review M1)")
  { name: "M1-1 transparent borders 16px (the rule saw 62px)", body: '<div class="g"></div>', css: ".g { width: 40px; height: 30px; border-top: 16px solid transparent; border-bottom: 16px solid transparent; background: linear-gradient(#202020, #848484); }", expect: ["GRADIENT_PAINT_BOX", "GRADIENT_TOO_STEEP"] },
  { name: "M1-2 black to white, 100px + transparent borders (hard edge where the tile repeats)", body: '<div class="g"></div>', css: ".g { width: 40px; height: 100px; border-top: 16px solid transparent; border-bottom: 16px solid transparent; background: linear-gradient(#000, #fff); }", expect: ["GRADIENT_PAINT_BOX", "GRADIENT_TOO_STEEP"] },
  { name: "M1-3 1em borders under a 256px font (the grammar reads 16px; drawn 256px, ~17 repeats)", body: '<div class="g"></div>', css: ".g { width: 40px; font-size: 256px; height: 30px; border-top: 1em solid transparent; border-bottom: 1em solid transparent; background: linear-gradient(#000, #fff); }", expect: ["GRADIENT_PAINT_BOX", "GRADIENT_TOO_STEEP"] },
  { name: "M1-4 an empty inline span wrapping over three lines (one gradient per fragment)", body: `<p class="p"><span class="g">${'<img alt="">'.repeat(6)}</span></p>`, css: ".p { width: 150px; margin: 0; line-height: 1; font-size: 16px; } .p img { width: 60px; height: 30px; } .g { background: linear-gradient(#303030, #a0a0a0); }", expect: ["GRADIENT_PAINT_BOX"] },
  // DEV-180: more forms of the same gap
  { name: "a transparent left border only, horizontal gradient", body: '<div class="g"></div>', css: ".g { width: 140px; height: 20px; border-left: 16px solid transparent; background: linear-gradient(to right, #000, #fff); }", expect: ["GRADIENT_PAINT_BOX"] },
  { name: "an opaque dashed border (the repeat shows in the gaps)", body: '<div class="g"></div>', css: ".g { width: 60px; height: 130px; border: 12px dashed #000; background: linear-gradient(#fff, #000); }", expect: ["GRADIENT_PAINT_BOX"] },
  { name: "an opaque double border (the repeat shows between the lines)", body: '<div class="g"></div>', css: ".g { width: 60px; height: 130px; border: 15px double #000; background: linear-gradient(#fff, #000); }", expect: ["GRADIENT_PAINT_BOX"] },
  { name: "a half-transparent solid border", body: '<div class="g"></div>', css: ".g { width: 60px; height: 130px; border: 16px solid rgba(0, 0, 0, 0.5); background: linear-gradient(#fff, #000); }", expect: ["GRADIENT_PAINT_BOX"] },
  { name: "an opaque dotted top border (the repeat shows between the dots)", body: '<div class="g"></div>', css: ".g { width: 60px; height: 128px; border-top: 12px dotted #000; background: linear-gradient(#000, #fff); }", expect: ["GRADIENT_PAINT_BOX"] },
  { name: "opaque solid borders: no repeat shows, but the gradient is drawn over the 30px padding box, not the 62px border box", body: '<div class="g"></div>', css: ".g { width: 40px; height: 30px; border-top: 16px solid #000; border-bottom: 16px solid #000; background: linear-gradient(#202020, #848484); }", expect: ["GRADIENT_TOO_STEEP"] },
];

describe("DEV-180 the measuring-box gap (M1) is closed by the candidate", () => {
  it.each(GAPS)("fails: $name", async (g) => {
    const css = `${g.css}`;
    expect(cssProblems(css, ON), "allowlisted with gradient_ground").toEqual([]);
    await load(g.body, css);
    const before = await prod();
    const d = await drawn();
    const after = await candidateScan(tab);
    console.log(`DEV-180 M1 | ${g.name} | production ${before.join(",") || "[]"} | candidate ${after.join(",")} | drawn step ${d.jump}/px, bands flat ${d.bandsFlat}, fragments ${d.frags}`);
    // production passes the gradient's own smoothness (it may fail only for an unrelated reason: none here)
    expect(before.filter((c) => c.startsWith("GRADIENT_")), "production scan").toEqual([]);
    // what is drawn breaks the rule's promise: a step above 2 levels per px inside the padding box, or a repeat in a band
    expect(d.jump > 3 || !d.bandsFlat || d.frags > 1, "drawn").toBe(true);
    for (const c of g.expect) expect(after, g.name).toContain(c);
  });

  it("a box that fragments only at some widths: the candidate's 1px sweep fails exactly the widths where it has more than one client rect", async () => {
    // an inline ground of four 60px images in a paragraph 45% of the page wide: one line from 534px, two or more below
    const body = `<p class="p"><span class="g">${'<img alt="">'.repeat(4)}</span></p><p>文字</p>`;
    const css = `${BASE} .p { width: 45%; margin: 0; line-height: 1; } img { width: 60px; height: 30px; } .g { background: linear-gradient(to right, #303030, #383838); }`;
    expect(cssProblems(css, ON)).toEqual([]);
    const page = rawDoc(body, css);
    const got = (await candidateSweep(browser, page, 320, 700)).filter((f) => f.codes.includes("GRADIENT_PAINT_BOX")).map((f) => f.w);
    // the oracle: count the client rects at every width, independently
    const o = await openCompPage(browser, page, { width: 320, height: 900, scale: 1, mobile: false });
    const want: number[] = [];
    try {
      for (let w = 320; w <= 700; w++) {
        await o.page.setViewportSize({ width: w, height: 900 });
        if (((await o.page.evaluate(`document.querySelector(".g").getClientRects().length`)) as number) > 1) want.push(w);
      }
    } finally {
      await o.context.close();
    }
    expect(want.length).toBeGreaterThan(0);
    expect(want.length).toBeLessThan(381);
    expect(got).toEqual(want);
    // production: no gradient code at any width (it measures the union of the fragments, which is wide enough)
    const s = (await displaySweepPass(browser, page, { css: ON, displayWords: [] }, { range: [320, 700] }))!;
    expect(s.failing.flatMap((f) => f.codes).filter((c) => c.startsWith("GRADIENT_"))).toEqual([]);
    console.log(`DEV-180 fragmenting inline: candidate fails ${want[0]}–${want[want.length - 1]} (${want.length} widths), production none`);
  });

  it("a ground whose display is not one box fails closed (raw HTML: a table cell, display: contents)", async () => {
    await load('<table><tr><td class="g"></td></tr></table>', ".g { width: 60px; height: 200px; padding: 0; background: linear-gradient(#000, #fff); }");
    expect(await candidateScan(tab)).toContain("GRADIENT_PAINT_BOX");
    await load('<div class="g"><div style="height: 200px"></div></div>', ".g { display: contents; background: linear-gradient(#000, #fff); }");
    expect(await candidateScan(tab)).toContain("GRADIENT_PAINT_BOX");
  });
});

describe("DEV-180 what the candidate passes is drawn as the rule says", () => {
  it("borderless grounds: the candidate gives exactly the production codes (the DEV-172 edge cases)", async () => {
    const cases: Array<[string, string]> = [
      ["300×128 black to white", ".g { width: 300px; height: 128px; background: linear-gradient(#000, #fff); }"],
      ["300×127 black to white", ".g { width: 300px; height: 127px; background: linear-gradient(#000, #fff); }"],
      ["128×40 to right", ".g { width: 128px; height: 40px; background: linear-gradient(to right, #000, #fff); }"],
      ["91×91 45deg", ".g { width: 91px; height: 91px; background: linear-gradient(45deg, #000, #fff); }"],
      ["600×254 radial circle", ".g { width: 600px; height: 254px; background: radial-gradient(circle, #000, #fff); }"],
      ["300 hard stop 9.9%", ".g { width: 300px; height: 40px; background: linear-gradient(to right, #000, #000 50%, #fff 59.9%); }"],
      ["inline, one line", ".g { background: linear-gradient(#303030, #343434); }"],
    ];
    for (const [name, css] of cases) {
      const body = name.startsWith("inline") ? `<p><span class="g">${'<img alt="" style="width: 60px; height: 30px">'.repeat(2)}</span></p>` : '<div class="g"></div>';
      await load(body, css);
      expect(await candidateScan(tab), name).toEqual(await prod());
    }
  });

  it("48 seeded boxes: wherever the candidate passes, the padding box steps at most 3 levels per px and every border band is flat", async () => {
    let seed = 180;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
    let passed = 0;
    let failedBox = 0;
    const rows: string[] = [];
    for (let i = 0; i < 48; i++) {
      const style = pick(["none", "solid", "solid", "dashed", "dotted", "double", "groove"] as const);
      const colour = pick(["#000", "#7a4b20", "transparent", "rgba(0, 0, 0, 0.5)"] as const);
      const bw = pick([0, 1, 4, 12, 20] as const);
      const sides = pick(["border", "border-top", "border-left", "border-bottom"] as const);
      const dir = pick(["to bottom", "to right"] as const);
      const inline = rnd() < 0.2;
      const w = 40 + Math.floor(rnd() * 260);
      const h = 40 + Math.floor(rnd() * 260);
      const [a, b] = pick([["#000", "#fff"], ["#202020", "#848484"], ["#5b2a17", "#ffe2b0"], ["#efe6d6", "#a99172"]] as const);
      const css = inline
        ? `.p { width: ${w}px; margin: 0; line-height: 1; } .p img { width: 50px; height: ${Math.min(h, 60)}px; } .g { ${sides}: ${bw}px ${style} ${colour}; background: linear-gradient(${dir}, ${a}, ${b}); }`
        : `.g { width: ${w}px; height: ${h}px; ${sides}: ${bw}px ${style} ${colour}; background: linear-gradient(${dir}, ${a}, ${b}); }`;
      const body = inline ? `<p class="p"><span class="g">${'<img alt="">'.repeat(1 + Math.floor(rnd() * 5))}</span></p>` : '<div class="g"></div>';
      await load(body, css);
      const c = await candidateScan(tab);
      const d = await drawn();
      if (c.includes("GRADIENT_PAINT_BOX")) failedBox += 1;
      rows.push(`${i} | ${css.replace(/\s+/g, " ")} | ${c.join(",") || "[]"} | step ${d.jump}, flat ${d.bandsFlat}, frags ${d.frags}`);
      if (c.some((x) => x.startsWith("GRADIENT_"))) continue;
      passed += 1;
      expect(d.jump, `${i} ${css}`).toBeLessThanOrEqual(3);
      expect(d.bandsFlat, `${i} ${css}`).toBe(true);
      expect(d.frags, `${i} ${css}`).toBe(1);
    }
    console.log(`DEV-180 seeded boxes (candidate passes ${passed}, GRADIENT_PAINT_BOX ${failedBox} of 48)\n${rows.join("\n")}`);
    expect(passed).toBeGreaterThanOrEqual(8);
    expect(failedBox).toBeGreaterThanOrEqual(8);
  });
});

describe("DEV-180 the three shops' gradient pages: the candidate adds nothing", () => {
  it("at the checked widths the candidate equals production on strict, grad and grad_eased", async () => {
    for (const shop of ["sento", "tsugute", "bicycle"] as const)
      for (const v of ["strict", "grad", "grad_eased"] as const)
        for (const w of NOWRAP_WIDTHS) {
          const o = await openCompPage(browser, gradPage(shop, v), { width: w, height: 900, scale: 1, mobile: w <= 390 });
          try {
            const p = phaseBCodes(await phaseBScan(o.page, { css: ON, displayWords: [] }));
            expect(await candidateScan(o.page), `${shop} ${v} ${w}`).toEqual(p);
          } finally {
            await o.context.close();
          }
        }
  });

  it("the 1px sweep 320–1920 (real resizes): the candidate's codes are production's at every width (sento grad and grad_eased, tsugute grad)", async () => {
    for (const [shop, v] of [["sento", "grad"], ["sento", "grad_eased"], ["tsugute", "grad"]] as const) {
      const page = gradPage(shop, v);
      const cand = await candidateSweep(browser, page);
      const p = (await displaySweepPass(browser, page, { css: ON, displayWords: [] }, { forceReal: true }))!;
      const key = (f: Array<{ w: number; codes: string[] }>) => f.map((x) => `${x.w}:${x.codes.join(",")}`);
      expect(key(cand), `${shop} ${v}`).toEqual(key(p.failing));
      expect(cand.some((f) => f.codes.includes("GRADIENT_PAINT_BOX")), `${shop} ${v}`).toBe(false);
      console.log(`DEV-180 ${shop} ${v} sweep: candidate = production (${cand.length} failing widths)`);
    }
  }, 2_400_000);
});
