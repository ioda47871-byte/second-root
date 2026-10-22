/**
 * The implementation spec of a comp (DEV-082, docs/operations/comp-to-site.md):
 * what a design comp (one PNG of a whole page) says about layout, written down
 * as numbers BEFORE the page is built, so the built page can be measured
 * against it. In the PoC Claude writes this file by looking at the comp (a
 * human-in-the-loop step in a Claude Code session); nothing here reads text
 * out of the comp (no OCR), and nothing here is a source of shop facts.
 *
 * The spec carries layout only: sections and their boxes (fractions of the
 * artboard), palette, type scale, spacing, nav, CTA, image slots and where the
 * disclosure sits. Every visible word it names is either a fixed UI label from
 * COMP_UI_LABELS, a verbatim excerpt of a verified fact (fact_phrases, checked
 * against the facts by specFactProblems), or one of the two fixed disclosures.
 */
import { z } from "zod";
import type { DemoView } from "@/lib/sales/demo-content";
import { factStrings } from "../compare/shops";
import { POC_DISCLOSURE, POC_DISCLOSURE_V2 } from "../design-image/prompt";

export const COMP_SPEC_VERSION = 1;

/**
 * The only UI words a comp page may show besides facts and the disclosure.
 * Neutral navigation and information labels (the v2 art direction's web_ui
 * plus アクセス / メニュー); never a claim (no おすすめ, 人気, 予約, 購入 …).
 */
export const COMP_UI_LABELS = ["商品・こだわり", "店舗情報", "店舗情報を見る", "営業時間", "定休日", "住所", "電話", "アクセス", "メニュー", "お店について", "ページの先頭へ"] as const;
/** The labels of shop information: each must be a dt of a dl, paired with its value (render.ts PAIRS_SCRIPT). */
export const COMP_INFO_LABELS = ["営業時間", "定休日", "住所", "電話", "アクセス"] as const;
/** The only alt texts an image slot may carry (an AI concept image is always named as one). */
export const COMP_ALT_TEXTS = ["和菓子のイメージ（AI生成）", "どら焼きの断面と粒あんのイメージ（AI生成）", "上生菓子のイメージ（AI生成）", "粒あんの接写のイメージ（AI生成）"] as const;
/** Words that would claim a shop, an order or a reservation the facts do not hold (same list as the PoC's art direction check). */
export const SALES_UI = /購入|予約|注文|通販|カート|買う|お取り寄せ|おすすめ|人気|限定|送料/;
export const COMP_DISCLOSURES = [POC_DISCLOSURE, POC_DISCLOSURE_V2] as const;

export const SECTION_ROLES = ["header", "hero", "products", "info", "footer", "other"] as const;
export const PALETTE_ROLES = ["background", "surface", "text", "muted", "accent", "other"] as const;
export const SLOT_KINDS = ["ai_concept", "placeholder"] as const;
export const FACT_KEYS = ["name", "address", "hours", "closed_days", "access", "phone", "description"] as const;

const Id = z.string().regex(/^[a-z][a-z0-9-]{1,31}$/);
const Frac = z.number().min(0).max(1);
const Box = z.strictObject({ x: Frac, y: Frac, w: Frac, h: Frac });
const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const Px = (min: number, max: number) => z.number().min(min).max(max);

export const CompSpecSchema = z.strictObject({
  version: z.literal(COMP_SPEC_VERSION),
  /** sha256 of the comp PNG this spec was written from (checked against the bundle). */
  comp_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  /** Who wrote it: in the PoC always a Claude Code session a human watches. */
  authored_by: z.literal("claude_session"),
  artboard: z.strictObject({ width_px: z.number().int().min(256).max(8192), height_px: z.number().int().min(256).max(8192) }),
  /** The desktop width (CSS px) the comp shows, scaled to the artboard. */
  page_width_px: z.literal(1440),
  sections: z.array(z.strictObject({ id: Id, role: z.enum(SECTION_ROLES), box: Box })).min(2).max(12),
  palette: z.array(z.strictObject({ name: z.string().min(1).max(40), hex: Hex, role: z.enum(PALETTE_ROLES) })).min(2).max(8),
  /** Desktop CSS px, read off the comp at page_width_px. */
  type_scale: z.strictObject({ display_px: Px(16, 160), heading_px: Px(14, 96), caption_px: Px(12, 48), body_px: Px(12, 32), label_px: Px(12, 32) }),
  spacing: z.strictObject({ unit_px: Px(2, 32), section_padding_px: Px(0, 400), content_max_width_px: Px(320, 1920) }),
  nav: z.strictObject({ items: z.array(z.strictObject({ label: z.string().min(1).max(20), target: Id })).max(6) }),
  cta: z.strictObject({ label: z.string().min(1).max(20), target: Id }).nullable(),
  image_slots: z.array(z.strictObject({ id: Id, section: Id, kind: z.enum(SLOT_KINDS), aspect_w_per_h: z.number().min(0.2).max(5), box: Box })).max(8),
  disclosure: z.strictObject({ section: Id, text: z.enum(COMP_DISCLOSURES) }),
  required_facts: z.array(z.enum(FACT_KEYS)).min(1).max(FACT_KEYS.length),
  /** Verbatim excerpts of a fact the page may show on their own (captions); each must be inside one fact. */
  fact_phrases: z.array(z.string().min(2).max(40)).max(12),
  /** The section order on a phone (a permutation of the section ids). */
  mobile: z.strictObject({ order: z.array(Id).min(2).max(12) }),
});
export type CompSpec = z.infer<typeof CompSpecSchema>;

