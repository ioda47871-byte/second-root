/**
 * DEV-139: ほし窯 (bakery, a FICTIONAL bakery) research page d2-v2 in the existing photo pipeline, OFFLINE.
 *
 * Every picture here is a MOCK made by code at test time under os.tmpdir() (solid colours), never written to the
 * repository; the pipeline root with .intake/photos/ is temporary. No model, generator or network is used, and nothing
 * here approves anything: ほし窯's swap spec keeps aiDemoAllowed: false, HOSHIGAMA_APPROVAL stays null, and ほし窯 is in
 * neither AUTORUN_SHOPS nor root's IMAGE_AUTORUN_SHOPS. Where a test shows the path AFTER an approval, it hands a STUB
 * approval record explicitly (tests/support/hoshigama-approval-stub.ts).
 *
 * Covered: the spec (pages, breakpoints, edges, SP viewports, the exact placeholder triples, the CSS), the transform,
 * the swap end to end with mock photos (rights, 2× at the range edges, focal box, overflow, PC 1440 / SP 390 renders),
 * the upscale situation of the 1370 px oven-mouth photo against the existing 2× rule, the draft prompt pins, and the
 * bundle writer and intake (refusing without an approval; working with the stub).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { chromium, type Browser } from "playwright";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeHoshigamaPhotos, writeHoshigamaPhotosForRun } from "@/lib/design-agent/design-image/hoshigama-photos";
import type { ImageBatchResult } from "@/lib/design-agent/design-image/image-once";
import {
  boxText,
  buildHoshigamaRunPrompt,
  buildHoshigamaRunPromptCandidate,
  checkApprovedHoshigamaPrompt,
  checkDraftHoshigamaPrompt,
  HOSHIGAMA_APPROVAL,
  HOSHIGAMA_MAX_UPSCALE,
  HOSHIGAMA_OFFLINE_STUB_GENERATOR,
  HOSHIGAMA_PHOTOS,
  HOSHIGAMA_PROMPT_DRAFT_BYTES,
  HOSHIGAMA_PROMPT_DRAFT_SHA256,
  HOSHIGAMA_PROMPT_FILE,
  HOSHIGAMA_RUN_PROMPT_DRAFT_CHARS,
  HOSHIGAMA_RUN_PROMPT_DRAFT_SHA256,
  readApprovedHoshigamaPrompt,
} from "@/lib/design-agent/quality-pipeline/hoshigama-ai-photos";
import { loadForbiddenSha256 } from "@/lib/design-agent/quality-pipeline/photo-rights";
import { edgesFor, EDGE_VIEWPORTS, PhotoSlotEdges, PhotoSlotInventory, planSlot, requestFor, type FocalBox } from "@/lib/design-agent/quality-pipeline/photo-slots";
import { HOSHIGAMA_SWAP_CSS, SWAP_SHOP_SPECS } from "@/lib/design-agent/quality-pipeline/photo-swap-shops";
import { importHoshigamaAiPhotos } from "../../../../scripts/design-artifact/hoshigama-ai-intake";
import { AI_DEMO_SHOPS, loadInventory, swapPage, SWAP_SHOPS, transformHtml } from "../../../../scripts/design-artifact/photo-swap";
import { deriveEdges, deriveSlots } from "../../../../scripts/design-artifact/photo-slots";
import { MAX_UPSCALE, upscaleFactor } from "../../../../scripts/design-artifact/tsugute-ai-intake";
import { AUTORUN_SHOPS } from "../../../../scripts/sales-design-worker/autorun-shops";
import { STUB_APPROVAL, STUB_RUN_APPROVAL_ID } from "../../../support/hoshigama-approval-stub";

const REPO = resolve(__dirname, "../../../..");
const POC = "design-library/research/quality-pipeline/poc/bakery";
const PAGE = `${POC}/fidelity/d2-v2`;
const INV = PhotoSlotInventory.parse(JSON.parse(readFileSync(join(REPO, POC, "photo-slots-d2-v2.json"), "utf8")));
const EDGES = PhotoSlotEdges.parse(JSON.parse(readFileSync(join(REPO, POC, "photo-slot-edges-d2-v2.json"), "utf8")));
const EDGE_MAP = edgesFor(INV, EDGES)!;
const SPEC = SWAP_SHOP_SPECS.bakery;
const FORBIDDEN = loadForbiddenSha256(REPO);
const NOW = "2026-11-17";
const DRAFT = readFileSync(join(REPO, HOSHIGAMA_PROMPT_FILE), "utf8");
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const slot = (id: string) => INV.slots.find((s) => s.slot_id === id)!;
const photo = (id: string) => HOSHIGAMA_PHOTOS.find((p) => p.photo_id === id)!;
const launch = () => chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });

describe("ほし窯 d2-v2: the swap spec, pinned to the page", () => {
  it("is in the swap (research only) and nowhere that generates: no AI demo, no prompt pin, not an auto-run shop", () => {
    expect(SWAP_SHOPS).toContain("bakery");
    expect(SPEC.aiDemoAllowed).toBe(false);
    expect("aiDemoPromptSha256" in SPEC).toBe(false);
    expect(AI_DEMO_SHOPS.has("bakery")).toBe(false);
    expect(Object.keys(AUTORUN_SHOPS)).not.toContain("bakery");
    const cycle = readFileSync(join(REPO, "scripts/sales-design-worker/cycle.sh"), "utf8");
    expect(cycle).toMatch(/^IMAGE_AUTORUN_SHOPS='tsugute:6 bicycle:6'$/m);
    expect(cycle).not.toMatch(/bakery|hoshigama/);
  });
  it("the inventory and edges pin the page's HTML, CSS and copy; two slots, both empty CSS boards", () => {
    for (const [f, h] of [["index.html", INV.html_sha256], ["style.css", INV.css_sha256], ["copy.json", INV.copy_sha256]] as const) expect(sha(readFileSync(join(REPO, PAGE, f))), f).toBe(h);
    expect(INV.page_dir).toBe(PAGE);
    expect(INV.slots.map((s) => [s.slot_id, s.role, s.placeholder])).toEqual([["ph-mouth", "石窯の口", "css_board"], ["ph-loaf", "田舎パン", "css_board"]]);
    expect(readFileSync(join(REPO, PAGE, "index.html"), "utf8").replace(/<wbr>/g, "").match(/写真｜/g)).toHaveLength(2);
    expect(EDGE_MAP).not.toBeNull();
  });
  it("its ranges are the page's two (≤600, ≥601; the PC range in two files at the measured 1199 edge), its edges the default", () => {
    const css = readFileSync(join(REPO, PAGE, "style.css"), "utf8");
    expect(new Set([...css.matchAll(/@media[^{]*/g)].map((m) => m[0].trim()))).toEqual(new Set(["@media (min-width: 601px)"]));
    expect(SPEC.ranges.map((r) => [r.key, r.media])).toEqual([["desktop", null], ["tablet", "(max-width: 1199px)"], ["mobile", "(max-width: 600px)"]]);
    expect(SPEC.edgeViewports).toEqual(EDGE_VIEWPORTS);
    expect(EDGES.edge_viewports ?? EDGE_VIEWPORTS).toEqual(EDGE_VIEWPORTS);
    expect(SPEC.spViewports).toEqual(["mobile_390", "mobile_600"]);
    expect(SPEC.renders.map((r) => r.viewport)).toEqual(["desktop_1440", "mobile_390"]);
    // every PC viewport of a slot has the same board shape (601…1920), and the oven mouth changes shape only at ≤600
    for (const s of INV.slots) {
      const all = [...s.variants, ...EDGE_MAP.get(s.slot_id)!];
      const pc = new Set(all.filter((v) => !v.viewport.startsWith("mobile")).map((v) => v.ratio));
      expect(pc.size, s.slot_id).toBe(1);
    }
    expect(slot("ph-mouth").variants.find((v) => v.viewport === "mobile_390")!.ratio).toBeLessThan(0.7);
    expect(loadInventory("bakery", PAGE)).toMatchObject({ ok: true });
  });
  it("the placeholder triples are the page's exact markup, and the CSS keeps the arch clip (.board overflow)", () => {
    const html = readFileSync(join(REPO, PAGE, "index.html"), "utf8");
    const st = SPEC.structure as Extract<typeof SPEC.structure, { kind: "board_before_caption" }>;
    for (const t of st.triples) expect(html.split(`${t.container}${t.board}<div class="photo"></div></div>${t.caption}`).length - 1, t.board).toBe(1);
    expect(SPEC.swapCss).toBe(HOSHIGAMA_SWAP_CSS);
    expect(readFileSync(join(REPO, PAGE, "style.css"), "utf8")).toContain(".board { position: relative; overflow: hidden; }");
  });
});

