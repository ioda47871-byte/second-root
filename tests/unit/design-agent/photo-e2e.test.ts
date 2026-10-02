import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pocReport } from "@/lib/design-agent/worker/poc";
import { productionPreview } from "@/lib/design-agent/worker/preview";
import { RUN_TIME_BUDGET_MS } from "@/lib/design-agent/worker/run";
import { chromium } from "playwright";
import { AMERICAN_EDITORIAL, review } from "./fixtures";
import { fakeAnalysis, fakePng, writeStore, type FakeAsset } from "./photo-fixtures";
import { makeLayout, runWorker, startMockSite, writeJob, type MockSite } from "./worker-support";

type Probe = { kind: string; images: Array<{ inWorkDir: boolean; sha256: string | null }>; storeVisible: boolean; queueVisible: boolean; resultsVisible: boolean; stateVisible: boolean };
type Rep = { codex: { notes: string[]; revisions: number; final_candidate: string | null }; photos: Record<string, unknown> | null };
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

// DEV-029 stage 5: the fake-asset E2E. One whole worker run per case with
// everything real except Codex's answers: the real `next build` + preview
// server, the real asset route, real Chromium screenshots and section crops,
// the real render check, and Codex inside the REAL bubblewrap sandbox with
// the asset store hidden. Photos are drawn by the test; no real shop.
//
// Slow (a production build): runs only with SR_PHOTO_E2E=1 and a working bwrap.

