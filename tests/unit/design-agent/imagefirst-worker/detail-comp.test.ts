import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser } from "playwright";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PromptStop } from "@/lib/design-agent/image-first/prompt";
import { parseRequest } from "@/lib/design-agent/image-first/request-prompt";
import { packBundle } from "@/lib/design-agent/imagefirst-worker/bundle";
import { checkDesignApproval, DESIGN_AXES } from "@/lib/design-agent/imagefirst-worker/design-approval";
import { checkDetailFaithfulness, compareGrids } from "@/lib/design-agent/imagefirst-worker/detail-faithfulness";
import { runImplCompare } from "@/lib/design-agent/imagefirst-worker/impl-compare-approved";
import { approveRehearsal, sealRehearsal } from "@/lib/design-agent/imagefirst-worker/rehearsal";
import { loadRequestRun, printRequestPlan, validateRequestFile } from "@/lib/design-agent/imagefirst-worker/request";

// DEV-364 PR 4 (quality-proof-plan §2.4, §6 row 4; the owner's directive item 5): the detail comp request (offline only:
// validated and planned, never run) bound to an approved WHOLE-PAGE design, and the advisory faithfulness record of an
// implementation against the whole page and its detail comps. FICTIONAL data only (the research log's fictional bakery,
// an invented whole-page design, an invented site); NO Codex is started anywhere (the run path refuses the stage).

vi.setConfig({ testTimeout: 120_000 });
const REPO = resolve(__dirname, "../../../..");
const temps: string[] = [];
const tmp = (p = "sr-detail-") => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), p)));
  chmodSync(d, 0o700);
  temps.push(d);
  return d;
};
let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
});
afterAll(async () => {
  await browser?.close();
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const bytesOf = (o: unknown) => Buffer.from(`${JSON.stringify(o, null, 2)}\n`);
const codeOf = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string }) => e.code ?? String(e));
const T0 = Date.parse("2026-11-26T01:00:00Z");
const SHOP = "hoshigama";
const FACTS_BYTES = readFileSync(join(REPO, "design-library/research/quality-pipeline/poc/bakery/facts-pack.json"));
const DESIGN_ID = "req-hoshigama-design-detail-1";
const DETAIL_ID = "req-hoshigama-detail-1";

/** An invented whole-page picture with structure (grey bands and a dark block), so regions can be told apart. */
async function designPng(width: number, height: number, seed: number): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const band = Math.floor((y / height) * 8);
      const v = (band * 29 + seed * 17) % 200 + (x < width / 3 && y < height / 4 ? 0 : 40);
      raw.fill(v, (y * width + x) * 3, (y * width + x) * 3 + 3);
    }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