describe("ほし窯's transform", () => {
  const html = readFileSync(join(REPO, PAGE, "index.html"), "utf8");
  const slotsIn = INV.slots.map((s) => ({ slot: s, alt: s.role, files: { desktop: `photos/${s.slot_id}-desktop.png`, tablet: `photos/${s.slot_id}-tablet.png`, mobile: `photos/${s.slot_id}-mobile.png` }, size: { width: 10, height: 10 } }));
  it("fills both boards with a picture following the page's breakpoints, and changes nothing else", () => {
    const out = transformHtml(html, slotsIn, SPEC);
    expect(out.replace(/<wbr>/g, "")).not.toContain("写真｜");
    expect(out).not.toMatch(/<div class="photo"><\/div>/);
    for (const s of INV.slots)
      expect(out).toContain(`<div class="photo"><picture data-slot="${s.slot_id}"><source media="(max-width: 600px)" srcset="photos/${s.slot_id}-mobile.png"><source media="(max-width: 1199px)" srcset="photos/${s.slot_id}-tablet.png"><img src="photos/${s.slot_id}-desktop.png" alt="${s.role}" width="10" height="10"></picture></div></div>\n  </div>`);
    const strip = (h: string) => h.replace(/\n {4}<p class="ph ph-(?:mouth|loaf)">写真｜[\s\S]*?<\/p>|<picture[\s\S]*?<\/picture>/g, "");
    expect(strip(out)).toBe(strip(html));
  });
  it("the other shops' structures on ほし窯's page are refused", () => {
    expect(() => transformHtml(html, slotsIn)).toThrow(/^CAPTION_NOT_FOUND: ph-mouth$/);
    expect(() => transformHtml(html, slotsIn, SWAP_SHOP_SPECS.bicycle)).toThrow(/^CAPTION_NOT_FOUND: ph-mouth$/);
  });
  it.each([
    ["a board with content", (h: string) => h.replace('<div class="board board-loaf"><div class="photo"></div>', '<div class="board board-loaf"><div class="photo"><b>x</b></div>'), "BOARD_NOT_FOUND: ph-loaf"],
    ["another indent before the caption", (h: string) => h.replace('</div></div>\n    <p class="ph ph-mouth">', '</div></div>\n  <p class="ph ph-mouth">'), "CAPTION_NOT_FOUND: ph-mouth"],
    ["the boards' triples mixed", (h: string) => h.replace('<div class="fig fig-loaf">', '<div class="fig fig-mouth">'), "BOARD_NOT_FOUND: ph-loaf"],
    ["a second copy of a caption", (h: string) => h.replace("</main>", '<div>\n    <p class="ph ph-loaf">写真｜田舎パン</p></div></main>'), "CAPTION_NOT_FOUND: ph-loaf"],
  ])("fails closed on %s", (_, mutate, code) => {
    const bad = mutate(html);
    expect(bad).not.toBe(html);
    expect(() => transformHtml(bad, slotsIn, SPEC)).toThrow(new RegExp(`^${code}$`));
  });
});