const bwrapWorks = spawnSync("bwrap", ["--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "--unshare-pid", "/bin/true"]).status === 0;
const enabled = process.env.SR_PHOTO_E2E === "1" && bwrapWorks;

vi.setConfig({ testTimeout: 15 * 60_000, hookTimeout: 60_000 });

let site: MockSite;
beforeAll(async () => {
  if (enabled) site = await startMockSite();
});
afterAll(() => {
  site?.server.close();
});

const A = "asset-aaaaaaaaaaaaaaaaaaaaaaaa";
const B = "asset-bbbbbbbbbbbbbbbbbbbbbbbb";
const C = "asset-cccccccccccccccccccccccc";
const ASSETS: FakeAsset[] = [
  { id: A, png: fakePng(720, 900, { seed: 11 }), sourceKind: "generated_concept" },
  { id: B, png: fakePng(960, 640, { seed: 12 }), sourceKind: "generated_concept" },
  { id: C, png: fakePng(800, 800, { seed: 13 }), sourceKind: "generated_concept" },
];
const ANALYSES = [fakeAnalysis(A, { orientation: "portrait" }), fakeAnalysis(B, { orientation: "landscape", suitability: { hero: 3, feature: 5 } }), fakeAnalysis(C, { orientation: "square" })];
const place = (assetId: string, over: Record<string, unknown> = {}) => ({ assetId, fit: "cover", focal: { x: 0.5, y: 0.45 }, mobileFocal: { x: 0.5, y: 0.45 }, aspect: { desktop: "4:5", mobile: "4:5" }, treatment: "natural", ...over });
const FACTS = { name: "EXAMPLE TEST BAKERY", category: "baked_goods", ward: "北区", address: "名古屋市北区テスト町1-2-3", description: "テスト用の架空の紹介文です。焼き菓子とパンの小さな店。" };
const photoReview = (over: Record<string, unknown> = {}) => ({
  ...review(),
  photo_scores: { image_selection: 4, crop: 4, focal_visibility: 4, text_image_collision: 5, image_repetition: 5, image_quality: 4, mobile_crop: 4, photo_brand_fit: 4 },
  photo_issues: [],
  revision_target: "none",
  ...over,
});

/**
 * A Codex CLI that answers by the schema it is given (profile, analysis,
 * direction, photo review in order from `reviews`), and records what it
 * could see from inside the sandbox.
 */
function codexScript(o: { queue: string; out: string; state: string; store: string; analyses: unknown; directions: unknown[]; reviews: unknown[] }): string {
  return `#!/usr/bin/env node
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const a = process.argv.slice(2);
if (a[0] === "login") { console.log("Logged in using ChatGPT"); process.exit(0); }
const schema = fs.readFileSync(a[a.indexOf("--output-schema") + 1], "utf8");
const images = a.filter((x) => x.startsWith("--image=")).map((x) => x.slice(8));
const counter = (name) => { const f = path.join(process.env.CODEX_HOME, name); const n = fs.existsSync(f) ? Number(fs.readFileSync(f, "utf8")) : 0; fs.writeFileSync(f, String(n + 1)); return n; };
const kind = schema.includes("revision_target") ? "photo_review" : schema.includes("nearDuplicateOf") ? "photo_analysis" : schema.includes("paletteFit") ? "image_direction" : schema.includes("verdict") ? "review" : "brief";
const probe = {
  kind,
  images: images.map((p) => ({ inWorkDir: p.startsWith(path.join(process.cwd(), "inputs") + "/"), sha256: (() => { try { return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); } catch { return null; } })() })),
  storeVisible: fs.existsSync(${JSON.stringify(o.store)}),
  queueVisible: fs.existsSync(${JSON.stringify(o.queue)}),
  resultsVisible: fs.existsSync(${JSON.stringify(o.out)}),
  stateVisible: fs.existsSync(${JSON.stringify(o.state)}),
};
fs.appendFileSync(path.join(process.env.CODEX_HOME, "probes.jsonl"), JSON.stringify(probe) + "\\n");
const answers = {
  brief: () => (${JSON.stringify(AMERICAN_EDITORIAL)}),
  photo_analysis: () => (${JSON.stringify(o.analyses)}),
  image_direction: () => ${JSON.stringify(o.directions)}[counter("directions")],
  photo_review: () => ${JSON.stringify(o.reviews)}[counter("reviews")],
  review: () => (${JSON.stringify(review())}),
};
fs.writeFileSync(a[a.indexOf("--output-last-message") + 1], JSON.stringify(answers[kind]()));
console.log(JSON.stringify({ type: "thread.started", thread_id: "11111111-1111-4111-8111-111111111111" }));
`;
}

async function e2e(jobId: string, n: number, directions: unknown[], reviews: unknown[]) {
  const l = makeLayout();
  const tmpBase = mkdtempSync(join(tmpdir(), "srdw-photo-e2e-tmp-"));
  const store = join(l.root, ".local", "share", "second-root-design-assets");
  await writeStore(store, jobId, ASSETS.slice(0, n));
  writeJob(l, jobId, "https://www.instagram.com/example_shop/", FACTS);
  const install = join(l.root, "codex-install", "bin");
  mkdirSync(install, { recursive: true });
  const codexBin = join(install, "codex");
  writeFileSync(codexBin, codexScript({ queue: l.queue, out: l.out, state: l.state, store, analyses: { photos: ANALYSES.slice(0, n) }, directions, reviews }), { mode: 0o755 });
  const launch = (env: NodeJS.ProcessEnv, args: readonly string[] = []) =>
    chromium.launch({ headless: true, env, args: [...args], ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : args.length > 0 ? { channel: "chromium" } : {}) });
  const env = {
    PATH: `${process.execPath.replace(/\/node$/, "")}:/usr/local/bin:/usr/bin:/bin`,
    HOME: l.root,
    LANG: "C.UTF-8",
    CODEX_HOME: join(l.root, "codex-home"),
    ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } : {}),
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { PLAYWRIGHT_CHROMIUM_EXECUTABLE: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
  };
  mkdirSync(env.CODEX_HOME, { recursive: true });
  const { report, logs } = await runWorker(l, site, {
    tmpBase,
    codexBin,
    prepareSandbox: undefined, // production: prepareCodexSandbox with workerProtectedPaths (the asset store included)
    env,
    startPreview: productionPreview(process.cwd(), launch),
  });
  const runDir = join(l.out, jobId);
  if (!existsSync(join(runDir, "report.json"))) throw new Error(`no report: ${JSON.stringify({ report, logs })}`);
  const rep = JSON.parse(readFileSync(join(runDir, "report.json"), "utf8")) as Rep;
  const probes = readFileSync(join(env.CODEX_HOME, "probes.jsonl"), "utf8").trim().split("\n").map((x) => JSON.parse(x) as Probe);
  const poc = await pocReport({ jobId, outRoot: l.out, queueRoot: l.queue, tmpBase, env: { HOME: l.root, TMPDIR: tmpBase, CODEX_HOME: env.CODEX_HOME }, repoDir: process.cwd(), budgetMs: RUN_TIME_BUDGET_MS });
  return { l, report, logs, rep, probes, poc, runDir };
}

