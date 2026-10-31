import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FactsPack } from "@/lib/design-agent/artifact/schema";
import { DesignBrief } from "@/lib/design-agent/phase2f/prompt";
import { RenderError, renderFailureDetail, renderPrototype } from "@/lib/design-agent/phase2f/render-prototype";
import { packageConceptRun, PLAN_LIMITS, PortStop, runPrototypeRoute, type AssetPort, type DesignPort } from "@/lib/design-agent/phase2f/runner";
import { answer, BRIEF, colourPng, FACTS, GENERATION, palettePng, workspace } from "./fixtures";

// Phase 2f-1: the runner with pseudo ports only (no Codex, no image generation).

let browser: Browser;
const ws = workspace();
beforeAll(async () => {
  // same launch as the comp-impl tests (a machine may point at its own Chromium)
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
});
afterAll(async () => {
  await browser.close();
  rmSync(ws.base, { recursive: true, force: true });
});

let n = 0;
const facts = { path: ws.factsPath, pack: FactsPack.parse(FACTS) };
const shop = { shop_id: "fictional-wagashi", display_name: "架空菓庵" };
const calls = { design: 0, asset: 0 };
const designPort = (a: unknown, gen: object = {}): DesignPort => async () => {
  calls.design += 1;
  return { answer: a, generation: { ...GENERATION, ...gen } };
};
const assetPort = (res: Awaited<ReturnType<AssetPort>>): AssetPort => async () => {
  calls.asset += 1;
  return res;
};
const run = (route: "B_html_prototype" | "C_hybrid", dp: DesignPort, ap?: AssetPort, extra: Partial<Parameters<typeof runPrototypeRoute>[0]> = {}) =>
  runPrototypeRoute({ route, browser, facts, shop, brief: DesignBrief.parse(BRIEF), artifactId: `DA-20261029-run${String(++n).padStart(3, "0")}`, outDir: ws.out(`r${n}`), designPort: dp, assetPort: ap, ...extra });

const SAVED = { png: colourPng(), image_outcome: "IMAGE_SAVED" as const, stop_code: null, approval_id: "fictional-2f-c-asset-01" };

