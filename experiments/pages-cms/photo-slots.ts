/**
 * DEV-364 PR 2b (docs/design/quality-proof-plan.md §3.1, §6 row 2b): the photo-slot spec `sr_photo_slots_v1`, an
 * attachment of the first approval. Offline and fictional only.
 *
 * It says, for each picture slot of the approved composition: its role (hero / product / background / decor), which
 * of the approved composition's existing materials go in it (`material_ids`, the ids of the photo-materials request's
 * `materials`, request-prompt.ts Material), and for PC and SP separately: the slot's box in the approved image (0..1),
 * its aspect, its shape, the picture's object-position, where the subject sits in the picture, and the gap between the
 * picture and its text (`text_gap`: adjacent | separated).
 *
 *   - Text over a photo cannot be written in this form: `text_gap` has no overlay value and every object is strict (no
 *     extra field). An overlay is a separate approval item (plan §4), never a value here.
 *   - It never changes the approved design or the whole-page prompt: it is a separate record bound to the approval by
 *     its fields and SHA-256 (approved_design, the ApprovedDesignRef fields plus approval_sha256).
 *
 * Two checks:
 *   checkPhotoSlots (Second Root, at delivery, with the approval context): the spec names the given approval
 *     (CONTENT_SLOTS_NOT_APPROVED); every material id is one of the approved materials (CONTENT_SLOTS_MATERIAL_UNKNOWN);
 *     the role fits the material's kind (CONTENT_SLOTS_ROLE_MISMATCH); each box lies inside the approved image and its
 *     pixel shape matches the declared aspect (CONTENT_SLOTS_BOX_MISMATCH); the subject stays inside the crop of the
 *     material's own aspect (CONTENT_SLOTS_SUBJECT_CROPPED).
 *     Review #372 M1: Second Root's delivery build (build.ts, delivery: true) runs it whenever the repository has a
 *     spec, and stops without the context (CONTENT_DELIVERY_SLOT_CONTEXT_MISSING).
 *   appliedSlots (every build, from content/photo-slots.json; not in .pages.yml, so the CMS cannot edit it): every
 *     material id must be named by the handover record (content/generated-materials.json), or the build stops
 *     (CONTENT_SLOTS_MATERIAL_NOT_HANDED_OVER; review #372 M1: refused, never skipped); a picture whose handover entry
 *     names a slot's material gets that slot; its subject must stay inside the crop for the picture's REAL ratio at PC
 *     and SP (CONTENT_SLOTS_SUBJECT_CROPPED). The page applies the slot's object-position (slotCss); Q1 measures the
 *     rendered frame (q1-check.ts).
 *
 * Limits: the subject's position is the declared one (where the spec says it is), not found in the pixels. A slot
 * reaches a picture through the handover record's material id, so B / C pictures (and a replaced picture) take the
 * page's default frame; keeping a replacement inside the approved composition is PR 5.
 * The request-prompt.ts values are mirrored here (experiments/ may not import that module: the owner-approved isolation
 * test); a unit test keeps the mirrors equal to it.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ContentError } from "./content-model";

export const PHOTO_SLOTS_SCHEMA = "sr_photo_slots_v1";
export const PHOTO_SLOTS_FILE = "content/photo-slots.json";

/** Mirrors of request-prompt.ts (REQUEST_ID_RE, Material.id, MATERIAL_KINDS, MATERIAL_ASPECTS, DESIGN_RECORD_NAME_RE). */
export const MIRROR = {
  requestId: /^req-[a-z0-9][a-z0-9-]{2,58}$/,
  materialId: /^[a-z][a-z0-9-]{1,30}$/,
  kinds: ["photo", "background", "decoration"] as const,
  aspects: ["landscape_3x2", "square_1x1", "portrait_2x3"] as const,
  recordName: /^[a-z0-9][a-z0-9._-]{0,63}\.json$/,
};
/** MATERIAL images (the approved composition's materials, request-prompt.ts aspects): width / height. */
export const MATERIAL_IMAGE_RATIOS: Record<(typeof MIRROR.aspects)[number], number> = { landscape_3x2: 3 / 2, square_1x1: 1, portrait_2x3: 2 / 3 };

