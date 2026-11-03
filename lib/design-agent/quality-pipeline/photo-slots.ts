/**
 * DEV-163 (Issue #193 comment 6601921731, decision 3): where a real photo would go in a research fidelity page (C),
 * and how it would be cropped there. Pure: no file, no browser, no photo.
 *
 * A slot is one placeholder board of a page: the box next to a caption that starts with 写真｜ (a copy-record item
 * `ph-*`). Its size at each viewport is measured from the rendered page by scripts/design-artifact/photo-slots.ts and
 * kept in design-library/research/quality-pipeline/poc/<shop>/photo-slots.json, with the hashes of the page it was
 * measured on (a changed page must be measured again).
 *
 * The crop is CSS `object-fit: cover` around a focal point: the photo fills the board, and what spills over is cut on
 * the side away from the focal point. A photo that would be shown below its slot's minimum size (2× the board, for a
 * 2× screen), or that would lose more than half of its area to the crop, is refused instead of being drawn badly.
 */
import { z } from "zod";

export const SLOT_VIEWPORTS = ["desktop_1440", "tablet_1024", "tablet_768", "mobile_390"] as const;
export type SlotViewport = (typeof SLOT_VIEWPORTS)[number];
/** device pixels per CSS pixel a photo must cover (a 2× phone or laptop screen) */
export const SLOT_DENSITY = 2;
/** the least share of the photo's area a crop may keep; below it the photo is the wrong shape for the slot */
export const MIN_KEPT_AREA = 0.5;

const Focal = z.strictObject({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) });
export type Focal = z.infer<typeof Focal>;

export const SlotVariant = z.strictObject({
  viewport: z.enum(SLOT_VIEWPORTS),
  /** the board's layout box in CSS px (before any rotation the page draws it with) */
  width_px: z.number().int().positive(),
  height_px: z.number().int().positive(),
  /** width / height, to 3 decimals */
  ratio: z.number().positive(),
  /** SLOT_DENSITY × the box: the least a crop of the photo must keep */
  min_width_px: z.number().int().positive(),
  min_height_px: z.number().int().positive(),
});
export type SlotVariant = z.infer<typeof SlotVariant>;

export const PhotoSlot = z.strictObject({
  /** the copy-record id of the caption (ph-*) */
  slot_id: z.string().regex(/^ph-[a-z0-9-]{1,40}$/),
  /** what the photo shows: the caption without 写真｜ */
  role: z.string().min(1).max(80),
  /** the page's section (data-comp-section) the board sits in */
  section: z.string().regex(/^[a-z0-9-]{1,40}$/),
  /** the board element: its class list, as the page writes it */
  board_class: z.string().min(1).max(120),
  /** a selector under the section that names this board and nothing else (where the photo goes) */
  board_selector: z.string().regex(/^\[data-comp-section="[a-z0-9-]{1,40}"\] [a-z0-9 >.:()_-]{1,200}$/),
  /** what the board is in the page now: a CSS-drawn ground, a ground with an inline SVG drawing on it */
  placeholder: z.enum(["css_board", "css_board_with_svg"]),
  focal_default: Focal,
  variants: z.array(SlotVariant).length(SLOT_VIEWPORTS.length),
});
export type PhotoSlot = z.infer<typeof PhotoSlot>;

export const PhotoSlotInventory = z
  .strictObject({
    schema: z.literal("photo_slots_v0"),
    shop: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/),
    shop_id: z.string().regex(/^fictional-[a-z0-9-]{1,60}$/),
    page_dir: z.string().regex(/^design-library\/research\/quality-pipeline\/poc\/[a-z0-9/_.-]+$/).refine((p) => !p.split("/").includes(".."), "no .."),
    html_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    css_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    copy_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    derived_by: z.literal("scripts/design-artifact/photo-slots.ts"),
    /** until a rights-cleared photo fills every slot, the page is judged with placeholders */
    evaluation_label: z.literal("placeholder_limited"),
    density: z.literal(SLOT_DENSITY),
    slots: z.array(PhotoSlot).min(1).max(40),
  })
  .refine((inv) => new Set(inv.slots.map((s) => s.slot_id)).size === inv.slots.length, "slot ids must be unique");
export type PhotoSlotInventory = z.infer<typeof PhotoSlotInventory>;

export type CropCode = "BAD_INPUT" | "PHOTO_TOO_SMALL" | "RATIO_MISMATCH_EXTREME";
export type Crop =
  | {
      ok: true;
      /** the part of the photo that is shown, in photo pixels */
      crop: { x: number; y: number; width: number; height: number };
      object_fit: "cover";
      /** the CSS object-position that shows exactly that part */
      object_position: string;
      /** share of the photo's area that is shown */
      kept_area: number;
      /** photo pixels per CSS pixel of the board */
      density: number;
    }
  | { ok: false; codes: CropCode[]; kept_area?: number; density?: number };

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const pct = (n: number) => `${Math.round(n * 10000) / 100}%`;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * The cover crop of a photo (w × h) into a slot variant, centred on the focal point as far as the photo allows.
 * object-position p% places the photo so that the point p% across its overflow is at the board's edge: the
 * crop's left edge is (w − cw) · p, so p = x / (w − cw).
 */