describe("ほし窯's draft prompt: pinned, NOT approved", () => {
  it("the file's bytes are the draft of the brief §6, and nothing names it approved", () => {
    expect(sha(DRAFT)).toBe(HOSHIGAMA_PROMPT_DRAFT_SHA256);
    expect(Buffer.byteLength(DRAFT)).toBe(HOSHIGAMA_PROMPT_DRAFT_BYTES);
    expect(DRAFT.split("\n")[0]).toContain("DRAFT (未承認)");
    const brief = readFileSync(join(REPO, "docs/design/hoshigama-ai-photo-brief.md"), "utf8");
    const block = brief.slice(brief.indexOf("## 6."), brief.indexOf("## 7."));
    expect(DRAFT.endsWith(block.slice(block.indexOf("```\n") + 4, block.lastIndexOf("```")))).toBe(true);
    expect(checkDraftHoshigamaPrompt(DRAFT)).toMatchObject({ ok: true });
    expect(HOSHIGAMA_APPROVAL).toBeNull();
    expect(checkApprovedHoshigamaPrompt(DRAFT)).toEqual({ ok: false, codes: ["PROMPT_NOT_APPROVED"] });
    expect(buildHoshigamaRunPrompt()).toBe("");
    expect(readApprovedHoshigamaPrompt()).toBe("");
    const run = buildHoshigamaRunPromptCandidate(DRAFT);
    expect([sha(run), run.length]).toEqual([HOSHIGAMA_RUN_PROMPT_DRAFT_SHA256, HOSHIGAMA_RUN_PROMPT_DRAFT_CHARS]);
    expect(run.endsWith(DRAFT.slice(DRAFT.indexOf("COMMON: ")))).toBe(true);
    // with the stub approval the run prompt is built (the shape the worker would get after an approval)
    expect(buildHoshigamaRunPrompt({ approval: STUB_APPROVAL })).toBe(run);
    expect(buildHoshigamaRunPrompt({ approval: STUB_APPROVAL, text: `${DRAFT} ` })).toBe("");
  });
  it("an edited text is not the draft (fail closed)", () => {
    expect(checkDraftHoshigamaPrompt(DRAFT.replace("country loaf", "baguette")).ok).toBe(false);
    expect(() => buildHoshigamaRunPromptCandidate(`${DRAFT}\n`)).toThrow(/PROMPT_NOT_THE_DRAFT/);
  });
  it("3 photos (2 slots), each target the swap's 2× request at the range edges, each box the draft's, each passing planSlot", () => {
    expect(HOSHIGAMA_PHOTOS.map((p) => [p.photo_id, p.slot_id, p.use, p.aspect])).toEqual([["ph-mouth-pc", "ph-mouth", "pc", "1:1"], ["ph-mouth-sp", "ph-mouth", "sp", "2:3"], ["ph-loaf", "ph-loaf", "pc", "4:3"]]);
    for (const p of HOSHIGAMA_PHOTOS) {
      expect(DRAFT).toContain(`${p.photo_id} (${p.aspect}): `);
      expect(DRAFT).toContain(`inside ${boxText(p.focal_box)})`);
    }
    // ph-loaf: the swap's own request for the slot (one shape for every viewport)
    expect(requestFor(slot("ph-loaf"), { edges: EDGE_MAP.get("ph-loaf")! })).toMatchObject({ ok: true, aspect: "4:3", min_width_px: photo("ph-loaf").target.width, min_height_px: photo("ph-loaf").target.height });
    // the oven mouth: one 3:4 photo would keep about 83% of itself at PC and 80% at SP (the worst) → the brief asks for a PC and an SP photo
    expect(requestFor(slot("ph-mouth"), { edges: EDGE_MAP.get("ph-mouth")! })).toMatchObject({ ok: true, aspect: "3:4", worst_kept_area: 0.803 });
    const exact = (id: string) => ({ width: photo(id).target.width, height: photo(id).target.height, focal_box: photo(id).focal_box });
    expect(planSlot(slot("ph-mouth"), { pc: exact("ph-mouth-pc"), sp: exact("ph-mouth-sp") }, { spViewports: SPEC.spViewports, edges: EDGE_MAP.get("ph-mouth")! })).toMatchObject({ ok: true, codes: [] });
    expect(planSlot(slot("ph-loaf"), { pc: exact("ph-loaf") }, { spViewports: SPEC.spViewports, edges: EDGE_MAP.get("ph-loaf")! })).toMatchObject({ ok: true, codes: [] });
    // 20 px less on the oven mouth's PC photo is below 2× at the 1920 edge (680 px tall → 1360)
    const small = { ...exact("ph-mouth-pc"), width: 1350, height: 1350 };
    expect(planSlot(slot("ph-mouth"), { pc: small, sp: exact("ph-mouth-sp") }, { spViewports: SPEC.spViewports, edges: EDGE_MAP.get("ph-mouth")! }).codes).toEqual(["SCALE_EXCEPTION_REQUIRED"]);
  });
});

