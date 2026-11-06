/**
 * DEV-191 (Issue #193, owner approval 2026-11-06, comment 6687410438): 輪's approved photo prompt, pinned; the run bundle
 * writer, the AI demo intake and the swap's OFF candidate — tested OFFLINE with 6 STUB pictures.
 *
 * Every picture here is a flat stub PNG made by code at test time under os.tmpdir() (a coloured block marks the subject
 * box); nothing is generated, fetched or committed. No Codex, no image tool, no network. The renders use the local
 * Chromium (PLAYWRIGHT_CHROMIUM_EXECUTABLE when set).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser } from "playwright";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeBicyclePhotos } from "@/lib/design-agent/design-image/bicycle-photos";
import type { ImageBatchResult } from "@/lib/design-agent/design-image/image-once";
import {
  BICYCLE_DEMO_LABEL,
  BICYCLE_GENERATOR,
  BICYCLE_OFFLINE_STUB_GENERATOR,
  BICYCLE_PHOTOS,
  BICYCLE_PROMPT_APPROVAL,
  BICYCLE_PROMPT_BYTES,
  BICYCLE_PROMPT_CHARS,
  BICYCLE_PROMPT_FILE,
  BICYCLE_PROMPT_SHA256,
  BICYCLE_RUN_APPROVAL_ID,
  BICYCLE_RUN_PROMPT_CANDIDATE_CHARS,
  BICYCLE_RUN_PROMPT_CANDIDATE_SHA256,
  buildBicycleRunPrompt,
  buildBicycleRunPromptCandidate,
  BICYCLE_RUN_PROMPT_APPROVAL,
  readApprovedBicyclePrompt,
  checkApprovedBicyclePrompt,
  parseBicyclePrompt,
  photoPrompt,
} from "@/lib/design-agent/quality-pipeline/bicycle-ai-photos";
import { AI_DEMO_PUBLIC_LABEL, checkPhotoRights, loadForbiddenSha256, toPublicPhotoRecord } from "@/lib/design-agent/quality-pipeline/photo-rights";
import { edgesFor, PhotoSlotEdges, PhotoSlotInventory, planSlot } from "@/lib/design-agent/quality-pipeline/photo-slots";
import { SWAP_SHOP_SPECS } from "@/lib/design-agent/quality-pipeline/photo-swap-shops";
import { importBicycleAiPhotos } from "../../../../scripts/design-artifact/bicycle-ai-intake";
import { AI_DEMO_SHOPS, swapPage, SwapManifest } from "../../../../scripts/design-artifact/photo-swap";

const REPO = resolve(__dirname, "../../../..");
const POC = "design-library/research/quality-pipeline/poc/bicycle";
const PAGE = `${POC}/fidelity/d1-v9`;
const INV = PhotoSlotInventory.parse(JSON.parse(readFileSync(join(REPO, POC, "photo-slots-d1-v9.json"), "utf8")));
const EDGES = edgesFor(INV, PhotoSlotEdges.parse(JSON.parse(readFileSync(join(REPO, POC, "photo-slot-edges-d1-v9.json"), "utf8"))))!;
const TEXT = readFileSync(join(REPO, BICYCLE_PROMPT_FILE), "utf8");
const FORBIDDEN = loadForbiddenSha256(REPO);
const COMMIT = "38e396eedf2de3f7472fd29052036b8ca0f7541e";
const STUB_APPROVAL = "bicycle-stub-test-01";
const GENERATED_AT = "2026-11-06T09:00:00Z";
const NOW = "2026-11-06";
const ORDER = ["ph-d", "ph-a", "ph-c", "ph-b", "ph-bench-pc", "ph-bench-sp"];
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const launch = () => chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });

describe("DEV-191 the owner-approved prompt: verified and pinned, its bytes unedited", () => {
  it("the file is exactly the approved bytes (SHA-256 83c9b2c6…, 3865 bytes); the historical DRAFT line is still there", () => {
    const buf = readFileSync(join(REPO, BICYCLE_PROMPT_FILE));
    expect(sha(buf)).toBe("83c9b2c628873d645a78145065a5ff5befeab7f406555b79649f1f44d8275594");
    expect(buf.length).toBe(3865);
    expect([BICYCLE_PROMPT_SHA256, BICYCLE_PROMPT_BYTES, BICYCLE_PROMPT_CHARS]).toEqual([sha(buf), buf.length, TEXT.length]);
    expect(TEXT.split("\n")[0]).toMatch(/^DRAFT \(未承認\) — DEV-190/);
  });
  it("the approval is recorded beside the bytes: owner, 2026-11-06, comment 6687410438, the SHA and bytes, text only", () => {
    expect(BICYCLE_PROMPT_APPROVAL).toEqual({
      approval_id: "bicycle-photo-prompt-20261106",
      scope: "prompt_text_only_not_a_generation_run",
      decided_by: "owner",
      decided_on: "2026-11-06",
      evidence: "Issue #193 comment 6687410438",
      file: "docs/design/bicycle-ai-photo-prompt.txt",
      sha256: BICYCLE_PROMPT_SHA256,
      bytes: 3865,
      leading_draft_note_is_historical: true,
    });
    const brief = readFileSync(join(REPO, "docs/design/bicycle-ai-photo-brief.md"), "utf8");
    for (const s of ["6687410438", "bicycle-photo-prompt-20261106", "`83c9b2c628873d645a78145065a5ff5befeab7f406555b79649f1f44d8275594` (3865 バイト)", "BICYCLE_RUN_PROMPT_CANDIDATE_SHA256", BICYCLE_RUN_PROMPT_CANDIDATE_SHA256]) expect(brief, s).toContain(s);
  });
  it("the 6 fixed photos, in call order, each with its slot, use, heading and pinned prompt SHA-256", () => {
    expect(BICYCLE_PHOTOS.map((p) => p.photo_id)).toEqual(ORDER);
    expect(BICYCLE_PHOTOS.map((p) => `${p.slot_id}/${p.use}`)).toEqual(["ph-d/pc", "ph-a/pc", "ph-c/pc", "ph-b/pc", "ph-bench/pc", "ph-bench/sp"]);
    expect(BICYCLE_PHOTOS.filter((p) => p.upscale_allowed).map((p) => p.photo_id)).toEqual(["ph-bench-pc"]);
    const check = checkApprovedBicyclePrompt(TEXT);
    if (!check.ok) throw new Error(check.codes.join(","));
    for (const p of BICYCLE_PHOTOS) expect(sha(photoPrompt(check.parsed, p.photo_id)), p.photo_id).toBe(p.prompt_sha256);
    expect(check.parsed.common.startsWith("Documentary workshop photograph for a fictional bicycle repair shop.")).toBe(true);
  });
  it("each photo's shape, 2× target and 1.5× floor are the brief's §3 table, and the 6 targets pass the d1-v9 plan at 2× (range edges included)", () => {
    const brief = readFileSync(join(REPO, "docs/design/bicycle-ai-photo-brief.md"), "utf8");
    const label = (p: (typeof BICYCLE_PHOTOS)[number]) => (p.photo_id === "ph-bench-pc" ? "ph-bench (PC)" : p.photo_id === "ph-bench-sp" ? "ph-bench (SP)" : p.photo_id);
    for (const p of BICYCLE_PHOTOS) expect(brief, p.photo_id).toContain(`| ${label(p)} | ${p.aspect} | ${p.target.width}×${p.target.height} | ${p.floor.width}×${p.floor.height} |`);
    expect(INV.slots.map((s) => s.slot_id)).toEqual([...new Set(BICYCLE_PHOTOS.map((p) => p.slot_id))]);
    const spec = SWAP_SHOP_SPECS.bicycle;
    for (const slot of INV.slots) {
      const pc = BICYCLE_PHOTOS.find((p) => p.slot_id === slot.slot_id && p.use === "pc")!;
      const sp = BICYCLE_PHOTOS.find((p) => p.slot_id === slot.slot_id && p.use === "sp");
      const asInput = (p: typeof pc) => ({ width: p.target.width, height: p.target.height, focal_box: p.focal_box });
      expect(planSlot(slot, { pc: asInput(pc), ...(sp ? { sp: asInput(sp) } : {}) }, { spViewports: spec.spViewports, edges: EDGES.get(slot.slot_id)! }), slot.slot_id).toMatchObject({ ok: true, codes: [] });
    }
  });
  it("a single changed byte, a reordered paragraph or a changed heading fails closed", () => {
    expect(checkApprovedBicyclePrompt(`${TEXT} `)).toMatchObject({ ok: false, codes: expect.arrayContaining(["PROMPT_SHA_NOT_APPROVED"]) });
    expect(checkApprovedBicyclePrompt(TEXT.replace("No hands.", "No hands!"))).toMatchObject({ ok: false });
    const swapped = TEXT.replace(/\nph-a \(/, "\nph-x (");
    expect(() => parseBicyclePrompt(swapped)).toThrow(/PROMPT_PHOTO_ORDER/);
    expect(() => parseBicyclePrompt(TEXT.replace("at least 980x735 px; subject inside x 0.25-0.75", "at least 900x735 px; subject inside x 0.25-0.75"))).toThrow(/PROMPT_HEADING_MISMATCH: ph-d/);
  });
  it("the run prompt (DEV-192: owner-approved): fixed rules + the approved text from COMMON: on, byte for byte; no run approval id in code", () => {
    const run = buildBicycleRunPromptCandidate(TEXT);
    expect([sha(run), run.length]).toEqual([BICYCLE_RUN_PROMPT_CANDIDATE_SHA256, BICYCLE_RUN_PROMPT_CANDIDATE_CHARS]);
    const at = TEXT.indexOf("\nCOMMON:\n") + 1;
    expect(run.endsWith(TEXT.slice(at))).toBe(true);
    // only the 3 historical DRAFT lines (and the blank line after them) are left out
    expect(TEXT.slice(0, at).split("\n").filter(Boolean)).toHaveLength(3);
    expect(TEXT.slice(0, at)).toContain("DRAFT (未承認)");
    expect(run).not.toContain("未承認");
    expect(run).toContain("exactly 6 times");
    expect(run).toContain("do not retry");
    expect(BICYCLE_RUN_APPROVAL_ID).toBeNull();
    expect(() => buildBicycleRunPromptCandidate(`${TEXT}x`)).toThrow(/PROMPT_NOT_APPROVED/);
  });
  it("DEV-192: the owner's one-time-run approval pins both byte sequences; a change in either voids it (fails closed, never throws)", () => {
    expect(BICYCLE_RUN_PROMPT_APPROVAL).toEqual({
      approval_record: "bicycle-one-time-run-20261107",
      scope: "one_time_run_of_6_pictures_not_a_standing_permission",
      decided_by: "owner",
      decided_on: "2026-11-07",
      evidence: "Issue #193 comment 6689664215",
      shop: "bicycle",
      page: "d1-v9",
      jobs: 1,
      max_image_calls: 6,
      codex_runs: 1,
      timeout_minutes: 15,
      retry: false,
      run_prompt_sha256: "4b8081e02c08e1d0842c27bf28afab2bc647a9c80acce8464c23acf20e6d7447",
      run_prompt_chars: 4566,
      core_prompt_sha256: "83c9b2c628873d645a78145065a5ff5befeab7f406555b79649f1f44d8275594",
      core_prompt_bytes: 3865,
      void_if_either_byte_sequence_changes: true,
      run_approval_id_in_code: false,
    });
    const run = buildBicycleRunPrompt();
    expect([sha(run), run.length]).toEqual([BICYCLE_RUN_PROMPT_CANDIDATE_SHA256, 4566]);
    expect(readApprovedBicyclePrompt()).toBe(TEXT);
    // the core text changed by one byte (even in the historical DRAFT lines, which the run prompt does not carry): void
    for (const t of [TEXT.replace("No hands.", "No hands!"), TEXT.replace("DRAFT (未承認)", "DRAFT (承認済)"), `${TEXT}\n`, ""]) expect(buildBicycleRunPrompt(t)).toBe("");
  });
});

describe("DEV-191/192 offline E2E with 6 STUB pictures: bundle → intake → rights → swap → PC 1440 / tablet 768 / SP 390", () => {
  let root: string;
  let browser: Browser;
  let n = 0;
  const fresh = () => {
    const d = join(root, `case-${++n}`);
    mkdirSync(join(d, "bundle"), { recursive: true });
    mkdirSync(join(d, "pipeline", ".intake", "photos"), { recursive: true });
    return { dir: d, bundleRoot: join(d, "bundle"), pipeline: join(d, "pipeline"), manifestOut: join(d, "swap-manifest.json") };
  };
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "dev191-"));
    browser = await launch();
  });
  afterAll(async () => {
    await browser?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  /** a flat stub PNG with a red block inside the photo's subject box (inset 10%), so a crop that cuts the subject is visible */
  async function stub(id: string, width: number, height: number, i: number) {
    const p = BICYCLE_PHOTOS.find((x) => x.photo_id === id)!;
    const f = p.focal_box;
    const bx = Math.round((f.x + f.w * 0.1) * width);
    const by = Math.round((f.y + f.h * 0.1) * height);
    const bw = Math.round(f.w * 0.8 * width);
    const bh = Math.round(f.h * 0.8 * height);
    const block = await sharp({ create: { width: bw, height: bh, channels: 3, background: { r: 230, g: 20, b: 20 } } }).png().toBuffer();
    const png = await sharp({ create: { width, height, channels: 3, background: { r: 40 + 20 * i, g: 90 + 10 * i, b: 130 - 10 * i } } }).composite([{ input: block, left: bx, top: by }]).png().toBuffer();
    return { png, width, height };
  }
  /** the 6 stub pictures: the stations at their targets, the PC bench at the tool's largest landscape (enlarged ×1.323), the SP bench at its target */
  const SIZES: Record<string, [number, number]> = { "ph-d": [980, 735], "ph-a": [1040, 694], "ph-c": [1040, 694], "ph-b": [980, 735], "ph-bench-pc": [1536, 1152], "ph-bench-sp": [590, 885] };
  async function batch(sizes: Record<string, [number, number]> = SIZES, ids: string[] = ORDER, over: Partial<ImageBatchResult> = {}): Promise<ImageBatchResult> {
    const images = [];
    for (const [i, id] of ids.entries()) images.push(await stub(id, ...sizes[id]!, i));
    return { images, outcome: "IMAGE_SAVED", stopCode: null, imageCalls: images.length, imageFailed: 0, threadId: null, cliVersion: "stub-0.0.0", model: "stub-image-model", codexMs: 1, ...over };
  }
  const write = async (c: ReturnType<typeof fresh>, b: ImageBatchResult, over: Partial<Parameters<typeof writeBicyclePhotos>[0]> = {}) =>
    writeBicyclePhotos({ outRoot: c.bundleRoot, batch: b, commit: COMMIT, approvedPrompt: TEXT, runPrompt: buildBicycleRunPromptCandidate(TEXT), generatedAt: GENERATED_AT, approvalId: STUB_APPROVAL, generator: BICYCLE_OFFLINE_STUB_GENERATOR, ...over });
  const intake = (c: ReturnType<typeof fresh>, from: string, over: Partial<Parameters<typeof importBicycleAiPhotos>[0]> = {}) =>
    importBicycleAiPhotos({ from, manifestOut: c.manifestOut, pipelineRoot: c.pipeline, approvalIds: [STUB_APPROVAL], generators: [BICYCLE_OFFLINE_STUB_GENERATOR], ...over });
  const nothingWritten = (c: ReturnType<typeof fresh>) => {
    expect(existsSync(c.manifestOut)).toBe(false);
    expect(existsSync(`${c.manifestOut}.provenance.json`)).toBe(false);
    expect(readdirSync(join(c.pipeline, ".intake", "photos"))).toEqual([]);
  };

  it("the whole chain: schema, order, dimensions and aspect, rights and provenance, focal crops, renders at 1440 / 768 / 390", async () => {
    const c = fresh();
    const { dir, manifest: run } = await write(c, await batch());
    // the bundle: 0700 dir, 0600 files, 6 PNGs in call order, the approved prompt's pins
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readdirSync(dir).sort()).toEqual([...ORDER.map((id) => `${id}.png`), "manifest.json"].sort());
    expect(run).toMatchObject({ schema: "bicycle_ai_photos_v0", shop: "bicycle", page: "d1-v9", demo_only: true, public_web: false, label: BICYCLE_DEMO_LABEL, status: "complete", stop_code: null, prompt_sha256: BICYCLE_PROMPT_SHA256, prompt_bytes: 3865, prompt_approval_id: "bicycle-photo-prompt-20261106", run_prompt_sha256: BICYCLE_RUN_PROMPT_CANDIDATE_SHA256, approval_id: STUB_APPROVAL, generator: BICYCLE_OFFLINE_STUB_GENERATOR });
    expect(run.photos.map((p) => p.photo_id)).toEqual(ORDER);
    expect(run.photos.find((p) => p.photo_id === "ph-bench-pc")!.meets_target_2x).toBe(false);

    const r = await intake(c, dir);
    if (!r.ok) throw new Error(r.codes.join(","));
    // schema: a valid swap manifest for 輪, 5 slots in the page's order, the bench with its PC and SP photo
    const m = SwapManifest.parse(r.manifest);
    expect(m.shop).toBe("bicycle");
    expect(m.slots.map((s) => s.slot_id)).toEqual(INV.slots.map((s) => s.slot_id));
    expect(m.slots.map((s) => Boolean(s.sp))).toEqual([false, false, false, false, true]);
    // dimensions and aspect: each picture keeps its shape; only the PC bench is enlarged, ×1.323 (≤ 2×), lanczos3, recorded
    for (const p of r.provenance) {
      const want = SIZES[p.photo_id]!;
      const photo = BICYCLE_PHOTOS.find((x) => x.photo_id === p.photo_id)!;
      const [a, b] = photo.aspect.split(":").map(Number) as [number, number];
      expect(Math.abs(p.width / p.height - a / b), p.photo_id).toBeLessThan(0.01);
      expect(p.width + 0.5 >= photo.target.width && p.height + 0.5 >= photo.target.height, p.photo_id).toBe(true);
      if (p.photo_id === "ph-bench-pc") {
        expect(p.upscale).toEqual({ original_width: 1536, original_height: 1152, original_sha256: run.photos[4]!.sha256, factor: 1.323, method: "sharp-lanczos3" });
        expect([p.width, p.height]).toEqual([Math.round(1536 * 1.323), Math.round(1152 * 1.323)]);
      } else {
        expect(p.upscale, p.photo_id).toBeNull();
        expect([p.width, p.height]).toEqual(want);
      }
    }
    // rights: ai_generated_demo, demo only, never public web; the provenance names tool, model, date, prompt SHA, approval and slot
    expect(r.provenance.map((p) => [p.photo_id, p.slot_id, p.use])).toEqual(BICYCLE_PHOTOS.map((p) => [p.photo_id, p.slot_id, p.use]));
    for (const p of r.provenance) {
      expect(p).toMatchObject({ source_kind: "ai_generated_demo", demo_only: true, public_web: false, generator: BICYCLE_OFFLINE_STUB_GENERATOR, model: "stub-image-model", generated_at: GENERATED_AT, approval_id: STUB_APPROVAL, prompt_sha256: BICYCLE_PROMPT_SHA256, prompt_approval: BICYCLE_PROMPT_APPROVAL, run_prompt_sha256: BICYCLE_RUN_PROMPT_CANDIDATE_SHA256 });
      expect(p.photo_prompt_sha256).toBe(BICYCLE_PHOTOS.find((x) => x.photo_id === p.photo_id)!.prompt_sha256);
    }
    const prov = JSON.parse(readFileSync(`${c.manifestOut}.provenance.json`, "utf8")) as { photos: unknown[]; max_upscale: number };
    expect([prov.photos.length, prov.max_upscale]).toEqual([6, 2]);
    expect(statSync(c.manifestOut).mode & 0o777).toBe(0o600);
    for (const s of m.slots)
      for (const ref of [s.pc, ...(s.sp ? [s.sp] : [])]) {
        const rec = ref.rights as Record<string, unknown> & { allowed_uses: { public_web: boolean }; ai_provenance: Record<string, unknown> };
        expect(rec.source_kind).toBe("ai_generated_demo");
        expect(rec.allowed_uses.public_web).toBe(false);
        expect(rec.ai_provenance).toMatchObject({ generator: BICYCLE_OFFLINE_STUB_GENERATOR, model: "stub-image-model", prompt_sha256: BICYCLE_PROMPT_SHA256, approval_id: STUB_APPROVAL, demo_only: true });
        expect(String(rec.license)).toContain("bicycle-photo-prompt-20261106");
        const measured = { sha256: rec.sha256 as string, bytes: rec.bytes as number, width: rec.width as number, height: rec.height as number, format: "png" as const, orientation: 1 };
        // the general rights gate: refused unless the caller allows AI demo pictures; never for a public site
        expect(checkPhotoRights(rec, measured, { now: NOW, forbiddenSha256: FORBIDDEN })).toMatchObject({ ok: false, codes: ["AI_DEMO_NOT_ALLOWED"] });
        expect(checkPhotoRights(rec, measured, { now: NOW, forbiddenSha256: FORBIDDEN, aiDemoAllowed: true })).toMatchObject({ ok: true });
        expect(checkPhotoRights(rec, measured, { now: NOW, forbiddenSha256: FORBIDDEN, aiDemoAllowed: true, purpose: "public_site" })).toMatchObject({ ok: false, codes: expect.arrayContaining(["AI_DEMO_NOT_FOR_PUBLIC_SITE"]) });
      }

    // DEV-192: the swap takes 輪's AI demo pictures (owner GO 2026-11-07), rendered at PC 1440, tablet 768 and SP 390
    const out = join(c.dir, "swap");
    const res = await swapPage({ pageDir: PAGE, manifest: m, out, pipelineRoot: c.pipeline, now: NOW, forbiddenSha256: FORBIDDEN, browser });
    if (!res.ok) throw new Error(JSON.stringify(res.refusals));
    expect(res.renders.map((x) => x.viewport)).toEqual(["desktop_1440", "tablet_768", "mobile_390"]);
    for (const x of res.renders) expect(x, x.viewport).toMatchObject({ images: 5, images_loaded: 5, boards_matched: 5, caption_text_left: false, horizontal_overflow: false, boards_intact: 5 });
    // all 6 pictures are used: the bench's desktop and tablet files from its PC picture, its mobile file from its SP picture
    const crops = res.summary.crops as Record<string, { source: "pc" | "sp"; asset_id: string; rect: { left: number; top: number; width: number; height: number } }>;
    expect(new Set(Object.values(crops).map((x) => x.asset_id)).size).toBe(6);
    expect(["desktop", "tablet", "mobile"].map((k) => crops[`ph-bench/${k}`]!.source)).toEqual(["pc", "pc", "sp"]);
    // the public summary says these are AI demo images, with the prompt's SHA and the upscale
    const pub = (res.summary.slots as Array<{ slot_id: string; photos: Array<Record<string, unknown>> }>).flatMap((s) => s.photos);
    expect(pub).toHaveLength(6);
    for (const p of pub) expect(p).toMatchObject({ source_kind: "ai_generated_demo", demo_image: true, ai_generated: true, label: AI_DEMO_PUBLIC_LABEL, prompt_sha256: BICYCLE_PROMPT_SHA256, bytes_committed: false });
    // focal crop: every crop rectangle holds the whole subject box, and its file holds every subject (red) pixel of the picture
    const red = async (buf: Buffer) => {
      const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
      let k = 0;
      for (let i = 0; i < data.length; i += info.channels) if (data[i]! > 200 && data[i + 1]! < 60 && data[i + 2]! < 60) k += 1;
      return k;
    };
    for (const [key, cr] of Object.entries(crops)) {
      const [slotId, range] = key.split("/") as [string, string];
      const p = r.provenance.find((x) => x.slot_id === slotId && x.use === cr.source)!;
      const f = BICYCLE_PHOTOS.find((x) => x.photo_id === p.photo_id)!.focal_box;
      expect(cr.rect.left <= f.x * p.width + 0.5 && cr.rect.top <= f.y * p.height + 0.5, key).toBe(true);
      expect(cr.rect.left + cr.rect.width >= (f.x + f.w) * p.width - 0.5 && cr.rect.top + cr.rect.height >= (f.y + f.h) * p.height - 0.5, key).toBe(true);
      const source = readFileSync(join(c.pipeline, ".intake", "photos", `bicycle-ai-${p.photo_id}.png`));
      const cropFile = readFileSync(join(out, "page", "photos", `${slotId}-${range}.png`));
      expect(await red(cropFile), key).toBe(await red(source));
    }
    expect(readdirSync(join(out, "renders")).sort()).toEqual(["desktop_1440.png", "mobile_390.png", "tablet_768.png"]);
  }, 240_000);

  it("DEV-192: the swap takes 輪's AI demo pictures (aiDemoAllowed), rights checks unchanged; the test-only seam is gone", async () => {
    expect(SWAP_SHOP_SPECS.bicycle.aiDemoAllowed).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(SWAP_SHOP_SPECS.bicycle, "aiDemoCandidate")).toBe(false);
    expect([...AI_DEMO_SHOPS].sort()).toEqual(["bicycle", "tsugute"]);
    expect(readFileSync(join(REPO, "scripts/design-artifact/photo-swap.ts"), "utf8")).not.toMatch(/offlineAiDemoCandidate|aiDemoAllowedFor/);
    // a real-generator bundle (as the worker hook writes it) passes intake and swap without any test option
    const c = fresh();
    const real = await write(c, await batch(), { generator: BICYCLE_GENERATOR });
    const r = await intake(c, real.dir, { generators: [BICYCLE_GENERATOR] });
    if (!r.ok) throw new Error(r.codes.join(","));
    const out = join(c.dir, "swap-real-label");
    const res = await swapPage({ pageDir: PAGE, manifest: r.manifest, out, pipelineRoot: c.pipeline, now: NOW, forbiddenSha256: FORBIDDEN });
    if (!res.ok) throw new Error(JSON.stringify(res.refusals));
    // the rights are still demo only: a record that claims public web or lacks its provenance is refused
    const m = SwapManifest.parse(r.manifest);
    const rec = m.slots[0]!.pc.rights as Record<string, unknown>;
    const bad = { ...m, slots: [{ ...m.slots[0]!, pc: { ...m.slots[0]!.pc, rights: { ...rec, ai_provenance: undefined } } }, ...m.slots.slice(1)] };
    const out2 = join(c.dir, "swap-no-provenance");
    const r2 = await swapPage({ pageDir: PAGE, manifest: bad, out: out2, pipelineRoot: c.pipeline, now: NOW, forbiddenSha256: FORBIDDEN });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.refusals[0]!.codes).toContain("RIGHTS_MISSING_AI_PROVENANCE");
    expect(existsSync(out2)).toBe(false);
  }, 120_000);

  describe("refusal on failure: refused, and nothing written", () => {
    it("a picture whose bytes do not match its SHA-256 (tampered after the run)", async () => {
      const c = fresh();
      const { dir } = await write(c, await batch());
      writeFileSync(join(dir, "ph-c.png"), await sharp({ create: { width: 1040, height: 694, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer());
      expect(await intake(c, dir)).toEqual({ ok: false, codes: ["FILE_MISMATCH:ph-c"] });
      nothingWritten(c);
    });
    it("a picture in the wrong slot (two photos swapped in the manifest), and a photo prompt that is not the pinned one", async () => {
      const c = fresh();
      const { dir, manifest } = await write(c, await batch());
      const photos = [...manifest.photos];
      [photos[0], photos[1]] = [photos[1]!, photos[0]!];
      writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...manifest, photos }));
      expect(await intake(c, dir)).toEqual({ ok: false, codes: ["SLOT_ORDER:ph-a", "SLOT_ORDER:ph-d"] });
      writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...manifest, photos: manifest.photos.map((p, i) => (i === 3 ? { ...p, photo_prompt_sha256: "0".repeat(64) } : p)) }));
      expect(await intake(c, dir)).toEqual({ ok: false, codes: ["SLOT_PROMPT_NOT_APPROVED:ph-b"] });
      writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...manifest, photos: manifest.photos.map((p, i) => (i === 5 ? { ...p, use: "pc" } : p)) }));
      expect(await intake(c, dir)).toEqual({ ok: false, codes: ["SLOT_ORDER:ph-bench-sp"] });
      nothingWritten(c);
    });
    it("the SP bench missing (a 5-picture batch)", async () => {
      const c = fresh();
      const { dir, manifest } = await write(c, await batch(SIZES, ORDER.slice(0, 5)));
      expect(manifest).toMatchObject({ status: "stopped", stop_code: "CODEX_IMAGES_INCOMPLETE" });
      expect(await intake(c, dir)).toEqual({ ok: false, codes: ["RUN_NOT_COMPLETE", "RUN_NOT_SIX_IMAGES", "SP_BENCH_MISSING"] });
      nothingWritten(c);
    });
    it("the PC bench would need more than 2× (1000×750 → 2.03×), and a station below its target (no upscale for it)", async () => {
      const c = fresh();
      const { dir } = await write(c, await batch({ ...SIZES, "ph-bench-pc": [1000, 750], "ph-a": [900, 600] }));
      expect(await intake(c, dir)).toEqual({ ok: false, codes: ["BELOW_TARGET:ph-a", "UPSCALE_EXCEEDS_2X:ph-bench-pc"] });
      nothingWritten(c);
    });
    it("up to 2× is taken: 1016×762 → ×1.999", async () => {
      const c = fresh();
      const { dir } = await write(c, await batch({ ...SIZES, "ph-bench-pc": [1016, 762] }));
      const r = await intake(c, dir);
      if (!r.ok) throw new Error(r.codes.join(","));
      expect(r.provenance.find((p) => p.photo_id === "ph-bench-pc")!.upscale).toMatchObject({ original_width: 1016, original_height: 762, factor: 1.999, method: "sharp-lanczos3" });
    });
    it("a portrait picture for a landscape slot", async () => {
      const c = fresh();
      const { dir } = await write(c, await batch({ ...SIZES, "ph-b": [735, 980] }));
      expect(await intake(c, dir)).toEqual({ ok: false, codes: ["ORIENTATION_MISMATCH:ph-b"] });
      nothingWritten(c);
    });
    it("an unapproved prompt hash: the writer refuses another text; the intake refuses a manifest naming another prompt or run prompt", async () => {
      const c = fresh();
      const b = await batch();
      await expect(write(c, b, { approvedPrompt: TEXT.replace("No people.", "No person.") })).rejects.toThrow(/PROMPT_NOT_APPROVED/);
      await expect(write(c, b, { runPrompt: "Make 6 photos." })).rejects.toThrow(/RUN_PROMPT_DOES_NOT_CARRY_THE_APPROVED_TEXT/);
      // PR #233 review L2: a run prompt that carries the approved text but is not the pinned candidate (one added rule)
      await expect(write(c, b, { runPrompt: `Extra rule: anything.\n${buildBicycleRunPromptCandidate(TEXT)}` })).rejects.toThrow(/^RUN_PROMPT_NOT_THE_CANDIDATE$/);
      expect(readdirSync(c.bundleRoot)).toEqual([]);
      const { dir, manifest } = await write(c, b);
      writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...manifest, prompt_sha256: "8b659d02".padEnd(64, "0") }));
      expect(await intake(c, dir)).toEqual({ ok: false, codes: ["RUN_PROMPT_NOT_APPROVED"] });
      writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...manifest, run_prompt_sha256: "1".repeat(64) }));
      expect(await intake(c, dir)).toEqual({ ok: false, codes: ["RUN_PROMPT_NOT_THE_CANDIDATE"] });
      nothingWritten(c);
    });
    it("the defaults accept no run: no approval id (none exists) and only the real generator's label", async () => {
      const c = fresh();
      const { dir } = await write(c, await batch());
      expect(await importBicycleAiPhotos({ from: dir, manifestOut: c.manifestOut, pipelineRoot: c.pipeline })).toEqual({ ok: false, codes: ["RUN_APPROVAL_UNKNOWN", "RUN_GENERATOR_UNKNOWN"] });
      nothingWritten(c);
    });
    it("a manifest-out inside the repository (outside .intake/) and an edited demo label", async () => {
      const c = fresh();
      const { dir, manifest } = await write(c, await batch());
      expect(await intake(c, dir, { manifestOut: join(REPO, "docs", "dev191-should-not-exist.json") })).toEqual({ ok: false, codes: ["MANIFEST_OUT_NOT_PRIVATE"] });
      expect(existsSync(join(REPO, "docs", "dev191-should-not-exist.json"))).toBe(false);
      writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...manifest, label: "photo" }));
      expect(await intake(c, dir)).toEqual({ ok: false, codes: ["RUN_DEMO_LABEL_MISSING"] });
      writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...manifest, public_web: true }));
      expect(await intake(c, dir)).toEqual({ ok: false, codes: ["RUN_MANIFEST_INVALID"] });
      nothingWritten(c);
    });
  });

  it("no stub picture is left in the repository", () => {
    const intakeDir = join(REPO, "design-library/research/quality-pipeline/.intake/photos");
    if (existsSync(intakeDir)) expect(readdirSync(intakeDir).filter((f) => f.startsWith("bicycle-ai-"))).toEqual([]);
    expect(toPublicPhotoRecord).toBeTypeOf("function");
  });
});