function expectSandboxed(probes: Probe[], n: number) {
  for (const p of probes) {
    expect(p).toMatchObject({ storeVisible: false, queueVisible: false, resultsVisible: false, stateVisible: false });
    expect(p.images.every((i) => i.inWorkDir && i.sha256)).toBe(true);
    if (p.kind === "photo_analysis" || p.kind === "image_direction") expect(p.images.map((i) => i.sha256)).toEqual(ASSETS.slice(0, n).map((a) => sha256(a.png)));
  }
}

describe.skipIf(!enabled)("photo E2E: the real build, preview, asset route, Chromium and sandbox; fake Codex answers", () => {
  it("1 photo: split hero, accepted at round 0", async () => {
    const { report, logs, rep, probes, poc, runDir } = await e2e("poc-e2e-1", 1, [{ version: 1, layout: "split_hero", hero: place(A), features: [], rejected: [], paletteFit: 4 }], [photoReview({ verdict: "accept" })]);
    expect(report, JSON.stringify({ report, logs })).toMatchObject({ status: "finished", jobs: [{ status: "done", outcome: "done" }] });
    expect(rep.codex.notes).toEqual([]);
    expect(rep.photos).toMatchObject({ assets: 1, analysis: "done", final_layout: "split_hero", codex_calls: { photo_analysis: 1, image_direction: 1, photo_review: 1 } });
    expect(probes.map((p) => p.kind)).toEqual(["brief", "photo_analysis", "image_direction", "photo_review"]);
    expectSandboxed(probes, 1);
    expect(poc).toMatchObject({ lineage_ok: true, cleanup_ok: true, timing: { calls: 4 } });
    expect(existsSync(join(runDir, "after-mobile.png"))).toBe(true);
  });

  it("3 photos: hero + two features, one images revision, then accepted", async () => {
    const three = { version: 1, layout: "split_hero", hero: place(A), features: [{ ...place(B, { aspect: { desktop: "3:2", mobile: "3:2" } }), slot: "visit", side: "right" }, { ...place(C, { aspect: { desktop: "1:1", mobile: "1:1" } }), slot: "about", side: "left" }], rejected: [], paletteFit: 4 };
    const framed = { ...three, layout: "framed_hero" };
    const { report, logs, rep, probes, poc } = await e2e("poc-e2e-3", 3, [three, framed], [photoReview({ verdict: "revise", revision_target: "images", photo_issues: [{ issue: "crop", severity: "medium" }] }), photoReview({ verdict: "accept" })]);
    expect(report, JSON.stringify({ report, logs })).toMatchObject({ status: "finished", jobs: [{ status: "done", outcome: "done" }] });
    expect(rep.codex.notes).toEqual([]);
    expect(rep.codex).toMatchObject({ revisions: 1, final_candidate: "candidate-1" });
    expect(rep.photos).toMatchObject({ assets: 3, final_layout: "framed_hero", codex_calls: { photo_analysis: 1, image_direction: 2, photo_review: 2 } });
    expect(probes.map((p) => p.kind)).toEqual(["brief", "photo_analysis", "image_direction", "photo_review", "image_direction", "photo_review"]);
    expectSandboxed(probes, 3);
    expect(poc).toMatchObject({ lineage_ok: true, cleanup_ok: true, timing: { calls: 6 } });
  });
});
