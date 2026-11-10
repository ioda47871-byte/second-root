/**
 * DEV-196b (spec §4.4・§7.2・§7.5, owner decisions 2026-11-10): the owner's 7-item quality checklist of a demo
 * version, and the template-drift warnings.
 *
 * - All 7 items `ok` and both required renders (PC 1440, SP 390) present and viewed → `approved` is allowed.
 *   One `ng` → only `changes_requested` or `rejected`.
 * - Similarity (GENERIC_SKELETON, close to another shop's approved version, close to a success case / SR-001) is a
 *   WARNING only: it is shown to the owner and never blocks a version or an approval. Turning it into a gate is a
 *   separate approval once the vocabulary and thresholds are settled (Issue #159).
 *
 * Pure.
 */
import { z } from "zod";
import { structureFindings, THRESHOLDS, type StructureDescriptor } from "@/lib/design-agent/structure/descriptor";
import { REQUIRED_RENDERS, type RenderViewport } from "./manifest";

/** §7.2: the 7 items, in the order the admin screen shows them. 3, 4 and 5 are the ones the owner weighs most. */
export const QUALITY_CHECKLIST_ITEMS = [
  "identity_lock", // 1 店名・業種が正しい
  "facts_confirmed", // 2 表示された事実がすべて確認済み
  "shop_specific_structure", // 3 その店舗でなければ成立しない構成
  "no_generic_lp_regression", // 4 凡庸な LP への回帰がない
  "full_page_information", // 5 全ページで情報が伝わる (PC1440・SP390)
  "photos_truthful", // 6 写真が店の事実を偽らない
  "not_a_copy", // 7 成功例の写しではない
] as const;
export type QualityChecklistItem = (typeof QUALITY_CHECKLIST_ITEMS)[number];
export const EMPHASISED_ITEMS: readonly QualityChecklistItem[] = ["shop_specific_structure", "no_generic_lp_regression", "full_page_information"];

export const QualityChecklist = z.strictObject(Object.fromEntries(QUALITY_CHECKLIST_ITEMS.map((k) => [k, z.enum(["ok", "ng"])])) as Record<QualityChecklistItem, z.ZodEnum<{ ok: "ok"; ng: "ng" }>>);
export type QualityChecklist = z.infer<typeof QualityChecklist>;

export const QUALITY_DECISIONS = ["approved", "rejected", "changes_requested"] as const;
export type QualityDecision = (typeof QUALITY_DECISIONS)[number];

export type QualityDecisionCode = "CHECKLIST_INVALID" | "CHECKLIST_HAS_NG" | "RENDER_MISSING" | "RENDER_NOT_VIEWED" | "DECISION_INVALID";

/**
 * Whether a quality decision may be recorded. `renders` maps each render the version carries to its sha256;
 * `viewedRenders` is what the admin screen showed (`viewed_renders_sha256`). Warnings are not an input: they cannot
 * change the answer.
 */
export function evaluateQualityDecision(o: {
  decision: QualityDecision;
  checklist: unknown;
  renders: Partial<Record<RenderViewport, string>>;
  viewedRenders: Partial<Record<RenderViewport, string>>;
}): { ok: true; checklist: QualityChecklist } | { ok: false; codes: QualityDecisionCode[] } {
  if (!QUALITY_DECISIONS.includes(o.decision)) return { ok: false, codes: ["DECISION_INVALID"] };
  const parsed = QualityChecklist.safeParse(o.checklist);
  if (!parsed.success) return { ok: false, codes: ["CHECKLIST_INVALID"] };
  if (o.decision !== "approved") return { ok: true, checklist: parsed.data };
  const codes: QualityDecisionCode[] = [];
  if (QUALITY_CHECKLIST_ITEMS.some((k) => parsed.data[k] !== "ok")) codes.push("CHECKLIST_HAS_NG");
  for (const v of REQUIRED_RENDERS) {
    const sha = o.renders[v];
    if (!sha) codes.push("RENDER_MISSING");
    else if (o.viewedRenders[v] !== sha) codes.push("RENDER_NOT_VIEWED");
  }
  // a tablet render, if the version has one, was shown too (it is optional, but what was approved is what was seen)
  if (o.renders.tablet_768 && o.viewedRenders.tablet_768 !== o.renders.tablet_768) codes.push("RENDER_NOT_VIEWED");
  return codes.length ? { ok: false, codes: [...new Set(codes)] } : { ok: true, checklist: parsed.data };
}

export type TemplateWarning =
  | { code: "GENERIC_SKELETON"; reasons: string[] }
  | { code: "SAME_SKELETON_AS_OTHER_SHOP"; versionId: string; similarity: number }
  | { code: "TOO_CLOSE_TO_REFERENCE"; reference: string; similarity: number }
  | { code: "ASPECTS_UNKNOWN"; aspects: string[] };

/** Provisional thresholds (§7.5): the same values as the structure checks. */
export const TEMPLATE_WARNING_THRESHOLDS = { otherShops: THRESHOLDS.siblings_same_skeleton, reference: THRESHOLDS.too_close_to_reference } as const;
/** §7.5: how many recently approved versions of other shops the candidate is compared with. */
export const RECENT_OTHER_SHOP_VERSIONS = 20;

/**
 * §7.5 warnings for the admin screen: the structure checks (lib/design-agent/structure) against the success cases /
 * SR-001 (`references`) and the recently approved versions of OTHER shops (`otherShops`, at most 20 used).
 * `blocking` is always false.
 */
export function templateWarnings(candidate: StructureDescriptor, o: { references?: Record<string, StructureDescriptor>; otherShops?: Record<string, StructureDescriptor> } = {}): { blocking: false; warnings: TemplateWarning[] } {
  const others = Object.fromEntries(Object.entries(o.otherShops ?? {}).slice(0, RECENT_OTHER_SHOP_VERSIONS));
  const warnings: TemplateWarning[] = structureFindings(candidate, { references: o.references ?? {}, siblings: others }).map((f): TemplateWarning => {
    if (f.code === "SIBLINGS_SAME_SKELETON") return { code: "SAME_SKELETON_AS_OTHER_SHOP", versionId: f.sibling, similarity: f.similarity };
    if (f.code === "ASPECTS_UNKNOWN") return { code: "ASPECTS_UNKNOWN", aspects: [...f.aspects] };
    return f;
  });
  return { blocking: false, warnings };
}
