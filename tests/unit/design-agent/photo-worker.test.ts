import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ImageDirection } from "@/lib/design-agent/assets/direction";
import { CodexError, runCodexJson } from "@/lib/design-agent/codex";
import { pocReport } from "@/lib/design-agent/worker/poc";
import { RUN_TIME_BUDGET_MS, type PreviewSession, type WorkerOptions, type WorkerReport } from "@/lib/design-agent/worker/run";
import { passthroughSandbox } from "../../support/passthrough-sandbox";
import { AMERICAN_EDITORIAL, review } from "./fixtures";
import { fakeAnalysis, fakePng, writeStore, type FakeAsset } from "./photo-fixtures";
import { codexCalls, FAKE_CODEX, makeLayout, PNG, runWorker, startMockSite, writeJob, type Layout, type MockSite, type Step } from "./worker-support";

// DEV-029 stage 4: photos through the real design worker (fake Codex CLI,
// fake preview renderer, photos drawn by the tests). The worker's own asset
// job is the asset store job with the same id; nothing of another job can be
// mixed in. Image copies never outlive a Codex call.

vi.setConfig({ testTimeout: 120_000 });

let site: MockSite;
beforeAll(async () => {
  site = await startMockSite();
});
afterAll(() => {
  site.server.close();
});

const A = "asset-aaaaaaaaaaaaaaaaaaaaaaaa";
const B = "asset-bbbbbbbbbbbbbbbbbbbbbbbb";
const C = "asset-cccccccccccccccccccccccc";
const ASSETS: FakeAsset[] = [
  { id: A, png: fakePng(360, 450, { seed: 1 }), sourceKind: "generated_concept" },
  { id: B, png: fakePng(480, 320, { seed: 2 }), sourceKind: "approved_real" },
  { id: C, png: fakePng(400, 400, { seed: 3 }), sourceKind: "generated_concept" },
];
const ANALYSES = [fakeAnalysis(A, { orientation: "portrait" }), fakeAnalysis(B, { orientation: "landscape" }), fakeAnalysis(C, { orientation: "square" })];
const place = (assetId: string, over: Record<string, unknown> = {}) => ({ assetId, fit: "cover", focal: { x: 0.5, y: 0.4 }, mobileFocal: { x: 0.5, y: 0.45 }, aspect: { desktop: "4:5", mobile: "1:1" }, treatment: "natural", ...over });
const direction = (n: number, layout = "split_hero") => {
  const ids = ASSETS.slice(0, n).map((a) => a.id);
  return { version: 1, layout, hero: place(ids[0]), features: ids.length > 1 ? [{ ...place(ids[1]), slot: "visit", side: "right" }] : [], rejected: ids.slice(2).map((assetId) => ({ assetId, reason: "not_needed" })), paletteFit: 4 };
};
const photoReview = (over: Record<string, unknown> = {}) => ({
  ...review(),
  photo_scores: { image_selection: 4, crop: 4, focal_visibility: 4, text_image_collision: 5, image_repetition: 5, image_quality: 4, mobile_crop: 4, photo_brand_fit: 4 },
  photo_issues: [],
  revision_target: "none",
  ...over,
});
const FACTS_WITH_VISIT = { name: "EXAMPLE TEST", category: "baked_goods", ward: "北区", address: "名古屋市北区テスト町1-2-3", description: "テスト用の架空の紹介文です。" };

/** A preview renderer that reports the photos the run directory says it would draw, like the real one would. */
function photoPreview(rendered: string[]): WorkerOptions["startPreview"] {
  return async ({ previewRoot }) => {
    const session: PreviewSession = {
      renderer: {
        async render(runId, candidate, shotsDir) {
          rendered.push(candidate);
          const shots = { desktop: join(shotsDir, `${candidate}-desktop.png`), mobile: join(shotsDir, `${candidate}-mobile.png`) };
          writeFileSync(shots.desktop, PNG);
          writeFileSync(shots.mobile, PNG);
          const artPath = join(previewRoot, runId, `${candidate}.images.json`);
          const art = existsSync(artPath) ? (JSON.parse(readFileSync(artPath, "utf8")) as { value: ImageDirection }) : null;
          const d = art?.value ?? null;
          const placed = (["desktop", "mobile"] as const).flatMap((device) =>
            d
              ? [...(d.hero ? [{ assetId: d.hero.assetId, role: "hero" as const }] : []), ...d.features.map((f) => ({ assetId: f.assetId, role: f.slot }))].map((p) => ({
                  ...p,
                  device,
                  visible: true,
                  labelled: ASSETS.find((a) => a.id === p.assetId)?.sourceKind === "generated_concept",
                  overlapsText: false,
                }))
              : [],
          );
          const sections = d ? [join(shotsDir, `${candidate}-mobile-section-1.png`)] : [];
          for (const s of sections) writeFileSync(s, PNG);
          return { shots, overflow: [], sections, placed };
        },
      },
      stop: async () => undefined,
    };
    return session;
  };
}