describe("route B (HTML prototype rendered by the runner)", () => {
  it("a valid prototype becomes render_pair_complete: real 1440/390 renders at dsf 1, measured geometry, prototype kept out of the handoff", async () => {
    const r = await run("B_html_prototype", designPort(answer()));
    expect(r.status).toBe("done");
    if (r.status !== "done") return;
    expect(r.record.verification_state).toBe("render_pair_complete");
    expect(r.record.files.find((f) => f.path === "originals/desktop_1440.png")).toMatchObject({ width: 1440 });
    expect(r.record.files.find((f) => f.path === "originals/mobile_390.png")).toMatchObject({ width: 390 });
    expect(JSON.stringify(r.record.handoff)).not.toContain("quarantine");
    expect(r.log.route_delivered).toBe("B_html_prototype");
    expect(r.log.design_calls).toBe(1);
    // Codex's own estimate is kept for comparison; the artifact carries the measured geometry
    expect(r.log.declared_geometry).toMatchObject({ page_height: { desktop_1440: 1200 } });
  });

  it("DEV-134: records the phone checks in the artifact and shows their findings as a warning, never a stop or a state change", async () => {
    const clean = await run("B_html_prototype", designPort(answer()));
    expect(clean.status === "done" && clean.record.verification_state).toBe("render_pair_complete");
    if (clean.status !== "done") return;
    const recorded = JSON.parse(readFileSync(join(clean.packageDir, "artifact.json"), "utf8"));
    expect(recorded.observed.checks).toMatchObject({ structure: null, identity: null, mobile: { viewport: "mobile_390", findings: [], advisory: true } });
    // tiny text on the phone only: the run still delivers, the state stays render_pair_complete, the finding is a warning
    const css = `body{margin:0;font-family:serif}section{min-height:420px;padding:48px}@media (max-width:600px){p{font-size:9px}}`;
    const small = await run("B_html_prototype", designPort(answer({ css })));
    expect(small.status).toBe("done");
    if (small.status !== "done") return;
    expect(small.record.verification_state).toBe("render_pair_complete");
    expect(small.record.warnings).toContain("mobile_findings:SP_TEXT_TOO_SMALL");
    expect(small.log.stops).toEqual([]);
  });

  it("an unknown model is a warning, not a stop (no false stop)", async () => {
    const r = await run("B_html_prototype", designPort(answer(), { model_reported: null }));
    expect(r.status === "done" && r.record.verification_state).toBe("render_pair_complete");
    expect(r.status === "done" && r.record.warnings).toEqual(["generation_model_unknown"]);
  });

  it("a section hidden on the phone is a design choice, not a stop", async () => {
    const r = await run("B_html_prototype", designPort(answer({ css: "body{margin:0;background:#f4efe6;color:#222}section{min-height:300px;padding:40px}@media (max-width:600px){[data-section=story]{display:none}}" })));
    expect(r.status === "done" && r.record.verification_state).toBe("render_pair_complete");
  });

  it("design freedom: any CSS layout (grid, transforms, vertical writing, shapes) is not refused for being unusual", async () => {
    // a real design clips its own decorations (overflow-x: clip); the unusual layout itself is never refused
    const css = `html,body{overflow-x:clip}body{margin:0;display:grid;grid-template-columns:1fr 3fr;background:linear-gradient(90deg,#f4efe6,#e8dccb)}h1{writing-mode:vertical-rl;letter-spacing:.3em}
[data-section=hero]{transform:rotate(-2deg);clip-path:polygon(0 0,100% 4%,100% 100%,0 96%);background:#8c2f39;color:#fff;min-height:400px}section{min-height:300px}`;
    const r = await run("B_html_prototype", designPort(answer({ css })));
    expect(r.status === "done" && r.record.verification_state).toBe("render_pair_complete");
  });

  it("a page that renders blank is recorded (incomplete), never passed", async () => {
    const r = await run("B_html_prototype", designPort(answer({ css: "*{color:#fff!important;background:#fff!important;border:0!important}" })));
    expect(r.status === "done" && r.record.verification_state).toBe("incomplete");
    expect(r.status === "done" && r.record.reasons.some((x) => x.startsWith("run_stopped:RENDER_BLANK"))).toBe(true);
  });

  it("horizontal overflow is recorded (incomplete), the boxes are clipped to the page", async () => {
    const r = await run("B_html_prototype", designPort(answer({ css: "body{margin:0}section{min-height:200px}[data-section=hero]{width:2000px;background:#8c2f39}" })));
    expect(r.status === "done" && r.record.verification_state).toBe("incomplete");
    expect(r.status === "done" && r.record.reasons.join(" ")).toContain("PROTOTYPE_HORIZONTAL_OVERFLOW");
  });

  it("a declared section with no marker in the page is recorded as missing (incomplete)", async () => {
    const r = await run("B_html_prototype", designPort(answer({ extraSection: true })));
    expect(r.status === "done" && r.record.verification_state).toBe("incomplete");
    expect(r.status === "done" && r.record.reasons.some((x) => x.startsWith("declared_missing:section_not_marked"))).toBe(true);
  });

  it.each<[string, unknown, string]>([
    ["an answer that is not codex_design_v1", { ...answer(), verified: true }, "CODEX_DESIGN_INVALID"],
    ["an answer without a prototype", { ...answer(), prototype: null }, "CODEX_NO_PROTOTYPE"],
    ["a script in the prototype", answer({ html: `<!doctype html><html><body><section data-section="header">x</section><script>1</script></body></html>` }), "PROTOTYPE_UNSAFE"],
    ["an external image", answer({ html: `<!doctype html><html><body><section data-section="header"><img src="https://example.com/a.png" alt="x"></section></body></html>` }), "PROTOTYPE_UNSAFE"],
    ["an asset on route B", answer({ asset: "story" }), "CODEX_ASSETS_ON_ROUTE_B"],
  ])("stops %s", async (_n, a, code) => {
    const r = await run("B_html_prototype", designPort(a));
    expect(r.status === "stopped" && r.code).toBe(code);
  });

  it("an unsafe prototype goes to the owner, with no render and nothing written", async () => {
    const r = await run("B_html_prototype", designPort(answer({ css: "body{background:url(https://example.com/x.png)}" })));
    expect(r).toMatchObject({ status: "stopped", code: "PROTOTYPE_UNSAFE", ownerCheck: true, detail: "css url: https://example.com/x.png" });
  });
});