/** A worker HOME with the fictional bakery's facts and an approved whole-page design (sealed bundle + its records). */
/** section: the old 6-picture section design (PC 2 + SP 4) instead of a whole page (#375 review M1). */
async function world(o: { decision?: "approve" | "revise"; section?: boolean } = {}) {
  const home = tmp("sr-detail-home-");
  const shopDir = join(home, "second-root-shops", SHOP);
  mkdirSync(join(shopDir, "design-reviews"), { recursive: true, mode: 0o700 });
  writeFileSync(join(shopDir, "facts-pack.json"), FACTS_BYTES);
  const runs = tmp("sr-detail-runs-");
  const runDir = join(runs, `${DESIGN_ID}-20261126T010000Z`);
  mkdirSync(join(runDir, "parts"), { recursive: true, mode: 0o700 });
  chmodSync(runDir, 0o700);
  const pictures = { pc: await designPng(1024, 1536, 1), sp: await designPng(1024, 1536, 2) };
  const parts: { view: "pc" | "sp"; n: number }[] = o.section ? [...[1, 2].map((n) => ({ view: "pc" as const, n })), ...[1, 2, 3, 4].map((n) => ({ view: "sp" as const, n }))] : [{ view: "pc", n: 1 }, { view: "sp", n: 1 }];
  const images = await Promise.all(
    parts.map(async ({ view, n }) => {
      const bytes = n === 1 ? pictures[view] : await designPng(1024, 1536, 10 + n);
      writeFileSync(join(runDir, "parts", `${view}-${n}.png`), bytes, { mode: 0o600 });
      return { file: `parts/${view}-${n}.png`, sha256: sha(bytes), bytes: bytes.length };
    }),
  );
  const references = [{ id: "ref-1", case_id: "CP-001", sha256: sha("invented reference") }];
  if (!o.section) writeFileSync(join(runDir, "reference-inputs.json"), JSON.stringify({ schema: "image_first_reference_inputs_v0", layout: "whole_page", references }), { mode: 0o600 });
  const receipt = {
    schema: "imagefirst_worker_receipt_v1", status: "succeeded", stop_code: null, stage: null, cli_exit: 0, cli_timed_out: false, interrupted: false,
    shop: SHOP, direction: "request", approval_id: DESIGN_ID, plan_id: DESIGN_ID, commit: "c".repeat(40), packet_sha256: "a".repeat(64), plan_sha256: "b".repeat(64), prompt_sha256: "d".repeat(64), prompt_chars: 4000,
    run_dir: runDir, images, stopped_images: [], verified: true,
    timings: { started_at: "2026-11-26T01:00:00.000Z", finished_at: "2026-11-26T01:05:00.000Z", elapsed_ms: 300_000 },
    mode: "request", kind: "fictional", request_id: DESIGN_ID, request_sha256: "a".repeat(64), facts_sha256: sha(FACTS_BYTES), images_total: images.length,
    ...(o.section ? { counts: { pc: 2, sp: 4, total: 6, stopped: 0 } } : { counts: { pc: 1, sp: 1, total: 2, stopped: 0 }, design_layout: "whole_page", reference_images: references }),
  };
  const receiptPath = join(runs, "design.receipt.json");
  writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
  mkdirSync(join(home, "sr-runs"), { mode: 0o700 });
  const sealed = await packBundle({ runDir, receiptPath, bundlesDir: join(home, "sr-runs", "review-inbox"), now: () => T0 });
  const dr = join(shopDir, "design-reviews");
  const pick = (view: "pc" | "sp") => images.filter((i) => i.file.startsWith(`parts/${view}-`)).map((i) => ({ file: i.file, sha256: i.sha256 }));
  const axis = { verdict: "pass", evidence: [{ image: "pc", region: "ページ全体", note: "試験用の根拠（架空）" }] };
  const reviewPath = join(dr, `${DESIGN_ID}.review.json`);
  writeFileSync(reviewPath, bytesOf({ schema: "sr_design_review_v1", request_id: DESIGN_ID, bundle_sha256: sealed.bundle_sha256, images: { pc: pick("pc"), sp: pick("sp") }, axes: Object.fromEntries(DESIGN_AXES.map((a) => [a, axis])), reviewer: "independent-subagent", reviewed_at: "2026-11-26T01:10:00Z" }), { mode: 0o600 });
  const draft = await checkDesignApproval({ bundleDir: sealed.dir, reviewPath, repo: REPO, mode: "draft" });
  const approvalPath = join(dr, `${DESIGN_ID}.approval.json`);
  writeFileSync(approvalPath, bytesOf({ schema: "sr_design_approval_v1", request_id: DESIGN_ID, bundle_sha256: sealed.bundle_sha256, approved_images: { pc: pick("pc"), sp: pick("sp") }, review_sha256: draft.review_sha256, page_sha256: draft.page_sha256, decision: o.decision ?? "approve", decided_at: "2026-11-26T01:20:00Z" }), { mode: 0o600 });
  return { home, bundleDir: sealed.dir, bundleSha: sealed.bundle_sha256, reviewPath, approvalPath, pictures };
}
type World = Awaited<ReturnType<typeof world>>;

