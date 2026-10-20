import { execFile } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { chromium, type Browser } from "playwright";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import ProfileRenderer from "@/components/demo/profile/ProfileRenderer";
import { renderDemo } from "@/components/demo/renderDemo";
import { RunDeadline } from "@/lib/design-agent/bounded-process";
import { pixelDifference, structureDistance, structureOf } from "@/lib/design-agent/compare/metrics";
import { reportMarkdown, buildCompareReport } from "@/lib/design-agent/compare/report";
import { baselineProfile, runComparison, type CompareOptions } from "@/lib/design-agent/compare/run";
import { loadHandWritten, loadShops, parseShop, selectShops } from "@/lib/design-agent/compare/shops";
import { CATEGORY_DEFAULT_PROFILES } from "@/lib/design-agent/defaults";
import { buildBriefPrompt, buildReviewPrompt } from "@/lib/design-agent/prompts";
import { loadPreviewRun } from "@/lib/design-agent/preview";
import { screenshotPage } from "@/lib/design-agent/preview-server";
import { checkProfile, type DesignProfile } from "@/lib/design-agent/profile";
import { drawPng } from "@/lib/design-agent/worker/preview-check";
import type { PreviewSession } from "@/lib/design-agent/worker/run";
import { passthroughSandbox } from "../../support/passthrough-sandbox";
import { review } from "./fixtures";
import { pageHtml } from "./stage1-fixtures";
import { codexCalls, fakeCodex, LEAK, makeLayout, type Layout, type Step } from "./worker-support";

// DEV-073: the local 3-shop comparison, dry-run here with the fake Codex of the
// worker tests and a real Chromium (the preview renders the real renderer's
// markup with its module CSS; the production preview is next build + start).
// Real Codex runs only on the human's WSL machine, with their approval.

vi.setConfig({ testTimeout: 300_000 });

const REPO = resolve(__dirname, "../../..");
const FIXTURES = join(REPO, "scripts/sales-design-worker/compare");
const run = promisify(execFile);

