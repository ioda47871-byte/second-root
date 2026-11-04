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
  const { x, y, cw, ch, keptRaw } = coverRect(photo, slot, focal);
  const kept = r3(keptRaw);
  const density = r3(cw / slot.width_px);
  const codes: CropCode[] = [];
  // a crop that would be upscaled on a 2× screen: blurry. 0.5px of slack for rounding of the fractional crop
  if (cw + 0.5 < slot.min_width_px || ch + 0.5 < slot.min_height_px) codes.push("PHOTO_TOO_SMALL");
  if (keptRaw < MIN_KEPT_AREA) codes.push("RATIO_MISMATCH_EXTREME");
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

/**
 * The unrounded cover rectangle (photo pixels) of a photo in a board of the slot's shape, centred on the focal point
 * as far as the photo allows. keptRaw is the share of the photo's area it keeps: compared unrounded, so 0.4996 never
 * rounds up to the 0.5 limit.
 */
export function coverRect(photo: { width: number; height: number }, slot: Pick<SlotVariant, "width_px" | "height_px">, focal: Focal) {
  const { width: w, height: h } = photo;
  const target = slot.width_px / slot.height_px;
  const wide = w / h > target;
  const cw = wide ? h * target : w;
  const ch = wide ? h : w / target;
  const x = clamp(focal.x * w - cw / 2, 0, w - cw);
  const y = clamp(focal.y * h - ch / 2, 0, h - ch);
  return { x, y, cw, ch, keptRaw: (cw * ch) / (w * h) };
}

/** One photo against every viewport of a slot: it fits the slot only if it fits each of them. */
export function fitSlot(photo: { width: number; height: number }, slot: PhotoSlot, focal: Focal = slot.focal_default) {
  const byViewport = Object.fromEntries(slot.variants.map((v) => [v.viewport, coverCrop(photo, v, focal)])) as Record<SlotViewport, Crop>;
  const codes = [...new Set(Object.values(byViewport).flatMap((c) => (c.ok ? [] : c.codes)))];
  return { ok: codes.length === 0, codes, byViewport };
}

