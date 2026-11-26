/**
 * DEV-364 PR 3a (review #373 M1, L4): the strict forms of the two records the second approval binds, COPIED from the
 * fictional Pages CMS experiment (experiments/pages-cms/provenance.ts and photo-slots.ts) because lib/ must not import
 * experiments/. A unit test (tests/unit/experiments/pages-cms-final-approval.test.ts) keeps every copy equal to its
 * original on the same accepted and refused samples; change both together.
 *
 *   sr_photo_provenance_v1  per picture: A (generated material: its id and the materials approval), B (the shop's
 *                           photo: a role, a source, a permission, the facts check), C (a customer's upload)
 *   sr_photo_slots_v1       the photo-slot spec: per slot its role, materials and PC / SP framing; no text over photos
 *
 * Pure schemas: no file, no process, no network.
 */
import { z } from "zod";

export const PROVENANCE_SCHEMA = "sr_photo_provenance_v1";
const PROV_SHA = z.string().regex(/^[0-9a-f]{64}$/);
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** review #371 L1: who provided / who confirmed — a role from a fixed list, never a person. */
export const PROVENANCE_ROLES = ["店主", "店長", "スタッフ", "撮影者", "Second Root 担当"] as const;
/**
 * review #371 L1 and its Low: free text that should not carry a person's contact or name. Matched after NFKC
 * normalisation (full-width digits, letters and ＠ become ASCII): a phone number (any dash or minus sign between the
 * groups), a LINE ID, an @handle, a handle after an SNS name (「Instagram yamada_t」) or any ASCII word with an
 * underscore, an e-mail address, a link, or a name with an honorific (様・さん・氏・くん・ちゃん after kana, kanji or
 * a letter, whatever follows). A heuristic, NOT a reliable block: it errs strict (「模様」「仕様」「皆さん」 are refused
 * too) and it still misses a bare name or a handle written without these signs. The role lists are the real guard.
 */
const PERSONAL =
  /[<>@]|https?:|www\.|\d{2,4}[-‐‑‒–—―−ー\s]?\d{2,4}[-‐‑‒–—―−ー\s]?\d{3,4}|\bline\s*(?:id)?\s*[:：]|\b(?:instagram|insta|ig|twitter|tiktok|facebook|threads|line|youtube)\b\s*[:：]?\s*[a-z0-9._]{2,}|\b[a-z][a-z0-9]*_[a-z0-9_]*|[ぁ-んァ-ヶ一-龯A-Za-z]\s*(?:様|さん|氏|くん|ちゃん)/i;
/** A role or a short plain phrase; no link, markup or e-mail address (a role, never a person's contact). */
const Plain = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => s === s.trim() && !PERSONAL.test(s.normalize("NFKC")), "plain_text");

export const ProvenanceA = z.strictObject({
  schema: z.literal(PROVENANCE_SCHEMA),
  class: z.literal("A"),
  sha256: PROV_SHA,
  material_id: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
  materials_approval_sha256: PROV_SHA,
});
export const ProvenanceB = z.strictObject({
  schema: z.literal(PROVENANCE_SCHEMA),
  class: z.literal("B"),
  sha256: PROV_SHA,
  provided_by: z.enum(PROVENANCE_ROLES),
  source: Plain(120),
  permission: z.strictObject({ scope: Plain(200), confirmed_at: IsoDate, confirmed_by: z.enum(PROVENANCE_ROLES) }),
  facts_check: z.strictObject({ shown_as_fact: z.boolean(), confirmed: z.boolean() }).refine((f) => !f.shown_as_fact || f.confirmed, "facts_unconfirmed"),
});
export const ProvenanceC = z.strictObject({
  schema: z.literal(PROVENANCE_SCHEMA),
  class: z.literal("C"),
  sha256: PROV_SHA,
  uploaded_via: z.literal("pages_cms"),
  commit: z.string().regex(/^[0-9a-f]{7,40}$/).optional(),
  checks: z.strictObject({ type: z.literal("ok"), bytes: z.literal("ok"), dimensions: z.literal("ok"), ratio: z.literal("ok") }),
});
export const Provenance = z.discriminatedUnion("class", [ProvenanceA, ProvenanceB, ProvenanceC]);
export type Provenance = z.infer<typeof Provenance>;
export type ProvenanceB = z.infer<typeof ProvenanceB>;

/** Copies of the request schema's rules (REQUEST_ID_RE, Material.id, MATERIAL_KINDS, MATERIAL_ASPECTS, DESIGN_RECORD_NAME_RE). */
export const MIRROR = {
  requestId: /^req-[a-z0-9][a-z0-9-]{2,58}$/,
  materialId: /^[a-z][a-z0-9-]{1,30}$/,
  kinds: ["photo", "background", "decoration"] as const,
  aspects: ["landscape_3x2", "square_1x1", "portrait_2x3"] as const,
  recordName: /^[a-z0-9][a-z0-9._-]{0,63}\.json$/,
};
/** MATERIAL images (the approved composition's materials, the request schema aspects): width / height. */
export const MATERIAL_IMAGE_RATIOS: Record<(typeof MIRROR.aspects)[number], number> = { landscape_3x2: 3 / 2, square_1x1: 1, portrait_2x3: 2 / 3 };

export const SLOT_ROLES = ["hero", "product", "background", "decor"] as const;
/** The material kinds each role takes. */
export const ROLE_KINDS: Record<(typeof SLOT_ROLES)[number], readonly (typeof MIRROR.kinds)[number][]> = { hero: ["photo"], product: ["photo"], background: ["background"], decor: ["decoration"] };
/** SLOT frames (the box a picture is cropped into on the page): width / height. Not the material's own ratio. */
export const SLOT_FRAME_RATIOS = { "16:9": 16 / 9, "3:2": 3 / 2, "4:3": 4 / 3, "1:1": 1, "3:4": 3 / 4, "2:3": 2 / 3 } as const;
/** Where the subject sits in the picture, as a point in percent of its width and height. */
export const SUBJECT_POINTS = { center: [50, 50], "left-third": [100 / 3, 50], "right-third": [200 / 3, 50], top: [50, 25], bottom: [50, 75] } as const;
export const TEXT_GAPS = ["adjacent", "separated"] as const;

const SLOT_SHA = z.string().regex(/^[0-9a-f]{64}$/);
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
    bundle_sha256: SLOT_SHA,
    review_file: z.string().regex(MIRROR.recordName),
    approval_file: z.string().regex(MIRROR.recordName),
    approval_sha256: SLOT_SHA,
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
    schema: z.literal("sr_photo_slots_v1"),
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
