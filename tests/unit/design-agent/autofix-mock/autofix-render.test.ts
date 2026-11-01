import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LOCATE_SCRIPT } from "@/lib/design-agent/autofix-mock/locate";
import { runAutofixMock, type AutofixPorts, type AutofixResult, type Measurement, type Target } from "@/lib/design-agent/autofix-mock/run";
import { pixelDifference } from "@/lib/design-agent/compare/metrics";
import { renderPrototype } from "@/lib/design-agent/phase2f/render-prototype";
import { BASE, CORPUS, FACTS, NAME } from "../phase2f/mobile-quality-corpus";

// DEV-146 (Issue #177 D, MOCK ONLY): the limited automatic fixes on fictional phone pages, rendered by Chromium through
// the Phase 2f renderer (JS off, network shut) and checked by the SP checks (DEV-134). The lane gets every render and
// check as an injected port; nothing here is wired into the real runner, worker or loop.

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
});
afterAll(async () => {
  await browser.close();
});

const LINK = '<link rel="stylesheet" href="style.css">';
const doc = (body: string) => `<!doctype html><html lang="ja"><head><meta charset="utf-8">${LINK}</head><body>${body}</body></html>`;
const frozenFacts = Object.freeze([...FACTS]);

/** The real ports: the Phase 2f render and SP checks, the locator on a second SP page, the pixel share of compare/metrics. */
function ports(html: string, identity: AutofixPorts["identity"] = async () => "PASS_IDENTITY_ONLY") {
  const seen: string[] = [];
  const p: AutofixPorts = {
    identity: async (h, css) => (seen.push(h), identity(h, css)),
    measure: async (h, css): Promise<Measurement> => {
      seen.push(h);
      const r = await renderPrototype(browser, { html: h, css }, new Map(), [], { facts: frozenFacts, shopName: NAME });
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, javaScriptEnabled: false });
      try {
        const page = await ctx.newPage();
        await page.route("**/*", (route) => route.abort());
        await page.setContent(h.replace(LINK, `<style>${css}</style>`));
        const targets = (await page.evaluate(LOCATE_SCRIPT)) as Target[];
        const q = r.mobile_390.mobileQuality!;
        return { sp_findings: q.findings, sp_scroll_width: r.mobile_390.scrollWidth, instances: q.examples ?? [], counts: q.counts, targets, pc_png: r.desktop_1440.png, blocked: r.desktop_1440.blocked + r.mobile_390.blocked };
      } finally {
        await ctx.close();
      }
    },
    pcChange: (a, b) => pixelDifference(Buffer.from(a), Buffer.from(b), 900).full,
  };
  return { ports: p, seen, html };
}

async function run(body: string, css: string, identity?: AutofixPorts["identity"]) {
  const html = doc(body);
  const htmlCopy = Buffer.from(html);
  const m = ports(html, identity);
  const r = await runAutofixMock({ source: "implementation", html, css, css_path: "style.css" }, m.ports);
  // the HTML and the facts are never changed: every port got the original bytes
  expect(m.seen.length).toBeGreaterThan(0);
  for (const h of m.seen) expect(Buffer.from(h).equals(htmlCopy)).toBe(true);
  expect(frozenFacts).toEqual(FACTS);
  checkAppendOnly(r, css);
  return r;
}

/** A proposal only appends to the CSS, inside the SP media query; every diff only adds lines. */
function checkAppendOnly(r: AutofixResult, css: string) {
  for (const a of r.attempts) {
    const body = a.diff.split("\n").slice(2);
    expect(body.filter((l) => l.startsWith("-"))).toEqual(css.endsWith("\n") || css === "" ? [] : [`-${css.split("\n").at(-1)}`]);
    expect(a.diff).toContain("+@media (max-width: 480px) {");
  }
  if (r.proposed_css !== null) expect(r.proposed_css.startsWith(css)).toBe(true);
  expect(r).toMatchObject({ applied: false, mock: true, design_approved: false });
}

const corpus = (id: string) => CORPUS.find((c) => c.id === id)!;