describe("the upscale situation of the 1370 px oven-mouth photo (the existing 2× rule, not loosened)", () => {
  const pc = photo("ph-mouth-pc");
  it("ほし窯's max is an explicit per-shop value left at the existing 2×; upscaleFactor's default is unchanged", () => {
    expect(HOSHIGAMA_MAX_UPSCALE).toBe(MAX_UPSCALE);
    expect(MAX_UPSCALE).toBe(2);
    expect(upscaleFactor({ width: 1024, height: 1024 }, pc)).toBe(upscaleFactor({ width: 1024, height: 1024 }, pc, MAX_UPSCALE));
  });
  it("a 1536² picture needs no enlargement, a 1024² one 1.338× (within 2×), a 640² one 2.141× (refused); 1024×1536 reaches the SP photo", () => {
    expect(upscaleFactor({ width: 1536, height: 1536 }, pc, HOSHIGAMA_MAX_UPSCALE)).toBe(1);
    expect(upscaleFactor({ width: 1024, height: 1024 }, pc, HOSHIGAMA_MAX_UPSCALE)).toBe(1.338);
    expect(upscaleFactor({ width: 640, height: 640 }, pc, HOSHIGAMA_MAX_UPSCALE)).toBeNull();
    expect(upscaleFactor({ width: 1024, height: 1536 }, photo("ph-mouth-sp"), HOSHIGAMA_MAX_UPSCALE)).toBe(1);
    expect(upscaleFactor({ width: 1536, height: 1024 }, photo("ph-loaf"), HOSHIGAMA_MAX_UPSCALE)).toBe(1.283);
  });
  it("the swap's density rule: a 1280² picture is 1.88× at 1920 — only with an owner scale exception (≥1.5)", () => {
    const at1280 = { width: 1280, height: 1280, focal_box: pc.focal_box };
    const sp = { width: 650, height: 975, focal_box: photo("ph-mouth-sp").focal_box };
    const opts = { spViewports: SPEC.spViewports, edges: EDGE_MAP.get("ph-mouth")! };
    expect(planSlot(slot("ph-mouth"), { pc: at1280, sp }, opts).codes).toEqual(["SCALE_EXCEPTION_REQUIRED"]);
    expect(planSlot(slot("ph-mouth"), { pc: at1280, sp, scale_exception: { scale: 1.85, reason: "test", decided_by: "owner" } }, opts)).toMatchObject({ ok: true });
  });
});

