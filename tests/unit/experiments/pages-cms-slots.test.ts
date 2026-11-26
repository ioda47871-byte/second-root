import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildSite } from "@/experiments/pages-cms/build";
import { ContentError } from "@/experiments/pages-cms/content-model";
import { FICTIONAL_APPROVAL, FICTIONAL_APPROVED_IMAGE, Q1_TODAY, writeFixture } from "@/experiments/pages-cms/fixtures";
import { pagesYaml } from "@/experiments/pages-cms/pages-config";
import { checkPhotoSlots, MIRROR, PHOTO_SLOTS_FILE, PhotoSlots, type SlotContext, subjectVisible } from "@/experiments/pages-cms/photo-slots";
import { SLOT_CONTROL, slotFindings } from "@/experiments/pages-cms/q1-check";
import { BAKERY_SITE, CAFE_SITE, SHOP_SITES } from "@/experiments/pages-cms/shop-site";
import { ApprovedDesignRef, DESIGN_RECORD_NAME_RE, Material, MATERIAL_ASPECTS, MATERIAL_KINDS, REQUEST_ID_RE } from "@/lib/design-agent/image-first/request-prompt";

// DEV-364 PR 2b (docs/design/quality-proof-plan.md §3.1, §6 row 2b): the photo-slot spec, the pages applying it and
// the Q1 measurement of it. FICTIONAL and LOCAL only; the browser part is experiments/pages-cms/q1-check.ts.

const temps: string[] = [];
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "sr-pcms-slots-")));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
const code = (f: () => unknown) => {
  try {
    f();
    return "ok";
  } catch (e) {
    return e instanceof ContentError ? e.code : String(e);
  }
};
const codeOf = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof ContentError ? e.code : String(e)));
const spec = (site = BAKERY_SITE) => structuredClone(site.fixtures()["photo-slots"]!.slots!);
const ctx = (s: PhotoSlots): SlotContext => ({
  approval: FICTIONAL_APPROVAL,
  materials: s.slots.flatMap((x) => x.material_ids.map((id) => ({ id, kind: "photo" as const, aspect: "landscape_3x2" as const }))),
  approvedImage: FICTIONAL_APPROVED_IMAGE,
});
const repoOf = async (site = BAKERY_SITE, name = "photo-slots") => {
  const repo = join(tmp(), "repo");
  await writeFixture(repo, site.fixtures()[name]!);
  return repo;
};