export function coverCrop(photo: { width: number; height: number }, slot: Pick<SlotVariant, "width_px" | "height_px" | "min_width_px" | "min_height_px">, focal: Focal = { x: 0.5, y: 0.5 }): Crop {
  const { width: w, height: h } = photo;
  const ok = (n: number) => Number.isFinite(n) && n > 0;
  if (![w, h, slot.width_px, slot.height_px, slot.min_width_px, slot.min_height_px].every(ok) || !Focal.safeParse(focal).success) return { ok: false, codes: ["BAD_INPUT"] };
  const target = slot.width_px / slot.height_px;
  const wide = w / h > target;
  const cw = wide ? h * target : w;
  const ch = wide ? h : w / target;
  const x = clamp(focal.x * w - cw / 2, 0, w - cw);
  const y = clamp(focal.y * h - ch / 2, 0, h - ch);
  const kept = r3((cw * ch) / (w * h));
  const density = r3(cw / slot.width_px);
  const codes: CropCode[] = [];
  // a crop that would be upscaled on a 2× screen: blurry. 0.5px of slack for rounding of the fractional crop
  if (cw + 0.5 < slot.min_width_px || ch + 0.5 < slot.min_height_px) codes.push("PHOTO_TOO_SMALL");
  if (kept < MIN_KEPT_AREA) codes.push("RATIO_MISMATCH_EXTREME");
  if (codes.length) return { ok: false, codes, kept_area: kept, density };
  const px = w - cw > 0.5 ? x / (w - cw) : 0.5;
  const py = h - ch > 0.5 ? y / (h - ch) : 0.5;
  return {
    ok: true,
    crop: { x: Math.round(x), y: Math.round(y), width: Math.round(cw), height: Math.round(ch) },
    object_fit: "cover",
    object_position: `${pct(px)} ${pct(py)}`,
    kept_area: kept,
    density,
  };
}

/** One photo against every viewport of a slot: it fits the slot only if it fits each of them. */
export function fitSlot(photo: { width: number; height: number }, slot: PhotoSlot, focal: Focal = slot.focal_default) {
  const byViewport = Object.fromEntries(slot.variants.map((v) => [v.viewport, coverCrop(photo, v, focal)])) as Record<SlotViewport, Crop>;
  const codes = [...new Set(Object.values(byViewport).flatMap((c) => (c.ok ? [] : c.codes)))];
  return { ok: codes.length === 0, codes, byViewport };
}

/** The variant a measured board gives: ratio and the 2× minimum. */
export function variantOf(viewport: SlotViewport, width: number, height: number): SlotVariant {
  const wpx = Math.round(width);
  const hpx = Math.round(height);
  return { viewport, width_px: wpx, height_px: hpx, ratio: r3(width / height), min_width_px: Math.ceil(width * SLOT_DENSITY), min_height_px: Math.ceil(height * SLOT_DENSITY) };
}

/** Shapes a person can shoot or export without thinking: width : height. */
export const REQUEST_ASPECTS: ReadonlyArray<readonly [number, number]> = [
  [16, 9],
  [3, 2],
  [4, 3],
  [1, 1],
  [4, 5],
  [3, 4],
  [2, 3],
];

export type PhotoRequest =
  | { ok: true; aspect: string; min_width_px: number; min_height_px: number; worst_kept_area: number }
  | { ok: false; code: "NO_SINGLE_SHAPE"; note: string };

/**
 * What to ask the owner for, for one slot: one common shape that every viewport can crop (each keeps at least
 * MIN_KEPT_AREA), the one that keeps the most in its worst viewport, and the least size for which no viewport
 * falls below its 2× minimum. A slot whose PC and SP shapes are too far apart for one photo says so.
 */
export function requestFor(slot: PhotoSlot): PhotoRequest {
  const keep = (r: number, t: number) => Math.min(r, t) / Math.max(r, t);
  const desktop = slot.variants.find((v) => v.viewport === "desktop_1440") ?? slot.variants[0]!;
  const target = (v: SlotVariant) => v.width_px / v.height_px;
  const scored = REQUEST_ASPECTS.map(([a, b]) => ({ a, b, r: a / b, worst: Math.min(...slot.variants.map((v) => keep(a / b, target(v)))) }))
    .filter((c) => c.worst >= MIN_KEPT_AREA)
    .sort((x, y) => y.worst - x.worst || Math.abs(Math.log(x.r / target(desktop))) - Math.abs(Math.log(y.r / target(desktop))));
  const best = scored[0];
  if (!best) return { ok: false, code: "NO_SINGLE_SHAPE", note: "no common shape keeps half of the photo at every viewport: ask for one photo per viewport" };
  // the least width W (height W / r) whose cover crop meets each viewport's 2× minimum
  let width = 0;
  for (const v of slot.variants) {
    const t = target(v);
    const w = best.r > t ? Math.max(v.min_height_px, v.min_width_px / t) * best.r : Math.max(v.min_width_px, v.min_height_px * t);
    width = Math.max(width, w);
  }
  const W = Math.ceil(width / 10) * 10;
  return { ok: true, aspect: `${best.a}:${best.b}`, min_width_px: W, min_height_px: Math.ceil(W / best.r), worst_kept_area: r3(best.worst) };
}