export const SLOT_ROLES = ["hero", "product", "background", "decor"] as const;
/** The material kinds each role takes. */
export const ROLE_KINDS: Record<(typeof SLOT_ROLES)[number], readonly (typeof MIRROR.kinds)[number][]> = { hero: ["photo"], product: ["photo"], background: ["background"], decor: ["decoration"] };
/** SLOT frames (the box a picture is cropped into on the page): width / height. Not the material's own ratio. */
export const SLOT_FRAME_RATIOS = { "16:9": 16 / 9, "3:2": 3 / 2, "4:3": 4 / 3, "1:1": 1, "3:4": 3 / 4, "2:3": 2 / 3 } as const;
/** Where the subject sits in the picture, as a point in percent of its width and height. */
export const SUBJECT_POINTS = { center: [50, 50], "left-third": [100 / 3, 50], "right-third": [200 / 3, 50], top: [50, 25], bottom: [50, 75] } as const;
export const TEXT_GAPS = ["adjacent", "separated"] as const;

const SHA = z.string().regex(/^[0-9a-f]{64}$/);
const Unit = z.number().min(0).max(1);
const Box = z
  .strictObject({ x: Unit, y: Unit, w: Unit, h: Unit })
  .refine((b) => b.w > 0 && b.h > 0 && b.x + b.w <= 1 + 1e-9 && b.y + b.h <= 1 + 1e-9, "box_outside");
/** "<x>% <y>%", each 0..100 (the only object-position form: safe to write into CSS). */
const ObjectPosition = z.string().regex(/^(?:100|[1-9]?\d)% (?:100|[1-9]?\d)%$/);
const View = z.strictObject({
  box: Box,
  aspect: z.enum(Object.keys(SLOT_FRAME_RATIOS) as [keyof typeof SLOT_FRAME_RATIOS, ...(keyof typeof SLOT_FRAME_RATIOS)[]]),
  shape: z.enum(["rect", "rounded"]),
  object_position: ObjectPosition,
  subject: z.enum(Object.keys(SUBJECT_POINTS) as [keyof typeof SUBJECT_POINTS, ...(keyof typeof SUBJECT_POINTS)[]]),
  text_gap: z.enum(TEXT_GAPS),
});
export type SlotView = z.infer<typeof View>;
const SlotId = z.string().regex(/^[a-z][a-z0-9-]{1,30}$/);
export const ApprovedDesign = z
  .strictObject({
    bundle_id: z.string().regex(MIRROR.requestId),
    bundle_sha256: SHA,
    review_file: z.string().regex(MIRROR.recordName),
    approval_file: z.string().regex(MIRROR.recordName),
    approval_sha256: SHA,
  })
  .refine((a) => a.review_file !== a.approval_file, "approved_design_same_file");
export type ApprovedDesign = z.infer<typeof ApprovedDesign>;
/**
 * Notes on spacing, brightness, legibility: a remark for people, NOT an instruction to the page or to a generator
 * (nothing reads them). Plain text, no fact (no link, markup or digit run), and no overlay wording (review #372 L1:
 * text over a photo cannot come in through the notes either): 重ね・重な・乗せ・載せ・のせ・被せ・かぶせ・上に＋文字 /
 * 店名 / 見出し / ロゴ / テキスト・overlay・オーバーレイ. Matched after NFKC; a heuristic on the strict side.
 */
const OVERLAY_WORDING = /重ね|重な|乗せ|載せ|のせ|被せ|かぶせ|上に.{0,6}(?:文字|店名|見出し|ロゴ|テキスト|コピー)|overlay|オーバーレイ|over\s*the\s*photo/i;
const Notes = z
  .string()
  .max(200)
  .refine((s) => {
    const n = s.normalize("NFKC");
    return !/[<>]|https?:|www\.|\d{3,}/i.test(n) && !OVERLAY_WORDING.test(n);
  }, "notes_plain");