let browser: Browser;
const launch = (env?: NodeJS.ProcessEnv) => chromium.launch({ headless: true, ...(env ? { env } : {}), ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
beforeAll(async () => {
  browser = await launch();
});
afterAll(async () => {
  await browser?.close();
});

/** The design-preview route's reading (loadPreviewRun) and markup, served on 127.0.0.1, with real screenshots. */
function testPreview(log: { started: number; renders: string[] }): CompareOptions["startPreview"] {
  return async ({ previewRoot }) => {
    log.started += 1;
    const server: Server = createServer((req, res) => {
      void (async () => {
        const u = new URL(req.url ?? "/", "http://127.0.0.1");
        const m = /^\/design-preview\/([^/]+)$/.exec(u.pathname);
        const found = m ? await loadPreviewRun(previewRoot, m[1]!, u.searchParams.get("profile") ?? "none") : null;
        if (!found) {
          res.writeHead(404);
          return res.end();
        }
        const body = renderToStaticMarkup(found.profile ? <ProfileRenderer demo={found.demo} profile={found.profile} photos={found.photos} /> : renderDemo(found.demo));
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(pageHtml(body));
      })();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const address = server.address();
    const origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const session: PreviewSession = {
      origin,
      renderer: {
        async render(runId, candidate, shotsDir) {
          log.renders.push(`${runId}:${candidate}`);
          const url = `${origin}/design-preview/${runId}?profile=${candidate}`;
          const shots = { desktop: join(shotsDir, `${candidate}-desktop.png`), mobile: join(shotsDir, `${candidate}-mobile.png`) };
          const d = await screenshotPage(browser, url, shots.desktop, false);
          const m = await screenshotPage(browser, url, shots.mobile, true);
          return { shots, overflow: [...(d.overflow ? [`OVERFLOW_${candidate}_DESKTOP`] : []), ...(m.overflow ? [`OVERFLOW_${candidate}_MOBILE`] : [])] };
        },
      },
      stop: () => new Promise<void>((r) => server.close(() => r())),
    };
    return session;
  };
}

async function handSpecs(): Promise<Record<string, DesignProfile>> {
  return loadHandWritten(join(FIXTURES, "hand-written"), ["coffee", "patisserie", "wagashi"]);
}

/** Codex answers: a brief per shop (the hand-written specs as answers), coffee revised once. */
async function steps(): Promise<Step[]> {
  const h = await handSpecs();
  const brief = (p: DesignProfile) => ({ answer: { ...p, confidence: 0.8, rationale: [LEAK.rationale] } });
  const note = [{ area: "layout" as const, severity: "medium" as const, note: LEAK.note }];
  const revised = { ...h.coffee!, confidence: 0.8, rationale: [LEAK.rationale], layout: { ...h.coffee!.layout!, type: { scale: "standard" as const, headings: "en_ja" as const } }, palette: { ...h.coffee!.palette, accent: "#2F6B4F" } };
  return [
    // coffee, patisserie, wagashi (the shops load in file-name order)
    brief(h.coffee!),
    { answer: review({ verdict: "revise", brand_fit: 3, problems: note, recommended_profile_changes: { summary: [LEAK.note], revised_profile: revised } }) },
    { answer: review() },
    brief(h.patisserie!),
    { answer: review({ problems: note }) },
    brief(h.wagashi!),
    { answer: review({ brand_fit: 5 }) },
  ];
}

async function options(l: Layout, over: Partial<CompareOptions> & { steps?: Step[] } = {}) {
  const preview = { started: 0, renders: [] as string[] };
  const codexBin = fakeCodex(l, over.steps ?? (await steps()));
  const logs: string[] = [];
  const env = { PATH: process.env.PATH, HOME: l.root, LANG: "C.UTF-8", CODEX_HOME: join(l.root, "codex-home"), OPENAI_API_KEY: "sk-test-openai" };
  const o: CompareOptions = {
    humanApprovalConfirmed: true,
    compareId: "cmp-test-1",
    mode: "design",
    shops: await loadShops(join(FIXTURES, "shops")),
    root: join(l.root, "sr-design-compare"),
    workerPaths: { stateDir: l.state, queueRoot: l.queue, outRoot: l.out },
    // short: Chromium's profile and socket paths live under the run's temp root (the worker's is /tmp on WSL)
    tmpBase: tmpdir(),
    env,
    workerSha: "0123456789abcdef0123456789abcdef01234567",
    deadline: new RunDeadline(Date.now() + 30 * 60_000),
    codexBin,
    prepareSandbox: async (e) => passthroughSandbox(codexBin, e),
    launchBrowser: (env) => launch(env),
    startPreview: testPreview(preview),
    log: (line) => logs.push(line),
    ...over,
  };
  return { o, preview, logs };
}

const allText = (dir: string) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.(json|md)$/.test(e.name))
    .map((e) => readFileSync(join(e.parentPath, e.name), "utf8"))
    .join("\n");

describe("the test shops", () => {
  it("are three fictional shops of different categories, with rich, medium and sparse facts, and valid hand-written specs", async () => {
    const shops = await loadShops(join(FIXTURES, "shops"));
    expect(shops.map((s) => [s.key, s.demo.category, s.richness])).toEqual([
      ["coffee", "cafe", "medium"],
      ["patisserie", "bakery", "sparse"],
      ["wagashi", "baked_goods", "rich"],
    ]);
    for (const s of shops) {
      // fictional: test / made-up place names, no real phone number range
      expect(s.demo.address).toMatch(/テスト|架空/);
      if (s.demo.phone) expect(s.demo.phone).toMatch(/^052-000-/);
      // no claim words are added to the facts
      expect(JSON.stringify(s.facts)).not.toMatch(/おすすめ|人気|看板/);
    }
    const counts = shops.map((s) => Object.keys(s.facts).length);
    expect(counts[2]).toBeGreaterThan(counts[0]!);
    expect(counts[0]).toBeGreaterThan(counts[1]!);
    const specs = await handSpecs();
    for (const s of shops) expect(checkProfile(specs[s.key]).ok).toBe(true);
    expect(parseShop({ key: "x", richness: "rich", industry: "", facts: {} })).toBeNull();
  });

  it("brief and review prompts without references say so instead of counting zero screenshots", async () => {
    const [shop] = await loadShops(join(FIXTURES, "shops"));
    const brief = buildBriefPrompt({ demo: shop!.demo, referenceCount: 0, currentDemoCount: 2 });
    expect(brief).toContain("Attached images: 2, the current generic demo (desktop, then mobile)");
    expect(brief).toContain("No image of the shop itself is attached");
    expect(brief).not.toMatch(/the first 0|The last 2/);
    const reviewPrompt = buildReviewPrompt({ demo: shop!.demo, profile: CATEGORY_DEFAULT_PROFILES.cafe, referenceCount: 0, round: 0, maxRevisions: 2 });
    expect(reviewPrompt).toContain("Attached images: two, the rendered demo: desktop (1440 CSS px wide), then mobile (390 CSS px wide). No image of the shop itself is attached");
    expect(reviewPrompt).not.toMatch(/the first 0|\(reference\)|The last two/);
    // with references (the worker: always at least one) the lines are as before
    expect(buildBriefPrompt({ demo: shop!.demo, referenceCount: 3, currentDemoCount: 2 })).toContain("Attached images: the first 3 are");
    expect(buildBriefPrompt({ demo: shop!.demo, referenceCount: 3, currentDemoCount: 2 })).not.toContain("No image of the shop");
  });

  it("--shops picks listed keys only (each once, all known)", async () => {
    const shops = await loadShops(join(FIXTURES, "shops"));
    expect(selectShops(shops, undefined)?.map((s) => s.key)).toEqual(["coffee", "patisserie", "wagashi"]);
    expect(selectShops(shops, "wagashi,coffee")?.map((s) => s.key)).toEqual(["coffee", "wagashi"]);
    expect(selectShops(shops, "coffee,coffee")).toBeNull();
    expect(selectShops(shops, "coffee,ramen")).toBeNull();
    expect(selectShops(shops, "")).toBeNull();
  });
});

describe("the metrics", () => {
  it("structural distance: 0 for the same page, larger for pages that differ, every part in 0–1", async () => {
    const shops = await loadShops(join(FIXTURES, "shops"));
    const h = await handSpecs();
    const s = Object.fromEntries(shops.map((x) => [x.key, structureOf(h[x.key]!, x.demo)]));
    expect(structureDistance(s.coffee!, s.coffee!).total).toBe(0);
    const d = structureDistance(s.coffee!, s.wagashi!);
    expect(d.total).toBeGreaterThan(0.5);
    for (const v of Object.values(d)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    const base = structureOf(baselineProfile("cafe"), shops[0]!.demo);
    // the baseline draws the default layout (about, menu, visit) with the category's direction
    expect(base.sections.map((x) => x.kind)).toEqual(["about", "menu", "visit"]);
    expect(base.direction).toBe(CATEGORY_DEFAULT_PROFILES.cafe.direction);
    expect(baselineProfile("cafe")).not.toHaveProperty("layout");
  });

  it("pixel difference: 0 for the same image, about the differing share otherwise; extra rows count as different", () => {
    const a = drawPng(200, 100, 1);
    expect(pixelDifference(a, a, 50)).toEqual({ full: 0, first_screen: 0 });
    const tall = drawPng(200, 200, 1);
    const d = pixelDifference(a, tall, 50);
    expect(d.full).toBeGreaterThan(0.4);
    expect(pixelDifference(drawPng(200, 100, 1), drawPng(100, 100, 1), 100).full).toBeGreaterThan(0.4);
  });
});

describe("runComparison", () => {
  it("refuses without the human's approval and creates nothing", async () => {
    const l = makeLayout();
    const { o, preview } = await options(l, { humanApprovalConfirmed: false });
    expect(await runComparison(o)).toEqual({ status: "refused", code: "HUMAN_APPROVAL_MISSING" });
    expect(existsSync(o.root)).toBe(false);
    expect(preview.started).toBe(0);
    expect(codexCalls(l)).toEqual([]);
  });

  it("design: the worker's pipeline per shop with the fake Codex → run dirs the preview reads, baselines, report and contact sheet; codes and numbers only", async () => {
    const l = makeLayout();
    const { o, preview } = await options(l);
    const result = await runComparison(o);
    expect(result, JSON.stringify(result)).toMatchObject({ status: "done" });
    const dir = join(o.root, "cmp-test-1");
    const runs = readdirSync(join(dir, "runs")).sort();
    expect(runs).toEqual(["cmp-test-1-coffee", "cmp-test-1-coffee-base", "cmp-test-1-patisserie", "cmp-test-1-patisserie-base", "cmp-test-1-wagashi", "cmp-test-1-wagashi-base"]);
    // one preview (one build) for the whole comparison; candidates rendered as the worker does
    expect(preview.started).toBe(1);
    expect(preview.renders).toContain("cmp-test-1-coffee:candidate-1");
    // each run dir in the layout /design-preview/<runId> reads
    for (const r of runs) {
      expect(await loadPreviewRun(join(dir, "runs"), r, r.endsWith("-base") ? "default" : "final")).not.toBeNull();
      for (const f of ["facts.json", "report.json", "page-desktop.png", "page-mobile.png"]) expect(existsSync(join(dir, "runs", r, f)), `${r}/${f}`).toBe(true);
    }
    // Codex: brief + reviews, as the worker calls it (7 execs), never a reference image
    const calls = codexCalls(l).filter((c) => c.args[0] === "exec");
    expect(calls).toHaveLength(7);
    for (const c of calls) expect(c.apiKeyVars).toEqual([]);

    const report = JSON.parse(readFileSync(join(dir, "compare-report.json"), "utf8")) as Awaited<ReturnType<typeof buildCompareReport>>;
    expect(report.mode).toBe("design");
    expect(report.hand_written_specs).toBe(false);
    const coffee = report.shops.find((s) => s.shop === "coffee")!;
    expect(coffee.subject?.outcome).toBe("done");
    expect(coffee.subject?.codex).toMatchObject({ verdict: "accept", rounds: 2, revisions: 1, calls: 3, final_candidate: "candidate-1" });
    expect(coffee.subject?.codex?.scores).toEqual({ brand_fit: 4, visual_quality: 4, hierarchy: 4, mobile_quality: 4, generic_template_feel: 2, total: 20 });
    expect(coffee.subject?.codex?.call_list.map((c) => c.stage)).toEqual(["profile_brief", "visual_review", "visual_review_revision"]);
    expect(coffee.subject?.prompt_sizes.map((p) => p.kind)).toEqual(["brief", "review", "review"]);
    for (const p of coffee.subject!.prompt_sizes) {
      expect(p.prompt_chars).toBeGreaterThan(5000);
      expect(p.images).toBe(2);
    }
    expect(coffee.subject?.layout?.first_view).toBe("name_menu");
    const wagashi = report.shops.find((s) => s.shop === "wagashi")!;
    expect(wagashi.subject?.layout).toMatchObject({ direction: "japanese_modern", first_view: "vertical_name" });
    expect(wagashi.baseline?.layout?.sections).toEqual(["about/lead/plain", "menu/numbered/plain", "visit/ledger/plain"]);
    // safety: every fact, the notice and the footer at 1440 and 390, no sideways scroll
    for (const s of report.shops) {
      expect(s.subject?.safety?.ok, `${s.shop}`).toBe(true);
      expect(s.baseline?.safety?.ok, `${s.shop} baseline`).toBe(true);
    }
    // differences: between the shops, and each against its baseline
    expect(report.differences.between_shops.pairs).toHaveLength(3);
    expect(report.differences.against_baseline.pairs).toHaveLength(3);
    expect(report.differences.between_baselines.pairs).toHaveLength(3);
    for (const p of [...report.differences.between_shops.pairs, ...report.differences.against_baseline.pairs]) {
      expect(p.structure!.total).toBeGreaterThan(0.2);
      expect(p.pixels.desktop_1440!.full).toBeGreaterThan(0.05);
      expect(p.pixels.mobile_390!.full).toBeGreaterThan(0.05);
    }
    expect(report.totals).toMatchObject({ codex_calls: 7, accepted: 3, safety_ok: 6, pages: 6 });

    // the contact sheet: a real PNG of the three rows
    const sheet = readFileSync(join(dir, "contact-sheet.png"));
    expect(sheet.subarray(1, 4).toString("latin1")).toBe("PNG");
    expect(sheet.readUInt32BE(16)).toBeGreaterThan(1000);
    expect(readFileSync(join(dir, "compare-report.md"), "utf8")).toContain("## 店の間の違い");

    // no Codex text in the report, and no reference was used
    const reportText = readFileSync(join(dir, "compare-report.json"), "utf8") + readFileSync(join(dir, "compare-report.md"), "utf8");
    for (const leak of Object.values(LEAK)) expect(reportText).not.toContain(leak);
    expect(reportText).not.toContain(l.root);
    for (const r of runs) expect(readFileSync(join(dir, "runs", r, "report.json"), "utf8")).not.toContain(LEAK.note);
    // the worker's queue, results and ledger are untouched; the temp root is gone
    expect(existsSync(l.out)).toBe(false);
    expect(existsSync(l.state)).toBe(false);
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith("sr-design-worker-"))).toEqual([]);
    // a comparison id is never run twice
    expect(await runComparison((await options(l)).o)).toEqual({ status: "refused", code: "COMPARE_ID_USED" });
  });

  it("baseline: today's page per shop, no Codex at all", async () => {
    const l = makeLayout();
    const { o } = await options(l, { mode: "baseline", compareId: "cmp-base-1", prepareSandbox: async () => Promise.reject(new Error("no Codex in baseline mode")) });
    const result = await runComparison(o);
    expect(result.status).toBe("done");
    expect(codexCalls(l)).toEqual([]);
    const report = await buildCompareReport(join(o.root, "cmp-base-1"));
    expect(report.mode).toBe("baseline");
    expect(report.shops.map((s) => [s.subject, s.baseline?.outcome])).toEqual([
      [null, "baseline"],
      [null, "baseline"],
      [null, "baseline"],
    ]);
    expect(report.differences.between_baselines.pairs).toHaveLength(3);
  });

  it("hand_written: labelled as hand-written specs (not Codex) in the records, the report and the sheet", async () => {
    const l = makeLayout();
    const { o } = await options(l, { mode: "hand_written", compareId: "cmp-hand-1", handWritten: await handSpecs() });
    expect((await runComparison(o)).status).toBe("done");
    expect(codexCalls(l)).toEqual([]);
    const dir = join(o.root, "cmp-hand-1");
    const report = await buildCompareReport(dir);
    expect(report).toMatchObject({ mode: "hand_written", hand_written_specs: true });
    expect(report.shops.every((s) => s.subject?.source === "hand_written_spec" && s.subject.codex === null)).toBe(true);
    expect(reportMarkdown(report)).toContain("手書きの spec（Codex の生成ではない）");
    expect(allText(join(dir, "runs"))).toContain("hand_written_spec");
    expect(report.differences.between_shops.summary.structure_total!.min).toBeGreaterThan(0.4);
  });
});

describe("runComparison: fallback and stops", () => {
  const one = async (keys: string) => selectShops(await loadShops(join(FIXTURES, "shops")), keys)!;

  it("design fallback (no final candidate): page_candidate none, no layout, the existing template's pixels compared", async () => {
    const l = makeLayout();
    const { o } = await options(l, { compareId: "cmp-fb-1", shops: await one("coffee"), steps: [{ exit: 1 }, { exit: 1 }] });
    expect(await runComparison(o)).toMatchObject({ status: "done" });
    const run = JSON.parse(readFileSync(join(o.root, "cmp-fb-1", "runs", "cmp-fb-1-coffee", "report.json"), "utf8")) as { page_candidate: string; outcome: string };
    expect(run).toMatchObject({ page_candidate: "none", outcome: "fallback_template" });
    const report = await buildCompareReport(join(o.root, "cmp-fb-1"));
    const coffee = report.shops[0]!;
    expect(coffee.subject).toMatchObject({ outcome: "fallback_template", layout: null });
    expect(coffee.subject?.codex?.verdict).toBeNull();
    expect(coffee.subject?.safety?.ok).toBe(true);
    const p = report.differences.against_baseline.pairs[0]!;
    expect(p.structure).toBeNull();
    expect(p.pixels.desktop_1440).not.toBeNull();
  });

  it("an environment failure stops the comparison and still writes the report of what was done", async () => {
    const l = makeLayout();
    const { o } = await options(l, { compareId: "cmp-env-1", shops: await one("coffee,patisserie"), steps: [{ exit: 1, stderr: "usage limit reached" }] });
    const result = await runComparison(o);
    expect(result).toMatchObject({ status: "stopped", code: "CODEX_QUOTA" });
    expect((result as { runs: unknown[] }).runs).toEqual([
      { runId: "cmp-env-1-coffee-base", shop: "coffee", kind: "baseline", outcome: "baseline" },
      { runId: "cmp-env-1-coffee", shop: "coffee", kind: "design", outcome: "environment_failure" },
    ]);
    const dir = join(o.root, "cmp-env-1");
    const report = JSON.parse(readFileSync(join(dir, "compare-report.json"), "utf8")) as Awaited<ReturnType<typeof buildCompareReport>>;
    expect(report.shops.map((s) => [s.shop, s.subject?.outcome, s.subject?.code, s.baseline?.outcome])).toEqual([["coffee", "environment_failure", "CODEX_QUOTA", "baseline"]]);
    expect(existsSync(join(dir, "runs", "cmp-env-1-patisserie"))).toBe(false);
    expect(readFileSync(join(dir, "compare-report.md"), "utf8")).toContain("## 条件の偏り");
  });

  it("no design shop starts with less than 10 minutes left: stops with the report so far; a check that cannot run is NG", async () => {
    const l = makeLayout();
    const { o } = await options(l, { compareId: "cmp-time-1", deadline: new RunDeadline(Date.now() + 5 * 60_000) });
    // a preview without an origin: the safety check cannot run
    const start = o.startPreview;
    o.startPreview = async (x) => ({ ...(await start(x)), origin: undefined });
    const result = await runComparison(o);
    expect(result).toMatchObject({ status: "stopped", code: "COMPARE_RUN_TIME_BUDGET" });
    // the sign-in check only: no brief, no review
    expect(codexCalls(l).filter((c) => c.args[0] === "exec")).toEqual([]);
    const report = await buildCompareReport(join(o.root, "cmp-time-1"));
    expect(report.shops.map((s) => [s.shop, s.subject, s.baseline?.outcome])).toEqual([["coffee", null, "baseline"]]);
    expect(report.shops[0]!.baseline?.safety).toMatchObject({ ok: false, error: "SAFETY_CHECK_FAILED" });
    expect(readFileSync(join(o.root, "cmp-time-1", "compare-report.md"), "utf8")).toContain("NG（検査できなかった: SAFETY_CHECK_FAILED）");
  });
});

describe("the entry points refuse without the approval flag", () => {
  it("compare.ts: STOP, exit 2, nothing started", async () => {
    const home = mkdtempSync(join(tmpdir(), "sr-compare-cli-"));
    const err = await run(join(REPO, "node_modules/.bin/tsx"), [join(REPO, "scripts/sales-design-worker/compare.ts"), "--compare-id", "cmp-cli-1"], {
      cwd: REPO,
      env: { PATH: process.env.PATH, HOME: home } as unknown as NodeJS.ProcessEnv,
    }).catch((e: { code: number; stderr: string }) => e);
    expect(err).toMatchObject({ code: 2 });
    expect((err as { stderr: string }).stderr).toContain("STOP: --human-approval-confirmed is missing");
    expect(existsSync(join(home, "sr-design-compare"))).toBe(false);
    // started directly (not under compare-local.sh, which holds the worker's run lock): STOP
    const direct = await run(join(REPO, "node_modules/.bin/tsx"), [join(REPO, "scripts/sales-design-worker/compare.ts"), "--compare-id", "cmp-cli-1", "--human-approval-confirmed"], {
      cwd: REPO,
      env: { PATH: process.env.PATH, HOME: home } as unknown as NodeJS.ProcessEnv,
    }).catch((e: { code: number; stderr: string }) => e);
    expect(direct).toMatchObject({ code: 2 });
    expect((direct as { stderr: string }).stderr).toContain("STOP: start the comparison with scripts/sales-design-worker/compare-local.sh");
    expect(existsSync(join(home, "sr-design-compare"))).toBe(false);
  });

  it("compare-local.sh: STOP before the preflight, the lock, git, npm or tsx; with the flag it runs compare.ts in a clean environment", async () => {
    const root = mkdtempSync(join(tmpdir(), "sr-compare-sh-"));
    const repo = join(root, "repo");
    const bin = join(root, "bin");
    const home = join(root, "home");
    const record = join(root, "record.log");
    for (const d of [join(repo, "scripts/sales-design-worker"), join(repo, "scripts/ops"), join(repo, "node_modules/.bin"), bin, home]) mkdirSync(d, { recursive: true });
    cpSync(join(REPO, "scripts/sales-design-worker/compare-local.sh"), join(repo, "scripts/sales-design-worker/compare-local.sh"));
    writeFileSync(join(repo, "package-lock.json"), "{}");
    const tool = (path: string, name: string, extra = "") => {
      writeFileSync(path, `#!/bin/bash\necho "${name} $*" >> '${record}'\n${extra}\nexit 0\n`);
      chmodSync(path, 0o755);
    };
    tool(join(bin, "git"), "git", 'echo 0123456789ab');
    tool(join(bin, "npm"), "npm");
    tool(join(repo, "scripts/ops/wsl-resource-preflight.sh"), "preflight");
    tool(join(repo, "node_modules/.bin/tsx"), "tsx", `env | cut -d= -f1 | sort | tr '\\n' ' ' | sed 's/^/env /' >> '${record}'`);
    const script = join(repo, "scripts/sales-design-worker/compare-local.sh");
    const env = { PATH: `${bin}:${process.env.PATH}`, HOME: home, OPENAI_API_KEY: "sk-test", SUPABASE_SERVICE_ROLE_KEY: "x", SR_DESIGN_WORKER_NO_UPDATE: "1" } as unknown as NodeJS.ProcessEnv;
    const refused = await run("bash", [script, "--compare-id", "cmp-001"], { env }).catch((e: { code: number; stdout: string }) => e);
    expect(refused).toMatchObject({ code: 2 });
    expect((refused as { stdout: string }).stdout).toContain("STOP: --human-approval-confirmed is missing");
    expect(existsSync(record)).toBe(false);
    expect(await run("bash", [script, "--compare-id", "Real Shop", "--human-approval-confirmed"], { env }).catch((e: { code: number }) => e)).toMatchObject({ code: 2 });
    expect(existsSync(record)).toBe(false);

    await run("bash", [script, "--compare-id", "cmp-001", "--mode", "baseline", "--shops", "wagashi,coffee", "--human-approval-confirmed"], { env });
    const log = readFileSync(record, "utf8");
    expect(log).toContain("preflight");
    expect(log).toMatch(/tsx .*scripts\/sales-design-worker\/compare\.ts --compare-id cmp-001 --mode baseline --shops wagashi,coffee --human-approval-confirmed --budget-seconds=\d+/);
    const seen = /^env (.*)$/m.exec(log)![1]!;
    expect(seen).not.toContain("OPENAI_API_KEY");
    expect(seen).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(seen).toContain("SR_DESIGN_COMPARE_LOCKED");
    // the design budget fits in the jail's one run (3300 s, as run.sh), whatever is asked
    writeFileSync(record, "");
    await run("bash", [script, "--compare-id", "cmp-002", "--human-approval-confirmed"], { env: { ...env, SR_DESIGN_COMPARE_BUDGET_SECONDS: "10800" } as unknown as NodeJS.ProcessEnv });
    expect(Number(/--budget-seconds=(\d+)/.exec(readFileSync(record, "utf8"))![1])).toBeLessThanOrEqual(3300 - 120);

    // a worker run (run.sh) holds the run lock: STOP, exit 3, compare.ts never starts
    writeFileSync(record, "");
    const lockFile = join(home, ".local/state/sr-design-worker/run.lock");
    const holder = execFile("flock", ["-x", lockFile, "sleep", "30"]);
    try {
      for (let i = 0; i < 50 && !(await run("flock", ["-n", lockFile, "true"]).then(() => false, () => true)); i++) await new Promise((r) => setTimeout(r, 100));
      const busy = await run("bash", [script, "--compare-id", "cmp-003", "--human-approval-confirmed"], { env }).catch((e: { code: number; stdout: string }) => e);
      expect(busy).toMatchObject({ code: 3 });
      expect((busy as { stdout: string }).stdout).toContain("STOP: a design worker run (run.sh) is in progress");
      expect(readFileSync(record, "utf8")).not.toContain("tsx");
    } finally {
      holder.kill();
    }
  });
});