describe("DEV-364 PR 2b: the photo-slot spec sr_photo_slots_v1", () => {
  it("links to the approved composition's own vocabulary: the mirrors equal request-prompt.ts (Material, ApprovedDesignRef)", () => {
    expect(MIRROR.requestId.source).toBe(REQUEST_ID_RE.source);
    expect(MIRROR.recordName.source).toBe(DESIGN_RECORD_NAME_RE.source);
    expect([...MIRROR.kinds]).toEqual([...MATERIAL_KINDS]);
    expect([...MIRROR.aspects]).toEqual([...MATERIAL_ASPECTS]);
    // every material id in the fixtures is a valid Material id; the approval is a valid ApprovedDesignRef
    for (const site of SHOP_SITES)
      for (const id of spec(site).slots.flatMap((s) => s.material_ids)) expect(Material.safeParse({ id, kind: "photo", aspect: "landscape_3x2", placement: "左上の枠", note: "試験" }).success, id).toBe(true);
    const ref = { bundle_id: FICTIONAL_APPROVAL.bundle_id, bundle_sha256: FICTIONAL_APPROVAL.bundle_sha256, review_file: FICTIONAL_APPROVAL.review_file, approval_file: FICTIONAL_APPROVAL.approval_file };
    expect(ApprovedDesignRef.safeParse(ref).success).toBe(true);
  });

  it("text over a photo cannot be written: no overlay value, no extra field anywhere", () => {
    const s = spec();
    expect(PhotoSlots.safeParse(s).success).toBe(true);
    const view = s.slots[0]!.pc;
    const variants: unknown[] = [
      { ...s, slots: [{ ...s.slots[0]!, pc: { ...view, text_gap: "overlay" } }] },
      { ...s, slots: [{ ...s.slots[0]!, pc: { ...view, text_gap: "over" } }] },
      { ...s, slots: [{ ...s.slots[0]!, pc: { ...view, overlay: true } }] },
      { ...s, slots: [{ ...s.slots[0]!, pc: { ...view, text: "見出し" } }] },
      { ...s, slots: [{ ...s.slots[0]!, overlay_text: "見出し" }] },
      { ...s, overlay: { allowed: true } },
    ];
    for (const v of variants) expect(PhotoSlots.safeParse(v).success, JSON.stringify(v).slice(0, 80)).toBe(false);
  });

  it("refuses malformed slots: CSS beyond a plain object-position, a box outside the image, duplicates, a material in two slots, facts in the notes", () => {
    const s = spec();
    const one = s.slots[0]!;
    const bad: unknown[] = [
      { ...s, slots: [{ ...one, pc: { ...one.pc, object_position: "50% 50%;}body{display:none" } }] },
      { ...s, slots: [{ ...one, pc: { ...one.pc, object_position: "calc(10px) 50%" } }] },
      { ...s, slots: [{ ...one, pc: { ...one.pc, object_position: "120% 50%" } }] },
      { ...s, slots: [{ ...one, pc: { ...one.pc, box: { x: 0.9, y: 0.1, w: 0.2, h: 0.1 } } }] },
      { ...s, slots: [{ ...one, pc: { ...one.pc, box: { x: 0.1, y: 0.1, w: 0, h: 0.1 } } }] },
      { ...s, slots: [one, one] },
      { ...s, slots: [one, { ...one, id: "slot-other" }] },
      { ...s, slots: [{ ...one, role: "banner" }] },
      { ...s, slots: [{ ...one, material_ids: ["Bad_ID"] }] },
      { ...s, notes: "電話 0312345678 に連絡" },
      { ...s, notes: "https://example.invalid" },
      { ...s, approved_design: { ...s.approved_design, review_file: s.approved_design.approval_file } },
    ];
    for (const v of bad) expect(PhotoSlots.safeParse(v).success, JSON.stringify(v).slice(0, 100)).toBe(false);
    expect(PhotoSlots.safeParse({ ...s, notes: "写真の周りは余白を広めに取る" }).success).toBe(true);
  });

  it("the delivery check: bound to the approval, the approved materials only, the role fits the kind, the box fits the approved image, the subject stays in the crop", () => {
    const s = spec();
    expect(code(() => checkPhotoSlots(s, ctx(s)))).toBe("ok");
    expect(code(() => checkPhotoSlots({ ...s, schema: "sr_photo_slots_v0" }, ctx(s)))).toBe("CONTENT_SLOTS_INVALID");
    // not this approval (another approval record, another bundle)
    expect(code(() => checkPhotoSlots(s, { ...ctx(s), approval: { ...FICTIONAL_APPROVAL, approval_sha256: "c".repeat(64) } }))).toBe("CONTENT_SLOTS_NOT_APPROVED");
    expect(code(() => checkPhotoSlots({ ...s, approved_design: { ...s.approved_design, bundle_sha256: "d".repeat(64) } }, ctx(s)))).toBe("CONTENT_SLOTS_NOT_APPROVED");
    // a material the approved composition does not have
    expect(code(() => checkPhotoSlots(s, { ...ctx(s), materials: ctx(s).materials.slice(1) }))).toBe("CONTENT_SLOTS_MATERIAL_UNKNOWN");
    // a decoration in a product slot; a photo in a background slot
    expect(code(() => checkPhotoSlots(s, { ...ctx(s), materials: ctx(s).materials.map((m, k) => (k === 0 ? { ...m, kind: "decoration" as const } : m)) }))).toBe("CONTENT_SLOTS_ROLE_MISMATCH");
    const bg = structuredClone(s);
    bg.slots[0]!.role = "background";
    expect(code(() => checkPhotoSlots(bg, ctx(bg)))).toBe("CONTENT_SLOTS_ROLE_MISMATCH");
    // the box's shape in the approved image is not the declared aspect
    const box = structuredClone(s);
    box.slots[0]!.sp.aspect = "16:9";
    box.slots[0]!.sp.object_position = "50% 50%";
    box.slots[0]!.sp.subject = "center";
    expect(code(() => checkPhotoSlots(box, ctx(box)))).toBe("CONTENT_SLOTS_BOX_MISMATCH");
    expect(code(() => checkPhotoSlots(s, { ...ctx(s), approvedImage: { ...FICTIONAL_APPROVED_IMAGE, pc: { width: 1440, height: 1500 } } }))).toBe("CONTENT_SLOTS_BOX_MISMATCH");
    // a 3:2 material in a 4:3 slot pushed to its left edge while its subject is on the right third
    const crop = structuredClone(s);
    crop.slots[1]!.pc.object_position = "0% 50%";
    expect(code(() => checkPhotoSlots(crop, { ...ctx(crop), materials: ctx(crop).materials.map((m) => ({ ...m, aspect: "landscape_3x2" as const })) }))).toBe("ok");
    crop.slots[1]!.pc.aspect = "1:1";
    crop.slots[1]!.pc.box = { ...crop.slots[1]!.pc.box, h: (crop.slots[1]!.pc.box.w * 1440) / 3000 };
    expect(code(() => checkPhotoSlots(crop, ctx(crop)))).toBe("CONTENT_SLOTS_SUBJECT_CROPPED");
  });

  it("subjectVisible: cover crop geometry", () => {
    // a 3:1 picture in a 1:1 box shows a third of its width
    expect(subjectVisible({ w: 1200, h: 400 }, { w: 300, h: 300 }, "50% 50%", "center")).toBe(true);
    expect(subjectVisible({ w: 1200, h: 400 }, { w: 300, h: 300 }, "50% 50%", "right-third")).toBe(false);
    expect(subjectVisible({ w: 1200, h: 400 }, { w: 300, h: 300 }, "80% 50%", "right-third")).toBe(true);
    expect(subjectVisible({ w: 1200, h: 400 }, { w: 300, h: 300 }, "0% 50%", "left-third")).toBe(false); // on the edge of the crop
    expect(subjectVisible({ w: 1200, h: 400 }, { w: 300, h: 300 }, "10% 50%", "left-third")).toBe(true);
    // a tall picture in a wide box: only a band of its height
    expect(subjectVisible({ w: 400, h: 1200 }, { w: 400, h: 225 }, "50% 50%", "top")).toBe(false);
    expect(subjectVisible({ w: 400, h: 1200 }, { w: 400, h: 225 }, "50% 25%", "top")).toBe(true);
    // the same shape: nothing cropped
    expect(subjectVisible({ w: 600, h: 400 }, { w: 300, h: 200 }, "0% 0%", "bottom")).toBe(true);
    expect(subjectVisible({ w: 600, h: 400 }, { w: 300, h: 200 }, "left", "center")).toBe(false);
  });
});

