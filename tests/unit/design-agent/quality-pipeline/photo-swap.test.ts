/**
 * DEV-166: the scale rule (2×, 1.5× only with an owner exception), the separate SP photo, and the つぐ手 swap tool.
 *
 * Every picture here is SYNTHETIC: solid-colour PNGs and JPEGs made by code at test time under os.tmpdir(), never written to the
 * repository (the 35-image lock in photo-intake.test.ts stays green). The pipeline root with .intake/photos/ is a
 * temporary folder too.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser } from "playwright";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadForbiddenSha256 } from "@/lib/design-agent/quality-pipeline/photo-rights";
import { DESKTOP_CAP_PX, edgesFor, EDGE_VIEWPORTS, MIN_SCALE_FLOOR, planSlot, PhotoSlotEdges, PhotoSlotInventory, requestFor, scaledCrop, variantOf, type FocalBox, type PhotoSlot } from "@/lib/design-agent/quality-pipeline/photo-slots";
import { checkManifestPath, checkOut, RANGES, swapPage, transformHtml, TSUGUTE_SP_VIEWPORTS } from "../../../../scripts/design-artifact/photo-swap";
import { deriveEdges } from "../../../../scripts/design-artifact/photo-slots";

const REPO = resolve(__dirname, "../../../..");
const PAGE = "design-library/research/quality-pipeline/poc/tsugute/fidelity/d1-v3";
const INV = PhotoSlotInventory.parse(JSON.parse(readFileSync(join(REPO, "design-library/research/quality-pipeline/poc/tsugute/photo-slots.json"), "utf8")));
const EDGES_FILE = "design-library/research/quality-pipeline/poc/tsugute/photo-slot-edges.json";
const EDGES = PhotoSlotEdges.parse(JSON.parse(readFileSync(join(REPO, EDGES_FILE), "utf8")));
const EDGE_MAP = edgesFor(INV, EDGES)!;
const slot = (id: string) => INV.slots.find((s) => s.slot_id === id)!;
const edges = (id: string) => EDGE_MAP.get(id)!;
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

describe("range edges: the scale holds through each breakpoint range, not only at the 4 measured widths", () => {
  it("the edges were measured on the inventoried page, in slot order", () => {
    expect(EDGE_MAP).not.toBeNull();
    expect(EDGES.desktop_cap_px).toBe(1920);
    expect(DESKTOP_CAP_PX).toBe(1920);
    expect(EDGES.slots.map((s) => s.slot_id)).toEqual(INV.slots.map((s) => s.slot_id));
    expect(edgesFor(INV, { ...EDGES, css_sha256: "0".repeat(64) })).toBeNull();
  });
  it.each([
    // measured (Fresh Review M3): boards grow inside a range
    ["ph-ware", "mobile_390", 350, "mobile_600", 560],
    ["ph-ware", "tablet_1024", 562, "tablet_1199", 663],
    ["ph-ware", "desktop_1440", 600, "desktop_1920", 800],
    ["ph-hand", "tablet_1024", 607, "tablet_1199", 719],
    ["ph-hand", "desktop_1440", 615, "desktop_1920", 828],
  ])("%s: %s is %ipx wide, %s %ipx", (id, at, w, edge, ew) => {
    expect(slot(id).variants.find((v) => v.viewport === at)!.width_px).toBe(w);
    expect(edges(id).find((v) => v.viewport === edge)!.width_px).toBe(ew);
  });
  it("each crop range is checked at its widest edge, and the SP photo serves the tablet and mobile edges", () => {
    for (const r of RANGES) expect(r.viewports.some((v) => (EDGE_VIEWPORTS as readonly string[]).includes(v)), r.key).toBe(true);
    expect(TSUGUTE_SP_VIEWPORTS).toEqual(expect.arrayContaining(["tablet_1199", "mobile_600"]));
    expect(TSUGUTE_SP_VIEWPORTS).not.toContain("desktop_1920");
  });
  it("a photo 2× at the 4 measured widths but not at a range edge is refused", () => {
    const old = requestFor(slot("ph-ware")); // the 4 points only: 1200×900
    if (!old.ok) throw new Error("ph-ware");
    const pc = { width: old.min_width_px, height: old.min_height_px, focal_box: CENTRE };
    expect(planSlot(slot("ph-ware"), { pc }, { spViewports: TSUGUTE_SP_VIEWPORTS }).ok).toBe(true);
    const p = planSlot(slot("ph-ware"), { pc }, { spViewports: TSUGUTE_SP_VIEWPORTS, edges: edges("ph-ware") });
    expect(p.ok).toBe(false);
    expect(p.byViewport.tablet_1024.crop.ok).toBe(true);
    expect(p.byViewport.tablet_1199?.crop).toMatchObject({ ok: false, codes: ["SCALE_EXCEPTION_REQUIRED"] });
    expect(p.byViewport.desktop_1440.crop.ok).toBe(true);
    expect(p.byViewport.desktop_1920?.crop).toMatchObject({ ok: false, codes: ["SCALE_EXCEPTION_REQUIRED"] });
  });
});

describe("the request text's numbers (docs/design/tsugute-photo-request.md §3)", () => {
  const OWNER = { ...EXCEPTION, decided_by: "owner" };
  const plan = (id: string, w: number, h: number, exc?: unknown, box: FocalBox = CENTRE) => planSlot(slot(id), { pc: { width: w, height: h, focal_box: box }, ...(exc ? { scale_exception: exc } : {}) }, { spViewports: TSUGUTE_SP_VIEWPORTS, edges: edges(id) });
  it.each([
    ["ph-ware", 1610, 1208, 1210, 908],
    ["ph-kake", 1230, 923, 920, 690],
    ["ph-hibi", 1600, 900, 1200, 675],
    ["ph-dry", 1300, 1300, 980, 980],
    ["ph-hand", 1660, 1660, 1250, 1250],
    ["ph-desk", 1030, 773, 770, 578],
  ])("%s: the target passes at 2× (range edges included), the floor only with the owner's exception, below the floor never", (id, w, h, fw, fh) => {
    expect(requestFor(slot(id), { edges: edges(id) })).toMatchObject({ ok: true, min_width_px: w, min_height_px: h });
    expect(requestFor(slot(id), { edges: edges(id), scale: MIN_SCALE_FLOOR })).toMatchObject({ ok: true, min_width_px: fw, min_height_px: fh });
    expect(plan(id, w, h).ok).toBe(true);
    expect(plan(id, fw, fh).codes).toContain("SCALE_EXCEPTION_REQUIRED");
    expect(plan(id, fw, fh, OWNER).ok).toBe(true);
    expect(plan(id, Math.round(fw * 0.95), Math.round(fh * 0.95), OWNER).codes).toContain("PHOTO_BELOW_MIN_SCALE");
  });
  // DEV-182: the owner checklist (docs/design/tsugute-photo-owner-checklist.md §1) asks for the larger of the inventoried
  // page's request and the newest C page's (d1-v8, measured outside the repository and NOT pinned here). Read from the
  // checklist itself: it must never ask for less than the inventoried page needs — each target passes at 2× here, each
  // floor needs the owner's exception and passes with it.
  const CHECKLIST = readFileSync(join(REPO, "docs/design/tsugute-photo-owner-checklist.md"), "utf8");
  const checklistRows = [...CHECKLIST.matchAll(/^\| (ph-[a-z]+)(?: \(1枚なら\))? \|[^|]*\|[^|]*\| \**(\d+)×(\d+) px\** \| \**(\d+)×(\d+) px\** \|$/gm)].map((m) => [m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!] as const);
  it("the owner checklist names every slot once, with a target and a floor", () => {
    expect(checklistRows.map((r) => r[0]).sort()).toEqual(INV.slots.map((s) => s.slot_id).sort());
  });
  it.each(checklistRows)("owner checklist %s: %i×%i passes at 2× on the inventoried page; the floor %i×%i only with the exception", (id, w, h, fw, fh) => {
    const r = requestFor(slot(id), { edges: edges(id) });
    if (!r.ok) throw new Error(id);
    expect(w).toBeGreaterThanOrEqual(r.min_width_px);
    expect(h).toBeGreaterThanOrEqual(r.min_height_px);
    expect(plan(id, w, h).ok).toBe(true);
    expect(plan(id, fw, fh).codes).toContain("SCALE_EXCEPTION_REQUIRED");
    expect(plan(id, fw, fh, OWNER).ok).toBe(true);
  });
  it("ph-dry in one square photo: a subject within 60% of the width and 70% of the height fits PC and SP", () => {
    expect(plan("ph-dry", 1300, 1300, undefined, { x: 0.2, y: 0.15, w: 0.6, h: 0.7 })).toMatchObject({ ok: true, needs_sp_photo: false });
    expect(plan("ph-dry", 1300, 1300, undefined, { x: 0.2, y: 0.1, w: 0.6, h: 0.8 }).codes).toEqual(["SP_PHOTO_REQUIRED"]);
  });
  it("ph-dry in two photos: PC 2:3 and SP 4:3 at the target, and at the floor with the exception", () => {
    const two = (pw: number, ph: number, sw: number, sh: number, exc?: unknown) =>
      planSlot(slot("ph-dry"), { pc: { width: pw, height: ph, focal_box: CENTRE }, sp: { width: sw, height: sh, focal_box: CENTRE }, ...(exc ? { scale_exception: exc } : {}) }, { spViewports: TSUGUTE_SP_VIEWPORTS, edges: edges("ph-dry") });
    expect(two(640, 960, 1300, 975).ok).toBe(true);
    expect(two(480, 720, 980, 735).codes).toEqual(["SCALE_EXCEPTION_REQUIRED"]);
    expect(two(480, 720, 980, 735, OWNER).ok).toBe(true);
    expect(two(640, 960, 1100, 825).codes).toEqual(["SCALE_EXCEPTION_REQUIRED"]); // the old 4-point target is short at 1199
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
  it("puts $-patterns of the alt text in literally (no replacement-string expansion)", () => {
    const alt = "a $` b $' c $& d $$ e $1";
    const out = transformHtml(html, slotsIn.map((s, i) => (i === 0 ? { ...s, alt } : s)));
    expect(out).toContain('alt="a $` b $\' c $&amp; d $$ e $1"');
    expect(out.length).toBeLessThan(html.length + 6 * 400);
  });
  it("refuses a page whose caption is not where the pinned page has it", () => {
    expect(() => transformHtml(html.replace("写真｜縁の欠けた器", "縁の欠けた器"), slotsIn)).toThrow(/CAPTION_NOT_FOUND: ph-kake/);
    expect(() => transformHtml(html, slotsIn.slice(1))).toThrow(/CAPTION_LEFT/);
  });
  // DEV-182: the newer C pages (d1-v4 and later) keep drawn seams (<svg class="dmg">) inside the board and break the
  // captions with <wbr>. Until a page is inventoried and the transform is extended (owner-approved), the transform must
  // fail closed on them: never a half-swapped page with a placeholder board or a 写真｜ caption left behind.
  it("fails closed on every other つぐ手 C page: each one transforms whole or throws, and never leaves 写真｜", () => {
    const dir = join(REPO, "design-library/research/quality-pipeline/poc/tsugute/fidelity");
    const others = readdirSync(dir).filter((v) => join("design-library/research/quality-pipeline/poc/tsugute/fidelity", v) !== INV.page_dir);
    expect(others.length).toBeGreaterThanOrEqual(6); // d1-v2, d1-v4 … d1-v8: never a vacuous loop
    let refused = 0;
    for (const v of others) {
      const page = readFileSync(join(dir, v, "index.html"), "utf8");
      let out: string | null = null;
      try {
        out = transformHtml(page, slotsIn);
      } catch (e) {
        expect((e as Error).message, v).toMatch(/^(CAPTION_NOT_FOUND|BOARD_NOT_FOUND|CAPTION_LEFT):/);
        refused += 1;
      }
      if (out !== null) {
        expect(out, v).not.toContain("写真｜");
        for (const s of INV.slots) expect(out, `${v} ${s.slot_id}`).toContain(`<picture data-slot="${s.slot_id}">`);
      }
    }
    expect(refused).toBeGreaterThanOrEqual(1);
  });
  it("the newest つぐ手 C page (d1-v8, DEV-178) is refused by the transform: its boards hold drawn seams", () => {
    const page = readFileSync(join(REPO, "design-library/research/quality-pipeline/poc/tsugute/fidelity/d1-v8/index.html"), "utf8");
    expect(page.match(/写真｜/g)).toHaveLength(6);
    expect(() => transformHtml(page, slotsIn)).toThrow(/^BOARD_NOT_FOUND: ph-ware$/);
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
    return place(`${name}.png`, buf, width, height, "png", over);
  }
  /** Writes synthetic bytes under the temporary .intake/photos/ and returns their rights record (shown width × height). */
  function place(file: string, buf: Buffer, width: number, height: number, format: "png" | "jpeg", over: Record<string, unknown> = {}) {
    writeFileSync(join(pipeline, ".intake", "photos", file), buf);
    return {
      schema: "photo_rights_v0",
      asset_id: `photo-${file.replace(/\.[a-z]+$/, "")}`,
      sha256: createHash("sha256").update(buf).digest("hex"),
      bytes: buf.length,
      width,
      height,
      format,
      source_kind: "owner_provided",
      owner: "synthetic test owner",
      license: "synthetic test only",
      paid: false,
      allowed_uses: { edit: true, crop: true, commercial: true, public_web: false },
      consent_record_ref: "synthetic-consent",
      received_at: "2026-11-01",
      expiry: null,
      private_path: `.intake/photos/${file}`,
      depicts_identifiable_person: false,
      depicts_real_shop: false,
      ...over,
    };
  }
  /** The six slots, each a synthetic photo of the size requestFor asks for (2× at the measured viewports and range edges). */
  async function sixSlots(tag: string) {
    const out = [];
    for (const [i, s] of INV.slots.entries()) {
      const r = requestFor(s, { edges: edges(s.slot_id) });
      if (!r.ok) throw new Error(s.slot_id);
      out.push({ slot_id: s.slot_id, pc: { rights: await photo(`t-${tag}-${s.slot_id}`, r.min_width_px, r.min_height_px, 40 * i + 30), focal_box: CENTRE } } as Record<string, unknown>);
    }
    return out;
  }
  const manifest = (slots: unknown[]) => ({ schema: "photo_swap_manifest_v0", shop: "tsugute", slots });
  const run = (slots: unknown[], out = outDir(), browser?: Browser) => swapPage({ pageDir: PAGE, manifest: manifest(slots), out, pipelineRoot: pipeline, now: NOW, forbiddenSha256: FORBIDDEN, browser });
  const codesOf = (r: Awaited<ReturnType<typeof run>>) => (r.ok ? [] : r.refusals.flatMap((x) => x.codes));
  /** --out is absent and no temporary sibling of it is left behind */
  const nothingLeft = (out: string) => {
    expect(existsSync(out)).toBe(false);
    expect(readdirSync(root).filter((f) => f.includes(".partial-"))).toEqual([]);
  };

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
    const r = requestFor(slot("ph-desk"), { edges: edges("ph-desk") });
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
    slots[dry] = { ...slots[dry]!, sp: { rights: await photo("t-sp-dry-sp", 1300, 975, 10), focal_box: CENTRE } };
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
    // DEV-182: every other つぐ手 C page — the newest (d1-v8) included — is refused before anything is read or written
    const fidelity = "design-library/research/quality-pipeline/poc/tsugute/fidelity";
    const versions = readdirSync(join(REPO, fidelity)).filter((v) => join(fidelity, v) !== INV.page_dir);
    expect(versions).toContain("d1-v8");
    for (const v of versions) {
      const out = outDir();
      const res = await swapPage({ pageDir: join(fidelity, v), manifest: manifest(slots), out, pipelineRoot: pipeline, now: NOW, forbiddenSha256: FORBIDDEN });
      expect(codesOf(res), v).toEqual(["PAGE_NOT_INVENTORIED"]);
      nothingLeft(out);
    }
    expect(codesOf(await swapPage({ pageDir: PAGE, manifest: { ...manifest(slots), shop: "sento" }, out: outDir(), pipelineRoot: pipeline, now: NOW, forbiddenSha256: FORBIDDEN }))).toEqual(["MANIFEST_INVALID"]);
  });

  it("refuses a missing manifest path with a code, not a stack trace", () => {
    expect(checkManifestPath(join(root, "no-such-manifest.json"))).toBe("MANIFEST_NOT_FOUND");
  });

  describe("all or nothing: a failure after validation leaves no --out", () => {
    it("a truncated JPEG that passes the header and rights checks stops at decoding", async () => {
      const slots = await sixSlots("trunc");
      const desk = INV.slots.findIndex((s) => s.slot_id === "ph-desk");
      const r = requestFor(slot("ph-desk"), { edges: edges("ph-desk") });
      if (!r.ok) throw new Error("ph-desk");
      // noise, so the scan data is long; then cut it off in the middle of the scan
      const noise = Buffer.alloc(r.min_width_px * r.min_height_px * 3);
      for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24;
      const full = await sharp(noise, { raw: { width: r.min_width_px, height: r.min_height_px, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
      const cut = full.subarray(0, Math.floor(full.length * 0.6));
      slots[desk] = { slot_id: "ph-desk", pc: { rights: place("t-trunc-desk.jpg", cut, r.min_width_px, r.min_height_px, "jpeg"), focal_box: CENTRE } };
      const out = outDir();
      const res = await run(slots, out);
      expect(res.ok ? [] : res.refusals).toEqual([{ slot_id: "ph-desk", photo: "pc", codes: ["PHOTO_DECODE_FAILED"] }]);
      nothingLeft(out);
    });
    it("a transformHtml failure (forced)", async () => {
      const slots = await sixSlots("transform");
      const out = outDir();
      const res = await swapPage({ pageDir: PAGE, manifest: manifest(slots), out, pipelineRoot: pipeline, now: NOW, forbiddenSha256: FORBIDDEN, transform: () => { throw new Error("CAPTION_NOT_FOUND: ph-kake"); } });
      expect(codesOf(res)).toEqual(["CAPTION_NOT_FOUND"]);
      nothingLeft(out);
    });
    it("a render-check failure (forced: one image does not load) and a render that throws", async () => {
      const slots = await sixSlots("rcheck");
      const fake = (check: Record<string, unknown> | "throw") =>
        ({
          newContext: async () => {
            if (check === "throw") throw new Error("browser gone");
            return {
              newPage: async () => ({ route: async () => {}, goto: async () => null, evaluate: async (e: string) => (e.startsWith("document.fonts") ? true : check), screenshot: async () => Buffer.from("png") }),
              close: async () => {},
            };
          },
        }) as unknown as Browser;
      const out = outDir();
      const res = await run(slots, out, fake({ images: 6, images_loaded: 5, boards_matched: 6, caption_text_left: false }));
      expect(codesOf(res)).toEqual(["RENDER_CHECK_FAILED", "viewport:desktop_1440"]);
      nothingLeft(out);
      const left = await run(slots, out, fake({ images: 6, images_loaded: 6, boards_matched: 6, caption_text_left: true }));
      expect(codesOf(left)).toEqual(["RENDER_CHECK_FAILED", "viewport:desktop_1440"]);
      nothingLeft(out);
      expect(codesOf(await run(slots, out, fake("throw")))).toEqual(["RENDER_FAILED", "viewport:desktop_1440"]);
      nothingLeft(out);
    });
  });

  it("a JPEG with EXIF orientation 6, XMP, ICC and GPS: cut as shown, written with none of them", async () => {
    const slots = await sixSlots("exif");
    const desk = INV.slots.findIndex((s) => s.slot_id === "ph-desk");
    const r = requestFor(slot("ph-desk"), { edges: edges("ph-desk") });
    if (!r.ok) throw new Error("ph-desk");
    // stored portrait (height × width), left half red and right half blue; orientation 6 shows it turned 90° clockwise
    const [sw, sh] = [r.min_height_px, r.min_width_px];
    const raw = Buffer.alloc(sw * sh * 3);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) raw.set(x < sw / 2 ? [220, 20, 20] : [20, 20, 220], (y * sw + x) * 3);
    const jpg = await sharp(raw, { raw: { width: sw, height: sh, channels: 3 } })
      .jpeg({ quality: 92 })
      .withIccProfile("p3")
      .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>synthetic</dc:creator></rdf:Description></rdf:RDF></x:xmpmeta>')
      .withExif({ IFD0: { Artist: "synthetic" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "35/1 0/1 0/1" } })
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const inMeta = await sharp(jpg).metadata();
    expect(inMeta).toMatchObject({ orientation: 6, width: sw, height: sh });
    expect(inMeta.exif && inMeta.xmp && inMeta.icc).toBeTruthy();
    // the GPS IFD pointer (tag 0x8825) is in the input's EXIF
    expect(inMeta.exif!.includes(Buffer.from([0x88, 0x25])) || inMeta.exif!.includes(Buffer.from([0x25, 0x88]))).toBe(true);
    slots[desk] = { slot_id: "ph-desk", pc: { rights: place("t-exif-desk.jpg", jpg, r.min_width_px, r.min_height_px, "jpeg"), focal_box: CENTRE } };
    const out = outDir();
    const res = await run(slots, out);
    if (!res.ok) throw new Error(JSON.stringify(res.refusals));
    for (const range of ["desktop", "tablet", "mobile"]) {
      const file = join(out, "page", "photos", `ph-desk-${range}.jpg`);
      const m = await sharp(file).metadata();
      expect(m.width! > m.height!, range).toBe(true); // landscape: the rotation was applied
      expect([m.exif, m.xmp, m.icc, m.orientation], range).toEqual([undefined, undefined, undefined, undefined]);
      const bytes = readFileSync(file);
      for (const marker of ["Exif\0\0", "adobe:ns:meta", "ICC_PROFILE", "synthetic"]) expect(bytes.includes(marker), `${range} ${marker}`).toBe(false);
      // the stored left half (red) is the shown top
      const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
      const px = (x: number, y: number) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
      expect(px(Math.floor(info.width / 2), 2)[0]!, range).toBeGreaterThan(150);
      expect(px(Math.floor(info.width / 2), info.height - 3)[2]!, range).toBeGreaterThan(150);
    }
    expect(statSync(join(out, "rights.private.json")).mode & 0o077).toBe(0);
  });

  describe("render smoke", () => {
    let browser: Browser;
    beforeAll(async () => {
      browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
    });
    afterAll(async () => {
      await browser?.close();
    });
    it("the committed range edges are what the page measures now (within 2px)", async () => {
      const now = await deriveEdges(browser, INV);
      for (const [i, s] of now.slots.entries())
        for (const [j, v] of s.edges.entries()) {
          const w = EDGES.slots[i]!.edges[j]!;
          expect([s.slot_id, v.viewport]).toEqual([EDGES.slots[i]!.slot_id, w.viewport]);
          expect(Math.abs(v.width_px - w.width_px), `${s.slot_id} ${v.viewport}`).toBeLessThanOrEqual(2);
          expect(Math.abs(v.height_px - w.height_px), `${s.slot_id} ${v.viewport}`).toBeLessThanOrEqual(2);
        }
    }, 120_000);
    it("writes the private copy outside the repository, draws PC 1440 and SP 390 with every board a photo and no 写真｜ left", async () => {
      const slots = await sixSlots("render");
      const dry = INV.slots.findIndex((s) => s.slot_id === "ph-dry");
      slots[dry] = { slot_id: "ph-dry", alt: "金の線が乾くのを待つ器", pc: { rights: await photo("t-render-dry-pc", 1200, 1200, 11), focal_box: { x: 0.4, y: 0.1, w: 0.2, h: 0.8 } }, sp: { rights: await photo("t-render-dry-sp", 1300, 975, 12), focal_box: CENTRE } };
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
      // nothing temporary is left beside --out
      expect(readdirSync(root).filter((f) => f.includes(".partial-"))).toEqual([]);
    }, 120_000);
  });
});
