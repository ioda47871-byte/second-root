/**
 * DEV-159 (Issue #193 comment 6591440695, task T5 approved with conditions): the words a comp may show, each with
 * where it comes from.
 *
 *   fact                     the shop's fact, as the facts pack gives it: the whole value, one or more whole
 *                            consecutive sentences of it (split at 。), or one whole space-separated part (the
 *                            name alone). Nothing may be added or cut mid-sentence. A `label` from LABELS_BY_KEY
 *                            for that fact's key may introduce it (所在地 for the address).
 *   creative_expression      original brand copy (tagline, metaphor, section heading). Allowed only in the
 *                            quality-first research lane, on fictional shops; always needs the owner's review.
 *   proposal_pending_review  copy proposed for a real shop; never shown as the shop's own words until reviewed.
 *
 * Creative copy must not invent facts: an address, hours, prices, ingredients, certification, health or efficacy,
 * history, people, reputation, awards, menus, reservation or stock, customer voices. The check below refuses the
 * plain signs of those (digits, money, dates, history, people, ingredients, menus, superlatives, awards, safety and
 * efficacy, reservation and stock, customer voices); it is a tripwire, not a fact checker, and the owner's review
 * still decides.
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
  /** For facts only: a short label shown with the value, from LABELS_BY_KEY for the fact it introduces. */
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

/** The labels a fact may carry, by the fact's key (a label is shown on the page, so it is not free text). */
export const LABELS_BY_KEY: Readonly<Record<string, readonly string[]>> = {
  name: ["店名"],
  address: ["所在地", "住所"],
  hours: ["時間", "営業時間"],
  closed_days: ["定休", "定休日"],
  access: ["道順", "アクセス"],
  phone: ["電話", "電話番号"],
};

/** The plain signs of an invented fact in a creative line, by the owner's categories (Issue #193). */
export const INVENTED_FACT_SIGNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["number", /[0-9０-９]|[一二三四五六七八九十百千万]+(年|代|世紀|周年|人)|半世紀/],
  ["money_or_menu", /[¥￥円]|価格|値段|料金|税込|税別|無料|割引|半額|メニュー|コース|セット/],
  ["hours_or_date", /営業時間|[0-9０-９]+時|曜日|無休|[0-9０-９]+年|月[0-9０-９一二三四五六七八九十]|日[0-9０-９]/],
  ["history", /創業|老舗|伝統|歴史|由来|代々|受け継|代目|ゆかり|明治|大正|昭和|平成|令和|江戸|から続く/],
  ["people", /職人|店主|師匠|親方|代表者|オーナー|スタッフ|先生|匠|名工|熟練/],
  ["ingredients", /原材料|素材(?!感)|本漆|純金|金粉|産地|国産|天然|無添加|オーガニック/],
  ["award_or_certification", /受賞|表彰|認定|認証|公認|資格|ミシュラン|グランプリ|金賞|特許|掲載|紹介され|メディア|テレビ|雑誌/],
  ["superlative_or_reputation", /日本一|世界一|No\.?1|ナンバーワン|唯一|最高|一流|人気|評判|話題|満足度|口コミ|好評|愛され|行列/],
  ["customer_voice", /お客様|お客さま|レビュー|感想|声が/],
  ["health_or_safety_or_guarantee", /効果|効能|健康|治る|改善|安全|安心|保証|一生もの|二度と/],
  ["reservation_or_stock", /予約|在庫|限定|残りわずか|即日|配送|注文|発送/],
];

export type CopyFinding = { code: string; item?: string; detail?: string };

const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, "");

/** What a fact item may show of a value: all of it, whole consecutive sentences (split at 。), or one whole space-separated part. */
export function factParts(value: string): Set<string> {
  // whole words only for a value without sentences (the name), split at ASCII spaces only, so a sentence cannot be
  // cut at a full-width space into a fragment that reverses it
  const out = new Set<string>([norm(value)]);
  const sentences = value.split(/(?<=。)/).map((x) => x.trim()).filter(Boolean);
  for (let i = 0; i < sentences.length; i++)
    for (let j = i + 1; j <= sentences.length; j++) {
      const run = sentences.slice(i, j).join("");
      out.add(norm(run));
      out.add(norm(run.replace(/。$/, "")));
    }
  if (!value.includes("。")) for (const part of value.split(/ +/).filter(Boolean)) out.add(norm(part));
  return out;
}

