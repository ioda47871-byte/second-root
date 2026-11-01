import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { intakeArtifact } from "@/lib/design-agent/artifact/intake";
import { DNA_PARTS, FactsPack } from "@/lib/design-agent/artifact/schema";
import { auditPageText, type IdentityStatus } from "@/lib/design-agent/identity/identity-lock";
import { compareImplementation, type ImplCompareReport } from "@/lib/design-agent/impl-lane/impl-compare";
import { prepareImplementationLane, LaneStop } from "@/lib/design-agent/impl-lane/handoff";
import { LIMITS } from "@/lib/design-agent/loop/controller";
import { DesignBrief } from "@/lib/design-agent/phase2f/prompt";
import { checkPrototype } from "@/lib/design-agent/phase2f/prototype-safety";
import { renderPrototype } from "@/lib/design-agent/phase2f/render-prototype";
import { runPrototypeRoute, type DesignPort } from "@/lib/design-agent/phase2f/runner";
import { observeStructure, type StructureObservation } from "@/lib/design-agent/structure/observe";
import { ReferenceDescriptors } from "@/lib/design-agent/structure/references";
import { MOCK, MOCK_GENERATION, mockPng, outDir, readRepo, REPO, repairLoop, sha256, STUDY, templateKeys, unsourcedLines, visibleText, WIDTHS, type Method, type Page } from "./three-methods-mock";

// DEV-142 (Issue #180): a MOCK end-to-end run of the three methods of the study (docs/design/three-methods-study.md §3,
// §4, §5, §8) on saved fictional fixtures (design-library/research/three-methods/mock/). Offline: no Codex, no image
// generation, no network, no paid API. The Codex outputs are hand-written fixtures returned by fake ports, the asset is
// a solid-colour PNG made in code. The checks are the existing tools only. NOTHING HERE IS EVIDENCE THAT ONE METHOD IS
// BETTER: every record is run_kind "mock" and says so.

let browser: Browser;
const out = outDir();
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
});
afterAll(async () => {
  await browser?.close();
  if (out.temp) rmSync(out.dir, { recursive: true, force: true });
});

const factsPath = resolve(REPO, STUDY, "facts-pack.json");
const pack = FactsPack.parse(JSON.parse(readRepo(`${STUDY}/facts-pack.json`)));
const factValues = pack.facts.map((f) => f.value);
const shopName = pack.facts.find((f) => f.key === "name")!.value;
const lock = JSON.parse(readRepo(`${STUDY}/identity-lock.json`));
const template = JSON.parse(readRepo(`${STUDY}/run-record-template.json`));
const references = ReferenceDescriptors.parse(JSON.parse(readRepo("design-library/intelligence/v02/structure-descriptors-v0.json")));
const brief = DesignBrief.parse(JSON.parse(readRepo(`${MOCK}/runner-brief.json`)));
const SECTIONS = ["header", "hero", "products", "story", "info", "footer"];
const page = (dir: string, css = "style.css", assets: ReadonlyMap<string, Buffer> = new Map()): Page => ({ html: readRepo(`${MOCK}/${dir}/index.html`), css: readRepo(`${MOCK}/${dir}/${css}`), assets });
const worst = (a: IdentityStatus[]): IdentityStatus => (a.includes("REJECT") ? "REJECT" : a.includes("HOLD") ? "HOLD" : "PASS_IDENTITY_ONLY");