export const PhotoSlots = z
  .strictObject({
    schema: z.literal(PHOTO_SLOTS_SCHEMA),
    approved_design: ApprovedDesign,
    slots: z
      .array(z.strictObject({ id: SlotId, role: z.enum(SLOT_ROLES), material_ids: z.array(z.string().regex(MIRROR.materialId)).min(1).max(6), pc: View, sp: View }))
      .min(1)
      .max(12),
    notes: Notes.optional(),
  })
  .refine((s) => new Set(s.slots.map((x) => x.id)).size === s.slots.length, "slot_id_duplicate")
  .refine((s) => {
    const ids = s.slots.flatMap((x) => x.material_ids);
    return new Set(ids).size === ids.length;
  }, "material_in_two_slots");
export type PhotoSlots = z.infer<typeof PhotoSlots>;

/**
 * Whether the subject point stays inside the visible part of a picture (natural w × h) shown in a box (w × h) with
 * object-fit: cover at the given object-position — with a margin of 5% of the visible span on each side.
 */
export function subjectVisible(natural: { w: number; h: number }, box: { w: number; h: number }, position: string, subject: keyof typeof SUBJECT_POINTS): boolean {
  const m = /^(-?[\d.]+)% (-?[\d.]+)%$/.exec(position.trim());
  if (!m || natural.w <= 0 || natural.h <= 0 || box.w <= 0 || box.h <= 0) return false;
  const scale = Math.max(box.w / natural.w, box.h / natural.h);
  const [sx, sy] = SUBJECT_POINTS[subject];
  const axis = (nat: number, boxLen: number, pos: number, point: number) => {
    const shown = nat * scale;
    const start = ((shown - boxLen) * pos) / 100 / scale; // the first visible image pixel on this axis
    const span = boxLen / scale;
    const p = (nat * point) / 100;
    return p >= start + span * 0.05 && p <= start + span * 0.95;
  };
  return axis(natural.w, box.w, Number(m[1]), sx) && axis(natural.h, box.h, Number(m[2]), sy);
}

/** What the delivery check is given: the approval the spec must name, the approved materials, the approved image sizes. */
export type SlotContext = {
  approval: ApprovedDesign;
  materials: readonly { id: string; kind: (typeof MIRROR.kinds)[number]; aspect: (typeof MIRROR.aspects)[number] }[];
  approvedImage: { pc: { width: number; height: number }; sp: { width: number; height: number } };
};

/** Second Root's delivery check of a spec against its approval (see the header). Returns the parsed spec. */
export function checkPhotoSlots(raw: unknown, ctx: SlotContext): PhotoSlots {
  const r = PhotoSlots.safeParse(raw);
  if (!r.success) throw new ContentError("CONTENT_SLOTS_INVALID", PHOTO_SLOTS_FILE);
  const spec = r.data;
  const a = spec.approved_design;
  const b = ctx.approval;
  if (a.bundle_id !== b.bundle_id || a.bundle_sha256 !== b.bundle_sha256 || a.review_file !== b.review_file || a.approval_file !== b.approval_file || a.approval_sha256 !== b.approval_sha256)
    throw new ContentError("CONTENT_SLOTS_NOT_APPROVED", PHOTO_SLOTS_FILE);
  const byId = new Map(ctx.materials.map((m) => [m.id, m]));
  for (const slot of spec.slots) {
    for (const id of slot.material_ids) {
      const mat = byId.get(id);
      if (!mat) throw new ContentError("CONTENT_SLOTS_MATERIAL_UNKNOWN", `${slot.id}/${id}`);
      if (!ROLE_KINDS[slot.role].includes(mat.kind)) throw new ContentError("CONTENT_SLOTS_ROLE_MISMATCH", `${slot.id}/${id}`);
    }
    for (const view of ["pc", "sp"] as const) {
      const v = slot[view];
      const img = ctx.approvedImage[view];
      const shape = (v.box.w * img.width) / (v.box.h * img.height);
      const want = SLOT_FRAME_RATIOS[v.aspect];
      if (Math.abs(shape - want) / want > 0.08) throw new ContentError("CONTENT_SLOTS_BOX_MISMATCH", `${slot.id}/${view}`);
      for (const id of slot.material_ids) {
        const ratio = MATERIAL_IMAGE_RATIOS[byId.get(id)!.aspect];
        if (!subjectVisible({ w: ratio * 1000, h: 1000 }, { w: want * 1000, h: 1000 }, v.object_position, v.subject)) throw new ContentError("CONTENT_SLOTS_SUBJECT_CROPPED", `${slot.id}/${view}/${id}`);
      }
    }
  }
  return spec;
}