describe("DEV-364 PR 2b: the shop pages apply the slots (object-position at PC and SP)", () => {
  it("each site marks the pictures of its slot materials and appends the slot CSS under its own SP breakpoint; nothing changes without a spec", async () => {
    for (const [site, sp] of [
      [BAKERY_SITE, 600],
      [CAFE_SITE, 760],
    ] as const) {
      const built = await buildSite({ repo: await repoOf(site), outDir: join(tmp(), "dist"), today: Q1_TODAY, site });
      const s = spec(site);
      expect(built.slots.map((a) => a.slot).sort(), site.id).toEqual(s.slots.map((x) => x.id).sort());
      for (const slot of s.slots) {
        expect(built.html).toContain(`<img data-slot="${slot.id}" src=`);
        expect(built.css).toContain(`img[data-slot="${slot.id}"]{object-position:${slot.pc.object_position}}`);
      }
      expect(built.css).toContain(`@media (max-width:${sp}px){img[data-slot=`);
      // B / C pictures and pictures without a material keep the page's frame
      expect((built.html.match(/data-slot=/g) ?? []).length).toBe(s.slots.length);
      // the same content without the spec: the site's own output, no slot anywhere
      const plain = await buildSite({ repo: await repoOf(site, "photos-large-odd"), outDir: join(tmp(), "dist"), today: Q1_TODAY, site });
      expect(plain.slots).toEqual([]);
      expect(plain.html).not.toContain("data-slot");
      expect(plain.css).not.toContain("data-slot");
    }
    // the spec is written at delivery, never offered in the CMS
    for (const site of SHOP_SITES) expect(pagesYaml({ extensions: site.profile.extensions })).not.toMatch(/photo-slots|slots/);
  });

  it("the build refuses a spec that is not well-formed, and a slot whose subject a real picture's ratio would crop", async () => {
    const broken = await repoOf();
    writeFileSync(join(broken, PHOTO_SLOTS_FILE), "{");
    expect(await codeOf(buildSite({ repo: broken, outDir: join(tmp(), "dist"), today: Q1_TODAY }))).toBe("CONTENT_SLOTS_INVALID");
    const overlay = await repoOf();
    const o = JSON.parse(readFileSync(join(overlay, PHOTO_SLOTS_FILE), "utf8")) as PhotoSlots;
    o.slots[0]!.pc = { ...o.slots[0]!.pc, text_gap: "overlay" as never };
    writeFileSync(join(overlay, PHOTO_SLOTS_FILE), JSON.stringify(o));
    expect(await codeOf(buildSite({ repo: overlay, outDir: join(tmp(), "dist"), today: Q1_TODAY }))).toBe("CONTENT_SLOTS_INVALID");
    // the 3:1 picture (bake-board) shown from its left edge, its subject on the right third: cropped at SP only is enough
    const crop = await repoOf();
    const c = JSON.parse(readFileSync(join(crop, PHOTO_SLOTS_FILE), "utf8")) as PhotoSlots;
    c.slots.find((x) => x.material_ids.includes("bake-board"))!.sp.object_position = "0% 50%";
    writeFileSync(join(crop, PHOTO_SLOTS_FILE), JSON.stringify(c));
    expect(await codeOf(buildSite({ repo: crop, outDir: join(tmp(), "dist"), today: Q1_TODAY }))).toBe("CONTENT_SLOTS_SUBJECT_CROPPED");
  });
});