const TARGETS = [
  { id: "hero", view: "pc", box: { x: 0, y: 0, w: 1, h: 0.25 }, note: "最初の画面の見出しと写真の枠" },
  { id: "products", view: "pc", box: { x: 0.05, y: 0.3, w: 0.9, h: 0.3 }, note: "品書きの並び" },
  { id: "shop_info", view: "sp", box: { x: 0, y: 0.75, w: 1, h: 0.25 }, note: "営業時間と場所の区画" },
];
const detailRequest = (w: Pick<World, "bundleSha">, over: Record<string, unknown> = {}) => ({
  schema: "sr_imagefirst_request_v1",
  id: DETAIL_ID,
  shop_id: SHOP,
  kind: "fictional",
  created_at: "2026-11-26T02:00:00Z",
  facts_ref: { root: "second-root-shops", shop_id: SHOP },
  facts_sha256: sha(FACTS_BYTES),
  codex_runs: 1,
  stage: "detail_comp",
  approved_design: { bundle_id: DESIGN_ID, bundle_sha256: w.bundleSha, review_file: `${DESIGN_ID}.review.json`, approval_file: `${DESIGN_ID}.approval.json` },
  targets: TARGETS,
  max_images: TARGETS.length,
  ...over,
});
const place = (o: Record<string, unknown>) => {
  const file = join(tmp("sr-detail-req-"), `${o.id as string}.json`);
  writeFileSync(file, bytesOf(o));
  return file;
};