describe("route C (prototype + one generated asset, each its own call)", () => {
  it("a saved image becomes an approved asset: render_pair_complete on route C", async () => {
    calls.asset = 0;
    const r = await run("C_hybrid", designPort(answer({ asset: "story" })), assetPort(SAVED));
    expect(r.status === "done" && r.record.route).toBe("C_hybrid");
    expect(r.status === "done" && r.record.verification_state).toBe("render_pair_complete");
    expect(r.status === "done" && r.record.handoff.files.map((f) => f.path)).toContain("assets/A1.png");
    expect(calls.asset).toBe(1);
  });

  it("a failed, non-essential image falls back to B explicitly: placeholder, failure kept, warning (recoverable, no false stop)", async () => {
    const r = await run("C_hybrid", designPort(answer({ asset: "story" })), assetPort({ png: null, image_outcome: "TOOL_FAILED_TRANSIENT", stop_code: "CODEX_IMAGE_TOOL_FAILED", approval_id: "fictional-2f-c-asset-02" }));
    expect(r.status).toBe("done");
    if (r.status !== "done") return;
    expect(r.record.route).toBe("B_html_prototype");
    expect(r.record.verification_state).toBe("render_pair_complete");
    expect(r.record.warnings).toEqual(["fallback_from_c_hybrid:image_TOOL_FAILED_TRANSIENT"]);
    expect(r.record.runner_reported.fallback).toMatchObject({ from_route: "C_hybrid", image_outcome: "TOOL_FAILED_TRANSIENT", image_stop_code: "CODEX_IMAGE_TOOL_FAILED" });
    expect(r.record.runner_reported.generation.image_outcome).toBe("TOOL_FAILED_TRANSIENT");
  });

  it.each<[string, Awaited<ReturnType<AssetPort>>, "hero" | "story", string, boolean]>([
    ["a policy refusal (never bypassed by a fallback)", { png: null, image_outcome: "TOOL_FAILED_POLICY", stop_code: "CODEX_IMAGE_TOOL_FAILED", approval_id: "a-2f-03" }, "story", "IMAGE_POLICY_REFUSAL", true],
    ["a failed essential (hero) image (no silent degradation)", { png: null, image_outcome: "TOOL_FAILED", stop_code: "CODEX_IMAGE_TOOL_FAILED", approval_id: "a-2f-04" }, "hero", "IMAGE_ESSENTIAL_FAILED", true],
    ["a usage limit", { png: null, image_outcome: "TOOL_FAILED_USAGE_LIMIT", stop_code: "CODEX_QUOTA", approval_id: "a-2f-05" }, "story", "CODEX_QUOTA", false],
    ["a saved image without its file (never reclassified)", { png: null, image_outcome: "IMAGE_SAVED", stop_code: null, approval_id: "a-2f-06" }, "story", "RUN_ASSET_PORT_FAILED", false],
    ["a failure without a stop code (never filled in)", { png: null, image_outcome: "TOOL_FAILED", stop_code: null, approval_id: "a-2f-07" }, "story", "RUN_ASSET_PORT_FAILED", false],
  ])("stops on %s", async (_n, res, where, code, owner) => {
    const r = await run("C_hybrid", designPort(answer({ asset: where })), assetPort(res));
    expect(r).toMatchObject({ status: "stopped", code, ownerCheck: owner });
    if (r.status === "stopped" && owner) expect(r.recovery).toMatch(/NEW run may be approved/);
  });

  it("asks for at most the approved number of images (more assets than approved stop for the owner)", async () => {
    calls.asset = 0;
    const a = answer({ asset: "story" });
    a.structure_spec.sections[1]!.asset_refs = ["A2"];
    a.prototype.html = a.prototype.html.replace("<p>毎朝炊く", '<img src="assets/A2.png" alt="second picture"><p>毎朝炊く');
    const r = await run("C_hybrid", designPort(a), assetPort(SAVED));
    expect(r).toMatchObject({ status: "stopped", code: "RUN_LIMIT_ASSET_CALLS", ownerCheck: true });
    expect(calls.asset).toBe(0);
  });

  it("an asset without alt text cannot be requested", async () => {
    const a = answer({ asset: "story" });
    a.prototype.html = a.prototype.html.replace(/alt="[^"]*"/, 'alt=""');
    expect(await run("C_hybrid", designPort(a), assetPort(SAVED))).toMatchObject({ status: "stopped", code: "ASSET_DESCRIPTION_MISSING" });
  });
});

