import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareImplementationLane } from "@/lib/design-agent/impl-lane/handoff";
import { PACKAGE_LIMITS, PNG_LIMITS, PROTOTYPE_LIMITS } from "@/lib/design-agent/artifact/schema";
import { compareImplementation, IMPL_COMPARE_LIMITS, LaneReadError, readLane, renderImplementation, type Implementation } from "@/lib/design-agent/impl-lane/impl-compare";
import { renderPrototype } from "@/lib/design-agent/phase2f/render-prototype";
import { routeB, writePackage } from "../artifact/fixtures";

// DEV-139 (Issue #177 A): the design-to-implementation comparison, offline and report-only. A fictional shop's design
// page is drawn to make the design originals, packaged and handed over through the real lane (DEV-128); fictional
// implementations of it are then compared. No model, no network.

const REPO = resolve(__dirname, "../../../..");
let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
});
const made: string[] = [];
afterAll(async () => {
  await browser?.close();
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  made.push(d);
  return d;
};

const doc = (body: string) => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body>${body}</body></html>`;
const SECTIONS = (order = ["header", "shelf_hero", "info", "footer"]) => {
  const html: Record<string, string> = {
    header: `<header data-section="header"><p class="name">架空ベーカリー</p></header>`,
    shelf_hero: `<section data-section="shelf_hero"><h1>木の棚に毎朝のパンを並べる</h1><div class="shelf"><i></i><i></i><i></i></div></section>`,
    info: `<section data-section="info"><p>営業時間</p><p>8:00〜17:00</p><p>実在の店舗ではありません</p></section>`,
    footer: `<footer data-section="footer"><p>架空ベーカリー</p></footer>`,
  };
  return order.map((id) => html[id]).join("");
};
const DESIGN_CSS = `body{margin:0;font-family:sans-serif;background:#f6efe3;color:#3a2a1a}
header{height:120px;background:#3a2a1a;color:#f6efe3;display:flex;align-items:center;padding:0 48px}
[data-section=shelf_hero]{height:700px;background:#c98b4a;padding:64px 48px}
h1{margin:0;font-size:48px}
.shelf{display:flex;gap:24px;margin-top:48px}.shelf i{display:block;width:240px;height:240px;background:#7a4a20}
[data-section=info]{height:500px;padding:48px;background:#f6efe3}
footer{height:160px;background:#2a1a0a;color:#f6efe3}
@media (max-width:600px){header{height:100px;padding:0 20px}[data-section=shelf_hero]{height:900px;padding:32px 20px}h1{font-size:28px}.shelf{flex-direction:column}.shelf i{width:100%;height:160px}[data-section=info]{height:700px;padding:24px}footer{height:200px}}`;
const DESIGN = { html: doc(SECTIONS()), css: DESIGN_CSS, assets: new Map<string, Buffer>() } satisfies Implementation;
const IDS = ["header", "shelf_hero", "info", "footer"];

/** The design originals drawn from the fictional design page, packaged as route B and handed over through the real lane. */
async function buildLane(): Promise<string> {
  const p = routeB();
  const spec = p.artifact.declared.structure_spec;
  for (const v of ["desktop_1440", "mobile_390"] as const) {
    const r = await renderImplementation(browser, DESIGN, v, IDS);
    const height = readPngHeight(r.png);
    p.files[`originals/${v}.png`] = r.png;
    p.artifact.observed.originals[v].height = height;
    spec.page_height[v] = height;
    for (const s of spec.sections) {
      const b = r.sections.find((x) => x.id === s.id)!.box!;
      s.boxes[v] = { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) };
    }
  }
  const w = writePackage(p);
  made.push(w.base);
  const laneDir = join(tmp("dev139-lane-"), "lane");
  await prepareImplementationLane({ packageDir: w.dir, factsPath: w.factsPath, laneDir });
  return laneDir;
}
const readPngHeight = (png: Buffer) => png.readUInt32BE(20);

let lane: string;
beforeAll(async () => {
  lane = await buildLane();
}, 120_000);

/** Copies the lane, lets `edit` change the copy's artifact record and re-records its hash in lane.json (a lane as if built so). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the test edits nested fields of the record freely
function laneVariant(edit: (artifact: Record<string, any>) => void): string {
  const dir = join(tmp("dev139-variant-"), "lane");
  mkdirSync(join(dir, "originals"), { recursive: true });
  for (const f of ["lane.json", "artifact.json", "originals/desktop_1440.png", "originals/mobile_390.png"]) writeFileSync(join(dir, f), readFileSync(join(lane, f)));
  const artifact = JSON.parse(readFileSync(join(dir, "artifact.json"), "utf8"));
  edit(artifact);
  const bytes = Buffer.from(JSON.stringify(artifact));
  writeFileSync(join(dir, "artifact.json"), bytes);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const m = JSON.parse(readFileSync(join(dir, "lane.json"), "utf8"));
  m.artifact_json_sha256 = sha;
  m.files.find((f: { role: string }) => f.role === "artifact").sha256 = sha;
  writeFileSync(join(dir, "lane.json"), JSON.stringify(m));
  return dir;
}

describe("the comparison (report only)", () => {
  it("draws the implementation exactly as Phase 2f draws a prototype (same picture, same boxes), hard cases included", async () => {
    // review round 1 (M1): hidden by visibility, display: contents, a 0-height root with positioned content, a 0-size
    // root that clips, a section that is not there, as well as plain blocks
    const hard = {
      ...DESIGN,
      html: doc(`${SECTIONS()}<section data-section="ghost" style="height:200px;visibility:hidden">x</section>
<div data-section="contents" style="display:contents"><div style="height:300px;background:#123">c</div></div>
<div data-section="flat" style="position:relative;height:0"><div style="position:absolute;top:0;left:20px;width:100px;height:100px;background:#321"></div></div>
<div data-section="clipped" style="height:0;overflow:hidden"><div style="height:80px">y</div></div>`),
    };
    const ids = [...IDS, "ghost", "contents", "flat", "clipped", "absent"];
    const ours = { desktop_1440: await renderImplementation(browser, hard, "desktop_1440", ids), mobile_390: await renderImplementation(browser, hard, "mobile_390", ids) };
    const theirs = await renderPrototype(browser, hard, new Map(), ids);
    for (const v of ["desktop_1440", "mobile_390"] as const) {
      expect(ours[v].png.equals(theirs[v].png), v).toBe(true);
      expect(ours[v].sections.map((s) => s.id)).toEqual(ids);
      for (const s of ours[v].sections) expect(s.box, `${v} ${s.id}`).toEqual(theirs[v].sections[s.id]);
      // the cases really are different from a plain box
      expect(ours[v].sections.find((s) => s.id === "ghost")!.box).toEqual({ x: 0, y: 0, w: 0, h: 0 });
      expect(ours[v].sections.find((s) => s.id === "contents")!.box!.h).toBe(300);
      expect(ours[v].sections.find((s) => s.id === "flat")!.box).toMatchObject({ w: 100, h: 100 });
      expect(ours[v].sections.find((s) => s.id === "clipped")!.box).toEqual({ x: 0, y: 0, w: 0, h: 0 });
      expect(ours[v].sections.find((s) => s.id === "absent")!.box).toBeNull();
    }
  }, 120_000);

  it("a section hidden in the implementation (visibility: hidden) is missing; twins refuse the viewport", async () => {
    const hidden = { ...DESIGN, css: `${DESIGN_CSS}\n[data-section=info]{visibility:hidden}` };
    const r = await compareImplementation(browser, lane, hidden);
    expect(r.differences).toEqual(expect.arrayContaining(["PC_SECTION_MISSING_INFO", "SP_SECTION_MISSING_INFO"]));
    const twins = { ...DESIGN, html: doc(SECTIONS() + `<section data-section="info"><p>もう一つ</p></section>`) };
    const t = await compareImplementation(browser, lane, twins);
    expect(t.differences).toEqual(["PC_DUPLICATE_SECTION_ID", "SP_DUPLICATE_SECTION_ID"]);
    // a refused comparison measured nothing: not compared (review round 1, L3)
    expect(t.status).toBe("not_compared");
  }, 120_000);

  it("reads with the artifact schema's own limits (review round 1, L4)", () => {
    expect(IMPL_COMPARE_LIMITS.html).toBe(PROTOTYPE_LIMITS.html);
    expect(IMPL_COMPARE_LIMITS.css).toBe(PROTOTYPE_LIMITS.css);
    expect(IMPL_COMPARE_LIMITS.asset).toBe(PNG_LIMITS.asset.maxBytes);
    expect(IMPL_COMPARE_LIMITS.original.desktop_1440).toBe(PNG_LIMITS.viewport_render_desktop_1440.maxBytes);
    expect(IMPL_COMPARE_LIMITS.original.mobile_390).toBe(PNG_LIMITS.viewport_render_mobile_390.maxBytes);
    expect(IMPL_COMPARE_LIMITS.artifactJson).toBe(PACKAGE_LIMITS.artifactJsonBytes);
    expect(IMPL_COMPARE_LIMITS.assets).toBe(PACKAGE_LIMITS.maxFiles);
  });

  it("a faithful implementation has no differences; still never passing", async () => {
    const r = await compareImplementation(browser, lane, DESIGN);
    expect(r).toMatchObject({ schema: "impl_compare_report_v0", status: "compared", passing: false, advisory: true, differences: [] });
    for (const v of ["desktop_1440", "mobile_390"] as const) {
      expect(r.viewports[v].design).toMatchObject({ state: "present", box_source: "measured_by_runner", rendered_from: "html_prototype_screenshot" });
      expect(r.viewports[v].implementation).toMatchObject({ state: "rendered", blocked_requests: 0 });
      expect(r.viewports[v].compare!.page!.ssim).toBeGreaterThan(0.99);
    }
    // every input is identified by its hash
    expect(r.lane.artifact_json_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.implementation.html_sha256).toBe(createHash("sha256").update(DESIGN.html).digest("hex"));
  }, 120_000);

  it("a sloppy implementation names its causes: order, a missing section, colour", async () => {
    const sloppy = { ...DESIGN, html: doc(SECTIONS(["header", "info", "shelf_hero"])), css: DESIGN_CSS.replace("background:#c98b4a", "background:#4a7ac9") };
    const r = await compareImplementation(browser, lane, sloppy);
    expect(r.status).toBe("compared");
    for (const p of ["PC", "SP"]) {
      expect(r.differences).toContain(`${p}_SECTION_MISSING_FOOTER`);
      expect(r.differences).toContain(`${p}_SECTION_ORDER`);
      expect(r.differences).toContain(`${p}_SECTION_COLOUR_SHELF_HERO`);
    }
    expect(r.passing).toBe(false);
  }, 120_000);

  it("a different SP layout only shows at SP", async () => {
    // the PC page as designed; at SP the shelf stays a row instead of a column
    const css = DESIGN_CSS.replace(".shelf{flex-direction:column}.shelf i{width:100%;height:160px}", ".shelf i{width:100px;height:100px}");
    const r = await compareImplementation(browser, lane, { ...DESIGN, css });
    expect(r.viewports.desktop_1440.differences).toEqual([]);
    expect(r.viewports.mobile_390.differences.length).toBeGreaterThan(0);
    expect(r.viewports.mobile_390.differences.every((c) => c.startsWith("SP_"))).toBe(true);
  }, 120_000);

  it("records a request outside the implementation's own files (refused, counted)", async () => {
    const leaky = { ...DESIGN, html: DESIGN.html.replace("</body>", '<img src="https://example.invalid/x.png" alt=""></body>') };
    const r = await compareImplementation(browser, lane, leaky);
    expect(r.viewports.desktop_1440.implementation.blocked_requests).toBeGreaterThan(0);
  }, 120_000);
});

describe("what is never treated as the original", () => {
  it("a missing original or a concept image is not compared (partial), and says so", async () => {
    const concept = laneVariant((a) => {
      a.observed.originals.mobile_390 = { ...a.observed.originals.mobile_390, kind: "concept_image", rendered_from: "image_tool" };
    });
    const r = await compareImplementation(browser, concept, DESIGN);
    expect(r.status).toBe("partial");
    expect(r.viewports.mobile_390).toMatchObject({ design: { state: "not_a_render" }, implementation: { state: "not_rendered" }, compare: null, differences: [] });
    expect(r.viewports.desktop_1440.design.state).toBe("present");
    const missing = laneVariant((a) => {
      a.observed.originals.desktop_1440 = { state: "missing" };
      a.observed.originals.mobile_390 = { state: "generation_failed" };
    });
    const m = await compareImplementation(browser, missing, DESIGN);
    expect(m.status).toBe("not_compared");
    expect([m.viewports.desktop_1440.design.state, m.viewports.mobile_390.design.state]).toEqual(["missing", "missing"]);
    expect(m.differences).toEqual([]);
  }, 120_000);

  it("an original whose bytes changed after the lane was built is not compared", async () => {
    const dir = laneVariant(() => undefined);
    writeFileSync(join(dir, "originals/mobile_390.png"), readFileSync(join(dir, "originals/desktop_1440.png")));
    const r = await compareImplementation(browser, dir, DESIGN);
    expect(r.status).toBe("partial");
    expect(r.viewports.mobile_390.design.state).toBe("file_changed");
  }, 120_000);

  it("declared boxes (not measured by the runner) are labelled as declared", async () => {
    const owner = laneVariant((a) => {
      for (const v of ["desktop_1440", "mobile_390"]) a.observed.originals[v].rendered_from = "owner_upload";
    });
    const r = await compareImplementation(browser, owner, DESIGN);
    expect(r.viewports.desktop_1440.design.box_source).toBe("declared");
  }, 120_000);

  it("refuses a lane whose record changed, is not a lane, or is reached through a link", async () => {
    const code = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => (e instanceof LaneReadError ? e.code : String(e)));
    const changed = laneVariant(() => undefined);
    writeFileSync(join(changed, "artifact.json"), readFileSync(join(changed, "artifact.json"), "utf8").replace("DA-", "DB-"));
    expect(await code(readLane(changed))).toBe("ARTIFACT_CHANGED");
    const notLane = tmp("dev139-notlane-");
    expect(await code(readLane(notLane))).toBe("LANE_JSON_INVALID");
    const linked = laneVariant(() => undefined);
    rmSync(join(linked, "artifact.json"));
    symlinkSync(join(lane, "artifact.json"), join(linked, "artifact.json"));
    expect(await code(readLane(linked))).toBe("ARTIFACT_UNREADABLE");
    // a linked directory on the path to an original is not followed (review round 1, L5)
    const dirLink = laneVariant(() => undefined);
    rmSync(join(dirLink, "originals"), { recursive: true });
    symlinkSync(join(lane, "originals"), join(dirLink, "originals"));
    const r = await readLane(dirLink);
    expect([r.design.desktop_1440.state, r.design.mobile_390.state]).toEqual(["file_unreadable", "file_unreadable"]);
  }, 120_000);

  it("a browser that did not start is a not_compared report, never a clean one", async () => {
    const r = await compareImplementation(null, lane, DESIGN, new Error("no chrome at /opt/x/chrome"));
    expect(r.status).toBe("not_compared");
    expect(r.viewports.desktop_1440.implementation).toMatchObject({ state: "render_failed" });
    expect(r.viewports.desktop_1440.implementation.detail).toBe("BROWSER_LAUNCH_FAILED: no chrome at <path>");
  });
});

describe("the CLI (offline, writes one new report outside its inputs)", () => {
  const CLI = resolve(REPO, "scripts/design-artifact/impl-compare.ts");
  const run = (args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, [resolve(REPO, "node_modules/tsx/dist/cli.mjs"), CLI, ...args], { cwd: REPO, encoding: "utf8", env: { ...process.env, ...env }, timeout: 110_000 });
    let out: unknown = null;
    try {
      out = JSON.parse(r.stdout);
    } catch {
      out = r.stdout + r.stderr;
    }
    return { status: r.status, out };
  };
  const implDir = (impl: Implementation = DESIGN) => {
    const d = join(tmp("dev139-impl-"), "impl");
    mkdirSync(d);
    writeFileSync(join(d, "index.html"), impl.html);
    writeFileSync(join(d, "style.css"), impl.css);
    return d;
  };
  const hashes = (dir: string) =>
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => `${e.name}:${createHash("sha256").update(readFileSync(join(e.parentPath, e.name))).digest("hex")}`)
      .sort();

  it("writes the report outside, leaves the lane and the implementation unchanged, never overwrites", () => {
    const impl = implDir();
    mkdirSync(join(impl, "assets"));
    writeFileSync(join(impl, "assets/bread.png"), readFileSync(join(lane, "originals/mobile_390.png")));
    const out = join(tmp("dev139-out-"), "report.json");
    const before = [hashes(lane), hashes(impl)];
    expect(run(["--lane", lane, "--impl", impl, "--out", out])).toMatchObject({ status: 0, out: { status: "compared", differences: 0 } });
    expect([hashes(lane), hashes(impl)]).toEqual(before);
    const report = JSON.parse(readFileSync(out, "utf8"));
    expect(report).toMatchObject({ schema: "impl_compare_report_v0", passing: false, implementation: { assets: [{ path: "assets/bread.png" }] } });
    expect(run(["--lane", lane, "--impl", impl, "--out", out])).toMatchObject({ status: 2, out: { code: "OUT_EXISTS_OR_UNWRITABLE" } });
  }, 120_000);

  it("refuses a report inside an input (by name, '..x' and through links), bad arguments and missing files", () => {
    const impl = implDir();
    expect(run(["--lane", lane, "--impl", impl, "--out", join(lane, "r.json")])).toMatchObject({ status: 2, out: { code: "OUT_INSIDE_INPUT" } });
    expect(run(["--lane", lane, "--impl", impl, "--out", join(impl, "..r.json")])).toMatchObject({ status: 2, out: { code: "OUT_INSIDE_INPUT" } });
    const links = tmp("dev139-links-");
    symlinkSync(impl, join(links, "to-impl"));
    expect(run(["--lane", lane, "--impl", impl, "--out", join(links, "to-impl", "r.json")])).toMatchObject({ status: 2, out: { code: "OUT_INSIDE_INPUT" } });
    expect(run(["--lane", lane, "--impl", impl])).toMatchObject({ status: 2, out: { code: "ARGS_INVALID" } });
    const empty = join(tmp("dev139-empty-"), "impl");
    mkdirSync(empty);
    expect(run(["--lane", lane, "--impl", empty, "--out", join(tmp("dev139-out-"), "r.json")])).toMatchObject({ status: 2, out: { code: "IMPL_FILES_MISSING" } });
    expect(run(["--lane", empty, "--impl", impl, "--out", join(tmp("dev139-out-"), "r.json")])).toMatchObject({ status: 2, out: { code: "LANE_JSON_INVALID" } });
    for (const f of readdirSync(links)) rmSync(join(links, f));
  }, 120_000);

  it("never reads through a linked file or directory of the implementation", () => {
    const outDir = tmp("dev139-out-");
    const css = implDir();
    rmSync(join(css, "style.css"));
    symlinkSync(join(lane, "artifact.json"), join(css, "style.css"));
    expect(run(["--lane", lane, "--impl", css, "--out", join(outDir, "a.json")])).toMatchObject({ status: 2, out: { code: "IMPL_FILES_MISSING" } });
    const assets = implDir();
    symlinkSync(join(lane, "originals"), join(assets, "assets"));
    expect(run(["--lane", lane, "--impl", assets, "--out", join(outDir, "b.json")])).toMatchObject({ status: 2, out: { code: "IMPL_ASSET_INVALID" } });
    const odd = implDir();
    mkdirSync(join(odd, "assets"));
    writeFileSync(join(odd, "assets/notes.txt"), "x");
    expect(run(["--lane", lane, "--impl", odd, "--out", join(outDir, "c.json")])).toMatchObject({ status: 2, out: { code: "IMPL_ASSET_INVALID" } });
    for (const f of ["a.json", "b.json", "c.json"]) expect(existsSync(join(outDir, f))).toBe(false);
  }, 120_000);

  it("a browser that does not start still writes a not_compared report", () => {
    const out = join(tmp("dev139-out-"), "r.json");
    expect(run(["--lane", lane, "--impl", implDir(), "--out", out], { PLAYWRIGHT_CHROMIUM_EXECUTABLE: "/nonexistent/chrome" })).toMatchObject({ status: 0, out: { status: "not_compared" } });
    expect(JSON.parse(readFileSync(out, "utf8")).viewports.mobile_390.implementation.state).toBe("render_failed");
  }, 120_000);
});