/** The variant a measured board gives: ratio and the 2× minimum. */
export function variantOf<V extends PlanViewport>(viewport: V, width: number, height: number): Omit<SlotVariant, "viewport"> & { viewport: V } {
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

/** Options of requestFor: the range-edge boxes to hold too, and the scale to size for (2×, or the 1.5× floor). */
export type RequestOptions = { edges?: readonly EdgeVariant[]; scale?: number };

export type PhotoRequest =
  | { ok: true; aspect: string; min_width_px: number; min_height_px: number; worst_kept_area: number }
  | { ok: false; code: "NO_SINGLE_SHAPE"; note: string };

/**
 * What to ask the owner for, for one slot: one common shape that every viewport can crop (each keeps at least
 * MIN_KEPT_AREA), the one that keeps the most in its worst viewport, and the least size for which no viewport
 * falls below its 2× minimum. A slot whose PC and SP shapes are too far apart for one photo says so.
 */
export function requestFor(slot: PhotoSlot, opts: RequestOptions = {}): PhotoRequest {
  const variants: AnyVariant[] = [...slot.variants, ...(opts.edges ?? [])].map((v) => atScale(v, opts.scale ?? SLOT_DENSITY));
  const keep = (r: number, t: number) => Math.min(r, t) / Math.max(r, t);
  const desktop = slot.variants.find((v) => v.viewport === "desktop_1440") ?? slot.variants[0]!;
  const target = (v: Pick<SlotVariant, "width_px" | "height_px">) => v.width_px / v.height_px;
  const scored = REQUEST_ASPECTS.map(([a, b]) => ({ a, b, r: a / b, worst: Math.min(...variants.map((v) => keep(a / b, target(v)))) }))
    .filter((c) => c.worst >= MIN_KEPT_AREA)
    .sort((x, y) => y.worst - x.worst || Math.abs(Math.log(x.r / target(desktop))) - Math.abs(Math.log(y.r / target(desktop))));
  const best = scored[0];
  if (!best) return { ok: false, code: "NO_SINGLE_SHAPE", note: "no common shape keeps half of the photo at every viewport: ask for one photo per viewport" };
  // the least width W (height W / r) whose cover crop meets each viewport's minimum at that scale
  let width = 0;
  for (const v of variants) {
    const t = target(v);
    const w = best.r > t ? Math.max(v.min_height_px, v.min_width_px / t) * best.r : Math.max(v.min_width_px, v.min_height_px * t);
    width = Math.max(width, w);
  }
  const W = Math.ceil(width / 10) * 10;
  return { ok: true, aspect: `${best.a}:${best.b}`, min_width_px: W, min_height_px: Math.ceil(W / best.r), worst_kept_area: r3(best.worst) };
}

/*
 * DEV-166 (Issue #193 comment 6623100651; owner, 2026-11-04 item 3): the scale rule and the separate SP photo.
 *
 * Scale: a photo must cover its board at 2× (MIN_SCALE_DEFAULT) at each viewport it is checked at — the 4 measured
 * viewports, and, when the range edges are given (planSlot's `edges`), the widest edge of each breakpoint range, which
 * holds the scale through the whole range up to DESKTOP_CAP_PX (not wider). Between 1.5× and 2× it is accepted
 * only with an exception record the owner decided ({ scale, reason, decided_by: "owner" }), and only down to the
 * scale that record names. Below 1.5× (MIN_SCALE_FLOOR) it is always refused, exception or not.
 *
 * Separate SP photo: the subject of a photo is its focal box (a rectangle in photo coordinates, 0–1). When the cover
 * crop of the PC photo for an SP board (mobile_390, and any viewport the page draws in the SP shape) loses the
 * subject — the focal box does not fit inside the crop, or the crop keeps less than half of the photo
 * (kept_area < MIN_KEPT_AREA) — the slot needs its own SP photo, used at those viewports.
 */
export const MIN_SCALE_DEFAULT = SLOT_DENSITY;

/*
 * Range edges (DEV-166 Fresh Review M3). The 4 measured viewports are points; a board grows inside each CSS breakpoint
 * range (つぐ手: ph-ware is 350px wide at 390 and 560px at 600). A rule "2× at 390" therefore does not hold at 600.
 * The edge variants are the boards measured at the widest edge of each range — mobile ≤600 at 600, tablet 601–1199
 * at 1199, desktop at a stated cap (1920) — kept per shop in poc/<shop>/photo-slot-edges.json next to the pinned
 * inventory (scripts/design-artifact/photo-slots.ts --edges). Checking them as well holds the scale through each
 * whole range, on a page whose boards only grow with the window inside a range (measured for つぐ手). Wider than the
 * desktop cap is not guaranteed: the desktop boards keep growing.
 */
export const EDGE_VIEWPORTS = ["mobile_600", "tablet_1199", "desktop_1920"] as const;
export type EdgeViewport = (typeof EDGE_VIEWPORTS)[number];
export type PlanViewport = SlotViewport | EdgeViewport;
/** The window each edge is measured at (the height does not change a board's box on the pages measured). */
export const EDGE_WINDOWS: Record<EdgeViewport, { width: number; height: number }> = {
  mobile_600: { width: 600, height: 900 },
  tablet_1199: { width: 1199, height: 900 },
  desktop_1920: { width: 1920, height: 1080 },
};
/** The widest window the desktop scale is checked at: wider screens are not guaranteed. */
export const DESKTOP_CAP_PX = EDGE_WINDOWS.desktop_1920.width;
export const EdgeVariant = SlotVariant.extend({ viewport: z.enum(EDGE_VIEWPORTS) });
export type EdgeVariant = z.infer<typeof EdgeVariant>;
type AnyVariant = SlotVariant | EdgeVariant;

export const PhotoSlotEdges = z
  .strictObject({
    schema: z.literal("photo_slot_edges_v0"),
    shop: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/),
    page_dir: z.string().regex(/^design-library\/research\/quality-pipeline\/poc\/[a-z0-9/_.-]+$/).refine((p) => !p.split("/").includes(".."), "no .."),
    /** the same page as photo-slots.json: equal hashes, or the edges are stale */
    html_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    css_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    copy_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    derived_by: z.literal("scripts/design-artifact/photo-slots.ts --edges"),
    desktop_cap_px: z.literal(DESKTOP_CAP_PX),
    slots: z
      .array(z.strictObject({ slot_id: z.string().regex(/^ph-[a-z0-9-]{1,40}$/), edges: z.array(EdgeVariant).length(EDGE_VIEWPORTS.length) }))
      .min(1)
      .max(40),
  })
  .refine((e) => e.slots.every((s) => EDGE_VIEWPORTS.every((v, i) => s.edges[i]?.viewport === v)), "edges in EDGE_VIEWPORTS order");