describe("Fresh Review 1 fixes", () => {
  type R = Awaited<ReturnType<NonNullable<Parameters<typeof runPrototypeRoute>[0]["render"]>>>;
  const blockedRender = async (): Promise<R> => {
    const one = { png: colourPng(1440, 900), blocked: 1, scrollHeight: 900, scrollWidth: 1440, sections: {}, assets: {} };
    return { desktop_1440: one, mobile_390: { ...one, png: colourPng(390, 844), scrollWidth: 390 } };
  };
  it("an outside request in the render stops route B for the owner", async () => {
    expect(await run("B_html_prototype", designPort(answer()), undefined, { render: blockedRender })).toMatchObject({ status: "stopped", code: "PROTOTYPE_NETWORK_ATTEMPT", ownerCheck: true });
  });
  it("on route C the preflight render stops it BEFORE any image call is spent", async () => {
    calls.asset = 0;
    const r = await run("C_hybrid", designPort(answer({ asset: "story" })), assetPort(SAVED), { render: blockedRender });
    expect(r).toMatchObject({ status: "stopped", code: "PROTOTYPE_NETWORK_ATTEMPT", ownerCheck: true });
    expect(calls.asset).toBe(0);
  });
  it("a picture really shown in the hero but declared elsewhere stops (the declaration must match the page)", async () => {
    const a = answer({ asset: "hero" });
    a.structure_spec.sections[1]!.asset_refs = [];
    a.structure_spec.sections[2]!.asset_refs = ["A1"];
    expect(await run("C_hybrid", designPort(a), assetPort(SAVED))).toMatchObject({ status: "stopped", code: "CODEX_ASSET_PLACEMENT_MISMATCH" });
  });
  it("a failed picture in the first screen is essential: no silent fallback", async () => {
    // a short hero puts the story picture in the first screen
    const a = answer({ asset: "story", css: "body{margin:0;background:#f4efe6;color:#222}section{min-height:200px;padding:20px}" });
    const r = await run("C_hybrid", designPort(a), assetPort({ png: null, image_outcome: "TOOL_FAILED", stop_code: "CODEX_IMAGE_TOOL_FAILED", approval_id: "a-2f-08" }));
    expect(r).toMatchObject({ status: "stopped", code: "IMAGE_ESSENTIAL_FAILED", ownerCheck: true });
  });
  it("the runner enforces the per-call time limit even if a port ignores it", async () => {
    const r = await run("B_html_prototype", () => new Promise(() => undefined), undefined, { limits: { ...PLAN_LIMITS, callTimeoutMs: 30 } });
    expect(r).toMatchObject({ status: "stopped", code: "CODEX_TIMEOUT" });
  });
  it("a box sticking out on the left keeps only its visible part", async () => {
    const r = await run("B_html_prototype", designPort(answer({ css: "html,body{overflow-x:clip}body{margin:0}section{min-height:300px}[data-section=hero]{margin-left:-200px;width:600px;background:#8c2f39}" })));
    expect(r.status).toBe("done");
    if (r.status !== "done") return;
    const a = JSON.parse(readFileSync(join(r.packageDir, "artifact.json"), "utf8"));
    const hero = a.declared.structure_spec.sections.find((s: { id: string }) => s.id === "hero").boxes.desktop_1440;
    expect([hero.x, hero.w]).toEqual([0, 400]);
  });
  it("a section hidden at every width is recorded (incomplete)", async () => {
    const r = await run("B_html_prototype", designPort(answer({ css: "body{margin:0;background:#f4efe6;color:#222}section{min-height:300px}[data-section=story]{display:none}" })));
    expect(r.status === "done" && r.record.reasons).toEqual(["section_hidden_everywhere:story"]);
  });
});