/** A stub batch (3 PNGs made here, no model, no tool). */
async function stubBatch(sizes: Array<[number, number]>): Promise<ImageBatchResult> {
  const images = [];
  for (const [i, [w, h]] of sizes.entries()) images.push({ png: await sharp({ create: { width: w, height: h, channels: 3, background: { r: 120 + i * 30, g: 70, b: 30 } } }).png().toBuffer(), width: w, height: h });
  return { images, outcome: "not_applicable", stopCode: null, imageCalls: images.length, imageFailed: 0, threadId: null, cliVersion: "0.0.0-test", model: "fixture-image-model", codexMs: 1 };
}

describe("the bundle writer and the intake: refused without the owner's approval, working with a stub", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "dev139-intake-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const RUN = buildHoshigamaRunPromptCandidate(DRAFT);
  /** `approval: "default"` leaves the writer's own default (HOSHIGAMA_APPROVAL, null today) */
  const write = (batch: ImageBatchResult, approval: typeof STUB_APPROVAL | null | "default" = STUB_APPROVAL, runPrompt = RUN) =>
    writeHoshigamaPhotos({ outRoot: root, batch, commit: "a".repeat(40), approvedPrompt: DRAFT, runPrompt, generatedAt: "2026-11-17T10:00:00+09:00", approvalId: STUB_RUN_APPROVAL_ID, generator: HOSHIGAMA_OFFLINE_STUB_GENERATOR, ...(approval === "default" ? {} : { approval }) });
  const pipeline = (tag: string) => {
    const p = join(root, `pipeline-${tag}`);
    mkdirSync(join(p, ".intake", "photos"), { recursive: true });
    return p;
  };
  const intake = (from: string, p: string, o: Partial<Parameters<typeof importHoshigamaAiPhotos>[0]> = {}) => importHoshigamaAiPhotos({ from, manifestOut: join(p, "swap-manifest.json"), pipelineRoot: p, approvalIds: [STUB_RUN_APPROVAL_ID], generators: [HOSHIGAMA_OFFLINE_STUB_GENERATOR], approval: STUB_APPROVAL, ...o });

  it("today (no approval): the writer and the run hook refuse, and the intake refuses every bundle", async () => {
    const batch = await stubBatch([[1536, 1536], [1024, 1536], [1536, 1024]]);
    await expect(write(batch, "default")).rejects.toThrow(/PROMPT_NOT_APPROVED/);
    await expect(write(batch, null)).rejects.toThrow(/PROMPT_NOT_APPROVED/);
    await expect(writeHoshigamaPhotosForRun({ outRoot: root, batch, commit: "a".repeat(40), prompt: RUN, generatedAt: "2026-11-17T10:00:00+09:00", approvalId: STUB_RUN_APPROVAL_ID })).rejects.toThrow(/PROMPT_NOT_APPROVED/);
    // a run prompt other than the approved one is refused even with the stub
    await expect(write(batch, STUB_APPROVAL, `${RUN}\n`)).rejects.toThrow(/RUN_PROMPT/);
    const { dir } = await write(batch);
    const p = pipeline("none");
    expect(await importHoshigamaAiPhotos({ from: dir, manifestOut: join(p, "m.json"), pipelineRoot: p })).toEqual({ ok: false, codes: ["RUN_PROMPT_NOT_APPROVED"] });
    expect(await intake(dir, p, { approvalIds: undefined })).toMatchObject({ ok: false, codes: ["RUN_APPROVAL_UNKNOWN"] });
    expect(await intake(dir, p, { generators: undefined })).toMatchObject({ ok: false, codes: ["RUN_GENERATOR_UNKNOWN"] });
    expect(readdirSync(join(p, ".intake", "photos"))).toEqual([]);
  });
  it("with the stub: 3 pictures in, the oven-mouth PC and the loaf enlarged (lanczos3, ≤2×), rights ai_generated_demo", async () => {
    const { dir, manifest } = await write(await stubBatch([[1024, 1024], [1024, 1536], [1536, 1024]]));
    expect(manifest).toMatchObject({ status: "complete", shop: "bakery", page: "d2-v2", public_web: false, prompt_sha256: HOSHIGAMA_PROMPT_DRAFT_SHA256, run_prompt_sha256: HOSHIGAMA_RUN_PROMPT_DRAFT_SHA256 });
    expect(manifest.photos.map((x) => [x.photo_id, x.meets_target_2x])).toEqual([["ph-mouth-pc", false], ["ph-mouth-sp", true], ["ph-loaf", false]]);
    const p = pipeline("ok");
    const res = await intake(dir, p);
    if (!res.ok) throw new Error(res.codes.join(","));
    expect(res.provenance.map((x) => [x.photo_id, x.upscale?.factor ?? null, x.width, x.height])).toEqual([["ph-mouth-pc", 1.338, 1370, 1370], ["ph-mouth-sp", null, 1024, 1536], ["ph-loaf", 1.283, 1971, 1314]]);
    const slots = (res.manifest as { slots: Array<{ slot_id: string; pc: { rights: Record<string, unknown> }; sp?: unknown }> }).slots;
    expect(slots.map((s) => [s.slot_id, Boolean(s.sp)])).toEqual([["ph-mouth", true], ["ph-loaf", false]]);
    expect(slots[0]!.pc.rights).toMatchObject({ source_kind: "ai_generated_demo", allowed_uses: { public_web: false }, depicts_real_shop: false, ai_provenance: { prompt_sha256: HOSHIGAMA_PROMPT_DRAFT_SHA256, approval_id: STUB_RUN_APPROVAL_ID, demo_only: true } });
  });
  it("a 640² oven-mouth picture: UPSCALE_EXCEEDS_MAX (2.14× > 2×); a picture not on the upscale list: BELOW_TARGET", async () => {
    const { dir } = await write(await stubBatch([[640, 640], [1024, 1536], [1536, 1024]]));
    expect(await intake(dir, pipeline("640"))).toEqual({ ok: false, codes: ["UPSCALE_EXCEEDS_MAX:ph-mouth-pc"] });
    const { dir: d2 } = await write(await stubBatch([[1536, 1536], [1024, 1536], [1536, 1024]]));
    expect(await intake(d2, pipeline("nolist"), { approval: { ...STUB_APPROVAL, upscale_allowed: ["ph-mouth-pc"] } })).toEqual({ ok: false, codes: ["BELOW_TARGET:ph-loaf"] });
  });
});

