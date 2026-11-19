import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { readImageFirstRun } from "@/lib/design-agent/image-first/builder";
import { encodePng, scaleToWidth } from "@/lib/design-agent/image-first/pixels";
import { CODEX_STOP_CODES, REJECT_CODES, type RejectCode } from "@/lib/design-agent/image-first/record";
import { validateImageFirst, type ImageFirstVerdict } from "@/lib/design-agent/image-first/validate";
import { cleanup, drawPart, makeRun, PC_SIZE, SHOP, type RunOptions } from "./fixtures";

// Issue #293 P1: the IMAGE_FIRST hand-off contract on DUMMY runs only (synthetic flat pictures of a fictional shop,
// written to the OS temp dir). No model, no image generation, no network.

afterAll(cleanup);
const check = async (o: RunOptions = {}, implDir?: string): Promise<ImageFirstVerdict> => validateImageFirst(await readImageFirstRun(makeRun(o).dir, implDir ? { implDir } : {}));
const rejects = async (o: RunOptions, code: RejectCode) => {
  const v = await check(o);
  expect(v.status, JSON.stringify(v.details)).toBe("REJECT");
  expect(v.rejects).toContain(code);
  return v;
};

describe("the passing dummy: PC 1440 and SP 390 section sequences", { timeout: 120_000 }, () => {
  it("every machine check holds: AWAITING_OWNER_EVALUATION without an evaluation (never READY on machine checks alone)", async () => {
    const v = await check();
    expect(v.rejects, JSON.stringify(v.details)).toEqual([]);
    expect(v.status).toBe("AWAITING_OWNER_EVALUATION");
    expect(v.warnings).toEqual(["SESSION_MODEL_UNKNOWN"]);
    expect(v.parts.map((p) => [p.viewport, p.index, p.width, p.height])).toEqual([
      ["desktop_1440", 1, 1152, 768],
      ["desktop_1440", 2, 1152, 768],
      ["mobile_390", 1, 768, 1152],
      ["mobile_390", 2, 768, 1152],
      ["mobile_390", 3, 768, 1152],
    ]);
    expect(v.composites.desktop_1440).toMatchObject({ width: 1440, height: 1920 });
    expect(v.composites.mobile_390).toMatchObject({ width: 390, height: 1755 });
    expect(v.composites.desktop_1440!.parts.map((p) => p.scale)).toEqual([1.25, 1.25]);
  });

  it("with the owner's passing evaluation: READY_FOR_IMPLEMENTATION", async () => {
    const v = await check({ owner: true });
    expect(v.status, JSON.stringify(v.details)).toBe("READY_FOR_IMPLEMENTATION");
    expect(v.owner).toMatchObject({ pass: true, reasons: [] });
  });

  it("SP may reorder its sections (sp_plan) but never drop one", async () => {
    const reordered = await check({
      mutate: (r) => {
        const sp = r.viewports.mobile_390!;
        sp.section_order = ["header", "hero", "info", "story", "footer"];
        // part 2 shows info then story; part 3 then starts with footer only
        sp.parts[1]!.sections = [
          { id: "info", box: { x: 0, y: 0, w: 1, h: 0.4 } },
          { id: "story", box: { x: 0, y: 0.4, w: 1, h: 0.6 } },
        ];
        sp.parts[2]!.sections = [{ id: "footer", box: { x: 0, y: 0, w: 1, h: 1 } }];
        sp.seams[1] = { after_part: 2, kind: "section_break" };
      },
      mutateRead: (read) => {
        read.parts[3]!.observed_section_ids = ["info", "story"];
        read.parts[4]!.observed_section_ids = ["footer"];
      },
    });
    expect(reordered.rejects, JSON.stringify(reordered.details)).toEqual([]);
    await rejects({ mutate: (r) => (r.viewports.mobile_390!.section_order = ["header", "hero", "story", "info"]) }, "COMP_SECTION_SEQUENCE_INVALID");
  });
});