describe("limited autofix (mock) on rendered fictional pages", () => {
  it("a tap target that is too small: patched, re-rendered without the tap finding or a new one, the diff recorded", async () => {
    const c = corpus("small_buttons");
    const r = await run(c.body, c.css);
    expect(r.findings_before).toEqual(["SP_TAP_TARGET_BELOW_44"]);
    expect(r).toMatchObject({ status: "owner_review", code: null, owner_check: false, findings_after: [] });
    expect(r.attempts).toHaveLength(1);
    expect(r.attempts[0]).toMatchObject({ cause: "TAP_TARGET", variant: 1, kept: true, reverted_because: null, new_findings: [], pc_change: 0, selectors: ["a.b"] });
    expect(r.attempts[0]!.diff).toContain("+  a.b { min-width: 44px; min-height: 44px; box-sizing: border-box; }");
    expect(r.proposed_diff).toContain("a.b { min-width: 44px");
  }, 120_000);

  it("a tap target below 24 px: patched the same way", async () => {
    const c = corpus("tiny_buttons");
    const r = await run(c.body, c.css);
    expect(r.findings_before).toEqual(["SP_TAP_TARGET_TOO_SMALL"]);
    expect(r).toMatchObject({ status: "owner_review", findings_after: [] });
    expect(r.attempts.map((a) => [a.cause, a.kept])).toEqual([["TAP_TARGET", true]]);
  }, 120_000);

  it("copy clipped by a fixed height: the height is released", async () => {
    const c = corpus("clipped_copy");
    const r = await run(c.body, c.css);
    expect(r.findings_before).toEqual(["SP_TEXT_CLIPPED"]);
    expect(r).toMatchObject({ status: "owner_review", findings_after: [] });
    expect(r.attempts[0]).toMatchObject({ cause: "TEXT_CLIPPED", variant: 1, kept: true, selectors: ["div.box"] });
    expect(r.attempts[0]!.diff).toContain("div.box { height: auto; max-height: none; }");
  }, 120_000);

  it("a row wider than the phone: its width is capped, the page fits", async () => {
    const body = `<section><h1>${NAME}</h1><div class="row"><p>ブレンド</p><p>シングル</p><p>カフェオレ</p></div><p>8:00〜19:00</p><p>架空市本町3-4</p></section>`;
    const r = await run(body, `${BASE} .row{display:flex;width:900px;gap:40px} .row p{width:260px}`);
    // the row also pushes its text off the screen (SP_TEXT_OFFSCREEN, out of scope); capping the row clears both
    expect(r.findings_before).toEqual(["PAGE_HORIZONTAL_OVERFLOW", "SP_TEXT_OFFSCREEN"]);
    expect(r).toMatchObject({ status: "owner_review" });
    expect(r.findings_after).toEqual([]);
    expect(r.attempts[0]).toMatchObject({ cause: "HORIZONTAL_OVERFLOW", kept: true, selectors: ["div.row"] });
  }, 120_000);

  it("a patch that does not resolve the finding is reverted; the cause's limit stops the run for the owner, the original kept", async () => {
    // the page holds its targets small with !important: the appended override (never !important) cannot win
    const c = corpus("small_buttons");
    const r = await run(c.body, `${BASE} .b{display:inline-block;width:30px;height:30px;min-width:30px !important;min-height:30px !important;max-width:30px !important;max-height:30px !important}`);
    expect(r.findings_before).toEqual(["SP_TAP_TARGET_BELOW_44"]);
    expect(r.attempts.map((a) => [a.variant, a.kept, a.reverted_because])).toEqual([
      [1, false, "NOT_RESOLVED"],
      [2, false, "NOT_RESOLVED"],
    ]);
    expect(r).toMatchObject({ status: "stopped", code: "SAME_CAUSE_FIX_LIMIT", owner_check: true, proposed_css: null, proposed_diff: "", findings_after: ["SP_TAP_TARGET_BELOW_44"] });
  }, 180_000);

  it("a patch that brings a new finding is reverted (releasing the height lays the copy under a label)", async () => {
    // the label sits just below the 28 px card (31 px; 29-33 px give the same result here): the cut-off copy under it is
    // not painted, so it is no overlap until the height is released
    const body = `<section><h1>${NAME}</h1><div class="wrap"><div class="card"><p class="copy">朝の一杯を、灯のそばで。季節の豆を、ひとつずつ手で選んでいます。焙煎は毎朝、店の奥で。</p></div><p class="tag">季節限定</p></div><p>8:00〜19:00</p><p>架空市本町3-4</p></section>`;
    const css = `${BASE} .wrap{position:relative;margin-bottom:64px} .card{height:28px;overflow:hidden} .copy{margin:0} .tag{position:absolute;top:31px;left:8px;margin:0}`;
    const r = await run(body, css);
    expect(r.findings_before).toEqual(["SP_TEXT_CLIPPED"]);
    expect(r.attempts.map((a) => [a.cause, a.variant, a.kept, a.reverted_because])).toEqual([
      ["TEXT_CLIPPED", 1, false, "NEW_FINDING"],
      ["TEXT_CLIPPED", 2, false, "NEW_FINDING"],
    ]);
    expect(r.attempts[0]!.new_findings).toContain("SP_TEXT_OVERLAP");
    expect(r).toMatchObject({ status: "stopped", code: "SAME_CAUSE_FIX_LIMIT", owner_check: true, proposed_css: null });
  }, 180_000);

  // intentional designs from the DEV-140 corpus: nothing in scope is located, so nothing is patched. Two of them are the
  // corpus's known false positives (deco_type_not_marked: SP_TEXT_CLIPPED + SP_TEXT_OFFSCREEN; drawer_translated:
  // SP_TEXT_OFFSCREEN): the clipped decorative word is positioned, so the locator leaves it out, and OFFSCREEN is out of scope.
  it.each(["text_over_picture", "big_decorative_type", "vertical_name", "fixed_header", "deco_type_not_marked", "drawer_translated"])("intentional design %s: nothing patched", async (id) => {
    const c = corpus(id);
    const r = await run(c.body, c.css);
    expect(r).toMatchObject({ status: "no_change", code: null, owner_check: false, attempts: [], proposed_css: null });
    expect(r.events.filter((e) => e.startsWith("patch:"))).toEqual([]);
    if (id === "deco_type_not_marked") {
      expect(r.findings_before).toEqual(["SP_TEXT_CLIPPED", "SP_TEXT_OFFSCREEN"]);
      expect(r.events).toContain("skip:TEXT_CLIPPED:not_located");
    }
  }, 120_000);

  it("a false positive already on the page does not hide a newly clipped fact (review round 1, H1)", async () => {
    // deco_type_not_marked already carries SP_TEXT_CLIPPED; a row wider than the phone holds the hours. Capping the
    // row's width (v1) clips the hours under the same code: per instance it is new, so v1 is reverted and v2 (wrap) kept.
    const c = corpus("deco_type_not_marked");
    const row = '<div class="row"><p>架空の朝の焼き菓子</p><p>架空の昼の焼き菓子</p><p>8:00〜19:00 定休 水</p></div>';
    const r = await run(c.body + row, `${c.css}\n.row{display:flex;width:900px;overflow:hidden}.row p{flex:none;width:280px;margin:0}\n`);
    expect(r.findings_before).toContain("PAGE_HORIZONTAL_OVERFLOW");
    expect(r.findings_before).toContain("SP_TEXT_CLIPPED");
    const v1 = r.attempts.find((a) => a.cause === "HORIZONTAL_OVERFLOW" && a.variant === 1)!;
    expect(v1).toMatchObject({ kept: false, reverted_because: "NEW_FINDING" });
    expect(v1.new_findings.some((f) => f.startsWith("SP_TEXT_CLIPPED:") || f === "COUNT:text_nodes_with_problems")).toBe(true);
    // whatever is proposed never clips more text than before
    for (const a of r.attempts.filter((x) => x.kept)) expect(a.new_findings).toEqual([]);
  }, 120_000);

  it("a repeated text does not hide a newly clipped copy of it (review round 2, M1)", async () => {
    // deco_type_not_marked already carries SP_TEXT_CLIPPED on COFFEE; a small tag repeats COFFEE in 10px type. Raising
    // it to 12px (TEXT_TOO_SMALL v1) clips it: the pair SP_TEXT_CLIPPED:COFFEE is now there twice, so v1 is reverted.
    const c = corpus("deco_type_not_marked");
    const tag = '<div class="tag"><span class="s">COFFEE</span></div>';
    const r = await run(c.body + tag, `${c.css}\n.tag{position:relative;width:200px;height:11px;overflow:hidden}.s{position:absolute;top:0;left:0;font-size:10px;line-height:1}\n`);
    expect(r.findings_before).toContain("SP_TEXT_TOO_SMALL");
    const small = r.attempts.filter((x) => x.cause === "TEXT_TOO_SMALL");
    expect(small.length).toBeGreaterThan(0);
    for (const a of small) {
      expect(a).toMatchObject({ kept: false, reverted_because: "NEW_FINDING" });
      expect(a.new_findings).toContain("SP_TEXT_CLIPPED:COFFEE");
    }
    expect(r.proposed_css).toBeNull();
  }, 120_000);

  it("an identity mismatch stops the run at once: nothing rendered, nothing patched", async () => {
    const c = corpus("small_buttons");
    const html = doc(c.body);
    const m = ports(html, async () => "REJECT");
    const r = await runAutofixMock({ source: "implementation", html, css: c.css, css_path: "style.css" }, m.ports);
    expect(r).toMatchObject({ status: "stopped", code: "IDENTITY_REJECT", owner_check: true, attempts: [], proposed_css: null });
    expect(m.seen).toEqual([html]);
  }, 60_000);
});
