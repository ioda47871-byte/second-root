import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { checkCodexDesign } from "@/lib/design-agent/artifact/intake";
import { CodexDesign, FactsPack } from "@/lib/design-agent/artifact/schema";
import { EVAL_MIN_CRITERION, EVAL_PASS_TOTAL } from "@/lib/design-agent/comp-impl/bundle";
import { MIN_CRITERION, PASS_TOTAL, sheetEntry, sheetMarkdown, sheetVerdict, unnecessaryStopRate, type SheetEntry } from "@/lib/design-agent/phase2f/compare-sheet";
import { decodeCheck } from "@/lib/design-agent/phase2f/decode-check";
import { buildAssetPrompt, buildDesignPrompt, codexDesignJsonSchema, DesignBrief } from "@/lib/design-agent/phase2f/prompt";
import { checkPrototype, cssProblems, PrototypeUnsafe } from "@/lib/design-agent/phase2f/prototype-safety";
import { RENDER_VIEWPORTS, renderPrototype } from "@/lib/design-agent/phase2f/render-prototype";
import { placeholderPng } from "@/lib/design-agent/phase2f/runner";
import { answer, BRIEF, colourPng, FACTS } from "./fixtures";

// Phase 2f-1: the parts of the runner, one by one. Fictional data only.

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
});
afterAll(async () => {
  await browser.close();
});

const page = (body: string, head = '<link rel="stylesheet" href="style.css">') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const check = (html: string, css = "", assets: string[] = []) =>
  checkPrototype(browser, { html, css }, assets).then(
    () => "OK",
    (e: unknown) => (e instanceof PrototypeUnsafe ? `UNSAFE ${e.detail}` : `ERROR ${String(e)}`),
  );