describe("ほし窯 swap E2E with MOCK photos: rights → crop (2× at the edges, focal box) → swap → PC 1440 / SP 390", () => {
  let root: string;
  let pipeline: string;
  let browser: Browser;
  let n = 0;
  const outDir = () => join(root, `out-${++n}`);
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "dev139-swap-"));
    pipeline = join(root, "pipeline");
    mkdirSync(join(pipeline, ".intake", "photos"), { recursive: true });
    browser = await launch();
  });
  afterAll(async () => {
    await browser?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  async function mock(name: string, width: number, height: number, colour: number, over: Record<string, unknown> = {}) {
    const buf = await sharp({ create: { width, height, channels: 3, background: { r: (colour * 3) % 256, g: (colour * 11) % 256, b: (colour * 17) % 256 } } }).png().toBuffer();
    writeFileSync(join(pipeline, ".intake", "photos", `${name}.png`), buf);
    return {
      schema: "photo_rights_v0",
      asset_id: `photo-${name}`,
      sha256: sha(buf),
      bytes: buf.length,
      width,
      height,
      format: "png",
      source_kind: "owner_provided",
      owner: "mock test owner",
      license: "mock test only",
      paid: false,
      allowed_uses: { edit: true, crop: true, commercial: true, public_web: false },
      consent_record_ref: "mock-consent",
      received_at: "2026-11-01",
      expiry: null,
      private_path: `.intake/photos/${name}.png`,
      depicts_identifiable_person: false,
      depicts_real_shop: false,
      ...over,
    };
  }
  const box = (id: string): FocalBox => photo(id).focal_box;
  async function slots(tag: string) {
    const t = (id: string) => photo(id).target;
    return [
      { slot_id: "ph-mouth", pc: { rights: await mock(`h-${tag}-mouth-pc`, t("ph-mouth-pc").width, t("ph-mouth-pc").height, 40), focal_box: box("ph-mouth-pc") }, sp: { rights: await mock(`h-${tag}-mouth-sp`, t("ph-mouth-sp").width, t("ph-mouth-sp").height, 41), focal_box: box("ph-mouth-sp") } },
      { slot_id: "ph-loaf", pc: { rights: await mock(`h-${tag}-loaf`, t("ph-loaf").width, t("ph-loaf").height, 42), focal_box: box("ph-loaf") } },
    ];
  }
  const run = (s: unknown[], out = outDir(), b?: Browser) => swapPage({ pageDir: PAGE, manifest: { schema: "photo_swap_manifest_v0", shop: "bakery", slots: s }, out, pipelineRoot: pipeline, now: NOW, forbiddenSha256: FORBIDDEN, browser: b });
  const codesOf = (r: Awaited<ReturnType<typeof run>>) => (r.ok ? [] : r.refusals.flatMap((x) => x.codes));
  const nothingLeft = (out: string) => {
    expect(existsSync(out)).toBe(false);
    expect(readdirSync(root).filter((f) => f.includes(".partial-"))).toEqual([]);
  };

  it("the whole chain: both boards show a loaded mock photo at PC 1440 and SP 390, ≥2× everywhere checked, layout intact", async () => {
    const out = outDir();
    const res = await run(await slots("e2e"), out, browser);
    if (!res.ok) throw new Error(JSON.stringify(res.refusals));
    expect(res.renders.map((r) => r.viewport)).toEqual(["desktop_1440", "mobile_390"]);
    for (const r of res.renders) {
      expect(r, r.viewport).toMatchObject({ images: 2, images_loaded: 2, boards_matched: 2, caption_text_left: false, horizontal_overflow: false, boards_intact: 2 });
      expect((await sharp(r.file).metadata()).width).toBe({ desktop_1440: 1440, mobile_390: 390 }[r.viewport]);
    }
    const crops = res.summary.crops as Record<string, { source: string; rect: unknown; same_file_as?: string; density_by_viewport: Record<string, number | null> }>;
    // the loaf is 1.2 at 1440 and at 390: the same crop, so the mobile range shares the desktop file (no duplicate photo)
    expect(crops["ph-loaf/mobile"]).toMatchObject({ same_file_as: "desktop", rect: crops["ph-loaf/desktop"]!.rect });
    expect(Object.entries(crops).filter(([, c]) => c.same_file_as).map(([k]) => k)).toEqual(["ph-loaf/mobile"]);
    expect(readdirSync(join(out, "page", "photos")).sort()).toEqual(["ph-loaf-desktop.png", "ph-loaf-tablet.png", "ph-mouth-desktop.png", "ph-mouth-mobile.png", "ph-mouth-tablet.png"]);
    const shas = readdirSync(join(out, "page", "photos")).map((f) => sha(readFileSync(join(out, "page", "photos", f))));
    expect(new Set(shas).size).toBe(shas.length);
    const fileOf = (slotId: string, range: string) => `${slotId}-${crops[`${slotId}/${range}`]!.same_file_as ?? range}.png`;
    expect(["desktop", "tablet", "mobile"].map((r) => crops[`ph-mouth/${r}`]!.source)).toEqual(["pc", "pc", "sp"]);
    // 2× at every viewport the swap checked, the range edges (600, 1199, 1920) included
    for (const [k, c] of Object.entries(crops)) for (const [v, d] of Object.entries(c.density_by_viewport)) expect(d, `${k} ${v}`).toBeGreaterThanOrEqual(2);
    expect(Object.keys(crops["ph-mouth/desktop"]!.density_by_viewport)).toContain("desktop_1920");
    expect(Object.keys(crops["ph-mouth/tablet"]!.density_by_viewport)).toContain("tablet_1199");
    expect(Object.keys(crops["ph-mouth/mobile"]!.density_by_viewport)).toContain("mobile_600");
    const mouthSp = await sharp(join(out, "page", "photos", "ph-mouth-mobile.png")).metadata();
    const sp390 = slot("ph-mouth").variants.find((v) => v.viewport === "mobile_390")!;
    expect(Math.abs(mouthSp.width! / mouthSp.height! - sp390.width_px / sp390.height_px)).toBeLessThan(0.01);
    expect(res.summary).toMatchObject({ shop: "bakery", page_dir: PAGE, source_hashes: { html: INV.html_sha256, css: INV.css_sha256, copy: INV.copy_sha256 } });
    expect(readFileSync(join(out, "page", "style.css"), "utf8").endsWith(HOSHIGAMA_SWAP_CSS)).toBe(true);

    // independently, on the written copy: the arch still clips the oven-mouth photo (border-radius on its board)
    const dir = realpathSync(join(out, "page"));
    for (const [w, h, range] of [[1440, 900, "desktop"], [390, 844, "mobile"]] as const) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, javaScriptEnabled: false, serviceWorkers: "block" });
      try {
        const page = await ctx.newPage();
        const base = `file://${dir}${sep}`;
        const outside: string[] = [];
        await page.route("**/*", (route) => (route.request().url().startsWith(base) ? route.continue() : (outside.push(route.request().url()), route.abort())));
        await page.goto(`${base}index.html`, { waitUntil: "load" });
        const seen = (await page.evaluate(`(() => {
          const imgs = Array.from(document.querySelectorAll("img"));
          const mouth = document.querySelector('[data-comp-section="mouth"] div.board.board-mouth');
          return {
            imgs: imgs.map((i) => ({ current: i.currentSrc.split("/").pop(), natural: i.naturalWidth, alt: i.alt })),
            caption_left: document.body.innerText.includes("写真｜"),
            radius: getComputedStyle(mouth).borderTopLeftRadius,
            overflow: getComputedStyle(mouth).overflow,
            scroll: document.documentElement.scrollWidth,
            inner: window.innerWidth,
          };
        })()`)) as { imgs: Array<{ current: string; natural: number; alt: string }>; caption_left: boolean; radius: string; overflow: string; scroll: number; inner: number };
        expect(outside, `${w}`).toEqual([]);
        expect(seen.imgs.map((i) => i.alt)).toEqual(["石窯の口", "田舎パン"]);
        for (const [k, i] of seen.imgs.entries()) expect(i.natural > 0 && i.current === fileOf(["ph-mouth", "ph-loaf"][k]!, range), `${w} ${i.current}`).toBe(true);
        expect(seen.caption_left).toBe(false);
        expect(seen.radius).not.toBe("0px");
        expect(seen.overflow).toBe("hidden");
        expect(seen.scroll).toBeLessThanOrEqual(seen.inner + 1);
      } finally {
        await ctx.close();
      }
    }
    expect(readFileSync(join(out, "swap-summary.json"), "utf8")).not.toContain("mock test owner");
    expect(sha(readFileSync(join(REPO, PAGE, "index.html")))).toBe(INV.html_sha256);
  }, 180_000);

  it("refuses an ai_generated_demo picture for ほし窯 (not approved: AI_DEMO_NOT_ALLOWED), and nothing is written", async () => {
    const s: Array<Record<string, unknown>> = await slots("ai");
    const pc0 = (s[1]!.pc as { rights: Record<string, unknown> }).rights;
    s[1] = { ...s[1]!, pc: { rights: { ...pc0, source_kind: "ai_generated_demo", ai_provenance: { generator: "g", model: "fixture-image-model", generated_at: "2026-11-17T10:00:00+09:00", prompt_sha256: HOSHIGAMA_PROMPT_DRAFT_SHA256, approval_id: "x-test-01", demo_only: true } }, focal_box: box("ph-loaf") } };
    const out = outDir();
    const res = await run(s, out, browser);
    expect(res.ok ? [] : res.refusals).toEqual([{ slot_id: "ph-loaf", photo: "pc", codes: ["AI_DEMO_NOT_ALLOWED"] }]);
    nothingLeft(out);
  });
  it("a photo below 2× at the 1920 edge is refused; the SP photo is the brief's choice, not the swap rule's", async () => {
    const s = await slots("bad");
    // the square PC photo alone keeps its subject box and 61.5% of itself in the tall SP board: the swap would take it.
    // The brief asks for a separate SP photo for the arch's sake (its top 31% is cut away at SP), not because of the rule
    const pcOnly = planSlot(slot("ph-mouth"), { pc: { ...photo("ph-mouth-pc").target, focal_box: box("ph-mouth-pc") } }, { spViewports: SPEC.spViewports, edges: EDGE_MAP.get("ph-mouth")! });
    expect(pcOnly).toMatchObject({ ok: true, needs_sp_photo: false });
    const out = outDir();
    const small = [{ ...s[0]!, pc: { rights: await mock("h-bad-mouth-small", 1280, 1280, 7), focal_box: box("ph-mouth-pc") } }, s[1]!];
    expect(codesOf(await run(small, out))).toEqual(["SCALE_EXCEPTION_REQUIRED"]);
    nothingLeft(out);
  });

  it("the committed inventory and range edges are what the page measures now (within 2px)", async () => {
    const inv = await deriveSlots(browser, "bakery", PAGE);
    expect({ ...inv, slots: [] }).toEqual({ ...INV, slots: [] });
    const edges = await deriveEdges(browser, inv);
    expect({ ...edges, slots: [] }).toEqual({ ...EDGES, slots: [] });
    for (const [i, s] of inv.slots.entries()) {
      const w = INV.slots[i]!;
      expect([s.slot_id, s.role, s.board_selector, s.placeholder]).toEqual([w.slot_id, w.role, w.board_selector, w.placeholder]);
      for (const [j, v] of [...s.variants, ...edges.slots[i]!.edges].entries()) {
        const c = [...w.variants, ...EDGES.slots[i]!.edges][j]!;
        expect(v.viewport).toBe(c.viewport);
        expect(Math.abs(v.width_px - c.width_px), `${s.slot_id} ${v.viewport}`).toBeLessThanOrEqual(2);
        expect(Math.abs(v.height_px - c.height_px), `${s.slot_id} ${v.viewport}`).toBeLessThanOrEqual(2);
      }
    }
  }, 180_000);
});