export type PhotoSlotEdges = z.infer<typeof PhotoSlotEdges>;

/** The edge variants of each slot, or null when the edges were not measured on the inventory's page. */
export function edgesFor(inv: PhotoSlotInventory, edges: PhotoSlotEdges): Map<string, EdgeVariant[]> | null {
  if (edges.shop !== inv.shop || edges.page_dir !== inv.page_dir || edges.html_sha256 !== inv.html_sha256 || edges.css_sha256 !== inv.css_sha256 || edges.copy_sha256 !== inv.copy_sha256) return null;
  const ids = inv.slots.map((s) => s.slot_id);
  if (edges.slots.length !== ids.length || edges.slots.some((s, i) => s.slot_id !== ids[i])) return null;
  return new Map(edges.slots.map((s) => [s.slot_id, s.edges]));
}
export const MIN_SCALE_FLOOR = 1.5;
/**
 * The viewports a separate SP photo replaces the PC photo at, by default the phone only. A page whose CSS gives its
 * boards the SP shape at wider widths too (つぐ手: every board takes its SP shape at ≤1199px) passes those viewports.
 */
export const SP_VIEWPORTS_DEFAULT: readonly SlotViewport[] = ["mobile_390"];

export const ScaleException = z.strictObject({
  /** the least scale the owner accepts for this slot: 1.5 ≤ scale < 2 */
  scale: z.number().min(MIN_SCALE_FLOOR).lt(MIN_SCALE_DEFAULT),
  /** why the photo's real quality and crop are enough (the owner looked at it) */
  reason: z.string().trim().min(1).max(300),
  decided_by: z.literal("owner"),
});
export type ScaleException = z.infer<typeof ScaleException>;

/** The subject's box in the photo, as shares of its width and height (as the photo is shown). */
export const FocalBox = z
  .strictObject({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().positive().max(1), h: z.number().positive().max(1) })
  .refine((b) => b.x + b.w <= 1 + 1e-9 && b.y + b.h <= 1 + 1e-9, "the focal box must lie inside the photo");
export type FocalBox = z.infer<typeof FocalBox>;
export const focalOf = (b: FocalBox): Focal => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

export type ScaleCode = CropCode | "SCALE_EXCEPTION_REQUIRED" | "PHOTO_BELOW_MIN_SCALE" | "SCALE_EXCEPTION_INVALID";
export type ScaledCrop =
  | (Extract<Crop, { ok: true }> & { scale_basis: number; exception_applied: boolean })
  | { ok: false; codes: ScaleCode[]; kept_area?: number; density?: number };

const atScale = <T extends AnyVariant>(v: T, s: number): T =>
  s === SLOT_DENSITY ? v : { ...v, min_width_px: Math.ceil(v.width_px * s), min_height_px: Math.ceil(v.height_px * s) };

/**
 * coverCrop under the scale rule: 2× passes; 1.5–2× passes only with a valid owner exception whose scale the crop
 * meets; below 1.5× never passes. An exception record that is not valid is refused even when the photo is 2×.
 */
export function scaledCrop(photo: { width: number; height: number }, v: AnyVariant, focal: Focal, exception?: unknown): ScaledCrop {
  let exc: ScaleException | undefined;
  if (exception !== undefined) {
    const p = ScaleException.safeParse(exception);
    if (!p.success) return { ok: false, codes: ["SCALE_EXCEPTION_INVALID"] };
    exc = p.data;
  }
  const at2 = coverCrop(photo, v, focal);
  if (at2.ok) return { ...at2, scale_basis: MIN_SCALE_DEFAULT, exception_applied: false };
  if (at2.codes.some((c) => c !== "PHOTO_TOO_SMALL")) return at2;
  const floor = coverCrop(photo, atScale(v, MIN_SCALE_FLOOR), focal);
  if (!floor.ok) return { ok: false, codes: ["PHOTO_BELOW_MIN_SCALE"], kept_area: floor.kept_area, density: floor.density };
  if (!exc) return { ok: false, codes: ["SCALE_EXCEPTION_REQUIRED"], kept_area: floor.kept_area, density: floor.density };
  const agreed = coverCrop(photo, atScale(v, exc.scale), focal);
  if (!agreed.ok) return { ok: false, codes: ["PHOTO_TOO_SMALL"], kept_area: agreed.kept_area, density: agreed.density };
  return { ...agreed, scale_basis: exc.scale, exception_applied: true };
}