describe("DEV-364 PR 4: the detail comp request (offline only)", () => {
  let w: World;
  beforeAll(async () => {
    w = await world();
  });

  it("--validate-request: bound to the approved whole page, support only, never runnable", async () => {
    const file = place(detailRequest(w));
    const v = await validateRequestFile({ file, home: w.home, repo: REPO });
    expect(v).toMatchObject({ request_id: DETAIL_ID, stage: "detail_comp", runnable: false, support_only: true, approved_design: { bundle_id: DESIGN_ID, bundle_sha256: w.bundleSha }, photo_inputs: null });
    expect((v as { targets: unknown[] }).targets).toEqual(TARGETS.map((t) => ({ id: t.id, view: t.view, box: t.box })));
  });

  it("--print-plan: what the one run would be sent — enlarge and refine each region of the approved picture, nothing new", async () => {
    const file = place(detailRequest(w));
    const p = await printRequestPlan({ file, home: w.home, repo: REPO, checkout: async () => ({ head: null, base: null, clean: false }) });
    const v = await validateRequestFile({ file, home: w.home, repo: REPO });
    expect(p.plan_sha256).toBe(v.plan_sha256);
    expect(p.codex_invoked).toBe(false);
    expect(p.plan).toMatchObject({ stage: "detail_comp", support_only: true, counts_as_design_success: false });
    expect(p.sent.max_images).toBe(3);
    // the references: the approved PC and SP pictures, only the views used, each with its SHA-256 (never more than 5)
    expect(p.sent.attachments.map((a) => [a.name, a.image, a.sha256])).toEqual([
      ["ref-1.png", "pc-1", sha(w.pictures.pc)],
      ["ref-2.png", "sp-1", sha(w.pictures.sp)],
    ]);
    const prompt = p.sent.prompt;
    for (const words of ["enlarges and refines one region of the approved design", "the same layout, colours and type", "no new elements", "photo frames kept as plain frames labelled イメージ", "never change its composition"]) expect(prompt).toContain(words);
    for (const words of ["左から 0%〜100%、上から 0%〜25%", "範囲の外のものを描き足さない", "新しい要素", "「イメージ」の表示を残す"]) expect(prompt).toContain(words);
    expect(prompt).not.toMatch(/section|節分割/i);
  });

  it("refuses: no approved design, more than 5 references, a region outside the picture, a count mismatch, an unapproved design", async () => {
    const bad = async (over: Record<string, unknown>, ww: World = w) => codeOf(validateRequestFile({ file: place(detailRequest(ww, over)), home: ww.home, repo: REPO }));
    const noDesign = detailRequest(w);
    delete (noDesign as Record<string, unknown>).approved_design;
    expect(await codeOf(validateRequestFile({ file: place(noDesign), home: w.home, repo: REPO }))).toBe("APPROVED_DESIGN_REQUIRED");
    const six = Array.from({ length: 6 }, (_, n) => ({ id: (["hero", "products", "shop_info"] as const)[n % 3], view: n < 3 ? "pc" : "sp", box: { x: 0, y: n * 0.15, w: 1, h: 0.1 }, note: "試験" }));
    expect(await bad({ targets: six, max_images: 6 })).toBe("DETAIL_REFERENCES_OVER_LIMIT");
    expect(await bad({ targets: [{ ...TARGETS[0]!, box: { x: 0.5, y: 0, w: 0.6, h: 0.2 } }], max_images: 1 })).toBe("DETAIL_REGION_OUTSIDE");
    expect(await bad({ targets: [{ ...TARGETS[0]!, box: { x: 0, y: 0, w: 0, h: 0.2 } }], max_images: 1 })).toBe("DETAIL_REGION_OUTSIDE");
    expect(await bad({ max_images: 2 })).toBe("REQUEST_IMAGES_MISMATCH");
    expect(await bad({ targets: [TARGETS[0], TARGETS[0]], max_images: 2 })).toBe("REQUEST_INVALID");
    expect(await bad({ approved_design: { bundle_id: DESIGN_ID, bundle_sha256: "e".repeat(64), review_file: `${DESIGN_ID}.review.json`, approval_file: `${DESIGN_ID}.approval.json` } })).toBe("APPROVED_DESIGN_MISMATCH");
    // the design's own gate runs: a design the owner asked to revise is not approved
    const revised = await world({ decision: "revise" });
    expect(await bad({}, revised)).toBe("DESIGN_NOT_APPROVED");
    // #375 review M1: the old 6-picture section design (its references are only its first PC and SP) is not a whole page
    const section = await world({ section: true });
    expect(await bad({}, section)).toBe("DETAIL_COMP_NOT_WHOLE_PAGE");
    // a note quoting a facts-pack value (the shop's name)
    const facts = JSON.parse(FACTS_BYTES.toString("utf8")) as { facts: { key: string; value: string }[] };
    const name = facts.facts.find((f) => f.key === "name")!.value;
    expect(await bad({ targets: [{ ...TARGETS[0]!, note: `${name}の見出し` }], max_images: 1 })).toBe("REQUEST_DIRECTION_HAS_FACT");
  });

  it("the real worker CLI: --validate-request says valid / runnable false, --print-plan shows the plan (exit 0), nothing written", () => {
    const ENTRY = join(REPO, "tests/unit/design-agent/imagefirst-worker/fixtures/worker-cli-entry.ts");
    const file = place(detailRequest(w));
    const run = (flag: string) => {
      const r = spawnSync(process.execPath, ["--import", "tsx", ENTRY, "0::/\n", flag, file], { cwd: REPO, encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: w.home } as unknown as NodeJS.ProcessEnv, timeout: 60_000 });
      return { status: r.status, out: JSON.parse(r.stdout.trim().split("\n").filter(Boolean).length ? r.stdout : "null") as Record<string, unknown> | null };
    };
    const before = readdirSync(w.home).sort();
    const v = run("--validate-request");
    expect([v.status, v.out?.status, v.out?.stage, v.out?.runnable]).toEqual([0, "valid", "detail_comp", false]);
    const p = run("--print-plan");
    expect([p.status, p.out?.status, (p.out?.plan as { stage?: string } | undefined)?.stage, p.out?.codex_invoked]).toEqual([0, "plan", "detail_comp", false]);
    expect(readdirSync(w.home).sort()).toEqual(before);
  });

  it("refuses a synthetic (rehearsal) approval", async () => {
    const home = tmp("sr-detail-reh-");
    const r = await sealRehearsal({ home, repo: REPO, now: () => T0 });
    const draft = await checkDesignApproval({ bundleDir: r.bundle_dir, reviewPath: r.review, repo: REPO, mode: "draft" });
    const a = await approveRehearsal({ home, repo: REPO, pageSha256: draft.page_sha256, now: () => T0 + 60_000 });
    const m = JSON.parse(readFileSync(a.materials_request, "utf8")) as Record<string, unknown>;
    const req = { schema: m.schema, id: "req-synthetic-detail-1", shop_id: m.shop_id, kind: m.kind, created_at: m.created_at, facts_ref: m.facts_ref, facts_sha256: m.facts_sha256, codex_runs: 1, stage: "detail_comp", approved_design: m.approved_design, targets: [TARGETS[0]], max_images: 1 };
    expect(await codeOf(validateRequestFile({ file: place(req), home, repo: REPO }))).toBe("DETAIL_COMP_DESIGN_SYNTHETIC");
  });

  it("the run path never runs a detail comp (no Codex): parseRequest and loadRequestRun refuse the stage", async () => {
    const bytes = bytesOf(detailRequest(w));
    expect(() => parseRequest(bytes, sha(bytes), DETAIL_ID)).toThrow(PromptStop);
    expect(await codeOf(Promise.resolve().then(() => parseRequest(bytes, sha(bytes), DETAIL_ID)))).toBe("DETAIL_COMP_NOT_RUNNABLE");
    const file = place(detailRequest(w));
    expect(await codeOf(loadRequestRun({ requestFile: file, requestSha256: sha(readFileSync(file)), requestId: DETAIL_ID, home: w.home, repo: REPO }))).toBe("DETAIL_COMP_NOT_RUNNABLE");
  });
});

