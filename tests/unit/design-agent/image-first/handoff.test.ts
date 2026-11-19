import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compareImageFirst, ImageFirstStop, toImplCompareInput } from "@/lib/design-agent/image-first/adapter";
import { assembleRecord, readImageFirstRun, readImplementationAssets } from "@/lib/design-agent/image-first/builder";
import { decodeRgb } from "@/lib/design-agent/image-first/pixels";
import { validateImageFirst } from "@/lib/design-agent/image-first/validate";
import { cleanup, makeRun, SHOP } from "./fixtures";

// Issue #293 P1: the dummy end to end — build → validate → owner gate → adapter → the implementation comparison
// (impl-lane's own renderImplementation / compareViewport) against a trivial HTML page. No model, no network.

const REPO = resolve(__dirname, "../../../..");
const run = promisify(execFile);
let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
});
afterAll(async () => {
  await browser?.close();
  cleanup();
});

const ready = async () => {
  const r = makeRun({ owner: true });
  const verdict = validateImageFirst(await readImageFirstRun(r.dir));
  expect(verdict.status, JSON.stringify(verdict.details)).toBe("READY_FOR_IMPLEMENTATION");
  return { ...r, verdict };
};

/** A trivial page with the five sections as flat bands at the comp's declared heights (PC; SP under 600 px). */
const PAGE = {
  html: `<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body>
<header data-section="header"><p>${SHOP.display_name}</p></header><section data-section="hero"><h1>灯りのある夜へ</h1></section>
<section data-section="story"><p>毎晩灯す小さなランプを並べています。</p></section><section data-section="info"><p>営業時間</p><p>18:00〜22:00</p></section>
<footer data-section="footer"><p>${SHOP.display_name}</p></footer></body></html>`,
  css: `*{margin:0;padding:0;box-sizing:border-box}body{font:16px sans-serif;color:#f5f0e6}
[data-section]{display:block;overflow:hidden}
[data-section=header]{height:115px;background:#1e1e28}[data-section=hero]{height:845px;background:#c8963c}
[data-section=story]{height:432px;background:#f0ebdc;color:#282828}[data-section=info]{height:384px;background:#466e5a}
[data-section=footer]{height:144px;background:#141419}
@media (max-width:600px){[data-section=header]{height:58px}[data-section=hero]{height:527px}[data-section=story]{height:351px}[data-section=info]{height:468px}[data-section=footer]{height:351px}}`,
};

describe("the adapter: an approved comp to the implementation comparison at exactly 1440 / 390", { timeout: 120_000 }, () => {
  it("READY only: AWAITING_OWNER_EVALUATION, REJECT or a copied verdict object is refused", async () => {
    const awaiting = validateImageFirst(await readImageFirstRun(makeRun().dir));
    expect(awaiting.status).toBe("AWAITING_OWNER_EVALUATION");
    expect(() => toImplCompareInput(awaiting)).toThrow(ImageFirstStop);
    const rejected = validateImageFirst(await readImageFirstRun(makeRun({ owner: true, mutate: (r) => (r.rights.page_asset = true) }).dir));
    expect(rejected.status).toBe("REJECT");
    expect(() => toImplCompareInput(rejected)).toThrow("NOT_READY_FOR_IMPLEMENTATION");
    const { verdict } = await ready();
    // a verdict rebuilt from its JSON (or forged by hand) carries no hand-off: only validateImageFirst's own object does
    expect(() => toImplCompareInput(JSON.parse(JSON.stringify(verdict)) as typeof verdict)).toThrow("NOT_READY_FOR_IMPLEMENTATION");
  });

  it("composites at exactly 1440 and 390 px wide, scales recorded, declared boxes in composite px (a continuous section is one box)", async () => {
    const { verdict } = await ready();
    const input = toImplCompareInput(verdict);
    const pc = decodeRgb(input.viewports.desktop_1440.png)!;
    const sp = decodeRgb(input.viewports.mobile_390.png)!;
    expect([pc.width, pc.height, sp.width, sp.height]).toEqual([1440, 1920, 390, 1755]);
    expect(input.viewports.desktop_1440.box_source).toBe("declared");
    expect(input.viewports.desktop_1440.parts.map((p) => [p.index, p.scale, p.y, p.height])).toEqual([
      [1, 1.25, 0, 960],
      [2, 1.25, 960, 960],
    ]);
    expect(input.viewports.mobile_390.parts.map((p) => p.y)).toEqual([0, 585, 1170]);
    expect(input.viewports.desktop_1440.sections).toEqual([
      { id: "header", box: { x: 0, y: 0, w: 1440, h: 116 } },
      { id: "hero", box: { x: 0, y: 115, w: 1440, h: 845 } },
      { id: "story", box: { x: 0, y: 960, w: 1440, h: 432 } },
      { id: "info", box: { x: 0, y: 1392, w: 1440, h: 384 } },
      { id: "footer", box: { x: 0, y: 1776, w: 1440, h: 144 } },
    ]);
    // SP: info starts in part 2 (60 %) and continues into part 3 (to 40 %): one box over the seam
    expect(input.viewports.mobile_390.sections.find((s) => s.id === "info")).toEqual({ id: "info", box: { x: 0, y: 936, w: 390, h: 468 } });
    expect(input.record_sha256).toBe(verdict.record_sha256);
  });

  it("dummy end to end: the comparison runs against a trivial page (report only, passing false)", async () => {
    const { verdict } = await ready();
    const report = await compareImageFirst(browser, toImplCompareInput(verdict), { html: PAGE.html, css: PAGE.css, assets: new Map() });
    expect(report).toMatchObject({ schema: "image_first_compare_report_v0", scope: "offline_report_only", advisory: true, passing: false, status: "compared" });
    for (const v of ["desktop_1440", "mobile_390"] as const) {
      expect(report.viewports[v].implementation.state).toBe("rendered");
      expect(report.viewports[v].compare!.code).toBeNull();
      expect(report.viewports[v].compare!.order_changed).toBe(false);
    }
    // every section found on both sides; the page's blocks of text differ from the comp's blocks (reported, never judged)
    expect(report.differences.filter((d) => /MISSING|NOT_VISIBLE|ORDER|WIDTH/.test(d))).toEqual([]);
    // a browser that does not start: render_failed, never a clean result
    const failed = await compareImageFirst(null, toImplCompareInput(verdict), { html: PAGE.html, css: PAGE.css, assets: new Map() }, new Error("no browser"));
    expect([failed.status, failed.viewports.desktop_1440.implementation.state]).toEqual(["not_compared", "render_failed"]);
  });
});