/** Whether the focal box (0–1) lies inside a crop rectangle (photo px), with half a pixel of slack for rounding. */
export function subjectInside(photo: { width: number; height: number }, box: FocalBox, rect: { x: number; y: number; cw: number; ch: number }): boolean {
  const [bx, by, bw, bh] = [box.x * photo.width, box.y * photo.height, box.w * photo.width, box.h * photo.height];
  return bx + 0.5 >= rect.x && by + 0.5 >= rect.y && bx + bw <= rect.x + rect.cw + 0.5 && by + bh <= rect.y + rect.ch + 0.5;
}

export type SlotPhoto = { width: number; height: number; focal_box: FocalBox };
export type SlotPlanCode = ScaleCode | "SP_PHOTO_REQUIRED" | "FOCAL_SUBJECT_CROPPED";
export type SlotPlan = {
  ok: boolean;
  codes: SlotPlanCode[];
  /** the PC photo loses its subject in the SP crop: an SP photo is required (true even when one was given) */
  needs_sp_photo: boolean;
  /** the 4 measured viewports always; the range edges when they were given */
  byViewport: Record<SlotViewport, SlotViewportPlan> & Partial<Record<EdgeViewport, SlotViewportPlan>>;
};
export type SlotViewportPlan = { source: "pc" | "sp"; crop: ScaledCrop; subject_kept: boolean; kept_area: number };

/**
 * Plans one slot: the PC photo for every viewport, or, at SP, the separate SP photo when one is given. Refuses a
 * crop that cuts the subject (FOCAL_SUBJECT_CROPPED), and asks for an SP photo when the PC photo's SP crop loses it.
 */
export function planSlot(slot: PhotoSlot, photos: { pc: SlotPhoto; sp?: SlotPhoto; scale_exception?: unknown }, opts: { spViewports?: readonly PlanViewport[]; edges?: readonly EdgeVariant[] } = {}): SlotPlan {
  const spViewports: readonly PlanViewport[] = opts.spViewports ?? SP_VIEWPORTS_DEFAULT;
  const variants: AnyVariant[] = [...slot.variants, ...(opts.edges ?? [])];
  const codes = new Set<SlotPlanCode>();
  let needsSp = false;
  const byViewport = {} as SlotPlan["byViewport"];
  const valid = (p: SlotPhoto) => [p.width, p.height].every((n) => Number.isFinite(n) && n > 0) && FocalBox.safeParse(p.focal_box).success;
  if (!valid(photos.pc) || (photos.sp && !valid(photos.sp))) {
    for (const v of variants) byViewport[v.viewport] = { source: "pc", crop: { ok: false, codes: ["BAD_INPUT"] }, subject_kept: false, kept_area: 0 };
    return { ok: false, codes: ["BAD_INPUT"], needs_sp_photo: false, byViewport };
  }
  for (const v of variants) {
    const isSp = spViewports.includes(v.viewport);
    const source = isSp && photos.sp ? "sp" : "pc";
    const photo = source === "sp" ? photos.sp! : photos.pc;
    const focal = focalOf(photo.focal_box);
    const rect = coverRect(photo, v, focal);
    const kept = subjectInside(photo, photo.focal_box, rect) && rect.keptRaw >= MIN_KEPT_AREA;
    const crop = scaledCrop(photo, v, focal, photos.scale_exception);
    byViewport[v.viewport] = { source, crop, subject_kept: kept, kept_area: r3(rect.keptRaw) };
    if (isSp) {
      // decided on the PC photo, whether or not an SP photo was given
      const pcRect = coverRect(photos.pc, v, focalOf(photos.pc.focal_box));
      const lost = !(subjectInside(photos.pc, photos.pc.focal_box, pcRect) && pcRect.keptRaw >= MIN_KEPT_AREA);
      needsSp ||= lost;
      if (lost && source === "pc") {
        codes.add("SP_PHOTO_REQUIRED");
        continue;
      }
    }
    if (!crop.ok) crop.codes.forEach((c) => codes.add(c));
    if (!kept) codes.add("FOCAL_SUBJECT_CROPPED");
  }
  return { ok: codes.size === 0, codes: [...codes], needs_sp_photo: needsSp, byViewport };
}