describe("DEV-364 PR 4: the faithfulness record (advisory) against the whole page and the detail comps", () => {
  it("records the whole page (the stage-6 comparison) and each region against the approved picture and its detail comp; refuses unbound inputs", async () => {
    const w = await world();
    const design = { bundleDir: w.bundleDir, reviewPath: w.reviewPath, approvalPath: w.approvalPath };
    // an invented finished site: a dark heading block over light bands
    const site = tmp("sr-detail-site-");
    writeFileSync(join(site, "index.html"), '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="style.css"></head><body><header><h1>架空の店</h1></header><main><p>試験の本文です。</p></main><footer><p>架空の店の情報</p></footer></body></html>');
    writeFileSync(join(site, "style.css"), "body{margin:0;background:#eee;font-family:sans-serif}header{height:420px;background:#222;color:#fff;display:flex;align-items:center;padding-left:40px}main{height:900px;background:linear-gradient(#ddd,#999)}footer{height:300px;background:#444;color:#fff}");
    const implDir = join(tmp(), "impl");
    await runImplCompare({ ...design, siteDir: site, outDir: implDir, repo: REPO, browser, now: () => T0 + 600_000 });
    // a detail comp that matches the site's hero (its own capture region, enlarged) and one that does not (flat)
    const cap = readFileSync(join(implDir, "images", "pc-capture.png"));
    const meta = await sharp(cap).metadata();
    const hero = { x: 0, y: 0, w: 1, h: 0.2 };
    const matching = join(tmp(), "detail-hero.png");
    writeFileSync(matching, await sharp(cap).extract({ left: 0, top: 0, width: meta.width!, height: Math.round(meta.height! * hero.h) }).resize(1536, 1024, { fit: "fill" }).png().toBuffer(), { mode: 0o600 });
    const flat = join(tmp(), "detail-flat.png");
    writeFileSync(flat, await sharp({ create: { width: 1024, height: 1024, channels: 3, background: { r: 250, g: 250, b: 250 } } }).png().toBuffer(), { mode: 0o600 });
    const r = await checkDetailFaithfulness({ design, implCompareDir: implDir, regions: [{ target: "hero", view: "pc", box: hero, detailPath: matching }, { target: "hero", view: "sp", box: hero, detailPath: flat }, { target: "shop_info", view: "pc", box: { x: 0, y: 0.8, w: 1, h: 0.2 } }], outDir: join(tmp(), "faith"), repo: REPO, now: () => T0 + 700_000 });
    expect(r.record).toMatchObject({ schema: "sr_detail_faithfulness_v1", advisory: true, passing: false, request_id: DESIGN_ID });
    expect(JSON.parse(readFileSync(r.path, "utf8"))).toEqual(r.record);
    expect(r.record.whole_page.status).toBeTypeOf("string");
    const [m, f, plain] = r.record.regions;
    expect(m!.detail!.against_detail.mean_abs_diff).toBeLessThan(0.05);
    expect(m!.detail!.against_detail.correlation).toBeGreaterThan(0.9);
    expect(f!.detail!.against_detail.mean_abs_diff).toBeGreaterThan(m!.detail!.against_detail.mean_abs_diff);
    expect(plain!.detail).toBeNull();
    for (const x of r.record.regions) expect(x.against_whole_page.mean_abs_diff).toBeGreaterThanOrEqual(0);
    // refusals: regions outside / too many, a comparison of another design, a replaced capture, a non-empty output
    const again = (over: Partial<Parameters<typeof checkDetailFaithfulness>[0]>) => codeOf(checkDetailFaithfulness({ design, implCompareDir: implDir, regions: [{ target: "hero", view: "pc", box: hero }], outDir: join(tmp(), "faith"), repo: REPO, ...over }));
    expect(await again({ regions: [{ target: "hero", view: "pc", box: { x: 0.9, y: 0, w: 0.2, h: 0.1 } }] })).toBe("DETAIL_FAITH_REGION_OUTSIDE");
    expect(await again({ regions: Array.from({ length: 6 }, () => ({ target: "hero" as const, view: "pc" as const, box: hero })) })).toBe("DETAIL_FAITH_TOO_MANY_REGIONS");
    const recordPath = join(implDir, "record.json");
    const before = readFileSync(recordPath);
    writeFileSync(recordPath, Buffer.from(before.toString("utf8").replace(/"approval_sha256": "[0-9a-f]+"/, `"approval_sha256": "${"0".repeat(64)}"`)));
    expect(await again({})).toBe("DETAIL_FAITH_IMPL_MISMATCH");
    writeFileSync(recordPath, before);
    const capPath = join(implDir, "images", "sp-capture.png");
    const capBefore = readFileSync(capPath);
    writeFileSync(capPath, await sharp({ create: { width: 390, height: 800, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer());
    expect(await again({})).toBe("DETAIL_FAITH_CAPTURE_MISMATCH");
    writeFileSync(capPath, capBefore);
    const full = tmp();
    writeFileSync(join(full, "x"), "x");
    expect(await again({ outDir: full })).toBe("DETAIL_FAITH_OUT_NOT_EMPTY");
    expect(await again({ outDir: join(REPO, "tmp-faith") })).toBe("DETAIL_FAITH_IN_REPO");
    // #375 review L1: an existing output folder must be ours and private; inputs and their folders too
    const open = tmp();
    chmodSync(open, 0o755);
    expect(await again({ outDir: open })).toBe("DETAIL_FAITH_OUT_UNSAFE");
    chmodSync(implDir, 0o755);
    expect(await again({})).toBe("DETAIL_FAITH_FOLDER_UNSAFE");
    chmodSync(implDir, 0o700);
    chmodSync(matching, 0o644);
    expect(await again({ regions: [{ target: "hero", view: "pc", box: hero, detailPath: matching }] })).toBe("DETAIL_FAITH_INPUT_UNSAFE");
    chmodSync(matching, 0o600);
    expect(await again({})).toBe("ok");
  });

  it("compareGrids: identical grids, an inverted grid, a flat grid", () => {
    const a = Array.from({ length: 16 }, (_, i) => i / 15);
    expect(compareGrids(a, a)).toEqual({ mean_abs_diff: 0, correlation: 1 });
    expect(compareGrids(a, a.map((x) => 1 - x)).correlation).toBe(-1);
    expect(compareGrids(a, a.map(() => 0.5)).correlation).toBeNull();
  });
});