describe("the builder (read only) and the CLI", { timeout: 120_000 }, () => {
  it("assembleRecord computes every SHA, size and dimension from the files (the plan's values are replaced)", async () => {
    const { dir, record } = makeRun();
    const plan = JSON.parse(JSON.stringify(record)) as typeof record;
    plan.facts_pack_sha256 = null;
    plan.direction.direction_sha256 = null;
    for (const p of [...plan.viewports.desktop_1440!.parts, ...plan.viewports.mobile_390!.parts]) Object.assign(p, { png_sha256: "0".repeat(64), width: 1, height: 1, bytes: 1, prompt_sha256: "0".repeat(64), prompt_chars: 1 });
    writeFileSync(join(dir, "run-plan.json"), JSON.stringify(plan));
    const built = await assembleRecord(dir);
    expect(built.problems).toEqual([]);
    expect(built.record).toEqual(record);
    rmSync(join(dir, "parts", "sp-03.png"));
    expect((await assembleRecord(dir)).problems).toEqual(["PART_UNREADABLE_mobile_390_3"]);
  });

  it("more implementation assets than the comparison serves are reported, never silently cut", async () => {
    const impl = mkdtempSync(join(tmpdir(), "sr-image-first-impl-"));
    try {
      mkdirSync(join(impl, "assets"));
      for (let i = 0; i < 33; i++) writeFileSync(join(impl, "assets", `a${String(i).padStart(2, "0")}.png`), "x");
      const assets = await readImplementationAssets(impl);
      expect(assets[0]).toMatchObject({ path: "assets", source: "too_many" });
      expect(assets).toHaveLength(33);
      expect(validateImageFirst({ ...(await readImageFirstRun(makeRun().dir)), implementationAssets: assets }).rejects).toContain("ASSET_RIGHTS_MISSING");
    } finally {
      rmSync(impl, { recursive: true, force: true });
    }
  });

  it("the CLI prints the verdict, refuses a run directory inside the repository, and writes nothing", async () => {
    const tsx = join(REPO, "node_modules/.bin/tsx");
    const cli = join(REPO, "scripts/design-artifact/image-first-check.ts");
    const call = (args: string[]) => run(tsx, [cli, ...args], { cwd: REPO }).then((r) => ({ code: 0, out: JSON.parse(r.stdout) as Record<string, unknown> }), (e: { code: number; stdout: string }) => ({ code: e.code, out: JSON.parse(e.stdout) as Record<string, unknown> }));
    const awaiting = makeRun();
    const before = readdirSync(awaiting.dir, { recursive: true }).map(String).sort();
    const mtime = statSync(join(awaiting.dir, "manifest.json")).mtimeMs;
    expect(await call(["--run", awaiting.dir])).toMatchObject({ code: 1, out: { status: "AWAITING_OWNER_EVALUATION", rejects: [] } });
    expect(readdirSync(awaiting.dir, { recursive: true }).map(String).sort()).toEqual(before);
    expect(statSync(join(awaiting.dir, "manifest.json")).mtimeMs).toBe(mtime);
    expect(await call(["--run", makeRun({ owner: true }).dir])).toMatchObject({ code: 0, out: { status: "READY_FOR_IMPLEMENTATION" } });
    expect(await call(["--run", makeRun({ mutate: (r) => (r.generation.stop_code = "CODEX_NO_IMAGE") }).dir])).toMatchObject({ code: 1, out: { status: "REJECT" } });
    expect(await call(["--run", join(REPO, "docs")])).toEqual({ code: 2, out: { status: "refused", code: "RUN_DIR_IN_REPO" } });
    expect(await call(["--run", awaiting.dir, "--assemble", awaiting.dir])).toEqual({ code: 2, out: { status: "refused", code: "ARGS_INVALID" } });
    const empty = mkdtempSync(join(tmpdir(), "sr-image-first-empty-"));
    try {
      expect(await call(["--assemble", empty])).toEqual({ code: 1, out: { status: "not_assembled", problems: ["PLAN_MISSING_OR_INVALID"] } });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