/** The shared checks of §5 on one page, existing tools only (and the evaluation's unsourced-line count, record-only). */
async function sharedChecks(p: Page, sectionIds: readonly string[]) {
  // B-route constraints (no script, no outside request): the existing prototype safety check
  await checkPrototype(browser, p, [...p.assets.keys()]);
  const rendered = await renderPrototype(browser, p, p.assets, sectionIds, { facts: factValues, shopName });
  const text = { desktop_1440: await visibleText(browser, p, 1440), mobile_390: await visibleText(browser, p, 390) };
  const identity = { desktop_1440: auditPageText(lock, text.desktop_1440), mobile_390: auditPageText(lock, text.mobile_390) };
  const unsourced = { desktop_1440: unsourcedLines(text.desktop_1440, factValues), mobile_390: unsourcedLines(text.mobile_390, factValues) };
  const structure = await observeStructure(browser, { html: p.html, css: p.css, assets: Object.fromEntries(p.assets) }, references);
  return { rendered, text, identity, unsourced, structure, scrollWidth: { desktop_1440: rendered.desktop_1440.scrollWidth, mobile_390: rendered.mobile_390.scrollWidth } };
}
type Checks = Awaited<ReturnType<typeof sharedChecks>>;

/** Claude's implementation through the repair-trigger rule (§4); returns the loop's outcome and the final attempt's checks. */
async function implement(attempts: Page[], sectionIds: readonly string[]) {
  const checks: Checks[] = [];
  const loop = await repairLoop(attempts, async (a) => {
    const c = await sharedChecks(a, sectionIds);
    checks.push(c);
    return { identity: worst([c.identity.desktop_1440.status, c.identity.mobile_390.status]), scrollWidth: c.scrollWidth };
  });
  return { loop, final: checks[loop.final]!, page: attempts[loop.final]! };
}

type Run = {
  method: Method;
  started: string;
  finished: string;
  codexCalls: object[];
  impl: Awaited<ReturnType<typeof implement>>;
  implFiles: { html: string; css: string };
  extraArtifacts: { path: string; sha256: string; what: string }[];
  assetRequests: object[];
  mockAssets: number;
  compare: ImplCompareReport | null;
  renderStops: object[];
  stops: object[];
};
const runs: Partial<Record<Method, Run>> = {};
const mockCall = (purpose: "design" | "direction" | "asset", at: string, o: { prompt_sha256: string | null; prompt_chars: number; note: string }) => ({
  purpose,
  approval_id: null,
  plan_id: null,
  prompt_sha256: o.prompt_sha256,
  prompt_chars: o.prompt_chars,
  started_at: at,
  finished_at: at,
  outcome: "mock" as const,
  retry_of: null,
  commit: null,
  cli_version: null,
  model_reported: null,
  mock_note: o.note,
});
const write = (name: string, b: Buffer | string) => {
  const p = join(out.dir, name);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, b);
  return { path: `<mock-out>/${name}`, sha256: sha256(b) };
};
/** Where the asset really shows (measured by the render), in the shape of the runner's AssetRequest; no prompt exists for it yet. */
const assetRequest = (c: Checks, alt: string) => {
  const placement = Object.fromEntries((["desktop_1440", "mobile_390"] as const).map((k) => [k, c.rendered[k].assets["assets/A1.png"]]));
  const a = c.rendered;
  const essential = (["desktop_1440", "mobile_390"] as const).some((k) => (a[k].assets["assets/A1.png"]!.sections.includes("hero") && a[k].assets["assets/A1.png"]!.firstScreen) || a[k].assets["assets/A1.png"]!.outsideSections);
  return { asset_id: "A1", alt, prompt: null, prompt_sha256: null, prompt_chars: 0, placement, essential, note: "MOCK: Claude-written asset requests have no image entrance yet (DEV-143); the solid-colour PNG stands in" };
};