/** The repository's slot spec; null when absent (ENOENT only). Structure only: the approval is checked at delivery. */
export async function loadPhotoSlots(repo: string): Promise<PhotoSlots | null> {
  let bytes: Buffer;
  try {
    bytes = await readFile(join(repo, PHOTO_SLOTS_FILE));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ContentError("CONTENT_INVALID", PHOTO_SLOTS_FILE);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ContentError("CONTENT_SLOTS_INVALID", PHOTO_SLOTS_FILE);
  }
  const r = PhotoSlots.safeParse(raw);
  if (!r.success) throw new ContentError("CONTENT_SLOTS_INVALID", PHOTO_SLOTS_FILE);
  return r.data;
}

/** One slot as the page applies it to one picture (what Q1 measures). */
export type AppliedSlot = { slot: string; file: string; pc: Pick<SlotView, "aspect" | "object_position" | "subject">; sp: Pick<SlotView, "aspect" | "object_position" | "subject"> };

/**
 * The slots the page applies: a shown picture whose handover entry names a slot's material gets that slot. Its subject
 * must stay inside the crop for the picture's real ratio at PC and SP (CONTENT_SLOTS_SUBJECT_CROPPED).
 */
export function appliedSlots(spec: PhotoSlots | null, pictures: readonly { file: string; sha256: string; width: number; height: number }[], handover: readonly { sha256: string; material_id?: string }[]): AppliedSlot[] {
  if (!spec) return [];
  const named = new Set(handover.map((h) => h.material_id).filter(Boolean));
  for (const slot of spec.slots) for (const id of slot.material_ids) if (!named.has(id)) throw new ContentError("CONTENT_SLOTS_MATERIAL_NOT_HANDED_OVER", `${slot.id}/${id}`);
  const slotOfMaterial = new Map(spec.slots.flatMap((s) => s.material_ids.map((id) => [id, s] as const)));
  const out: AppliedSlot[] = [];
  for (const p of pictures) {
    const id = handover.find((h) => h.sha256 === p.sha256)?.material_id;
    const slot = id ? slotOfMaterial.get(id) : undefined;
    if (!slot) continue;
    for (const view of ["pc", "sp"] as const) {
      const v = slot[view];
      if (!subjectVisible({ w: p.width, h: p.height }, { w: SLOT_FRAME_RATIOS[v.aspect] * 1000, h: 1000 }, v.object_position, v.subject)) throw new ContentError("CONTENT_SLOTS_SUBJECT_CROPPED", `${slot.id}/${view}/${p.file}`);
    }
    const pick = (v: SlotView) => ({ aspect: v.aspect, object_position: v.object_position, subject: v.subject });
    out.push({ slot: slot.id, file: p.file, pc: pick(slot.pc), sp: pick(slot.sp) });
  }
  return out;
}

/** The CSS that applies the slots' object-position (PC, and SP under the site's breakpoint); "" when there are none. */
export function slotCss(applied: readonly AppliedSlot[], spMaxWidth: number): string {
  const bySlot = new Map(applied.map((a) => [a.slot, a]));
  if (bySlot.size === 0) return "";
  const rule = (a: AppliedSlot, v: "pc" | "sp") => `img[data-slot="${a.slot}"]{object-position:${a[v].object_position}}`;
  const list = [...bySlot.values()];
  return `${list.map((a) => rule(a, "pc")).join("")}\n@media (max-width:${spMaxWidth}px){${list.map((a) => rule(a, "sp")).join("")}}\n`;
}