describe("DEV-364 PR 2b: Q1 measures the slots (pure part; the browser run is q1-check.ts / q1-render.ts)", () => {
  const slots = SLOT_CONTROL.slots.slice(0, 1).map((a) => ({ ...a, pc: { aspect: "4:3" as const, object_position: "75% 50%", subject: "right-third" as const }, sp: { aspect: "4:3" as const, object_position: "75% 50%", subject: "right-third" as const } }));
  const good = { slot: "wrong", position: "75% 50%", fit: "cover", w: 400, h: 300, nw: 1200, nh: 400 };
  it("a frame that keeps the slot gives nothing; a changed aspect, position, fit, a cropped subject or a missing slot each give their code", () => {
    expect(slotFindings("f", "pc", slots, [good])).toEqual([]);
    const codes = (m: object[]) => slotFindings("f", "sp", slots, m as never).map((x) => x.code);
    expect(codes([{ ...good, h: 400 }])).toEqual(["Q1_SLOT_ASPECT"]);
    expect(codes([{ ...good, position: "50% 50%" }])).toEqual(["Q1_SLOT_POSITION"]);
    expect(codes([{ ...good, fit: "contain" }])).toEqual(["Q1_SLOT_POSITION"]);
    expect(codes([{ ...good, position: "0% 50%" }])).toEqual(["Q1_SLOT_POSITION", "Q1_SUBJECT_CROPPED"]);
    expect(codes([])).toEqual(["Q1_SLOT_MISSING"]);
    // a picture that did not load is not measured here (Q1_BROKEN_IMAGE reports it)
    expect(codes([{ ...good, nw: 0, nh: 0 }])).toEqual([]);
  });
  it("the slot control page is built to trip all four codes", () => {
    expect([...SLOT_CONTROL.present].sort()).toEqual(["Q1_SLOT_ASPECT", "Q1_SLOT_MISSING", "Q1_SLOT_POSITION", "Q1_SUBJECT_CROPPED"]);
    // its own geometry: a 900×300 picture in a 16:9 box at 100% 50%, subject on the left third
    expect(slotFindings("c", "pc", SLOT_CONTROL.slots, [{ slot: "wrong", position: "100% 50%", fit: "cover", w: 320, h: 180, nw: 900, nh: 300 }]).map((x) => x.code).sort()).toEqual([
      "Q1_SLOT_ASPECT",
      "Q1_SLOT_MISSING",
      "Q1_SLOT_POSITION",
      "Q1_SUBJECT_CROPPED",
    ]);
  });
});
