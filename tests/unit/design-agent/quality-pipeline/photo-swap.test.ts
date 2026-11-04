/**
 * DEV-166: the scale rule (2×, 1.5× only with an owner exception), the separate SP photo, and the つぐ手 swap tool.
 *
 * Every picture here is SYNTHETIC: solid-colour PNGs made by code at test time under os.tmpdir(), never written to the
 * repository (the 35-image lock in photo-intake.test.ts stays green). The pipeline root with .intake/photos/ is a
 * temporary folder too.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser } from "playwright";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadForbiddenSha256 } from "@/lib/design-agent/quality-pipeline/photo-rights";
import { MIN_SCALE_FLOOR, planSlot, PhotoSlotInventory, requestFor, scaledCrop, variantOf, type FocalBox, type PhotoSlot } from "@/lib/design-agent/quality-pipeline/photo-slots";
import { checkOut, swapPage, transformHtml, TSUGUTE_SP_VIEWPORTS } from "../../../../scripts/design-artifact/photo-swap";

const REPO = resolve(__dirname, "../../../..");
const PAGE = "design-library/research/quality-pipeline/poc/tsugute/fidelity/d1-v3";
const INV = PhotoSlotInventory.parse(JSON.parse(readFileSync(join(REPO, "design-library/research/quality-pipeline/poc/tsugute/photo-slots.json"), "utf8")));
const slot = (id: string) => INV.slots.find((s) => s.slot_id === id)!;
const FORBIDDEN = loadForbiddenSha256(REPO);
const NOW = "2026-11-04";
const CENTRE: FocalBox = { x: 0.4, y: 0.4, w: 0.2, h: 0.2 };
const EXCEPTION = { scale: 1.5, reason: "synthetic test: the owner looked at the photo", decided_by: "owner" };

describe("scale rule: 2× by default, 1.5× only with an owner exception", () => {
  const v = variantOf("desktop_1440", 400, 300); // 2× = 800×600, 1.5× = 600×450
  const at = (s: number) => ({ width: Math.round(400 * s), height: Math.round(300 * s) });
  const f = { x: 0.5, y: 0.5 };
  it("2× passes without an exception", () => {
    expect(scaledCrop(at(2), v, f)).toMatchObject({ ok: true, scale_basis: 2, exception_applied: false });
  });
  it("between 1.5× and 2× is refused without the exception record", () => {
    expect(scaledCrop(at(1.8), v, f)).toMatchObject({ ok: false, codes: ["SCALE_EXCEPTION_REQUIRED"] });
    expect(scaledCrop(at(1.5), v, f)).toMatchObject({ ok: false, codes: ["SCALE_EXCEPTION_REQUIRED"] });
  });
  it("between 1.5× and 2× passes with the owner's record, down to the scale it names", () => {
    expect(scaledCrop(at(1.8), v, f, EXCEPTION)).toMatchObject({ ok: true, scale_basis: 1.5, exception_applied: true });
    expect(scaledCrop(at(1.5), v, f, EXCEPTION)).toMatchObject({ ok: true, exception_applied: true });
    expect(scaledCrop(at(1.7), v, f, { ...EXCEPTION, scale: 1.8 })).toMatchObject({ ok: false, codes: ["PHOTO_TOO_SMALL"] });
  });
  it("below 1.5× is refused always, exception or not", () => {
    expect(MIN_SCALE_FLOOR).toBe(1.5);
    expect(scaledCrop(at(1.4), v, f)).toMatchObject({ ok: false, codes: ["PHOTO_BELOW_MIN_SCALE"] });
    expect(scaledCrop(at(1.4), v, f, EXCEPTION)).toMatchObject({ ok: false, codes: ["PHOTO_BELOW_MIN_SCALE"] });
  });
  it.each([
    ["decided by someone else", { ...EXCEPTION, decided_by: "claude" }],
    ["no reason", { ...EXCEPTION, reason: "  " }],
    ["scale 2 or more", { ...EXCEPTION, scale: 2 }],
    ["scale below 1.5", { ...EXCEPTION, scale: 1.4 }],
    ["an extra field", { ...EXCEPTION, slot: "ph-ware" }],
    ["no scale", { reason: "x", decided_by: "owner" }],
  ])("an exception record with %s is refused, even for a 2× photo", (_, exc) => {
    expect(scaledCrop(at(2), v, f, exc)).toMatchObject({ ok: false, codes: ["SCALE_EXCEPTION_INVALID"] });
  });
  it("a wrong shape is still refused by kept area, not by scale", () => {
    expect(scaledCrop({ width: 4000, height: 800 }, v, f, EXCEPTION)).toMatchObject({ ok: false, codes: ["RATIO_MISMATCH_EXTREME"] });
  });
});

describe("separate SP photo: when the PC photo's SP crop loses the subject", () => {
  // PC landscape 16:9, SP portrait 3:4
  const wide: PhotoSlot = {
    ...slot("ph-ware"),
    variants: [variantOf("desktop_1440", 640, 360), variantOf("tablet_1024", 640, 360), variantOf("tablet_768", 480, 270), variantOf("mobile_390", 300, 400)],
  };
  const pc = { width: 1600, height: 900 };
  it("kept_area below 0.5 at SP requires an SP photo, even with the subject in the centre", () => {
    const p = planSlot(wide, { pc: { ...pc, focal_box: CENTRE } });
    expect(p.byViewport.mobile_390.kept_area).toBeLessThan(0.5);
    expect(p).toMatchObject({ ok: false, needs_sp_photo: true });
    expect(p.codes).toEqual(["SP_PHOTO_REQUIRED"]);
  });
  it("a focal box that does not fit the SP crop requires an SP photo, though half of the photo is kept", () => {
    // ph-dry: PC portrait, SP (and ≤1199px) 4:3. A square photo keeps 75% at SP, but a subject 80% tall does not fit
    const dry = slot("ph-dry");
    const tall = { width: 1200, height: 1200, focal_box: { x: 0.4, y: 0.1, w: 0.2, h: 0.8 } };
    const p = planSlot(dry, { pc: tall }, { spViewports: TSUGUTE_SP_VIEWPORTS });
    expect(p.byViewport.mobile_390.kept_area).toBeGreaterThanOrEqual(0.5);
    expect(p.byViewport.mobile_390.subject_kept).toBe(false);
    expect(p).toMatchObject({ ok: false, needs_sp_photo: true, codes: ["SP_PHOTO_REQUIRED"] });
    // the same subject in a smaller box fits: no SP photo needed
    expect(planSlot(dry, { pc: { ...tall, focal_box: { x: 0.4, y: 0.2, w: 0.2, h: 0.6 } } }, { spViewports: TSUGUTE_SP_VIEWPORTS })).toMatchObject({ ok: true, needs_sp_photo: false });
  });
  it("with an SP photo the slot passes, and the SP viewport is cut from it", () => {
    const p = planSlot(wide, { pc: { ...pc, focal_box: CENTRE }, sp: { width: 900, height: 1200, focal_box: CENTRE } });
    expect(p).toMatchObject({ ok: true, needs_sp_photo: true });
    expect(p.byViewport.mobile_390.source).toBe("sp");
    expect(p.byViewport.desktop_1440.source).toBe("pc");
  });
  it("the SP photo is held to the same scale and subject rules", () => {
    expect(planSlot(wide, { pc: { ...pc, focal_box: CENTRE }, sp: { width: 420, height: 560, focal_box: CENTRE } }).codes).toContain("PHOTO_BELOW_MIN_SCALE");
    expect(planSlot(wide, { pc: { ...pc, focal_box: CENTRE }, sp: { width: 480, height: 640, focal_box: CENTRE } }).codes).toEqual(["SCALE_EXCEPTION_REQUIRED"]);
    expect(planSlot(wide, { pc: { ...pc, focal_box: CENTRE }, sp: { width: 1200, height: 1200, focal_box: { x: 0, y: 0, w: 1, h: 0.2 } } }).codes).toContain("FOCAL_SUBJECT_CROPPED");
  });
  it("つぐ手: the SP photo also serves ≤1199px, where every board takes its SP shape", () => {
    const dry = slot("ph-dry");
    const tall = { width: 1200, height: 1200, focal_box: { x: 0.4, y: 0.1, w: 0.2, h: 0.8 } };
    const sp = { width: 1200, height: 900, focal_box: CENTRE };
    expect(planSlot(dry, { pc: tall, sp })).toMatchObject({ ok: false, codes: ["FOCAL_SUBJECT_CROPPED"] }); // tablet still cut from PC
    const p = planSlot(dry, { pc: tall, sp }, { spViewports: TSUGUTE_SP_VIEWPORTS });
    expect(p).toMatchObject({ ok: true, needs_sp_photo: true });
    expect(p.byViewport.tablet_1024.source).toBe("sp");
  });
  it("a crop that cuts the PC subject is refused", () => {
    expect(planSlot(wide, { pc: { width: 1600, height: 1600, focal_box: { x: 0, y: 0, w: 1, h: 0.9 } }, sp: { width: 900, height: 1200, focal_box: CENTRE } }).codes).toContain("FOCAL_SUBJECT_CROPPED");
  });
});

describe("the request text's numbers (docs/design/tsugute-photo-request.md §3)", () => {
  const OWNER = { ...EXCEPTION, decided_by: "owner" };
  const plan = (id: string, w: number, h: number, exc?: unknown, box: FocalBox = CENTRE) => planSlot(slot(id), { pc: { width: w, height: h, focal_box: box }, ...(exc ? { scale_exception: exc } : {}) }, { spViewports: TSUGUTE_SP_VIEWPORTS });
  it.each([
    ["ph-ware", 1200, 900, 900, 675],
    ["ph-kake", 1040, 780, 780, 585],
    ["ph-hibi", 1200, 675, 900, 507],
    ["ph-dry", 1100, 1100, 830, 830],
    ["ph-hand", 1240, 1240, 930, 930],
    ["ph-desk", 870, 653, 660, 496],
  ])("%s: the target passes at 2×, the floor only with the owner's exception, below the floor never", (id, w, h, fw, fh) => {
    const r = requestFor(slot(id));
    expect(r).toMatchObject({ ok: true, min_width_px: w, min_height_px: h });
    expect(plan(id, w, h).ok).toBe(true);
    expect(plan(id, fw, fh).codes).toContain("SCALE_EXCEPTION_REQUIRED");
    expect(plan(id, fw, fh, OWNER).ok).toBe(true);
    expect(plan(id, Math.round(fw * 0.95), Math.round(fh * 0.95), OWNER).codes).toContain("PHOTO_BELOW_MIN_SCALE");
  });
  it("ph-dry in one square photo: a subject within 60% of the width and 70% of the height fits PC and SP", () => {
    expect(plan("ph-dry", 1100, 1100, undefined, { x: 0.2, y: 0.15, w: 0.6, h: 0.7 })).toMatchObject({ ok: true, needs_sp_photo: false });
    expect(plan("ph-dry", 1100, 1100, undefined, { x: 0.2, y: 0.1, w: 0.6, h: 0.8 }).codes).toEqual(["SP_PHOTO_REQUIRED"]);
  });
  it("ph-dry in two photos: PC 2:3 and SP 4:3 at the target, and at the floor with the exception", () => {
    const two = (pw: number, ph: number, sw: number, sh: number, exc?: unknown) => planSlot(slot("ph-dry"), { pc: { width: pw, height: ph, focal_box: CENTRE }, sp: { width: sw, height: sh, focal_box: CENTRE }, ...(exc ? { scale_exception: exc } : {}) }, { spViewports: TSUGUTE_SP_VIEWPORTS });
    expect(two(640, 960, 1100, 825).ok).toBe(true);
    expect(two(480, 720, 830, 623).codes).toEqual(["SCALE_EXCEPTION_REQUIRED"]);
    expect(two(480, 720, 830, 623, OWNER).ok).toBe(true);
  });
});

describe("caption → alt text", () => {
  const html = readFileSync(join(REPO, PAGE, "index.html"), "utf8");
  const slotsIn = INV.slots.map((s) => ({ slot: s, alt: s.role, files: { desktop: `photos/${s.slot_id}-desktop.png`, tablet: `photos/${s.slot_id}-tablet.png`, mobile: `photos/${s.slot_id}-mobile.png` }, size: { width: 10, height: 10 } }));
  it("removes every 写真｜ caption from the visible text and puts each role in its board's <img alt>", () => {
    expect(html.match(/写真｜/g)).toHaveLength(6);
    const out = transformHtml(html, slotsIn);
    expect(out).not.toContain("写真｜");
    expect(out).not.toContain('class="ph-label"');
    for (const s of INV.slots) {
      expect(out).toContain(`<picture data-slot="${s.slot_id}"><source media="(max-width: 600px)" srcset="photos/${s.slot_id}-mobile.png"><source media="(max-width: 1199px)" srcset="photos/${s.slot_id}-tablet.png"><img src="photos/${s.slot_id}-desktop.png" alt="${s.role}"`);
    }
    expect(out.match(/<div class="photo"><\/div>/g)).toBeNull();
  });
  it("escapes the alt text", () => {
    const out = transformHtml(html, slotsIn.map((s, i) => (i === 0 ? { ...s, alt: 'a "b" <c> & d' } : s)));
    expect(out).toContain('alt="a &quot;b&quot; &lt;c&gt; &amp; d"');
  });
  it("refuses a page whose caption is not where the pinned page has it", () => {
    expect(() => transformHtml(html.replace("写真｜縁の欠けた器", "縁の欠けた器"), slotsIn)).toThrow(/CAPTION_NOT_FOUND: ph-kake/);
    expect(() => transformHtml(html, slotsIn.slice(1))).toThrow(/CAPTION_LEFT/);
  });
});

describe("photo-swap: the つぐ手 C page with synthetic photos", () => {
  let root: string;
  let pipeline: string;
  let n = 0;
  const outDir = () => join(root, `out-${++n}`);
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "dev166-"));
    pipeline = join(root, "pipeline");
    mkdirSync(join(pipeline, ".intake", "photos"), { recursive: true });
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  /** A solid-colour PNG under the temporary .intake/photos/ and its rights record. */
  async function photo(name: string, width: number, height: number, colour: number, over: Record<string, unknown> = {}) {
    const buf = await sharp({ create: { width, height, channels: 3, background: { r: colour % 256, g: (colour * 7) % 256, b: (colour * 13) % 256 } } }).png().toBuffer();
    writeFileSync(join(pipeline, ".intake", "photos", `${name}.png`), buf);
    return {
      schema: "photo_rights_v0",
      asset_id: `photo-${name}`,
      sha256: createHash("sha256").update(buf).digest("hex"),
      bytes: buf.length,
      width,
      height,
      format: "png",
      source_kind: "owner_provided",
      owner: "synthetic test owner",
      license: "synthetic test only",
      paid: false,
      allowed_uses: { edit: true, crop: true, commercial: true, public_web: false },
      consent_record_ref: "synthetic-consent",
      received_at: "2026-11-01",
      expiry: null,
      private_path: `.intake/photos/${name}.png`,
      depicts_identifiable_person: false,
      depicts_real_shop: false,
      ...over,
    };
  }
  /** The six slots, each a synthetic photo of the size requestFor asks for (2× at every viewport). */
  async function sixSlots(tag: string) {
    const out = [];
    for (const [i, s] of INV.slots.entries()) {
      const r = requestFor(s);
      if (!r.ok) throw new Error(s.slot_id);
      out.push({ slot_id: s.slot_id, pc: { rights: await photo(`t-${tag}-${s.slot_id}`, r.min_width_px, r.min_height_px, 40 * i + 30), focal_box: CENTRE } } as Record<string, unknown>);
    }
    return out;
  }
  const manifest = (slots: unknown[]) => ({ schema: "photo_swap_manifest_v0", shop: "tsugute", slots });
  const run = (slots: unknown[], out = outDir(), browser?: Browser) => swapPage({ pageDir: PAGE, manifest: manifest(slots), out, pipelineRoot: pipeline, now: NOW, forbiddenSha256: FORBIDDEN, browser });
  const codesOf = (r: Awaited<ReturnType<typeof run>>) => (r.ok ? [] : r.refusals.flatMap((x) => x.codes));

  it("refuses unless all 6 slots have a photo, and writes nothing", async () => {
    const slots = await sixSlots("five");
    const out = outDir();
    const res = await run(slots.slice(0, 5), out);
    expect(codesOf(res)).toEqual(expect.arrayContaining(["SLOTS_INCOMPLETE", `missing:${INV.slots[5]!.slot_id}`]));
    expect(existsSync(out)).toBe(false);
    expect(codesOf(await run([...slots, slots[0]!]))).toContain("SLOT_DUPLICATE");
    expect(codesOf(await run([...slots, { ...slots[0]!, slot_id: "ph-tub" }]))).toContain("SLOT_UNKNOWN");
  });

  it("refuses a slot whose photo fails checkPhotoRights (each reason), and writes nothing", async () => {
    const slots = await sixSlots("rights");
    const pc = (i: number) => (slots[i]!.pc as { rights: Record<string, unknown> }).rights;
    slots[0] = { ...slots[0]!, pc: { rights: { ...pc(0), allowed_uses: { edit: true, crop: false, commercial: true, public_web: false } }, focal_box: CENTRE } };
    slots[1] = { ...slots[1]!, pc: { rights: { ...pc(1), sha256: "0".repeat(64) }, focal_box: CENTRE } };
    slots[2] = { ...slots[2]!, pc: { rights: { ...pc(2), paid: true }, focal_box: CENTRE } };
    slots[3] = { ...slots[3]!, pc: { rights: { ...pc(3), private_path: "../elsewhere.png" }, focal_box: CENTRE } };
    const out = outDir();
    const res = await run(slots, out);
    expect(res.ok).toBe(false);
    const by = (id: string) => (res.ok ? [] : res.refusals.filter((r) => r.slot_id === id).flatMap((r) => r.codes));
    expect(by(INV.slots[0]!.slot_id)).toContain("NOT_ALLOWED_FOR_CROP");
    expect(by(INV.slots[1]!.slot_id)).toContain("HASH_MISMATCH");
    expect(by(INV.slots[2]!.slot_id)).toContain("PAID_SOURCE_NOT_APPROVED");
    expect(by(INV.slots[3]!.slot_id)).toContain("PATH_NOT_PRIVATE");
    expect(existsSync(out)).toBe(false);
  });

  it("refuses a photo between 1.5× and 2× without the owner's exception, and takes it with one", async () => {
    const slots = await sixSlots("scale");
    const desk = INV.slots.findIndex((s) => s.slot_id === "ph-desk");
    const r = requestFor(slot("ph-desk"));
    if (!r.ok) throw new Error("ph-desk");
    const small = await photo("t-scale-desk-small", Math.round(r.min_width_px * 0.85), Math.round(r.min_height_px * 0.85), 7);
    slots[desk] = { slot_id: "ph-desk", pc: { rights: small, focal_box: CENTRE } };
    expect(codesOf(await run(slots))).toEqual(["SCALE_EXCEPTION_REQUIRED"]);
    slots[desk] = { ...slots[desk]!, scale_exception: { ...EXCEPTION, decided_by: "claude" } };
    expect(codesOf(await run(slots))).toEqual(["SCALE_EXCEPTION_INVALID"]);
    slots[desk] = { ...slots[desk]!, scale_exception: EXCEPTION };
    const ok = await run(slots);
    expect(ok.ok).toBe(true);
    const tiny = await photo("t-scale-desk-tiny", Math.round(r.min_width_px * 0.7), Math.round(r.min_height_px * 0.7), 8);
    slots[desk] = { slot_id: "ph-desk", pc: { rights: tiny, focal_box: CENTRE }, scale_exception: EXCEPTION };
    expect(codesOf(await run(slots))).toEqual(["PHOTO_BELOW_MIN_SCALE"]);
  });

  it("requires a separate SP photo where the PC photo's SP crop loses the subject", async () => {
    const slots = await sixSlots("sp");
    const dry = INV.slots.findIndex((s) => s.slot_id === "ph-dry");
    const tall = await photo("t-sp-dry-pc", 1200, 1200, 9);
    slots[dry] = { slot_id: "ph-dry", pc: { rights: tall, focal_box: { x: 0.4, y: 0.1, w: 0.2, h: 0.8 } } };
    expect(codesOf(await run(slots))).toEqual(["SP_PHOTO_REQUIRED"]);
    slots[dry] = { ...slots[dry]!, sp: { rights: await photo("t-sp-dry-sp", 1200, 900, 10), focal_box: CENTRE } };
    expect((await run(slots)).ok).toBe(true);
  });

  it("refuses an --out inside the repository (the private .intake/ too), an existing one, and a page it was not measured on", async () => {
    expect(checkOut(join(REPO, "tmp-dev166-out"))).toBe("OUT_INSIDE_REPO");
    expect(checkOut(join(REPO, "design-library/research/quality-pipeline/.intake/renders-dev166"))).toBe("OUT_INSIDE_REPO");
    expect(checkOut(join(REPO, "design-library"))).toBe("OUT_INSIDE_REPO");
    expect(checkOut(root)).toBe("OUT_EXISTS");
    expect(checkOut(join(root, "no-such-parent", "x"))).toBe("OUT_PARENT_MISSING");
    // a link outside the repository that points into it
    symlinkSync(REPO, join(root, "link-to-repo"));
    expect(checkOut(join(root, "link-to-repo", "out"))).toBe("OUT_INSIDE_REPO");
    const slots = await sixSlots("out");
    expect(codesOf(await run(slots, join(REPO, "tmp-dev166-out")))).toContain("OUT_INSIDE_REPO");
    expect(existsSync(join(REPO, "tmp-dev166-out"))).toBe(false);
    const other = await swapPage({ pageDir: "design-library/research/quality-pipeline/poc/tsugute/fidelity/d1-v2", manifest: manifest(slots), out: outDir(), pipelineRoot: pipeline, now: NOW, forbiddenSha256: FORBIDDEN });
    expect(codesOf(other)).toContain("PAGE_NOT_INVENTORIED");
    expect(codesOf(await swapPage({ pageDir: PAGE, manifest: { ...manifest(slots), shop: "sento" }, out: outDir(), pipelineRoot: pipeline, now: NOW, forbiddenSha256: FORBIDDEN }))).toEqual(["MANIFEST_INVALID"]);
  });

  describe("render smoke", () => {
    let browser: Browser;
    beforeAll(async () => {
      browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
    });
    afterAll(async () => {
      await browser?.close();
    });
    it("writes the private copy outside the repository, draws PC 1440 and SP 390 with every board a photo and no 写真｜ left", async () => {
      const slots = await sixSlots("render");
      const dry = INV.slots.findIndex((s) => s.slot_id === "ph-dry");
      slots[dry] = { slot_id: "ph-dry", alt: "金の線が乾くのを待つ器", pc: { rights: await photo("t-render-dry-pc", 1200, 1200, 11), focal_box: { x: 0.4, y: 0.1, w: 0.2, h: 0.8 } }, sp: { rights: await photo("t-render-dry-sp", 1200, 900, 12), focal_box: CENTRE } };
      const out = outDir();
      const res = await run(slots, out, browser);
      if (!res.ok) throw new Error(JSON.stringify(res.refusals));
      expect(res.renders.map((r) => r.viewport)).toEqual(["desktop_1440", "mobile_390"]);
      for (const r of res.renders) {
        expect(r, r.viewport).toMatchObject({ images: 6, images_loaded: 6, boards_matched: 6, caption_text_left: false });
        expect(existsSync(r.file)).toBe(true);
      }
      // the crops: 3 ranges × 6 slots, ph-dry's tablet and mobile from its SP photo
      expect(readdirSync(join(out, "page", "photos")).sort()).toHaveLength(18);
      const meta = await sharp(join(out, "page", "photos", "ph-dry-mobile.png")).metadata();
      expect(Math.abs(meta.width! / meta.height! - 286 / 215)).toBeLessThan(0.01);
      const crops = res.summary.crops as Record<string, { source: string }>;
      expect([crops["ph-dry/desktop"]!.source, crops["ph-dry/tablet"]!.source, crops["ph-dry/mobile"]!.source]).toEqual(["pc", "sp", "sp"]);
      const html = readFileSync(join(out, "page", "index.html"), "utf8");
      expect(html).toContain('alt="金の線が乾くのを待つ器"');
      expect(html).not.toContain("写真｜");
      // the private sidecar is next to the page, not inside what the browser may read; the summary names no owner
      expect(existsSync(join(out, "rights.private.json"))).toBe(true);
      expect(existsSync(join(out, "page", "rights.private.json"))).toBe(false);
      expect(readFileSync(join(out, "rights.private.json"), "utf8")).toContain("synthetic test owner");
      const summary = readFileSync(join(out, "swap-summary.json"), "utf8");
      expect(summary).not.toContain("synthetic test owner");
      expect(summary).not.toContain("synthetic-consent");
      expect(summary).not.toContain(".intake/photos");
      // the repository page is unchanged
      expect(createHash("sha256").update(readFileSync(join(REPO, PAGE, "index.html"))).digest("hex")).toBe(INV.html_sha256);
    }, 120_000);
  });
});