describe("Fresh Review 2 fixes", () => {
  it("a section whose root measures 0 but whose content is absolutely positioned (a vertical shop name) is measured by its content (no false stop)", async () => {
    // the header box itself is 0 high; the vertical name inside it has a real size
    const css = "body{margin:0;background:#f4efe6;color:#222}header{position:relative;height:0}header h1{position:absolute;top:0;left:20px;height:320px;writing-mode:vertical-rl;margin:0}section{min-height:300px}";
    const r = await run("B_html_prototype", designPort(answer({ css })));
    expect(r.status === "done" && r.record.verification_state).toBe("render_pair_complete");
  });
  it("a display: contents section is measured by what it paints (no false stop)", async () => {
    const css = "body{margin:0;background:#f4efe6;color:#222}footer{display:contents}section{min-height:300px}";
    const r = await run("B_html_prototype", designPort(answer({ css })));
    expect(r.status === "done" && r.record.verification_state).toBe("render_pair_complete");
  });
  it.each<[string, (h: string) => string, string]>([
    ["a ::before background", (h) => h.replace(/<img [^>]*>/, ""), "[data-section=story]::before{content:'';display:block;width:200px;height:100px;background:url(assets/A1.png)}"],
    ["an SVG <image>", (h) => h.replace(/<img [^>]*>/, '<svg width="200" height="100" aria-label="A wrapped dorayaki on rice paper"><image href="assets/A1.png" width="200" height="100"/></svg>'), ""],
  ])("an asset painted by %s is found in its section (no placement false stop)", async (_n, html, extraCss) => {
    const a = answer({ asset: "story" });
    a.prototype.html = html(a.prototype.html);
    a.prototype.css += extraCss;
    // the alt text request still needs an <img>; keep a hidden described one for the request only when absent
    if (!a.prototype.html.includes("<img")) a.prototype.html = a.prototype.html.replace("</footer>", '</footer><img src="assets/A1.png" alt="A wrapped dorayaki" style="display:none">');
    const r = await run("C_hybrid", designPort(a), assetPort(SAVED));
    expect(r.status === "done" && r.record.route).toBe("C_hybrid");
  });
  it("a picture that only grazes the first screen is not essential: its failure falls back to B", async () => {
    // the story picture starts 40 px above the fold (most of it below)
    // header 100 + hero 760 = 860: on the 900-high PC screen 40 px of the 200 px picture are in view (less than half)
    const css = "body{margin:0;background:#f4efe6;color:#222}header{height:100px;overflow:hidden}header h1{margin:0}[data-section=hero]{height:760px;overflow:hidden}section{padding:0;margin:0}[data-section=story] p{display:none}[data-section=story] img{display:block;height:200px!important}";
    const r = await run("C_hybrid", designPort(answer({ asset: "story", css })), assetPort({ png: null, image_outcome: "TOOL_FAILED", stop_code: "CODEX_IMAGE_TOOL_FAILED", approval_id: "a-2f-09" }));
    expect(r.status === "done" && r.record.route).toBe("B_html_prototype");
  });
  it("a hero picture is essential even below the first screen", async () => {
    const css = "body{margin:0;background:#f4efe6;color:#222}header{height:2000px}section{min-height:300px}";
    const r = await run("C_hybrid", designPort(answer({ asset: "hero", css })), assetPort({ png: null, image_outcome: "TOOL_FAILED", stop_code: "CODEX_IMAGE_TOOL_FAILED", approval_id: "a-2f-10" }));
    expect(r).toMatchObject({ status: "stopped", code: "IMAGE_ESSENTIAL_FAILED" });
  });
  it("a timeout aborts the port's signal (a real port must stop its process) and names the call", async () => {
    let signal: AbortSignal | undefined;
    const r = await run("B_html_prototype", (req) => ((signal = req.signal), new Promise(() => undefined)), undefined, { limits: { ...PLAN_LIMITS, callTimeoutMs: 30 } });
    expect(r).toMatchObject({ code: "CODEX_TIMEOUT" });
    expect(signal?.aborted).toBe(true);
    const c = await run("C_hybrid", designPort(answer({ asset: "story" })), () => new Promise(() => undefined), { limits: { ...PLAN_LIMITS, callTimeoutMs: 30 } });
    expect(c).toMatchObject({ code: "CODEX_IMAGE_TIMEOUT" });
  });
});