describe("prototype safety: refuses what could run or reach out", () => {
  it.each<[string, string, string]>([
    ["script", page("<script>alert(1)</script>"), "element <script>"],
    ["iframe", page('<iframe src="x.html"></iframe>'), "element <iframe>"],
    ["form", page('<form action="/x"><button>go</button></form>'), "element <form>"],
    ["event attribute", page('<div onclick="x()">a</div>'), "event attribute onclick"],
    ["javascript url", page('<a href="javascript:alert(1)">a</a>'), "a href: javascript:alert(1)"],
    ["external link", page('<a href="https://example.com">a</a>'), "a href: https://example.com"],
    ["protocol-relative image", page('<img src="//example.com/a.png" alt="a">'), "img src: //example.com/a.png"],
    ["data url image", page('<img src="data:image/png;base64,AAAA" alt="a">'), "img src: data:image/png;base64,AAAA"],
    ["undeclared asset", page('<img src="assets/A9.png" alt="a">'), "img src: assets/A9.png"],
    ["svg script", page('<svg><script>1</script></svg>'), "element <script>"],
    ["svg foreignObject", page("<svg><foreignObject><div>x</div></foreignObject></svg>"), "element <foreignobject>"],
    ["svg external href", page('<svg><use href="https://example.com/s.svg#a"/></svg>'), "use href: https://example.com/s.svg#a"],
    ["meta refresh", page("x", '<meta http-equiv="refresh" content="0;url=https://example.com">'), "meta http-equiv refresh"],
    ["base", page("x", '<base href="https://example.com/">'), "element <base>"],
    ["other stylesheet", page("x", '<link rel="stylesheet" href="https://example.com/a.css">'), "link href: https://example.com/a.css"],
    ["preload link", page("x", '<link rel="preload" href="style.css">'), "link rel preload"],
    ["script in a template", page("<template><script>1</script></template>"), "element <script>"],
    ["srcset with an outside image", page('<img src="assets/A1.png" srcset="assets/A1.png 1x, https://example.com/b.png 2x" alt="a">'), "img srcset: https://example.com/b.png"],
  ])("%s", async (_n, html, detail) => {
    expect(await check(html, "", ["assets/A1.png"])).toBe(`UNSAFE ${detail}`);
  });

  it.each<[string, string, string]>([
    ["@import", "@import url(x.css);", "css @import"],
    ["external url()", "body{background:url(https://example.com/a.png)}", "css url: https://example.com/a.png"],
    ["escaped url() hiding a host", "body{background:u\\72l(https://example.com/a.png)}", "css url: https://example.com/a.png"],
    ["expression()", "a{width:expression(alert(1))}", "css code execution"],
    ["image-set()", "a{background:image-set('x.png' 1x)}", "css image function other than url()"],
  ])("CSS %s", async (_n, css, detail) => {
    expect(await check(page("x"), css)).toBe(`UNSAFE ${detail}`);
    // the same rules apply inside <style> and style attributes
    expect(await check(page(`<style>${css}</style>`))).toBe(`UNSAFE ${detail}`);
  });

  it.each<[string, string, string, string]>([
    ["a quoted url holding a )", page("x"), 'body{background:url("http://evil/a)")}', "css url: http://evil/a)"],
    ["an escape forming a fake comment around a url", page("x"), "a{color:red} /\\2a b{} */ body{background:url(http://evil/x.png)} /* */", "css url: http://evil/x.png"],
    ["a /* inside a string hiding a url", page("x"), 'a::before{content:"/*"} body{background:url(http://evil/y.png)} b{content:"*/"}', "css url: http://evil/y.png"],
    ["an SVG fill url", page('<svg><rect fill="url(http://evil/f)"/></svg>'), "", "rect fill: url http://evil/f"],
    ["an SVG mask url", page('<svg><rect mask="url(http://evil/m)"/></svg>'), "", "rect mask: url http://evil/m"],
    ["an @import hidden by a /* inside an @charset string", page("x"), '@charset "/*"; @import url(http://evil/i.css); /* */', "css @import"],
  ])("refuses %s (the reviewer's bypasses)", async (_n, html, css, detail) => {
    expect(await check(html, css)).toBe(`UNSAFE ${detail}`);
  });

  it("Review 1's exact escape vector is refused only by the second (Chromium-parsed) pass", async () => {
    const css = "a{x:/\\2a} body{background:url(http://evil/z.png)} /* */";
    // the as-written pass alone does not see it ...
    expect(cssProblems(css, new Set())).toEqual([]);
    // ... the whole check does
    expect(await check(page("x"), css)).toBe("UNSAFE css url: http://evil/z.png");
  });

  it("allows in-page url(#id) references (SVG filters, gradients, clip paths) and harmless meta boilerplate", async () => {
    const html = `<!doctype html><html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><link rel="stylesheet" href="style.css"></head><body>
<svg><filter id="grain"/><linearGradient id="g"/><rect fill="url(#g)"/></svg><div style="clip-path:url(#c)">x</div></body></html>`;
    expect(await check(html, "body{filter:url(#grain)} rect{fill:url('#g')}")).toBe("OK");
  });

  it("does not over-constrain the design: unusual CSS, inline SVG, anchors, buttons and escapes are fine", async () => {
    const css = `body{display:grid;grid-template-columns:repeat(12,1fr);writing-mode:horizontal-tb}
h1{writing-mode:vertical-rl;font-feature-settings:"palt"}.mark::before{content:"\\201C";position:absolute;transform:rotate(-8deg)}
.wave{clip-path:path("M0 0 L10 10");mix-blend-mode:multiply;filter:blur(2px);background:url(assets/A1.png) center/cover,conic-gradient(red,blue)}
@supports (display:grid){@media (max-width:600px){body{grid-template-columns:1fr}}}`;
    const html = page(`<nav><a href="#story">story</a></nav><button type="button">menu</button>
<svg viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="4" fill="#8c2f39"/><path d="M0 0L10 10"/></svg>
<section id="story" data-section="story" style="background:url(assets/A1.png)"><img src="assets/A1.png" alt="a sweet"></section>`);
    expect(await check(html, css, ["assets/A1.png"])).toBe("OK");
  });

  it("returns each shown asset's alt text (the image request on route C)", async () => {
    const r = await checkPrototype(browser, { html: page('<img src="assets/A1.png" alt="a wrapped sweet">'), css: "" }, ["assets/A1.png"]);
    expect(r.alts).toEqual({ "assets/A1.png": "a wrapped sweet" });
  });

  it("cssProblems: comments do not hide anything and do not count", () => {
    expect(cssProblems("/* url(https://x) */ body{color:red}", new Set())).toEqual([]);
    // a comment or a string that mentions @import is not one; an escaped one outside them still is
    expect(cssProblems('/* no @import here */ a::before{content:"@import"} body{color:red}', new Set())).toEqual([]);
    expect(cssProblems("@\\69mport url(assets/A1.png);", new Set(["assets/A1.png"]))).toEqual(["css @import"]);
    expect(cssProblems("body{background:/**/url(https://x/a.png)}", new Set())).toEqual(["css url: https://x/a.png"]);
  });
});