/** The record against the shop's facts (ids, values, SHA and shop). */
export function checkCopyRecord(raw: unknown, o: { shopId: string; factsSha256: string; facts: ReadonlyArray<{ id: string; key?: string; value: string }> }): { ok: boolean; findings: CopyFinding[] } {
  const parsed = CopyRecord.safeParse(raw);
  if (!parsed.success) return { ok: false, findings: [{ code: "COPY_SCHEMA", detail: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }] };
  const r = parsed.data;
  const f: CopyFinding[] = [];
  if (r.shop_id !== o.shopId) f.push({ code: "COPY_SHOP_MISMATCH" });
  // the research lane is for fictional shops only (owner, Issue #193 comment 6591440695): the facts pack must say so
  if (r.lane === "quality_research_fictional" && !isFictionalShop(o)) f.push({ code: "COPY_LANE_NOT_FICTIONAL" });
  if (r.facts_sha256 !== o.factsSha256) f.push({ code: "COPY_FACTS_SHA_MISMATCH" });
  const ids = r.items.map((i) => i.id);
  if (new Set(ids).size !== ids.length) f.push({ code: "COPY_IDS_DUPLICATED" });
  const byId = new Map(o.facts.map((x) => [x.id, x.value]));
  for (const i of r.items) {
    // a soft hyphen is invisible but can show any hyphenation character (CSS hyphenate-character)
    if (/\u00ad/.test(i.text) || (i.label && /\u00ad/.test(i.label))) f.push({ code: "COPY_SOFT_HYPHEN", item: i.id });
    // bidi controls reorder what is drawn: a creative line reversed could show a word the record does not hold
    if (BIDI.test(i.text) || (i.label && BIDI.test(i.label))) f.push({ code: "COPY_BIDI_CONTROL", item: i.id });
    for (const s of i.source_fact_ids) if (!byId.has(s)) f.push({ code: "COPY_FACT_UNKNOWN", item: i.id, detail: s });
    if (i.claim_type === "fact") {
      if (!i.source_fact_ids.length) f.push({ code: "FACT_WITHOUT_SOURCE", item: i.id });
      else if (!i.source_fact_ids.some((s) => byId.has(s) && factParts(byId.get(s)!).has(norm(i.text)))) f.push({ code: "FACT_TEXT_NOT_FROM_FACTS", item: i.id });
      // a label belongs to the fact it introduces: 所在地 to the address, 電話 to the phone
      const keys = o.facts.filter((x) => i.source_fact_ids.includes(x.id) && factParts(x.value).has(norm(i.text))).map((x) => x.key ?? "");
      if (i.label && !keys.some((k) => (LABELS_BY_KEY[k] ?? []).includes(i.label!))) f.push({ code: "LABEL_NOT_ALLOWED", item: i.id, detail: i.label });
    } else {
      if (i.label) f.push({ code: "LABEL_ON_NON_FACT", item: i.id });
      if (!i.owner_review_needed) f.push({ code: "CREATIVE_WITHOUT_OWNER_REVIEW", item: i.id });
      if (i.claim_type === "creative_expression" && r.lane !== "quality_research_fictional") f.push({ code: "CREATIVE_OUTSIDE_RESEARCH_LANE", item: i.id });
      for (const [sign, re] of INVENTED_FACT_SIGNS) if (re.test(i.text)) f.push({ code: "CREATIVE_LOOKS_LIKE_FACT", item: i.id, detail: sign });
    }
  }
  return { ok: f.length === 0, findings: f };
}

const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069\u061c]/;

/** A shop is fictional for the research lane when its id says so and its name fact starts with 架空 (as in every research pack). */
export function isFictionalShop(o: { shopId: string; facts: ReadonlyArray<{ key?: string; value: string }> }): boolean {
  return /^fictional-/.test(o.shopId) && o.facts.some((x) => x.key === "name" && x.value.trim().startsWith("架空"));
}

/**
 * The texts a reader sees together (each innermost block, spans joined) that look like an invented fact once the
 * record's facts and labels are taken out: two creative items side by side can spell what neither does alone.
 */
export function joinedTextsLookingLikeFact(blocks: readonly string[], r: CopyRecord): string[] {
  const facts = r.items.filter((i) => i.claim_type === "fact").flatMap((i) => [norm(i.text), ...(i.label ? [norm(i.label)] : [])]).filter(Boolean).sort((a, b) => b.length - a.length);
  const out: string[] = [];
  for (const b of blocks) {
    let t = norm(b);
    for (const x of facts) t = t.split(x).join("\u0000");
    if (INVENTED_FACT_SIGNS.some(([, re]) => t.split("\u0000").some((part) => re.test(part)))) out.push(b);
  }
  return [...new Set(out)];
}

/** Every visible text of a page, normalised; the page may show only the record's texts and labels. */
export function textsNotInRecord(pageTexts: readonly string[], r: CopyRecord): string[] {
  const allowed = new Set(r.items.flatMap((i) => [norm(i.text), ...(i.label ? [norm(i.label)] : [])]));
  return [...new Set(pageTexts.map(norm).filter((t) => t.length > 0 && !allowed.has(t)))];
}