describe("MOCK end-to-end run of the three methods (pipeline verification only, not evidence of method quality)", () => {
  it("the fixtures are labelled MOCK, the direction covers the 8 DNA parts, and the asset is a solid-colour PNG made in code", () => {
    const readme = readRepo(`${MOCK}/README.md`);
    expect(readme).toContain("MOCK");
    expect(readme).toContain("方式の優劣の証拠にしない");
    const results = readRepo("docs/design/three-methods-study.md").split("## 12. ")[1] ?? "";
    expect(results).toMatch(/^模擬の通し実行の結果 \(DEV-142、MOCK\)/);
    expect(results).toContain("**MOCK。これは手順・引き渡し・検査・記録の通しの確かめだけで、方式の優劣の証拠にしない。**");
    const direction = readRepo(`${MOCK}/direction-first/direction.md`);
    expect(direction).toMatch(/^# MOCK/);
    expect(direction.match(/^## (\w+)$/gm)?.map((h) => h.slice(3))).toEqual([...DNA_PARTS]);
    for (const f of ["visual-first/codex-prototype", "visual-first/claude-impl", "layout-first/claude-impl", "direction-first/claude-impl"]) {
      expect(readRepo(`${MOCK}/${f}/index.html`), f).toContain(">MOCK ");
      expect(readRepo(`${MOCK}/${f}/style.css`), f).toMatch(/^\/\* MOCK/);
    }
    const png = mockPng(4, 3, [1, 2, 3]);
    expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
    expect(png.toString("latin1")).toContain("MOCK solid-colour stand-in");
  });

  it("the unsourced-line count follows the evaluation's rule (a count in this test, never a quality check)", () => {
    const facts = ["毎朝5時から石窯に火を入れています", "比較研究用の架空のパン屋です。実在の店舗ではありません。"];
    expect(unsourcedLines(["営業時間", "毎朝5時から石窯に火を入れています", "比較研究用の架空のパン屋です。", "焼きたてを、どうぞ", "朝の香りが広がる。", "MOCK 模擬の実装"].join("\n"), facts)).toEqual(["焼きたてを、どうぞ", "朝の香りが広がる。"]);
  });

  it("VISUAL_FIRST (V-B): fake design port → real Phase 2f runner → render_pair_complete → lane → separately written implementation → impl-compare", async () => {
    const started = new Date().toISOString();
    const proto = page("visual-first/codex-prototype");
    const answer = { ...JSON.parse(readRepo(`${MOCK}/visual-first/codex-answer.json`)), prototype: { html: proto.html, css: proto.css } };
    const seen: { sha: string; chars: number }[] = [];
    const designPort: DesignPort = async (req) => {
      seen.push({ sha: req.promptSha256, chars: req.prompt.length });
      return { answer, generation: { ...MOCK_GENERATION, prompt_sha256: req.promptSha256 } };
    };
    mkdirSync(join(out.dir, "visual-first"), { recursive: true });
    const packageDir = join(out.dir, "visual-first", "package");
    const r = await runPrototypeRoute({ route: "B_html_prototype", browser, facts: { path: factsPath, pack }, shop: { shop_id: pack.shop_id, display_name: shopName }, brief, artifactId: "DA-20261101-mockvb", outDir: packageDir, designPort });
    expect(r.status).toBe("done");
    if (r.status !== "done") return;
    expect(seen).toHaveLength(1);
    expect(r.log).toMatchObject({ design_calls: 1, asset_calls: 0, route_delivered: "B_html_prototype", stops: [] });
    // the Codex design's own identity (the runner does not run it): REJECT / HOLD would stop the run here
    const designText = await visibleText(browser, proto, 1440);
    expect(auditPageText(lock, designText).status).toBe("PASS_IDENTITY_ONLY");
    // the hand-off condition is the machine state (intake run again here, and once more inside the lane)
    const intake = await intakeArtifact({ packageDir, factsPath });
    expect(intake.verification_state).toBe("render_pair_complete");
    expect(intake.implementation_handoff_allowed).toBe(true);
    const laneDir = join(out.dir, "visual-first", "lane");
    const lane = await prepareImplementationLane({ packageDir, factsPath, laneDir });
    // the lane carries the originals and the record only: never the prototype's HTML / CSS
    expect(lane.files.map((f) => f.path).sort()).toEqual(["artifact.json", "originals/desktop_1440.png", "originals/mobile_390.png"]);
    expect(readdirSync(laneDir).sort()).toEqual(["artifact.json", "lane.json", "originals"]);
    const designPngs = Object.fromEntries((["desktop_1440", "mobile_390"] as const).map((k) => [k, readFileSync(join(laneDir, `originals/${k}.png`))]));

    // Claude's implementation: written separately from the originals (no shared file, no shared class name)
    const impl = page("visual-first/claude-impl");
    expect(sha256(impl.html)).not.toBe(sha256(proto.html));
    expect(sha256(impl.css)).not.toBe(sha256(proto.css));
    const classes = (h: string) => new Set([...h.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1]!.split(/\s+/)));
    expect([...classes(impl.html)].filter((c) => classes(proto.html).has(c))).toEqual([]);
    const done = await implement([impl], answer.structure_spec.sections.map((s: { id: string }) => s.id));
    const compare = await compareImplementation(browser, laneDir, impl);
    expect(compare.status).toBe("compared");
    writeFileSync(join(out.dir, "visual-first", "impl-compare.json"), JSON.stringify(compare, null, 2));
    runs.VISUAL_FIRST = {
      method: "VISUAL_FIRST",
      started,
      finished: new Date().toISOString(),
      codexCalls: [mockCall("design", started, { prompt_sha256: seen[0]!.sha, prompt_chars: seen[0]!.chars, note: "MOCK: a fake DesignPort returned the saved fixture (visual-first/codex-answer.json + codex-prototype/); the prompt is the runner's v1 prompt built from mock/runner-brief.json; nothing was sent" })],
      impl: done,
      implFiles: { html: `${MOCK}/visual-first/claude-impl/index.html`, css: `${MOCK}/visual-first/claude-impl/style.css` },
      extraArtifacts: [
        { ...write("visual-first-design-pc1440.png", designPngs.desktop_1440!), what: "design_original_pc_1440_png" },
        { ...write("visual-first-design-sp390.png", designPngs.mobile_390!), what: "design_original_sp_390_png" },
        { path: `${MOCK}/visual-first/codex-prototype/index.html`, sha256: sha256(proto.html), what: "codex_prototype_html_mock_not_handed_over" },
        { path: `${MOCK}/visual-first/codex-prototype/style.css`, sha256: sha256(proto.css), what: "codex_prototype_css_mock_not_handed_over" },
      ],
      assetRequests: [],
      mockAssets: 0,
      compare,
      renderStops: r.log.stops,
      stops: done.loop.stop ? [done.loop.stop] : [],
    };
  }, 180_000);

  it("LAYOUT_FIRST: Claude's layout, one MOCK asset, and one repair of its own horizontal overflow (attempt 1 → 2)", async () => {
    const started = new Date().toISOString();
    const assets = new Map([["assets/A1.png", mockPng(1200, 560, [197, 139, 58])]]);
    const attempts = [page("layout-first/claude-impl", "attempt-1/style.css", assets), page("layout-first/claude-impl", "style.css", assets)];
    const done = await implement(attempts, SECTIONS);
    // the first attempt overflowed on the phone only: one repair, then clean
    expect(done.loop.history.map((h) => h.overflow)).toEqual([["mobile_390"], []]);
    expect(done.loop).toMatchObject({ final: 1, repair_attempts: 1, fixes_by_cause: { IMPL_HORIZONTAL_OVERFLOW: 1 }, stop: null });
    const alt = "MOCK 単色の板 (写真の代わり)";
    runs.LAYOUT_FIRST = {
      method: "LAYOUT_FIRST",
      started,
      finished: new Date().toISOString(),
      codexCalls: [mockCall("asset", started, { prompt_sha256: null, prompt_chars: 0, note: "MOCK: no image call; a solid-colour PNG made in code stands in for the one asset (the entrance for a Claude-written request is DEV-143)" })],
      impl: done,
      implFiles: { html: `${MOCK}/layout-first/claude-impl/index.html`, css: `${MOCK}/layout-first/claude-impl/style.css` },
      extraArtifacts: [
        { path: `${MOCK}/layout-first/claude-impl/attempt-1/style.css`, sha256: sha256(attempts[0]!.css), what: "css_attempt_1_overflowing" },
        { ...write("layout-first-asset-A1.png", assets.get("assets/A1.png")!), what: "asset_mock_solid_colour" },
      ],
      assetRequests: [assetRequest(done.final, alt)],
      mockAssets: 1,
      compare: null,
      renderStops: [],
      stops: [],
    };
  }, 180_000);

  it("DIRECTION_FIRST: a MOCK direction text (8 DNA parts) → Claude's layout from it, one MOCK asset", async () => {
    const started = new Date().toISOString();
    const direction = readRepo(`${MOCK}/direction-first/direction.md`);
    const assets = new Map([["assets/A1.png", mockPng(608, 300, [122, 75, 18])]]);
    const done = await implement([page("direction-first/claude-impl", "style.css", assets)], SECTIONS);
    expect(done.loop).toMatchObject({ repair_attempts: 0, stop: null });
    runs.DIRECTION_FIRST = {
      method: "DIRECTION_FIRST",
      started,
      finished: new Date().toISOString(),
      codexCalls: [
        mockCall("direction", started, { prompt_sha256: null, prompt_chars: 0, note: "MOCK: no direction call exists yet (DEV-143); mock/direction-first/direction.md stands in for its answer" }),
        mockCall("asset", started, { prompt_sha256: null, prompt_chars: 0, note: "MOCK: no image call; a solid-colour PNG made in code stands in for the one asset (DEV-143)" }),
      ],
      impl: done,
      implFiles: { html: `${MOCK}/direction-first/claude-impl/index.html`, css: `${MOCK}/direction-first/claude-impl/style.css` },
      extraArtifacts: [
        { path: `${MOCK}/direction-first/direction.md`, sha256: sha256(direction), what: "direction_text" },
        { ...write("direction-first-asset-A1.png", assets.get("assets/A1.png")!), what: "asset_mock_solid_colour" },
      ],
      assetRequests: [assetRequest(done.final, "MOCK 単色の板 (写真の代わり)")],
      mockAssets: 1,
      compare: null,
      renderStops: [],
      stops: [],
    };
  }, 180_000);

  it("writes one three_method_run_v0 record per method, every one run_kind mock, in the template's shape", () => {
    const methods: Method[] = ["VISUAL_FIRST", "LAYOUT_FIRST", "DIRECTION_FIRST"];
    const summary: Record<string, unknown>[] = [];
    for (const m of methods) {
      const run = runs[m];
      expect(run, m).toBeDefined();
      const c = run!.impl.final;
      const slug = m.toLowerCase().replace("_", "-");
      const pngs = [
        { ...write(`${slug}-pc1440.png`, c.rendered.desktop_1440.png), what: "pc_1440_png" },
        { ...write(`${slug}-sp390.png`, c.rendered.mobile_390.png), what: "sp_390_png" },
      ];
      const obs = (s: StructureObservation, k: "desktop_1440" | "mobile_390") => s.viewports?.[k];
      const record = {
        schema: "three_method_run_v0",
        method: m,
        run_kind: "mock",
        run_label: `komugi-${slug}-mock-1`,
        shop: { shop_id: pack.shop_id, facts_pack_sha256: sha256(readFileSync(factsPath)), identity_lock_sha256: sha256(readRepo(`${STUDY}/identity-lock.json`)), brief_sha256: sha256(readRepo(`${MOCK}/runner-brief.json`)) },
        codex_calls: run!.codexCalls,
        asset_requests: run!.assetRequests,
        images: { generated: 0, used: 0, mock_assets: run!.mockAssets },
        claude: {
          started_at: run!.started,
          finished_at: run!.finished,
          timing_note: "MOCK: the test's own wall time; not Claude's work time and not meaningful",
          repair_attempts: run!.impl.loop.repair_attempts,
          fixes_by_cause: run!.impl.loop.fixes_by_cause,
          repair_history: run!.impl.loop.history,
          owner_requested_rework: 0,
        },
        artifacts: [
          ...pngs,
          { path: run!.implFiles.html, sha256: sha256(run!.impl.page.html), what: "html" },
          { path: run!.implFiles.css, sha256: sha256(run!.impl.page.css), what: "css" },
          ...run!.extraArtifacts,
        ],
        checks: {
          impl_compare: run!.compare
            ? { report: "<mock-out>/visual-first/impl-compare.json", status: run!.compare.status, differences: run!.compare.differences }
            : { report: null, status: "not_applicable", differences: [], reason: "no design original at the page's width for this method (§3, §5)" },
          mobile_quality: { findings: c.rendered.mobile_390.mobileQuality?.findings ?? null, counts: c.rendered.mobile_390.mobileQuality?.counts ?? null },
          structure_observation: {
            report: null,
            status: c.structure.status,
            close_to_rejected: (["desktop_1440", "mobile_390"] as const).flatMap((k) => (obs(c.structure, k)?.close_to_rejected ?? []).map((x) => `${k}:${x.id}`)),
            too_close_to_success: (["desktop_1440", "mobile_390"] as const).flatMap((k) => (obs(c.structure, k)?.too_close_to_success ?? []).map((x) => `${k}:${x.id}`)),
            generic_skeleton: { desktop_1440: obs(c.structure, "desktop_1440")?.generic_skeleton ?? null, mobile_390: obs(c.structure, "mobile_390")?.generic_skeleton ?? null },
          },
          identity: { status: worst([c.identity.desktop_1440.status, c.identity.mobile_390.status]), desktop_1440: c.identity.desktop_1440.status, mobile_390: c.identity.mobile_390.status },
          unsourced_lines: Math.max(c.unsourced.desktop_1440.length, c.unsourced.mobile_390.length),
          unsourced_lines_note: "counted in this test by the design-director evaluation's rule; record-only, not a check",
          render_stops: run!.renderStops,
          implementation_scroll_width: c.scrollWidth,
        },
        stops: run!.stops,
        notes: "MOCK — 模擬の通し実行 (DEV-142)。手順・引き渡し・検査・記録が動くことの確かめだけで、方式の優劣の証拠にしない",
        cost: { plan_usage_calls: 0, claude_minutes: null, claude_tokens_estimate: null },
        failure: { calls: run!.codexCalls.length, failed_or_aborted_or_refused: 0, rate: null, note: "MOCK calls: no failure rate is measured" },
        rework: { request_id: "not measured in the mock", minutes: null, files_changed: null, codex_calls_needed: null },
      };
      // the template's shape, every call MOCK and unapproved, and nothing claims a live run
      for (const k of templateKeys(template)) expect(record, `${m}: ${k}`).toHaveProperty(k);
      expect(record.run_kind).toBe("mock");
      for (const call of record.codex_calls as { outcome: string; approval_id: unknown }[]) expect(call).toMatchObject({ outcome: "mock", approval_id: null });
      expect(record.notes).toContain("MOCK");
      write(`run-record-${slug}.json`, `${JSON.stringify(record, null, 2)}\n`);
      summary.push({
        method: m,
        run_kind: "mock",
        repair_attempts: record.claude.repair_attempts,
        overflow_history: run!.impl.loop.history.map((h) => h.overflow),
        scroll_width: c.scrollWidth,
        identity: record.checks.identity.status,
        unsourced_lines: record.checks.unsourced_lines,
        sp_findings: record.checks.mobile_quality.findings,
        structure: record.checks.structure_observation,
        impl_compare: { status: record.checks.impl_compare.status, differences: record.checks.impl_compare.differences },
        png_bytes: { pc_1440: c.rendered.desktop_1440.png.length, sp_390: c.rendered.mobile_390.png.length },
        png_height: { pc_1440: c.rendered.desktop_1440.png.readUInt32BE(20), sp_390: c.rendered.mobile_390.png.readUInt32BE(20) },
      });
      // the shared checks ran on every method; their findings are recorded, never repaired (only overflow is)
      expect(record.checks.identity.status, m).toBe("PASS_IDENTITY_ONLY");
      expect(record.checks.unsourced_lines, m).toBe(0);
      expect(c.structure.status, m).toBe("observed");
      expect(c.scrollWidth, m).toEqual({ desktop_1440: WIDTHS.desktop_1440, mobile_390: WIDTHS.mobile_390 });
      // only fact values and short neutral labels are on the page (§4)
      for (const line of c.text.desktop_1440.split(/\n+/).map((l) => l.trim()).filter(Boolean)) {
        if (!factValues.some((v) => v.includes(line) || line.includes(v))) expect([...line].length, `${m}: ${line}`).toBeLessThanOrEqual(40);
      }
    }
    write("summary.json", `${JSON.stringify({ run_kind: "mock", note: "MOCK pipeline verification only; not evidence of method quality", runs: summary }, null, 2)}\n`);
    if (!out.temp) console.log(`DEV-142 MOCK output: ${out.dir}`);
  });
});

describe("MOCK: the repair-trigger rule of §4 (what repairs, what stops for the owner)", () => {
  const overflowing = () => page("layout-first/claude-impl", "attempt-1/style.css", new Map([["assets/A1.png", mockPng(40, 20, [197, 139, 58])]]));

  it("Claude's implementation that keeps overflowing stops for the owner at runLoop's LIMITS (never more repairs)", async () => {
    const tries = Array.from({ length: LIMITS.implementationAttempts + 1 }, overflowing);
    const done = await implement(tries, SECTIONS);
    expect(done.loop.history).toHaveLength(LIMITS.implementationAttempts);
    expect(done.loop.repair_attempts).toBe(Math.min(LIMITS.fixesPerCause, LIMITS.implementationAttempts - 1));
    expect(done.loop.stop?.code).toBe("REPAIR_LIMIT_REACHED");
  }, 180_000);

  it("another shop's name on the page (identity not PASS) stops at once, even when the page also overflows: no repair", async () => {
    const bad = overflowing();
    const wrong = { ...bad, html: bad.html.replace("</footer>", " 架空菓庵</footer>") };
    const done = await implement([wrong, overflowing()], SECTIONS);
    expect(done.loop.history).toHaveLength(1);
    expect(done.loop.repair_attempts).toBe(0);
    expect(done.loop.stop?.code).toMatch(/^IDENTITY_(REJECT|HOLD)$/);
  }, 120_000);

  it("Codex's own overflowing design is not repaired: the runner records it, the artifact is incomplete and the lane refuses it", async () => {
    const proto = page("visual-first/codex-prototype");
    const css = `${proto.css}\n[data-section=products] .loaves{width:2000px}`;
    const answer = { ...JSON.parse(readRepo(`${MOCK}/visual-first/codex-answer.json`)), prototype: { html: proto.html, css } };
    const designPort: DesignPort = async (req) => ({ answer, generation: { ...MOCK_GENERATION, prompt_sha256: req.promptSha256 } });
    mkdirSync(join(out.dir, "stops"), { recursive: true });
    const packageDir = join(out.dir, "stops", "codex-overflow");
    const r = await runPrototypeRoute({ route: "B_html_prototype", browser, facts: { path: factsPath, pack }, shop: { shop_id: pack.shop_id, display_name: shopName }, brief, artifactId: "DA-20261101-mockov", outDir: packageDir, designPort });
    expect(r.status === "done" && r.record.verification_state).toBe("incomplete");
    expect(r.status === "done" && r.log.stops.map((s) => s.code)).toContain("PROTOTYPE_HORIZONTAL_OVERFLOW");
    await expect(prepareImplementationLane({ packageDir, factsPath, laneDir: join(out.dir, "stops", "codex-overflow-lane") })).rejects.toThrow(LaneStop);
  }, 120_000);
});
