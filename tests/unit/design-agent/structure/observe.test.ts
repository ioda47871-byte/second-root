import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { observeStructure } from "@/lib/design-agent/structure/observe";
import { describe as describeMeasure, measurePage, VIEWPORTS } from "@/lib/design-agent/structure/measure";
import { ReferenceDescriptors } from "@/lib/design-agent/structure/references";

// DEV-138 (Issue #175): the offline, report-only structure observation of a Phase 2f prototype. Fictional pages and a
// fictional reference set only; no model, no network.

const REPO = resolve(__dirname, "../../../..");
let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
});
afterAll(async () => {
  await browser.close();
});

const doc = (body: string) => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body>${body}</body></html>`;
/** A generic landing page: a split hero and full-width bands of copy beside a picture, cut hard. */
const GENERIC = doc(
  ["hero", "a", "b", "c", "d"]
    .map((id, i) => `<section data-section="${id}" class="band b${i}"><div class="copy"><h2>架空の見出し${i}</h2><p>架空の本文</p><a href="#a">詳しく</a></div><img src="assets/A1.png" alt=""></section>`)
    .join(""),
);
const GENERIC_CSS = "body{margin:0} .band{display:flex;align-items:center;gap:40px;padding:48px;min-height:520px;width:100%;box-sizing:border-box} .band .copy{flex:1} .band img{flex:1;width:50%;height:360px;object-fit:cover} .b0{background:#eee}.b1{background:#ddd}.b2{background:#eee}.b3{background:#ddd}.b4{background:#eee} @media (max-width:600px){.band{flex-direction:column}.band img{width:100%}}";
/** A page that is not a landing page: one long drawn surface, vertical type, overlapping sections. */
const OWN = doc(`<section data-section="a" class="s1"><svg viewBox="0 0 10 10" class="draw"><circle cx="5" cy="5" r="4"/></svg><h1 class="v">架空継工房</h1></section><section data-section="b" class="s2"><p>架空の事実</p></section><section data-section="c" class="s3"><p>架空の案内</p></section>`);
const OWN_CSS = "body{margin:0;background:#f3efe6} section{position:relative;padding:40px} .s1{height:900px} .s2{margin-top:-120px;height:600px} .s3{margin-top:-80px;height:500px} .draw{width:800px;height:700px} .v{writing-mode:vertical-rl;font-size:64px;position:absolute;right:80px;top:60px}";

const set = (success: object[], rejected: object[]) =>
  ReferenceDescriptors.parse({ schema: "reference_structure_descriptors_v0", as_of: "2026-11-01", status: "provisional_declared_from_research_records", scope: "offline_advisory_only_not_generation_input", vocabulary: "structure_descriptor_v0", note: "fictional test set", success, rejected });
const declaredFrom = (d: Record<string, unknown>) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, k === "schema" || v === null ? v : { ...(v as object), source: "declared" }]));
const GENERIC_REJECTED = {
  id: "CP-990-v1",
  case: "CP-990",
  verdict: "fictional: generic",
  basis: ["docs/design/reference-structure-descriptors.md"],
  descriptor: { schema: "structure_descriptor_v0", hero: { value: "split_copy_media", source: "declared" }, flow: { value: "stacked_bands", source: "declared" }, navigation: null, reading_path: null, section_layouts: { value: ["split_copy_media", "split_copy_media", "split_copy_media", "split_copy_media", "split_copy_media"], source: "declared" }, transitions: { value: ["hard_cut", "hard_cut", "hard_cut", "hard_cut"], source: "declared" }, text_direction: null, imagery: null },
};
const SPARSE = { id: "CP-991", evidence: "text_record", basis: ["docs/design/reference-structure-descriptors.md"], descriptor: { schema: "structure_descriptor_v0", hero: { value: "type_led", source: "declared" }, flow: null, navigation: null, reading_path: null, section_layouts: null, transitions: null, text_direction: null, imagery: null } };

describe("structure observation (offline, report-only)", () => {
  it("a generic page is named close to a rejected skeleton, with its generic signs, at both widths' own geometry", async () => {
    const o = await observeStructure(browser, { html: GENERIC, css: GENERIC_CSS }, set([SPARSE], [GENERIC_REJECTED]));
    expect(o).toMatchObject({ status: "observed", check_failed: null, advisory: true, scope: "offline_report_only" });
    expect(o.viewports!.desktop_1440.close_to_rejected.map((m) => m.id)).toEqual(["CP-990-v1"]);
    expect(o.viewports!.desktop_1440.generic_skeleton).not.toBeNull();
    // the phone stacks the bands: its own geometry, not the desktop's
    expect(o.viewports!.mobile_390.measured).not.toEqual(o.viewports!.desktop_1440.measured);
  }, 60_000);

  it("a page with a success case's skeleton is named as too close to it (a copy)", async () => {
    const own = describeMeasure(await measurePage(browser, { html: OWN, css: OWN_CSS }, VIEWPORTS.desktop));
    const copied = { id: "CP-992", evidence: "text_record", basis: ["docs/design/reference-structure-descriptors.md"], descriptor: declaredFrom(own) };
    const o = await observeStructure(browser, { html: OWN, css: OWN_CSS }, set([copied, SPARSE], [GENERIC_REJECTED]));
    expect(o.viewports!.desktop_1440.too_close_to_success.map((m) => m.id)).toEqual(["CP-992"]);
    expect(o.viewports!.desktop_1440.close_to_rejected).toEqual([]);
  }, 60_000);

  it("never declares for the candidate: hero and flow stay unknown unless geometry shows a generic sign", async () => {
    const o = await observeStructure(browser, { html: OWN, css: OWN_CSS }, set([SPARSE], []));
    const pc = o.viewports!.desktop_1440;
    expect(pc.unknown_aspects).toEqual(expect.arrayContaining(["hero", "flow", "reading_path"]));
    expect(Object.keys(pc.measured)).not.toContain("hero");
  }, 60_000);

  it("a reference too sparse to compare is undecided, never 'not close'; with only such references nothing is decided", async () => {
    const o = await observeStructure(browser, { html: OWN, css: OWN_CSS }, set([SPARSE], []));
    expect(o.viewports!.desktop_1440).toMatchObject({ too_close_to_success: [], close_to_rejected: [], undecided: ["CP-991"] });
    // DEV-144: its record (Hero only, ceiling 0.2) can never be decided: reported as too thin, not as a finding
    expect(o.viewports!.desktop_1440.undecided_too_thin).toEqual(["CP-991"]);
    expect(o.viewports!.mobile_390.undecided_too_thin).toEqual(["CP-991"]);
  }, 60_000);

  it("a page that cannot be measured is check_failed with its reason, never a clean result", async () => {
    const refused = await observeStructure(browser, { html: doc('<iframe src="about:blank"></iframe>'), css: "" }, set([SPARSE], []));
    expect(refused).toMatchObject({ status: "check_failed", viewports: null, check_failed: { code: "MEASURE_PAGE_REFUSED" } });
    const closed = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
    await closed.close();
    const failed = await observeStructure(closed, { html: OWN, css: OWN_CSS }, set([SPARSE], []));
    expect(failed).toMatchObject({ status: "check_failed", viewports: null, check_failed: { code: "MEASURE_FAILED" } });
    expect(failed.check_failed!.detail.length).toBeGreaterThan(0);
  }, 60_000);

  it("with the real (provisional) reference set, a generic page is close to recorded rejected versions", async () => {
    const real = ReferenceDescriptors.parse(JSON.parse(readFileSync(join(REPO, "design-library/intelligence/v02/structure-descriptors-v0.json"), "utf8")));
    const o = await observeStructure(browser, { html: GENERIC, css: GENERIC_CSS }, real);
    expect(o.viewports!.desktop_1440.close_to_rejected.length).toBeGreaterThan(0);
    expect(o.viewports!.desktop_1440.too_close_to_success).toEqual([]);
  }, 60_000);
});

describe("the observation CLI (reads a finished package, writes one report elsewhere)", () => {
  const CLI = join(REPO, "scripts/design-artifact/phase2f-structure-observe.ts");
  const run = (args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], { cwd: REPO, encoding: "utf8", env: { ...process.env, ...env } });
    return { status: r.status, out: JSON.parse(r.stdout || "{}") as Record<string, unknown> };
  };
  const pkg = (route: string) => {
    const dir = mkdtempSync(join(tmpdir(), "observe-pkg-"));
    mkdirSync(join(dir, "quarantine"));
    writeFileSync(join(dir, "artifact.json"), JSON.stringify({ artifact_id: "DA-20261101-abc123", route }));
    writeFileSync(join(dir, "quarantine/index.html"), GENERIC);
    writeFileSync(join(dir, "quarantine/style.css"), GENERIC_CSS);
    return dir;
  };
  const hashes = (dir: string) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => `${e.name}:${createHash("sha256").update(readFileSync(join(e.parentPath, e.name))).digest("hex")}`).sort();
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("writes the report outside the package and leaves every file of the package byte-for-byte unchanged", () => {
    const dir = pkg("B_html_prototype");
    const outDir = mkdtempSync(join(tmpdir(), "observe-out-"));
    dirs.push(dir, outDir);
    const before = hashes(dir);
    const r = run(["--package", dir, "--out", join(outDir, "report.json")]);
    expect(r).toMatchObject({ status: 0, out: { status: "observed" } });
    expect(hashes(dir)).toEqual(before);
    const report = JSON.parse(readFileSync(join(outDir, "report.json"), "utf8"));
    expect(report).toMatchObject({ schema: "structure_observation_v0", advisory: true, package: { artifact_id: "DA-20261101-abc123", route: "B_html_prototype" }, reference_set: { status: "provisional_declared_from_research_records" } });
    // never overwrites a report
    expect(run(["--package", dir, "--out", join(outDir, "report.json")])).toMatchObject({ status: 2, out: { code: "OUT_EXISTS_OR_UNWRITABLE" } });
  }, 120_000);

  it("refuses a report inside the package, a package without a prototype, and bad arguments", () => {
    const dir = pkg("B_html_prototype");
    const concept = pkg("A_image");
    dirs.push(dir, concept);
    expect(run(["--package", dir, "--out", join(dir, "report.json")])).toMatchObject({ status: 2, out: { code: "OUT_INSIDE_PACKAGE" } });
    expect(run(["--package", concept, "--out", join(tmpdir(), `x-${Date.now()}.json`)])).toMatchObject({ status: 2, out: { code: "NOT_A_PROTOTYPE_PACKAGE" } });
    expect(run(["--package", dir])).toMatchObject({ status: 2, out: { code: "ARGS_INVALID" } });
  }, 120_000);

  it("review M1 / M2: never writes into the package, not by a name starting with '..' nor through a link", () => {
    const dir = pkg("B_html_prototype");
    const links = mkdtempSync(join(tmpdir(), "observe-links-"));
    dirs.push(dir, links);
    const before = hashes(dir);
    expect(run(["--package", dir, "--out", join(dir, "..report.json")])).toMatchObject({ status: 2, out: { code: "OUT_INSIDE_PACKAGE" } });
    symlinkSync(dir, join(links, "to-pkg"));
    expect(run(["--package", dir, "--out", join(links, "to-pkg", "r.json")])).toMatchObject({ status: 2, out: { code: "OUT_INSIDE_PACKAGE" } });
    expect(run(["--package", join(links, "to-pkg"), "--out", join(dir, "r.json")])).toMatchObject({ status: 2, out: { code: "OUT_INSIDE_PACKAGE" } });
    expect(hashes(dir)).toEqual(before);
    expect(existsSync(join(dir, "..report.json"))).toBe(false);
  }, 120_000);

  it("review L2: a browser that does not start is a written check_failed report, never a clean one", () => {
    const dir = pkg("B_html_prototype");
    const outDir = mkdtempSync(join(tmpdir(), "observe-out-"));
    dirs.push(dir, outDir);
    expect(run(["--package", dir, "--out", join(outDir, "r.json")], { PLAYWRIGHT_CHROMIUM_EXECUTABLE: "/nonexistent/chrome" })).toMatchObject({ status: 0, out: { status: "check_failed" } });
    expect(JSON.parse(readFileSync(join(outDir, "r.json"), "utf8"))).toMatchObject({ status: "check_failed", viewports: null, check_failed: { code: "BROWSER_LAUNCH_FAILED" } });
  }, 120_000);

  it("review L1 / L3: refuses a broken reference file, and a linked or oversized prototype file", () => {
    const dir = pkg("B_html_prototype");
    const outDir = mkdtempSync(join(tmpdir(), "observe-out-"));
    dirs.push(dir, outDir);
    writeFileSync(join(outDir, "bad.json"), "{not json");
    expect(run(["--package", dir, "--out", join(outDir, "a.json"), "--references", join(outDir, "bad.json")])).toMatchObject({ status: 2, out: { code: "REFERENCES_INVALID" } });
    rmSync(join(dir, "quarantine/style.css"));
    symlinkSync("/etc/hostname", join(dir, "quarantine/style.css"));
    expect(run(["--package", dir, "--out", join(outDir, "b.json")])).toMatchObject({ status: 2, out: { code: "PROTOTYPE_FILES_MISSING" } });
    rmSync(join(dir, "quarantine/style.css"));
    writeFileSync(join(dir, "quarantine/style.css"), "x".repeat(300 * 1024));
    expect(run(["--package", dir, "--out", join(outDir, "c.json")])).toMatchObject({ status: 2, out: { code: "PROTOTYPE_FILES_MISSING" } });
  }, 120_000);

  it("review round 2: never reads through a linked quarantine/, assets/ or artifact.json", () => {
    const outDir = mkdtempSync(join(tmpdir(), "observe-out-"));
    const elsewhere = pkg("B_html_prototype");
    dirs.push(outDir, elsewhere);
    // a linked quarantine/ would render a prototype from outside the package
    const q = pkg("B_html_prototype");
    dirs.push(q);
    rmSync(join(q, "quarantine"), { recursive: true });
    symlinkSync(join(elsewhere, "quarantine"), join(q, "quarantine"));
    expect(run(["--package", q, "--out", join(outDir, "q.json")])).toMatchObject({ status: 2, out: { code: "PROTOTYPE_FILES_MISSING" } });
    // a linked assets/ likewise
    const a = pkg("B_html_prototype");
    dirs.push(a);
    mkdirSync(join(elsewhere, "assets"));
    symlinkSync(join(elsewhere, "assets"), join(a, "assets"));
    expect(run(["--package", a, "--out", join(outDir, "a.json")])).toMatchObject({ status: 2, out: { code: "PACKAGE_ASSET_INVALID" } });
    // a linked artifact.json would copy another package's id into the report
    const j = pkg("B_html_prototype");
    dirs.push(j);
    rmSync(join(j, "artifact.json"));
    symlinkSync(join(elsewhere, "artifact.json"), join(j, "artifact.json"));
    expect(run(["--package", j, "--out", join(outDir, "j.json")])).toMatchObject({ status: 2, out: { code: "PACKAGE_UNREADABLE" } });
    for (const f of ["q.json", "a.json", "j.json"]) expect(existsSync(join(outDir, f))).toBe(false);
  }, 120_000);

  it("review round 3: reads a real assets/ directory, and refuses an image over the intake cap (16 MiB)", () => {
    const outDir = mkdtempSync(join(tmpdir(), "observe-out-"));
    const dir = pkg("B_html_prototype");
    dirs.push(outDir, dir);
    mkdirSync(join(dir, "assets"));
    // a 1x1 PNG
    writeFileSync(join(dir, "assets/A1.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
    writeFileSync(join(dir, "assets/A2.png"), Buffer.alloc(16 * 1024 * 1024));
    expect(run(["--package", dir, "--out", join(outDir, "ok.json")])).toMatchObject({ status: 0, out: { status: "observed" } });
    writeFileSync(join(dir, "assets/A3.png"), Buffer.alloc(16 * 1024 * 1024 + 1));
    expect(run(["--package", dir, "--out", join(outDir, "big.json")])).toMatchObject({ status: 2, out: { code: "PACKAGE_ASSET_INVALID" } });
    expect(existsSync(join(outDir, "big.json"))).toBe(false);
  }, 120_000);
});