async function photoRun(l: Layout, jobId: string, n: number, steps: Step[]) {
  if (n > 0) await writeStore(join(l.root, ".local", "share", "second-root-design-assets"), jobId, ASSETS.slice(0, n));
  writeJob(l, jobId, "https://www.instagram.com/example_shop/", FACTS_WITH_VISIT);
  const rendered: string[] = [];
  const started = Date.now();
  const result = await runWorker(l, site, { steps, startPreview: photoPreview(rendered) });
  const report = result.report as Extract<WorkerReport, { status: "finished" }>;
  return { ...result, report, rendered, elapsedMs: Date.now() - started };
}

const execs = (l: Layout) => codexCalls(l).filter((c) => c.args[0] === "exec") as unknown as Array<{ args: string[]; cwd: string }>;
const json = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

/** No image copy, Codex work dir or worker temp root is left anywhere under the layout. */
function assertClean(l: Layout) {
  expect(readdirSync(l.tmp)).toEqual([]);
  for (const call of execs(l)) expect(existsSync(call.cwd), call.cwd).toBe(false);
  const leftovers = readdirSync(l.root, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && /^photo-\d+\.png$/.test(e.name));
  expect(leftovers.map((e) => join(e.parentPath, e.name))).toEqual([]);
}

const budget: Array<{ scenario: string; calls: number; elapsedMs: number }> = [];
afterAll(async () => {
  const out = process.env.SR_PHOTO_BUDGET_OUT;
  if (out) await writeFile(out, JSON.stringify(budget, null, 2));
});