export type SpecCheck = { ok: true; spec: CompSpec } | { ok: false; problems: string[] };

const EPS = 0.005;
/** Sections may touch or overlap by this much of the artboard's height (anti-aliased edges in a comp). */
export const SECTION_OVERLAP_TOLERANCE = 0.02;

/** Checks the shape and the internal consistency of a spec; problems are fixed codes. */
export function checkCompSpec(raw: unknown): SpecCheck {
  const parsed = CompSpecSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, problems: ["SPEC_SHAPE"] };
  const spec = parsed.data;
  const p = new Set<string>();
  const ids = spec.sections.map((s) => s.id);
  if (new Set(ids).size !== ids.length) p.add("SPEC_SECTION_ID_REPEAT");
  for (const s of spec.sections) if (s.box.x + s.box.w > 1 + EPS || s.box.y + s.box.h > 1 + EPS || s.box.w <= 0 || s.box.h <= 0) p.add("SPEC_SECTION_BOX");
  for (let i = 1; i < spec.sections.length; i++) {
    const a = spec.sections[i - 1]!.box;
    const b = spec.sections[i]!.box;
    if (b.y + EPS < a.y) p.add("SPEC_SECTION_ORDER");
    if (a.y + a.h - b.y > SECTION_OVERLAP_TOLERANCE) p.add("SPEC_SECTION_OVERLAP");
  }
  const hexes = spec.palette.map((c) => c.hex.toLowerCase());
  if (new Set(hexes).size !== hexes.length) p.add("SPEC_PALETTE_REPEAT");
  const t = spec.type_scale;
  if (!(t.display_px > t.heading_px && t.heading_px > t.body_px && t.caption_px >= t.label_px)) p.add("SPEC_TYPE_ORDER");
  const labels = [...spec.nav.items.map((n) => n.label), ...(spec.cta ? [spec.cta.label] : [])];
  for (const label of labels) {
    if (!(COMP_UI_LABELS as readonly string[]).includes(label)) p.add("SPEC_LABEL_NOT_ALLOWED");
    if (SALES_UI.test(label)) p.add("SPEC_LABEL_SALES");
  }
  const targets = [...spec.nav.items.map((n) => n.target), ...(spec.cta ? [spec.cta.target] : [])];
  for (const target of targets) if (!ids.includes(target)) p.add("SPEC_TARGET_UNKNOWN");
  const slotIds = spec.image_slots.map((s) => s.id);
  if (new Set(slotIds).size !== slotIds.length) p.add("SPEC_SLOT_ID_REPEAT");
  for (const slot of spec.image_slots) {
    if (!ids.includes(slot.section)) p.add("SPEC_SLOT_SECTION_UNKNOWN");
    if (slot.box.x + slot.box.w > 1 + EPS || slot.box.y + slot.box.h > 1 + EPS) p.add("SPEC_SLOT_BOX");
  }
  if (!ids.includes(spec.disclosure.section)) p.add("SPEC_DISCLOSURE_SECTION_UNKNOWN");
  if (!spec.required_facts.includes("name")) p.add("SPEC_NAME_NOT_REQUIRED");
  if (new Set(spec.required_facts).size !== spec.required_facts.length) p.add("SPEC_FACT_REPEAT");
  for (const phrase of spec.fact_phrases) if (SALES_UI.test(phrase)) p.add("SPEC_PHRASE_SALES");
  const order = spec.mobile.order;
  if (order.length !== ids.length || new Set(order).size !== order.length || order.some((id) => !ids.includes(id))) p.add("SPEC_MOBILE_ORDER");
  return p.size === 0 ? { ok: true, spec } : { ok: false, problems: [...p].sort() };
}

const flat = (s: string) => s.replace(/\s+/g, "");

/** The shop's fact values by key (DemoView, the fact-only source); a key with no value is absent. */
export function factValues(demo: DemoView): Map<string, string> {
  return new Map(factStrings(demo).map((f) => [f.key, f.text]));
}

/** The spec against the verified facts: each required fact exists, each phrase lies inside one fact (verbatim). */
export function specFactProblems(spec: CompSpec, demo: DemoView): string[] {
  const facts = factValues(demo);
  const p = new Set<string>();
  for (const key of spec.required_facts) if (!facts.has(key)) p.add("SPEC_REQUIRED_FACT_ABSENT");
  const all = [...facts.values()].map(flat);
  for (const phrase of spec.fact_phrases) if (!all.some((f) => f.includes(flat(phrase)))) p.add("SPEC_PHRASE_NOT_A_FACT");
  return [...p].sort();
}