describe("Fresh Review 3 fixes", () => {
  const BASE = "body{margin:0;background:#f4efe6;color:#222}section{min-height:300px}";
  it.each(["overflow:hidden", "contain:paint", "clip-path:inset(0)"])("a 0-high section root that clips its content (%s) paints nothing and stays hidden", async (clip) => {
    const r = await run("B_html_prototype", designPort(answer({ css: `${BASE}header{height:0;${clip}}` })));
    expect(r.status === "done" && r.record.reasons).toEqual(["section_hidden_everywhere:header"]);
  });
  it("a 0-high section holding bare text (no child element) is measured by its glyphs (no false stop)", async () => {
    const a = answer({ css: `${BASE}footer{height:0;line-height:24px}` });
    a.prototype.html = a.prototype.html.replace('<footer data-section="footer"><p>架空菓庵</p></footer>', '<footer data-section="footer">架空菓庵</footer>');
    const r = await run("B_html_prototype", designPort(a));
    expect(r.status === "done" && r.record.verification_state).toBe("render_pair_complete");
  });
  it("a ::before with a background but no content paints nothing: the picture is not placed, and no image call is spent", async () => {
    const a = answer({ asset: "story" });
    a.prototype.html = a.prototype.html.replace(/<img [^>]*>/, "").replace("</footer>", '</footer><img src="assets/A1.png" alt="A wrapped dorayaki" style="display:none">');
    a.prototype.css += "[data-section=story]::before{display:block;width:200px;height:100px;background:url(assets/A1.png)}";
    let called = 0;
    const r = await run("C_hybrid", designPort(a), async () => ((called += 1), SAVED));
    expect(r).toMatchObject({ status: "stopped", code: "CODEX_ASSET_PLACEMENT_MISMATCH" });
    expect(called).toBe(0);
  });
  it("a picture taller than the screen that fills most of the first screen is essential", async () => {
    // header 100 + hero 200: the 3000 px story picture covers 600 of the 900 px PC screen (less than half of itself)
    const css = "body{margin:0;background:#f4efe6;color:#222}header{height:100px;overflow:hidden}header h1{margin:0}[data-section=hero]{height:200px;overflow:hidden}section{padding:0;margin:0}[data-section=story] p{display:none}[data-section=story] img{display:block;height:3000px!important}";
    const r = await run("C_hybrid", designPort(answer({ asset: "story", css })), assetPort({ png: null, image_outcome: "TOOL_FAILED", stop_code: "CODEX_IMAGE_TOOL_FAILED", approval_id: "a-2f-11" }));
    expect(r).toMatchObject({ status: "stopped", code: "IMAGE_ESSENTIAL_FAILED" });
  });
});

describe("limits and recovery are never automatic", () => {
  it("makes exactly one design call per run and never retries", async () => {
    calls.design = 0;
    await run("B_html_prototype", async () => {
      calls.design += 1;
      throw new PortStop("CODEX_TIMEOUT", "interrupted");
    });
    expect(calls.design).toBe(1);
  });

  it("a quota stop asks to wait; a zero call budget or an exhausted time budget makes no call", async () => {
    const q = await run("B_html_prototype", async () => {
      throw new PortStop("CODEX_QUOTA", "environment");
    });
    expect(q).toMatchObject({ status: "stopped", code: "CODEX_QUOTA" });
    calls.design = 0;
    expect(await run("B_html_prototype", designPort(answer()), undefined, { limits: { ...PLAN_LIMITS, maxDesignCalls: 0 } })).toMatchObject({ code: "RUN_LIMIT_DESIGN_CALLS" });
    let t = 0;
    expect(await run("B_html_prototype", designPort(answer()), undefined, { now: () => (t += PLAN_LIMITS.totalBudgetMs) })).toMatchObject({ code: "RUN_TIME_BUDGET" });
    expect(calls.design).toBe(0);
  });

  it("keeps the owner's plan limits", () => {
    expect(PLAN_LIMITS).toEqual({ maxDesignCalls: 1, maxAssetCalls: 1, callTimeoutMs: 15 * 60 * 1000, totalBudgetMs: 2 * 60 * 60 * 1000 });
  });
});