describe("the worker with photos", () => {
  it("wires the artifacts with their lineage, and every image copy is gone afterwards (0–3 photos, no revision)", async () => {
    for (const n of [0, 1, 2, 3]) {
      const l = makeLayout();
      const jobId = `job-photos-${n}`;
      const steps: Step[] = n === 0 ? [{ answer: AMERICAN_EDITORIAL }, { answer: review() }] : [{ answer: AMERICAN_EDITORIAL }, { answer: { photos: ANALYSES.slice(0, n) } }, { answer: direction(n) }, { answer: photoReview() }];
      const { report, logs, rendered, elapsedMs } = await photoRun(l, jobId, n, steps);
      expect(report.jobs[0], JSON.stringify({ report, logs })).toMatchObject({ status: "done" });
      budget.push({ scenario: `${n} photo(s), revision 0`, calls: execs(l).length, elapsedMs });
      const runDir = join(l.out, jobId);
      const rep = json(join(runDir, "report.json"));
      if (n === 0) {
        expect(execs(l)).toHaveLength(2);
        expect(existsSync(join(runDir, "assets.json"))).toBe(false);
        expect(rep.photos).toBeNull();
        continue;
      }
      expect(execs(l)).toHaveLength(4);
      expect(rendered).toEqual(["none", "candidate-0", "final"]);
      const assets = json(join(runDir, "assets.json"));
      const analyses = json(join(runDir, "photo-analyses.json"));
      const images = json(join(runDir, "candidate-0.images.json"));
      const final = json(join(runDir, "final.images.json"));
      expect(assets).toMatchObject({ runId: jobId, jobId });
      expect(analyses).toMatchObject({ runId: jobId, jobId, assetSetDigest: assets.assetSetDigest, inputDigest: assets.assetSetDigest });
      expect(images).toMatchObject({ runId: jobId, jobId, candidate: "candidate-0", assetSetDigest: assets.assetSetDigest, analysesDigest: analyses.outputDigest });
      expect(final).toMatchObject({ candidate: "final", value: images.value });
      expect(rep.photos).toMatchObject({ assets: n, analysis: "done", final_layout: "split_hero", codex_calls: { photo_analysis: 1, image_direction: 1, photo_review: 1 } });
      // each photo call had the photos as work-dir copies only
      for (const call of execs(l).slice(1, 3)) {
        const images = call.args.filter((a) => a.startsWith("--image=")).map((a) => a.slice(8));
        expect(images).toEqual(Array.from({ length: n }, (_, i) => join(call.cwd, "inputs", `photo-${i + 1}.png`)));
      }
      assertClean(l);
    }
  });

  it("never takes the photos of another job", async () => {
    const l = makeLayout();
    await writeStore(join(l.root, ".local", "share", "second-root-design-assets"), "job-someone-else", ASSETS);
    const { report } = await photoRun(l, "job-mine-1", 0, [{ answer: AMERICAN_EDITORIAL }, { answer: review() }]);
    expect(report.jobs[0]).toMatchObject({ status: "done" });
    expect(execs(l)).toHaveLength(2);
    expect(existsSync(join(l.out, "job-mine-1", "assets.json"))).toBe(false);
  });

  it("revision 1 (images) and revision 2 (worst case): analysis once, two rounds at most; cleanup holds", async () => {
    const one = makeLayout();
    const r1 = await photoRun(one, "job-rev-1", 3, [
      { answer: AMERICAN_EDITORIAL },
      { answer: { photos: ANALYSES } },
      { answer: direction(3) },
      { answer: photoReview({ verdict: "revise", revision_target: "images", photo_issues: [{ issue: "crop", severity: "high" }] }) },
      { answer: direction(3, "framed_hero") },
      { answer: photoReview() },
    ]);
    expect(r1.report.jobs[0]).toMatchObject({ status: "done" });
    expect(execs(one)).toHaveLength(6);
    budget.push({ scenario: "3 photos, revision 1 (images)", calls: execs(one).length, elapsedMs: r1.elapsedMs });
    assertClean(one);

    const two = makeLayout();
    const revised = { ...AMERICAN_EDITORIAL, palette: { ...AMERICAN_EDITORIAL.palette, accent: "#8A6A3A" } };
    const r2 = await photoRun(two, "job-rev-2", 3, [
      { answer: AMERICAN_EDITORIAL },
      { answer: { photos: ANALYSES } },
      { answer: direction(3) },
      { answer: photoReview({ verdict: "revise", revision_target: "both", recommended_profile_changes: { summary: [], revised_profile: revised } }) },
      { answer: direction(3, "framed_hero") },
      { answer: photoReview({ verdict: "revise", revision_target: "images" }) },
      { answer: direction(3) },
      { answer: photoReview({ verdict: "revise", revision_target: "images" }) },
    ]);
    expect(r2.report.jobs[0]).toMatchObject({ status: "done" });
    expect(execs(two)).toHaveLength(8);
    expect(json(join(two.out, "job-rev-2", "report.json")).photos).toMatchObject({ codex_calls: { photo_analysis: 1, image_direction: 3, photo_review: 3 } });
    budget.push({ scenario: "3 photos, revision 2 (worst case)", calls: execs(two).length, elapsedMs: r2.elapsedMs });
    // the per-call timing: fixed stages in order, one entry per exec
    const timing = json(join(two.out, "job-rev-2", "report.json")).timing as { calls: number; call_list: Array<{ stage: string; result: string; schema: string; duration_ms: number }> };
    expect(timing.calls).toBe(8);
    expect(timing.call_list.map((c) => c.stage)).toEqual([
      "profile_brief",
      "photo_analysis",
      "image_direction",
      "visual_review",
      "image_direction_revision",
      "visual_review_revision",
      "image_direction_revision",
      "visual_review_revision",
    ]);
    expect(timing.call_list.every((c) => c.result === "ok" && c.schema === "strict" && Number.isInteger(c.duration_ms))).toBe(true);
    // the PoC report over the same run: lineage from the store, cleanup, timing and the estimate; codes and numbers only
    const poc = await pocReport({
      jobId: "job-rev-2",
      outRoot: two.out,
      queueRoot: two.queue,
      tmpBase: two.tmp,
      env: { HOME: two.root, TMPDIR: two.tmp, CODEX_HOME: join(two.root, "codex-home") },
      repoDir: process.cwd(),
      budgetMs: RUN_TIME_BUDGET_MS,
    });
    expect(poc).toMatchObject({ status: "REPORT", outcome: "done", lineage_ok: true, cleanup_ok: true, codex: { revisions: 2 }, photos: { assets: 3 }, timing: { calls: 8 }, estimate: { verdict: "OK" } });
    expect((poc as { lineage: Array<{ check: string }> }).lineage.map((c) => c.check)).toEqual(["assets", "photo_analyses", "images_candidate-0", "images_candidate-1", "images_candidate-2", "images_final"]);
    expect(JSON.stringify(poc)).not.toContain(two.root);
    // an edited direction breaks the lineage
    const finalPath = join(two.out, "job-rev-2", "final.images.json");
    const edited = json(finalPath);
    writeFileSync(finalPath, JSON.stringify({ ...edited, value: { ...(edited.value as object), paletteFit: 1 } }));
    const broken = await pocReport({ jobId: "job-rev-2", outRoot: two.out, queueRoot: two.queue, tmpBase: two.tmp, env: { HOME: two.root, TMPDIR: two.tmp, CODEX_HOME: join(two.root, "codex-home") }, repoDir: process.cwd(), budgetMs: RUN_TIME_BUDGET_MS });
    expect(broken).toMatchObject({ lineage_ok: false });
    assertClean(two);
  });

  it("cleans up after an invalid analysis, a failing Codex and a failed revision, and still finishes the job", async () => {
    const invalid = makeLayout();
    const a = await photoRun(invalid, "job-bad-analysis", 2, [{ answer: AMERICAN_EDITORIAL }, { answer: { photos: [ANALYSES[0]] } }, { answer: review() }]);
    expect(a.report.jobs[0]).toMatchObject({ status: "done" });
    expect(json(join(invalid.out, "job-bad-analysis", "report.json")).photos).toMatchObject({ analysis: "PHOTO_ANALYSIS_INVALID", final_layout: null });
    expect(existsSync(join(invalid.out, "job-bad-analysis", "final.images.json"))).toBe(false);
    assertClean(invalid);

    const nonzero = makeLayout();
    const b = await photoRun(nonzero, "job-bad-codex", 2, [
      { answer: AMERICAN_EDITORIAL },
      { answer: { photos: ANALYSES.slice(0, 2) } },
      { exit: 1, stderr: "boom" },
      { exit: 1, stderr: "boom" },
      { answer: review() },
    ]);
    expect(b.report.jobs[0]).toMatchObject({ status: "done" });
    // the refused strict schema and its loose retry are two timed execs of one direction call
    const calls = (json(join(nonzero.out, "job-bad-codex", "report.json")).timing as { call_list: Array<{ stage: string; schema: string; result: string }> }).call_list;
    expect(calls.map((c) => [c.stage, c.schema, c.result])).toEqual([
      ["profile_brief", "strict", "ok"],
      ["photo_analysis", "strict", "ok"],
      ["image_direction", "strict", "CODEX_EXEC_FAILED"],
      ["image_direction", "loose", "CODEX_EXEC_FAILED"],
      ["visual_review", "loose", "ok"],
    ]);
    assertClean(nonzero);

    const revision = makeLayout();
    const c = await photoRun(revision, "job-bad-revision", 2, [
      { answer: AMERICAN_EDITORIAL },
      { answer: { photos: ANALYSES.slice(0, 2) } },
      { answer: direction(2) },
      { answer: photoReview({ verdict: "revise", revision_target: "images" }) },
      { answer: { ...direction(2), layout: "gallery_grid" } },
    ]);
    expect(c.report.jobs[0]).toMatchObject({ status: "done" });
    expect(json(join(revision.out, "job-bad-revision", "report.json")).codex).toMatchObject({ final_candidate: "candidate-0" });
    assertClean(revision);
  });
});

