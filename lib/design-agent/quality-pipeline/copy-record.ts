/**
 * DEV-159 (Issue #193 comment 6591440695, task T5 approved with conditions): the words a comp may show, each with
 * where it comes from.
 *
 *   fact                     the shop's fact, as the facts pack gives it (source_fact_ids name it; the text contains
 *                            the fact's value). A `label` may introduce it ("所在地").
 *   creative_expression      original brand copy (tagline, metaphor, section heading). Allowed only in the
 *                            quality-first research lane, on fictional shops; always needs the owner's review.
 *   proposal_pending_review  copy proposed for a real shop; never shown as the shop's own words until reviewed.
 *
 * Creative copy must not invent facts: an address, hours, prices, ingredients, certification, health or efficacy,
 * history, people, reputation, awards, menus, reservation or stock, customer voices. The check below refuses the
 * plain signs of those (digits, money, dates, superlatives, award and certification words); it is a tripwire, not a
 * fact checker, and the owner's review still decides.
 *
 * Pure: zod. The caller reads the facts pack.
 */
import { z } from "zod";

const Line = (max: number) => z.string().trim().min(1).max(max);

export const CopyItem = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_-]{1,40}$/),
  text: Line(300),
  claim_type: z.enum(["fact", "creative_expression", "proposal_pending_review"]),
  source_fact_ids: z.array(z.string().regex(/^F\d{1,3}$/)).max(8),
  owner_review_needed: z.boolean(),
  /** For facts only: a short label shown with the value (所在地, 営業時間...). */
  label: Line(20).optional(),
});
export type CopyItem = z.infer<typeof CopyItem>;

export const CopyRecord = z.strictObject({
  schema: z.literal("comp_copy_v1"),
  shop_id: z.string().min(1).max(80),
  facts_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Only fictional shops in the research lane may carry creative copy (owner, Issue #193). */
  lane: z.enum(["quality_research_fictional", "real_shop_proposal"]),
  items: z.array(CopyItem).min(1).max(120),
});
export type CopyRecord = z.infer<typeof CopyRecord>;

/** The plain signs of an invented fact in a creative line. */
export const INVENTED_FACT_SIGNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["number", /[0-9０-９]/],
  ["money", /[¥￥円]|価格|値段|税込|税別|無料|割引|半額/],
  ["time_or_date", /時間|曜日|年|月[0-9０-９一二三四五六七八九十]|日[0-9０-９]|創業|老舗|伝統の/],
  ["award_or_certification", /受賞|認定|認証|公認|資格|ミシュラン|グランプリ|金賞|特許/],
  ["superlative_or_reputation", /日本一|世界一|No\.?1|ナンバーワン|人気|評判|話題|満足度|口コミ|お客様の声|行列/],
  ["health_or_efficacy", /効果|効能|健康|治る|改善|安全|無添加|オーガニック|天然|国産/],
  ["reservation_or_stock", /予約|在庫|限定|残りわずか|即日|お届け|配送|注文/],
];

export type CopyFinding = { code: string; item?: string; detail?: string };

const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, "");

/** The record against the shop's facts (ids, values, SHA and shop). */
export function checkCopyRecord(raw: unknown, o: { shopId: string; factsSha256: string; facts: ReadonlyArray<{ id: string; value: string }> }): { ok: boolean; findings: CopyFinding[] } {
  const parsed = CopyRecord.safeParse(raw);
  if (!parsed.success) return { ok: false, findings: [{ code: "COPY_SCHEMA", detail: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }] };
  const r = parsed.data;
  const f: CopyFinding[] = [];
  if (r.shop_id !== o.shopId) f.push({ code: "COPY_SHOP_MISMATCH" });
  if (r.facts_sha256 !== o.factsSha256) f.push({ code: "COPY_FACTS_SHA_MISMATCH" });
  const ids = r.items.map((i) => i.id);
  if (new Set(ids).size !== ids.length) f.push({ code: "COPY_IDS_DUPLICATED" });
  const byId = new Map(o.facts.map((x) => [x.id, x.value]));
  for (const i of r.items) {
    for (const s of i.source_fact_ids) if (!byId.has(s)) f.push({ code: "COPY_FACT_UNKNOWN", item: i.id, detail: s });
    if (i.claim_type === "fact") {
      if (!i.source_fact_ids.length) f.push({ code: "FACT_WITHOUT_SOURCE", item: i.id });
      // the text carries one of its facts' values as written, or is a part of one (the name alone, one sentence of a
      // description); a label may stand beside it. Nothing else may be added to a fact.
      else if (!i.source_fact_ids.some((s) => byId.has(s) && (norm(i.text).includes(norm(byId.get(s)!)) || (norm(i.text).length >= 2 && norm(byId.get(s)!).includes(norm(i.text))))))
        f.push({ code: "FACT_TEXT_NOT_FROM_FACTS", item: i.id });
    } else {
      if (i.label) f.push({ code: "LABEL_ON_NON_FACT", item: i.id });
      if (!i.owner_review_needed) f.push({ code: "CREATIVE_WITHOUT_OWNER_REVIEW", item: i.id });
      if (i.claim_type === "creative_expression" && r.lane !== "quality_research_fictional") f.push({ code: "CREATIVE_OUTSIDE_RESEARCH_LANE", item: i.id });
      for (const [sign, re] of INVENTED_FACT_SIGNS) if (re.test(i.text)) f.push({ code: "CREATIVE_LOOKS_LIKE_FACT", item: i.id, detail: sign });
    }
  }
  return { ok: f.length === 0, findings: f };
}

/** Every visible text of a page, normalised; the page may show only the record's texts and labels. */
export function textsNotInRecord(pageTexts: readonly string[], r: CopyRecord): string[] {
  const allowed = new Set(r.items.flatMap((i) => [norm(i.text), ...(i.label ? [norm(i.label)] : [])]));
  return [...new Set(pageTexts.map(norm).filter((t) => t.length > 0 && !allowed.has(t)))];
}