describe("one reject code per failure (fail closed)", { timeout: 120_000 }, () => {
  it("COMP_RECORD_INVALID: a missing, unparseable or malformed manifest", async () => {
    const { dir } = makeRun();
    writeFileSync(join(dir, "manifest.json"), "{not json");
    expect(validateImageFirst(await readImageFirstRun(dir)).rejects).toEqual(["COMP_RECORD_INVALID"]);
    await rejects({ mutate: (r) => ((r as unknown as Record<string, unknown>).extra = 1) }, "COMP_RECORD_INVALID");
  });

  it("COMP_HERO_ONLY: one first-screen picture per viewport, or a read that never sees the lower sections / the footer", async () => {
    // a hero-only PC: one landscape picture holding everything declared, but only one screen tall at 1440
    await rejects(
      {
        mutate: (r) => {
          const pc = r.viewports.desktop_1440!;
          pc.mode = "single";
          pc.parts = [{ ...pc.parts[0]!, sections: ["header", "hero", "story", "info", "footer"].map((id, i) => ({ id, box: { x: 0, y: i * 0.2, w: 1, h: 0.2 } })) }];
          pc.seams = [];
          r.generation.image_calls = 4;
          r.generation.image_completed = 4;
        },
      },
      "COMP_HERO_ONLY",
    ).then((v) => expect(v.details).toContainEqual({ code: "COMP_HERO_ONLY", detail: "desktop_1440_composite_height" }));
    const v = await rejects({ mutateRead: (read) => ((read.parts[1]!.observed_section_ids = []), (read.parts[1]!.footer_visible = false)) }, "COMP_HERO_ONLY");
    expect(v.details.filter((d) => d.code === "COMP_HERO_ONLY").map((d) => d.detail).sort()).toEqual(["desktop_1440_no_footer", "desktop_1440_sections_not_seen"]);
  });

  it("COMP_PC_MISSING / COMP_SP_MISSING: both full-page designs are required", async () => {
    const sp = await rejects({ mutate: (r) => ((r.viewports.mobile_390 = null), (r.generation.image_calls = 2), (r.generation.image_completed = 2)) }, "COMP_SP_MISSING");
    expect(sp.rejects).not.toContain("COMP_PC_MISSING");
    await rejects({ mutate: (r) => ((r.viewports.desktop_1440 = null), (r.generation.image_calls = 3), (r.generation.image_completed = 3)) }, "COMP_PC_MISSING");
  });

  it("COMP_SP_IS_PC_SCALED: the same picture bytes, the PC parts shrunk, or a read that does not judge the SP independent", async () => {
    // SP part 1 is PC part 1's picture
    const pc1 = drawPart(PC_SIZE.width, PC_SIZE.height, [{ id: "header", y0: 0, y1: 0.12 }, { id: "hero", y0: 0.12, y1: 1 }], "pc", 1);
    await rejects({ pictures: { "sp-01": pc1 } }, "COMP_SP_IS_PC_SCALED");
    // SP part 1 is PC part 1 shrunk to 768 wide (same layout, same aspect)
    const shrunk = scaleToWidth(pc1, 768);
    const v = await rejects({ pictures: { "sp-01": shrunk } }, "COMP_SP_IS_PC_SCALED");
    expect(v.details).toContainEqual({ code: "COMP_SP_IS_PC_SCALED", detail: "pixels" });
    await rejects({ mutateRead: (read) => (read.sp_independent.judged = false) }, "COMP_SP_IS_PC_SCALED");
  });

  it("COMP_NOT_MODEL_GENERATED: an HTML screenshot disguised as a comp (render provenance, browser widths, a reused call, the read)", async () => {
    await rejects({ mutate: (r) => (r.viewports.desktop_1440!.parts[0]!.rendered_from = "html_prototype_screenshot") }, "COMP_NOT_MODEL_GENERATED");
    await rejects({ mutate: (r) => (r.output_kind = "HTML_PROTOTYPE_SCREENSHOT") }, "COMP_NOT_MODEL_GENERATED");
    await rejects({ mutate: (r) => (r.route = "VISUAL_FIRST") }, "COMP_NOT_MODEL_GENERATED");
    await rejects({ mutate: (r) => (r.generation.image_tool = "playwright_screenshot") }, "COMP_NOT_MODEL_GENERATED");
    // a browser render is exactly 1440 (or 390) px wide: the image tool cannot be asked for that width
    const screenshot = drawPart(1440, 1100, [{ id: "header", y0: 0, y1: 0.12 }, { id: "hero", y0: 0.12, y1: 1 }], "pc");
    const w = await rejects({ pictures: { "pc-01": screenshot } }, "COMP_NOT_MODEL_GENERATED");
    expect(w.details).toContainEqual({ code: "COMP_NOT_MODEL_GENERATED", detail: "desktop_1440_1_browser_width" });
    await rejects({ mutate: (r) => (r.viewports.mobile_390!.parts[0]!.call.item_id = "ig_1") }, "COMP_NOT_MODEL_GENERATED");
    await rejects({ mutateRead: (read) => (read.parts[0]!.looks_like_browser_screenshot = true) }, "COMP_NOT_MODEL_GENERATED");
  });

  it("COMP_NOT_A_WEBSITE: a photo or poster, or no page structure (nav, text, info)", async () => {
    await rejects({ mutateRead: (read) => (read.parts[0]!.photo_only = true) }, "COMP_NOT_A_WEBSITE");
    const v = await rejects({ mutateRead: (read) => read.parts.forEach((p) => (p.web_structure.nav = false)) }, "COMP_NOT_A_WEBSITE");
    expect(v.details.filter((d) => d.code === "COMP_NOT_A_WEBSITE").map((d) => d.detail).sort()).toEqual(["desktop_1440_no_nav", "mobile_390_no_nav"]);
  });

  it("COMP_IDENTITY_REJECT / COMP_IDENTITY_HOLD: another shop (Identity Lock auditIdentity, unchanged), or no recorded inspection", async () => {
    await rejects({ mutateIdentity: (id) => ((id.audits[0]!.visual_inspection as Record<string, unknown>).visible_site_identity_labels = ["別の店 ベーカリー"]) }, "COMP_IDENTITY_REJECT");
    await rejects({ mutateIdentity: (id) => ((id.audits[2]!.visual_inspection as Record<string, unknown>).image_looks_like_unrelated_shop = true) }, "COMP_IDENTITY_REJECT");
    await rejects({ mutateRead: (read) => (read.parts[0]!.visible_texts[0]!.text = "別の店 ベーカリー") }, "COMP_IDENTITY_REJECT");
    await rejects({ mutateIdentity: (id) => ((id.audits[1]!.target as Record<string, unknown>).official_name = "別の店") }, "COMP_IDENTITY_REJECT");
    await rejects({ omit: ["identity.json"] }, "COMP_IDENTITY_HOLD");
    await rejects({ mutateIdentity: (id) => id.audits.pop() }, "COMP_IDENTITY_HOLD");
    await rejects({ mutateIdentity: (id) => ((id.audits[0]!.visual_inspection as Record<string, unknown>).status = "pending") }, "COMP_IDENTITY_HOLD");
  });

  it("COMP_PROVENANCE_MISSING: unknown provenance (commit, plan, call id, prompt, facts, direction, time, storage)", async () => {
    for (const mutate of [
      (r: Parameters<NonNullable<RunOptions["mutate"]>>[0]) => (r.generation.repo_commit = null),
      (r: Parameters<NonNullable<RunOptions["mutate"]>>[0]) => (r.generation.plan_id = null),
      (r: Parameters<NonNullable<RunOptions["mutate"]>>[0]) => (r.generation.cli_version = null),
      (r: Parameters<NonNullable<RunOptions["mutate"]>>[0]) => (r.generation.started_at = null),
      (r: Parameters<NonNullable<RunOptions["mutate"]>>[0]) => (r.viewports.desktop_1440!.parts[1]!.call.thread_id = null),
      (r: Parameters<NonNullable<RunOptions["mutate"]>>[0]) => (r.viewports.mobile_390!.parts[0]!.call.item_id = null),
      (r: Parameters<NonNullable<RunOptions["mutate"]>>[0]) => (r.storage.location_kind = "github"),
      (r: Parameters<NonNullable<RunOptions["mutate"]>>[0]) => (r.facts_pack_sha256 = null),
    ])
      await rejects({ mutate }, "COMP_PROVENANCE_MISSING");
    await rejects({ omit: ["prompts"] }, "COMP_PROVENANCE_MISSING");
    await rejects({ omit: ["facts-pack.json"] }, "COMP_PROVENANCE_MISSING");
    await rejects({ omit: ["direction.json"] }, "COMP_PROVENANCE_MISSING");
    // an unknown image / session model is a warning only (owner decision DEV-114)
    const v = await check({ mutate: (r) => (r.generation.image_model = null) });
    expect([v.status, v.warnings]).toEqual(["AWAITING_OWNER_EVALUATION", ["IMAGE_MODEL_UNKNOWN", "SESSION_MODEL_UNKNOWN"]]);
  });

  it("COMP_SHA_MISMATCH: picture bytes, size, prompt, facts pack and direction are recomputed", async () => {
    const other = encodePng(drawPart(PC_SIZE.width, PC_SIZE.height, [{ id: "story", y0: 0, y1: 1 }], "pc"));
    await rejects({ replaceBytes: { "pc-02": other } }, "COMP_SHA_MISMATCH");
    await rejects({ mutate: (r) => (r.viewports.mobile_390!.parts[2]!.height = 1153) }, "COMP_SHA_MISMATCH");
    await rejects({ mutate: (r) => (r.viewports.mobile_390!.parts[0]!.prompt_chars += 1) }, "COMP_SHA_MISMATCH");
    await rejects({ mutate: (r) => (r.facts_pack_sha256 = "f".repeat(64)) }, "COMP_SHA_MISMATCH");
    await rejects({ mutate: (r) => (r.direction.direction_sha256 = "e".repeat(64)) }, "COMP_SHA_MISMATCH");
    await rejects({ mutate: (r) => (r.direction.direction_id = "d9-other-direction") }, "COMP_SHA_MISMATCH");
    await rejects({ mutate: (r) => (r.shop.shop_id = "fictional-other-shop") }, "COMP_SHA_MISMATCH");
  });

  it("COMP_TEXT_FABRICATED: the picture's text is never a fact source (a 'fact' not in the facts, a price / award / history)", async () => {
    await rejects({ mutateRead: (read) => read.parts[1]!.visible_texts.push({ text: "10:00〜19:00", kind: "fact" }) }, "COMP_TEXT_FABRICATED");
    await rejects({ mutateRead: (read) => read.parts[0]!.visible_texts.push({ text: "創業百年の老舗", kind: "creative" }) }, "COMP_TEXT_FABRICATED");
    await rejects({ mutateRead: (read) => read.parts[3]!.visible_texts.push({ text: "ランプ 3,800円", kind: "ui_label" }) }, "COMP_TEXT_FABRICATED");
    // the counts only: no picture text is echoed in the verdict
    const v = await rejects({ mutateRead: (read) => read.parts[0]!.visible_texts.push({ text: "受賞歴あり", kind: "creative" }) }, "COMP_TEXT_FABRICATED");
    expect(JSON.stringify(v)).not.toContain("受賞");
  });

  it("COMP_RIGHTS_MISSING: design reference only, never a page asset, public, a crop source or a fact source", async () => {
    for (const k of ["page_asset", "public_web", "crop_as_asset", "text_is_fact_source"] as const) await rejects({ mutate: (r) => (r.rights[k] = true) }, "COMP_RIGHTS_MISSING");
    await rejects({ mutate: (r) => (r.rights.use = "public_site") }, "COMP_RIGHTS_MISSING");
    await rejects({ mutate: (r) => (r.rights.ai_generated = false) }, "COMP_RIGHTS_MISSING");
  });

  it("COMP_GENERATION_UNAPPROVED: no approval id, no approval packet, or a call outside the approved ids", async () => {
    await rejects({ mutate: (r) => (r.generation.approval_ids = []) }, "COMP_GENERATION_UNAPPROVED");
    await rejects({ mutate: (r) => (r.generation.approval_packet_sha256 = null) }, "COMP_GENERATION_UNAPPROVED");
    await rejects({ mutate: (r) => (r.viewports.mobile_390!.parts[1]!.call.approval_id = "if-other-approval") }, "COMP_GENERATION_UNAPPROVED");
  });

  it("COMP_NOT_OWNER_APPROVED: the design-image rubric (comp-impl/bundle.ts evaluationVerdict) bound to this exact comp", async () => {
    const reasons = async (owner: (ev: Record<string, unknown>) => void) => (await rejects({ owner }, "COMP_NOT_OWNER_APPROVED")).owner!.reasons;
    const sheet = (ev: Record<string, unknown>) => ev.evaluation as Record<string, unknown>;
    expect(await reasons((ev) => ((sheet(ev).scores = { beauty: 5, fit: 5, originality: 5, structure: 3, implementability: 5 }), (sheet(ev).total = 23)))).toEqual(["EVAL_CRITERION_BELOW_MIN"]);
    expect(await reasons((ev) => ((sheet(ev).scores = { beauty: 4, fit: 4, originality: 4, structure: 4, implementability: 5 }), (sheet(ev).total = 21)))).toEqual(["EVAL_TOTAL_BELOW_PASS"]);
    expect(await reasons((ev) => (sheet(ev).human_confirmed = false))).toEqual(["EVAL_NOT_CONFIRMED"]);
    expect(await reasons((ev) => (sheet(ev).comp_kind = "synthetic"))).toEqual(["EVAL_NOT_REAL"]);
    expect(await reasons((ev) => ((sheet(ev).hard_fails as Record<string, boolean>).invented_facts = true))).toEqual(["EVAL_HARD_FAIL"]);
    expect(await reasons((ev) => ((ev.image_first_hard_fails as Record<string, boolean>).hero_only = true))).toEqual(["EVAL_HARD_FAIL"]);
    expect(await reasons((ev) => (ev.viewed_composites = false))).toEqual(["EVAL_NOT_VIEWED_WHOLE"]);
    expect(await reasons((ev) => (ev.record_sha256 = "a".repeat(64)))).toEqual(["EVAL_BINDING_MISMATCH"]);
    expect(await reasons((ev) => (ev.comp_set_sha256 = "b".repeat(64)))).toEqual(["EVAL_BINDING_MISMATCH"]);
    expect(await reasons((ev) => (sheet(ev).total = 24))).toEqual(["EVAL_TOTAL_MISMATCH"]);
    expect(await reasons((ev) => (ev.schema = "other"))).toEqual(["EVAL_INVALID"]);
  });

  it("COMP_VISUAL_READ_MISSING: no located read, or one not bound to exactly these pictures", async () => {
    await rejects({ omit: ["visual-read.json"] }, "COMP_VISUAL_READ_MISSING");
    await rejects({ mutateRead: (read) => (read.parts[0]!.inspected_sha256 = "c".repeat(64)) }, "COMP_VISUAL_READ_MISSING");
    await rejects({ mutateRead: (read) => read.parts.pop() }, "COMP_VISUAL_READ_MISSING");
    await rejects({ mutateRead: (read) => (read.run_id = "if-other-run") }, "COMP_VISUAL_READ_MISSING");
  });

  it("COMP_SECTION_SEQUENCE_INVALID: declared order, missing / doubled sections, seams and boxes", async () => {
    const detail = async (mutate: RunOptions["mutate"]) => (await rejects({ mutate }, "COMP_SECTION_SEQUENCE_INVALID")).details.filter((d) => d.code === "COMP_SECTION_SEQUENCE_INVALID").map((d) => d.detail);
    expect(await detail((r) => (r.viewports.desktop_1440!.section_order = ["header", "story", "hero", "info", "footer"]))).toContain("desktop_1440_PC_ORDER_NOT_DIRECTION");
    expect(await detail((r) => (r.viewports.mobile_390!.seams[1]!.kind = "section_break"))).toContain("mobile_390_SECTION_BREAK_SHARED");
    expect(await detail((r) => (r.viewports.desktop_1440!.seams[0]!.kind = "continuous"))).toContain("desktop_1440_CONTINUOUS_SEAM_NOT_SHARED");
    expect(await detail((r) => (r.viewports.desktop_1440!.seams = []))).toContain("desktop_1440_SEAMS_DECLARATION");
    expect(await detail((r) => (r.viewports.desktop_1440!.parts[1]!.sections[0]!.box.h = 0.9))).toContain("desktop_1440_PART_BOXES_OVERLAP");
    expect(await detail((r) => (r.viewports.desktop_1440!.parts[1]!.sections[2]!.id = "hero"))).toContain("desktop_1440_PARTS_NOT_SECTION_ORDER");
    expect(await detail((r) => (r.viewports.desktop_1440!.parts[1] = { ...r.viewports.desktop_1440!.parts[0]!, index: 2 }))).toContain("desktop_1440_picture_repeated");
    expect(await detail((r) => (r.viewports.mobile_390!.target_css_width = 1440))).toContain("mobile_390_TARGET_WIDTH");
  });

  it("COMP_SEAM_BROKEN: a section declared continuous whose two edges do not meet", async () => {
    // SP part 3 starts with the footer's colour where the info section should continue
    const broken = drawPart(768, 1152, [{ id: "footer", y0: 0, y1: 1 }], "sp", 3);
    const v = await rejects({ pictures: { "sp-03": broken } }, "COMP_SEAM_BROKEN");
    expect(v.details).toContainEqual({ code: "COMP_SEAM_BROKEN", detail: "mobile_390_after_part_2" });
  });

  it("COMP_COMPOSITE_OUT_OF_RANGE / COMP_PART_UNDECODABLE: too tall to compare; a valid PNG the comparison cannot decode", async () => {
    const tall = (bands: { id: string; y0: number; y1: number }[], i: number) => drawPart(512, 8192, bands, "sp", i);
    await rejects(
      {
        pictures: {
          "sp-01": tall([{ id: "header", y0: 0, y1: 0.1 }, { id: "hero", y0: 0.1, y1: 1 }], 1),
          "sp-02": tall([{ id: "story", y0: 0, y1: 0.6 }, { id: "info", y0: 0.6, y1: 1 }], 2),
          "sp-03": tall([{ id: "info", y0: 0, y1: 0.4 }, { id: "footer", y0: 0.4, y1: 1 }], 3),
        },
      },
      "COMP_COMPOSITE_OUT_OF_RANGE",
    );
    // a 16-bit greyscale PNG passes the PNG check but is not the 8-bit RGB(A) the comparison decodes
    const w = 768;
    const h = 1152;
    const raw = Buffer.alloc((1 + w * 2) * h, 0x80);
    for (let y = 0; y < h; y++) raw[y * (1 + w * 2)] = 0;
    const chunk = (type: string, data: Buffer) => {
      const t = Buffer.from(type, "latin1");
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
      return Buffer.concat([len, t, data, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 16;
    ihdr[9] = 0;
    const grey16 = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
    const v = await rejects({ replaceBytes: { "sp-02": grey16 }, mutate: () => undefined }, "COMP_PART_UNDECODABLE");
    // the record still names the drawn picture, so the bytes also differ from it
    expect(v.rejects).toContain("COMP_SHA_MISMATCH");
  });

  it("COMP_CROP_AS_ASSET / ASSET_RIGHTS_MISSING: no photo cut out of the comp as a web asset; every asset from a rights record", async () => {
    const run = makeRun();
    const impl = join(run.dir, "..", `${run.dir.split("/").pop()}-impl`);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(impl, "assets"), { recursive: true });
    // an exact crop of PC part 1 (its media block) saved as a page photo, declared as from the photo intake
    const p = run.pictures["pc-01"]!;
    const crop = { width: 200, height: 150, data: Buffer.alloc(200 * 150 * 3) };
    for (let y = 0; y < 150; y++) p.data.copy(crop.data, y * 600, ((200 + y) * p.width + 100) * 3, ((200 + y) * p.width + 300) * 3);
    writeFileSync(join(impl, "assets", "photo.png"), encodePng(crop));
    const placeholder = { width: 64, height: 64, data: Buffer.alloc(64 * 64 * 3, 0xc8) };
    writeFileSync(join(impl, "assets", "plain.png"), encodePng(placeholder));
    writeFileSync(join(impl, "assets.json"), JSON.stringify({ schema: "image_first_impl_assets_v0", assets: [{ path: "assets/photo.png", source: "photo_intake", rights_record_sha256: "d".repeat(64) }] }));
    const v = validateImageFirst(await readImageFirstRun(run.dir, { implDir: impl }));
    expect(v.details).toContainEqual({ code: "COMP_CROP_AS_ASSET", detail: "assets/photo.png" });
    // undeclared: no rights record
    expect(v.details).toContainEqual({ code: "ASSET_RIGHTS_MISSING", detail: "assets/plain.png" });
    // the part itself, or an asset declared as a comp crop
    writeFileSync(join(impl, "assets", "photo.png"), readFileSync(join(run.dir, "parts", "sp-02.png")));
    writeFileSync(join(impl, "assets.json"), JSON.stringify({ schema: "image_first_impl_assets_v0", assets: [{ path: "assets/plain.png", source: "comp_crop", rights_record_sha256: null }] }));
    const w = validateImageFirst(await readImageFirstRun(run.dir, { implDir: impl }));
    expect(w.details.filter((d) => d.code === "COMP_CROP_AS_ASSET").map((d) => d.detail).sort()).toEqual(["assets/photo.png", "assets/plain.png"]);
    // a placeholder declared as such passes the asset check
    writeFileSync(join(impl, "assets", "photo.png"), encodePng({ width: 32, height: 32, data: Buffer.alloc(32 * 32 * 3, 0x80) }));
    writeFileSync(join(impl, "assets.json"), JSON.stringify({ schema: "image_first_impl_assets_v0", assets: [{ path: "assets/photo.png", source: "placeholder", rights_record_sha256: null }, { path: "assets/plain.png", source: "placeholder", rights_record_sha256: null }] }));
    expect(validateImageFirst(await readImageFirstRun(run.dir, { implDir: impl })).rejects).toEqual([]);
    const { rmSync } = await import("node:fs");
    rmSync(impl, { recursive: true, force: true });
  });
});

describe("Codex outcomes are fail closed (never a comp from a stopped, failed or inconclusive run)", { timeout: 120_000 }, () => {
  it("each image-call stop code is refused with that very code", async () => {
    for (const code of ["CODEX_NO_IMAGE", "CODEX_IMAGE_TOOL_FAILED", "CODEX_QUOTA", "CODEX_TIMEOUT", "CODEX_SESSION_LOG_UNVERIFIED", "CODEX_IMAGE_COUNT_MISMATCH"] as const) await rejects({ mutate: (r) => (r.generation.stop_code = code) }, code);
    await rejects({ mutate: (r) => (r.generation.stop_code = "CODEX_SOMETHING_NEW") }, "CODEX_STOP_UNKNOWN");
  });

  it("outcomes: inconclusive (code mode, no log), not called, tool failed, usage limit", async () => {
    await rejects({ mutate: (r) => (r.generation.outcome = "TOOL_NOT_SEEN_CODE_MODE") }, "CODEX_OUTCOME_INCONCLUSIVE");
    await rejects({ mutate: (r) => (r.generation.outcome = "NO_SESSION_LOG") }, "CODEX_OUTCOME_INCONCLUSIVE");
    await rejects({ mutate: (r) => (r.generation.outcome = "TOOL_NOT_CALLED") }, "CODEX_NO_IMAGE");
    await rejects({ mutate: (r) => (r.generation.outcome = "TOOL_FAILED_POLICY") }, "CODEX_IMAGE_TOOL_FAILED");
    await rejects({ mutate: (r) => (r.generation.outcome = "TOOL_FAILED_USAGE_LIMIT") }, "CODEX_QUOTA");
  });

  it("counts: a failed call, more calls than pictures, fewer completed than pictures", async () => {
    await rejects({ mutate: (r) => ((r.generation.image_failed = 1), (r.generation.image_calls = 6)) }, "CODEX_IMAGE_TOOL_FAILED");
    await rejects({ mutate: (r) => (r.generation.image_calls = 6) }, "CODEX_IMAGE_CALLS_EXCEEDED");
    await rejects({ mutate: (r) => (r.generation.image_completed = 4) }, "CODEX_IMAGE_COUNT_MISMATCH");
  });

  it("a non-PNG raster (JPEG / WebP) or a broken PNG in place of a picture", async () => {
    await rejects({ replaceBytes: { "sp-02": Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4096)]) } }, "CODEX_IMAGE_UNSUPPORTED_FORMAT");
    await rejects({ replaceBytes: { "sp-02": Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(4096)]) } }, "CODEX_IMAGE_UNSUPPORTED_FORMAT");
    await rejects({ replaceBytes: { "sp-02": Buffer.from("<html><body>not a picture</body></html>") } }, "CODEX_IMAGE_INVALID");
  });

  it("the stop code list is image-once.ts's own (kept in step)", () => {
    const src = readFileSync(resolve(__dirname, "../../../../lib/design-agent/design-image/image-once.ts"), "utf8");
    for (const code of CODEX_STOP_CODES) expect(src, code).toContain(`"${code}"`);
    const found = new Set([...src.matchAll(/"(CODEX_[A-Z_]+)"/g)].map((m) => m[1]!));
    // the jail's own sandbox codes come from SandboxError (not a picture outcome) and are covered by CODEX_STOP_UNKNOWN
    expect([...found].filter((c) => !(CODEX_STOP_CODES as readonly string[]).includes(c)).sort()).toEqual(["CODEX_SANDBOX_UNAVAILABLE"]);
    expect(new Set([...REJECT_CODES, ...CODEX_STOP_CODES]).size).toBe(REJECT_CODES.length + CODEX_STOP_CODES.length);
  });
});

describe("the dummy shop is fictional, and no prior same-shop design is used", () => {
  it("the fixtures name no d2 lineage and use only the fictional lamp shop", () => {
    const src = readFileSync(resolve(__dirname, "fixtures.ts"), "utf8");
    // the pattern is built here so that this file does not match itself
    const banned = new RegExp([["hoshi", "gama"], ["\u307b\u3057", "\u7aaf"], ["hea", "rth"], ["d2", "-v"], ["ph-", "mouth"], ["ph-", "loaf"]].map((p) => p.join("")).join("|"), "i");
    expect(src).not.toMatch(banned);
    expect(SHOP.shop_id.startsWith("fictional-")).toBe(true);
  });
});