describe("a Codex call with photos leaves no copy, whatever happens", () => {
  it("removes the work dir and its photo copies after success, an invalid answer, a nonzero exit and a timeout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "photo-cleanup-"));
    const record = join(dir, "record.jsonl");
    const env = (steps: Step[]) => {
      const file = join(dir, `steps-${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(file, JSON.stringify(steps));
      return { PATH: process.env.PATH, HOME: dir, CODEX_HOME: join(dir, ".codex"), FAKE_CODEX_STEPS: file, FAKE_CODEX_STATE: `${file}.state`, FAKE_CODEX_RECORD: record };
    };
    const call = (steps: Step[], timeoutMs?: number) =>
      runCodexJson({ sandbox: passthroughSandbox(FAKE_CODEX, env(steps)), prompt: "p", schema: {}, imageBytes: ASSETS.map((a) => a.png), ...(timeoutMs ? { timeoutMs } : {}) }).then(
        () => "ok",
        (e: unknown) => (e instanceof CodexError ? e.code : String(e)),
      );
    expect(await call([{ answer: { photos: [] } }])).toBe("ok");
    expect(await call([{ text: "not json at all" }])).toBe("CODEX_NO_JSON");
    expect(await call([{ exit: 1, stderr: "x" }])).toBe("CODEX_EXEC_FAILED");
    expect(await call([{ sleepMs: 5_000, answer: {} }], 800)).toBe("CODEX_TIMEOUT");
    const calls = (await readFile(record, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { args: string[]; cwd: string }).filter((c) => c.args[0] === "exec");
    expect(calls).toHaveLength(4);
    for (const c of calls) {
      expect(c.args.filter((a) => a.startsWith("--image="))).toHaveLength(3);
      expect(existsSync(c.cwd), c.cwd).toBe(false);
    }
  });
});