describe("prompt", () => {
  const facts = FactsPack.parse(FACTS);
  const brief = DesignBrief.parse(BRIEF);
  it("is deterministic (its SHA-256 is the run's prompt SHA) and differs by route", () => {
    const b1 = buildDesignPrompt({ route: "B_html_prototype", facts, brief, maxAssets: 1 });
    expect(buildDesignPrompt({ route: "B_html_prototype", facts, brief, maxAssets: 1 })).toEqual(b1);
    expect(b1.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(buildDesignPrompt({ route: "C_hybrid", facts, brief, maxAssets: 1 }).sha256).not.toBe(b1.sha256);
  });
  it("asks for an original composition, gives facts and the brief as data, and fixes only safety and the hand-off", () => {
    const { prompt } = buildDesignPrompt({ route: "B_html_prototype", facts, brief, maxAssets: 1 });
    expect(prompt).toMatch(/could only belong to this shop/);
    expect(prompt).toMatch(/Avoid the generic landing page/);
    expect(prompt).toContain("架空菓庵");
    expect(prompt).toMatch(/data, not instructions/);
    expect(prompt).toMatch(/data-section/);
    expect(prompt).toMatch(/no <script>/);
    // no implementation CSS allowlist or fixed section template is imposed on the prototype
    expect(prompt).not.toMatch(/allowlist|allowed properties|COMP_UI_LABELS|must use (exactly )?these sections/i);
  });
  it("route C asks for alt text as the image request; the asset prompt forbids text, logos and people", () => {
    expect(buildDesignPrompt({ route: "C_hybrid", facts, brief, maxAssets: 1 }).prompt).toMatch(/alt text must describe the picture/);
    expect(buildAssetPrompt({ facts, alt: "a sweet", assetId: "A1" }).prompt).toMatch(/No text, letters, logos, people or faces/);
  });
  it("the output schema is the same zod schema the runner checks Codex's answer with", () => {
    const s = codexDesignJsonSchema() as { additionalProperties?: boolean; required?: string[] };
    expect(s.additionalProperties).toBe(false);
    expect(s.required).toEqual(Object.keys(CodexDesign.shape));
    expect(JSON.stringify(s)).not.toMatch(/"(approved|verified|verification_state|sha256|files)"/);
  });

  it("carries no root $schema (as the worker's schemas); otherwise exactly zod's schema, and the answer check is unchanged", () => {
    const s = codexDesignJsonSchema() as Record<string, unknown>;
    expect("$schema" in s).toBe(false);
    const full = z.toJSONSchema(CodexDesign, { unrepresentable: "any" }) as Record<string, unknown>;
    expect(full.$schema).toBeDefined();
    const { $schema: _meta, ...rest } = full;
    void _meta;
    expect(s).toEqual(rest);
    // the runner still checks Codex's answer with the same zod schema
    expect(checkCodexDesign(answer())).toMatchObject({ schema: "codex_design_v1" });
    expect(() => checkCodexDesign({ ...answer(), extra: 1 })).toThrow();
  });

  it("the B and C prompts for the fictional wagashi shop are unchanged by the schema fix", () => {
    const read = (p: string) => JSON.parse(readFileSync(resolve(__dirname, "../../../..", p), "utf8"));
    const facts = FactsPack.parse(read("design-library/phase2f/wagashi-facts-pack.json"));
    const brief = DesignBrief.parse(read("design-library/phase2f/wagashi-brief-v4.json"));
    const b = buildDesignPrompt({ route: "B_html_prototype", facts, brief, maxAssets: 1 });
    const c = buildDesignPrompt({ route: "C_hybrid", facts, brief, maxAssets: 1 });
    expect([b.sha256, b.chars]).toEqual(["a2fdd00365087046c44f03b4c3ea43530046af658b017ae5229fd7577c817954", 5706]);
    expect([c.sha256, c.chars]).toEqual(["20b6ec350c583c072f6c3bd466e8ce9ccf988d22645520742834137e64aa8845", 6200]);
  });
});

describe("render (second barrier): network shut, dsf 1, clipped to the viewport width", () => {
  it("counts any request that is not the page's own file, even one the safety check would have refused", async () => {
    const html = page('<section data-section="a"><img src="assets/A1.png" alt="x"><p>text</p></section>');
    const r = await renderPrototype(browser, { html, css: "body{background:#eee}" }, new Map(), ["a"]);
    expect(r.desktop_1440.blocked + r.mobile_390.blocked).toBeGreaterThan(0);
    const ok = await renderPrototype(browser, { html, css: "body{background:#eee}" }, new Map([["assets/A1.png", colourPng()]]), ["a"]);
    expect(ok.desktop_1440.blocked + ok.mobile_390.blocked).toBe(0);
  });
  it("captures exactly 1440 and 390 px wide at deviceScaleFactor 1, even when the page overflows sideways", async () => {
    expect(RENDER_VIEWPORTS.desktop_1440.scale).toBe(1);
    expect(RENDER_VIEWPORTS.mobile_390.scale).toBe(1);
    const r = await renderPrototype(browser, { html: page('<section data-section="a" style="width:3000px">wide</section>'), css: "body{background:#eee}" }, new Map(), ["a", "missing"]);
    expect(decodeCheck(r.desktop_1440.png, 1440)).toMatchObject({ width: 1440 });
    expect(decodeCheck(r.mobile_390.png, 390)).toMatchObject({ width: 390 });
    expect(r.mobile_390.scrollWidth).toBeGreaterThan(390);
    expect(r.desktop_1440.sections.missing).toBeNull();
  });
});

describe("real decode", () => {
  it("decodes a real picture, checks its width, and catches a blank one", () => {
    expect(decodeCheck(colourPng(64, 48), 64)).toMatchObject({ ok: true, width: 64, height: 48 });
    expect(decodeCheck(colourPng(64, 48), 65)).toMatchObject({ ok: false, code: "RENDER_SIZE_MISMATCH" });
    expect(decodeCheck(placeholderPng(), 16)).toMatchObject({ ok: false, code: "RENDER_BLANK" });
    expect(decodeCheck(Buffer.from("not a png"), 1)).toMatchObject({ ok: false, code: "RENDER_UNDECODABLE" });
  });
});

describe("comparison sheet: a technical pass is not a design success", () => {
  const filled = (over: Partial<SheetEntry> = {}): SheetEntry => ({
    route: "B_html_prototype",
    delivered_route: "B_html_prototype",
    kind: "browser_render",
    verification_state: "render_pair_complete",
    images: { desktop_1440: "originals/desktop_1440.png", mobile_390: "originals/mobile_390.png" },
    hard_fails: [],
    scores: { beauty: 5, shop_fit: 5, originality: 4, web_structure: 4, implementability: 4 },
    pc_sp_completeness: 4,
    owner: { not_generic: true, adopt: null, confirmed: true, notes: "" },
    stops_and_warnings: [],
    calls: [],
    ...over,
  });
  it("uses the owner's existing policy numbers (same as comp-impl)", () => {
    expect([PASS_TOTAL, MIN_CRITERION]).toEqual([EVAL_PASS_TOTAL, EVAL_MIN_CRITERION]);
  });
  it.each<[string, Partial<SheetEntry>, string]>([
    ["all filled and passing", {}, "pass"],
    ["not yet confirmed by the owner", { owner: { not_generic: true, adopt: null, confirmed: false, notes: "" } }, "pending"],
    ["generic, even with high scores", { owner: { not_generic: false, adopt: null, confirmed: true, notes: "" } }, "fail"],
    ["one criterion below 4", { scores: { beauty: 5, shop_fit: 5, originality: 3, web_structure: 5, implementability: 5 } }, "fail"],
    ["a total below 22", { scores: { beauty: 4, shop_fit: 4, originality: 4, web_structure: 4, implementability: 4 } }, "fail"],
    ["a hard fail", { hard_fails: ["invented fact"] }, "fail"],
    ["weak PC/SP completeness", { pc_sp_completeness: 3 }, "fail"],
    ["a technically incomplete render, however well scored", { verification_state: "incomplete" }, "fail"],
    ["a route C run delivered as a B fallback", { route: "C_hybrid", delivered_route: "B_html_prototype" }, "fail"],
    ["a concept image (route A) that scores well", { route: "A_image", delivered_route: "A_image", kind: "concept_image", verification_state: "incomplete", images: { desktop_1440: "originals/desktop_concept.png", mobile_390: null }, pc_sp_completeness: null }, "concept_pass"],
    ["a route A run that stopped, however well scored", { route: "A_image", delivered_route: null, kind: "concept_image", verification_state: "stopped", images: { desktop_1440: null, mobile_390: null }, pc_sp_completeness: null }, "concept_fail"],
    ["a route A entry without its concept image", { route: "A_image", delivered_route: "A_image", kind: "concept_image", verification_state: "incomplete", images: { desktop_1440: null, mobile_390: null }, pc_sp_completeness: null }, "concept_fail"],
    ["scores missing", { scores: { beauty: null, shop_fit: 5, originality: 5, web_structure: 5, implementability: 5 } }, "pending"],
  ])("%s → %s", (_n, over, verdict) => {
    expect(sheetVerdict(filled(over))).toBe(verdict);
  });
  it("route A from real run results: a stopped run is never a concept pass; a generated concept image is judged as a concept", () => {
    const owner = (e: SheetEntry): SheetEntry => ({ ...e, hard_fails: [], scores: { beauty: 5, shop_fit: 5, originality: 5, web_structure: 5, implementability: 5 }, owner: { not_generic: true, adopt: null, confirmed: true, notes: "" } });
    const log = { route_requested: "A_image", route_delivered: null, design_calls: 0, asset_calls: 0, prompt_sha256: null, declared_geometry: null, stops: [], ms: 1 };
    const stopped = sheetEntry("A_image", { status: "stopped", code: "CONCEPT_SHA_MISMATCH", stopClass: "input", ownerCheck: false, recovery: "", log });
    expect(sheetVerdict(owner(stopped))).toBe("concept_fail");
    const record = { route: "A_image", verification_state: "incomplete", warnings: [], reasons: ["original_missing:mobile_390"], files: [{ path: "originals/desktop_concept.png", role: "original", sha256: "a".repeat(64), bytes: 1 }] };
    const done = sheetEntry("A_image", { status: "done", packageDir: "", record: record as never, log: { ...log, route_delivered: "A_image" } });
    expect(done.images.desktop_1440).toBe("originals/desktop_concept.png");
    expect(sheetVerdict(owner(done))).toBe("concept_pass");
    // the sheet the owner reads says the same
    const md = sheetMarkdown([owner(stopped), owner(done)]);
    expect(md.split("## A_image")[1]).toContain("判定: concept_fail");
    expect(md.split("## A_image")[2]).toContain("判定: concept_pass");
    expect(md).toContain("構想画像（実装へは渡さない）");
  });

  it("does not count a run stop twice (run log and intake reason)", () => {
    const record = { route: "B_html_prototype", verification_state: "incomplete", warnings: [], reasons: ["run_stopped:RENDER_BLANK", "declared_missing:x"], files: [] };
    const e = sheetEntry("B_html_prototype", { status: "done", packageDir: "", record: record as never, log: { route_requested: "B_html_prototype", route_delivered: "B_html_prototype", design_calls: 1, asset_calls: 0, prompt_sha256: null, declared_geometry: null, stops: [{ code: "RENDER_BLANK", class: "output", stage: "render" }], ms: 1 } });
    expect(e.stops_and_warnings.map((s) => s.code)).toEqual(["RENDER_BLANK", "declared_missing:x"]);
  });

  it("lists every stop and warning for the owner to mark, and measures the unnecessary-stop rate", () => {
    const e = sheetEntry("C_hybrid", { status: "stopped", code: "IMAGE_POLICY_REFUSAL", stopClass: "capability", ownerCheck: true, recovery: "", log: { route_requested: "C_hybrid", route_delivered: null, design_calls: 1, asset_calls: 1, prompt_sha256: null, declared_geometry: null, stops: [], ms: 1 } });
    expect(e.stops_and_warnings).toEqual([{ code: "IMAGE_POLICY_REFUSAL", source: "run", stop_was_correct: null }]);
    expect(sheetVerdict(e)).toBe("pending");
    expect(unnecessaryStopRate([e])).toEqual({ judged: 0, unnecessary: 0, rate: null });
    e.stops_and_warnings[0]!.stop_was_correct = false;
    expect(unnecessaryStopRate([e])).toEqual({ judged: 1, unnecessary: 1, rate: 1 });
  });
});