describe("route A (existing image PoC output wrapped as a concept)", () => {
  const poc = (png: Buffer, report: object) => {
    const dir = join(ws.base, `poc${++n}`);
    mkdirSync(dir);
    writeFileSync(join(dir, "mockup.png"), png);
    writeFileSync(join(dir, "report.json"), JSON.stringify(report));
    return dir;
  };
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  const gen = { ...GENERATION, approval_id: "fictional-2f-a-20261029-01" };

  it("is a concept image, never a browser render: the 390 design is missing, so it is not handed to implementation", async () => {
    const png = colourPng(1024, 1536);
    const r = await packageConceptRun({ facts, shop, artifactId: "DA-20261029-concpt", outDir: ws.out("a1"), pocDir: poc(png, { png_sha256: sha(png), width: 1024, height: 1536 }), generation: gen });
    expect(r.status).toBe("done");
    if (r.status !== "done") return;
    expect(r.record.route).toBe("A_image");
    expect(r.record.verification_state).toBe("incomplete");
    expect(r.record.reasons).toContain("original_missing:mobile_390");
    expect(r.record.implementation_handoff_allowed).toBe(false);
  });

  it("refuses a report whose height is not the image's", async () => {
    const png = colourPng(1024, 1536);
    const r = await packageConceptRun({ facts, shop, artifactId: "DA-20261029-concp3", outDir: ws.out("a3"), pocDir: poc(png, { png_sha256: sha(png), width: 1024, height: 1000 }), generation: gen });
    expect(r).toMatchObject({ status: "stopped", code: "CONCEPT_REPORT_INVALID" });
  });

  it("a valid PNG in a format the runner does not decode is recorded, not stopped", async () => {
    const png = palettePng(600, 600);
    const r = await packageConceptRun({ facts, shop, artifactId: "DA-20261029-concp4", outDir: ws.out("a4"), pocDir: poc(png, { png_sha256: sha(png), width: 600, height: 600 }), generation: gen });
    expect(r.status === "done" && r.record.reasons).toContain("declared_missing:concept_pixels_not_decoded");
    expect(r.log.stops.map((x) => x.code)).toContain("CONCEPT_DECODE_UNSUPPORTED_FORMAT");
  });

  it("refuses a report whose width is not the image's", async () => {
    const png = colourPng(1024, 1536);
    const r = await packageConceptRun({ facts, shop, artifactId: "DA-20261029-concp5", outDir: ws.out("a5"), pocDir: poc(png, { png_sha256: sha(png), width: 1000, height: 1536 }), generation: gen });
    expect(r).toMatchObject({ status: "stopped", code: "CONCEPT_REPORT_INVALID" });
  });

  it("refuses an image whose SHA does not match its report", async () => {
    const png = colourPng(1024, 1536);
    const r = await packageConceptRun({ facts, shop, artifactId: "DA-20261029-concp2", outDir: ws.out("a2"), pocDir: poc(png, { png_sha256: "0".repeat(64), width: 1024, height: 1536 }), generation: gen });
    expect(r).toMatchObject({ status: "stopped", code: "CONCEPT_SHA_MISMATCH" });
  });
});

describe("DEV-137: a failed render says what the browser said", () => {
  it("keeps the first line only, without paths, at most 160 characters", () => {
    const e = new Error("page.goto: Timeout 30000ms exceeded.\nCall log:\n  - navigating to /home/runner/work/x/index.html");
    expect(renderFailureDetail(e)).toBe("Error: page.goto: Timeout 30000ms exceeded.");
    expect(renderFailureDetail(new Error("Protocol error at /tmp/abc/def.png: Unable to capture screenshot"))).toBe("Error: Protocol error at <path>: Unable to capture screenshot");
    expect(renderFailureDetail(new Error("x".repeat(500)))).toHaveLength(160);
    expect(renderFailureDetail("")).toBe("unknown");
  });

  it("a render on a closed browser stops with RENDER_FAILED and a detail", async () => {
    const closed = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
    await closed.close();
    const err = await renderPrototype(closed, { html: "<p>x</p>", css: "" }, new Map(), []).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RenderError);
    expect((err as RenderError).code).toBe("RENDER_FAILED");
    expect((err as RenderError).detail).toMatch(/closed/i);
  });

  it("the run's stop carries the detail (preflight and render alike)", async () => {
    const failing = (async () => {
      throw new RenderError("RENDER_FAILED", new Error("page.goto: Timeout 30000ms exceeded."));
    }) as unknown as Parameters<typeof runPrototypeRoute>[0]["render"];
    expect(await run("B_html_prototype", designPort(answer()), undefined, { render: failing })).toMatchObject({ status: "stopped", code: "RENDER_FAILED", detail: "Error: page.goto: Timeout 30000ms exceeded." });
    expect(await run("C_hybrid", designPort(answer({ asset: "story" })), assetPort(SAVED), { render: failing })).toMatchObject({ status: "stopped", code: "RENDER_FAILED", detail: "Error: page.goto: Timeout 30000ms exceeded." });
  });
});
