/**
 * Owner decision 2026-11-26: prices stay free text, with NO automatic tax calculation; the owner gets a check of the
 * consumer-facing tax-inclusive total price display (総額表示). This is that check. It READS the price texts and
 * reports; it never rewrites a price, never computes one and never stops a build (advice for the owner and the shop).
 *
 * Every amount in a price text is looked at on its own (owner request 2026-11-26: 「S 400円（税込）/ M 500円（税別）」
 * must not pass because S does). An amount is:
 *   included  a tax-inclusive amount is shown for it: 税込 / 税込み / 税込価格 / 内税 / 総額 directly before it
 *             (「税込1,080円」「税込価格 1,080円」「総額 550円」), or （税込）/（税込価格）/（込）/（税・サ込）/ 税込 directly
 *             after it (「324円（税込）」「1,080円（税・サ込）」);
 *   paired    it is followed, with only tax words and punctuation between, by an included amount (「本体1,000円（税込1,080円）」
 *             「800円（税抜）／880円（税込）」「380円〜520円（税込）」): the total is shown next to it;
 *   excluded  税別 / 税抜 / 外税 / +税 / +tax right after it (or 税別・税抜・外税 right before it), or the text says so elsewhere;
 *   bare      none of these.
 * The text is
 *   tax_included       when every amount is included or paired;
 *   tax_excluded_only  when an amount that is neither is excluded — a 総額表示 problem the owner takes up with the shop;
 *   no_tax_wording     when such an amount says nothing about tax (it may already be the total; the law does not
 *                      require the word 税込), so the owner confirms with the shop;
 *   no_amount          when there is no amount (時価, 店頭にて) — nothing to check; empty when nothing is shown.
 * 込み alone (送料込み, 申込み, サービス料込み) and a 総額 / 税込 not attached to an amount (「総額表示は店頭で」「税込価格は
 * 店頭で」「総額 3点で1,000円（税別）」) do not count. Wording heuristics, not a legal judgement.
 */
import type { Category, MenuItem } from "./content-model";

export type PriceClass = "tax_included" | "tax_excluded_only" | "no_tax_wording" | "no_amount" | "empty";
type AmountClass = "included" | "paired" | "excluded" | "bare";

/** A strong amount: ¥ + digits, digits + 円, or kanji numerals + 円 (half- or full-width digits and separators). */
const STRONG_RE = /[¥￥]\s*[0-9０-９][0-9０-９,，.．]*(?:\s*円)?|[0-9０-９][0-9０-９,，.．]*\s*円|[〇一二三四五六七八九十百千万壱弐参]+\s*円/g;
/** A digit run (review #360 M1: 「1,000（税別）」「S 400 / M 500（税別）」「400 / 500」 carry amounts without 円). */
const DIGITS_RE = /[0-9０-９][0-9０-９,，.．]*/g;
/** A digit run followed by one of these is a count, a size or a date, not a price (「3点」「10個」「2026年」). */
const COUNTER_AFTER = /^\s*(?:点|個|枚|本|名|人|組|品|種|切|入|g|ｇ|kg|ml|ｍｌ|cc|cm|mm|年|月|日|時|分|歳|%|％|号|番|階|丁目|番地|cal|kcal)/i;
/** A text that is only numbers, separators, size labels and tax words is a list of amounts (「400 / 500」「S 400 / M 500（税別）」). */
const ONLY_AMOUNTS = /^(?:[\s0-9０-９,，.．/／・、〜~～\-()（）:：|｜+＋]|[A-Za-zＡ-Ｚａ-ｚ]{1,3}(?![A-Za-z])|[大中小並特]|税込み?|税抜き?|税別|外税|内税|本体|tax|サイズ)+$/i;
const NUM = String.raw`(?:[¥￥]\s*)?[0-9０-９〇一二三四五六七八九十百千万壱弐参]`;
const INCLUDED_BEFORE = /(?:税込み?(?:価格)?|内税|総額)\s*[:：]?\s*$/;
/**
 * Directly after the amount: （税込）/（税込価格）/（込）/（税・サ込）, or 税込 / 内税 not followed by more words (review L1:
 * 「500円 税込価格は店頭で」 is not a tax-inclusive amount), or — review #360 M2 — a bracket naming the tax-exclusive
 * base price with its amount (「1,080円（税抜1,000円）」: the 1,080円 is the total).
 */
const INCLUDED_AFTER = new RegExp(String.raw`^\s*(?:[（(]\s*(?:税込み?(?:価格)?|内税|込|税[・･]?サ(?:ービス料)?込み?)\s*[）)]|(?:税込み?|内税)(?![価はがをのでもにと])|[（(]\s*(?:税抜き?|税別|本体)\s*[:：]?\s*${NUM})`);
/** Directly after: 税別 / 税抜 / 外税 (unless an amount follows: that is the base price of the amount before) / +税 / +tax. */
const EXCLUDED_AFTER = new RegExp(String.raw`^\s*(?:[（(]\s*)?(?:(?:税別|税抜き?|外税)(?!\s*[:：]?\s*${NUM})|[+＋]\s*(?:税|tax)|plus\s*tax|tax\s*excl)`, "i");
const EXCLUDED_BEFORE = /(?:税別|税抜き?|外税|本体)\s*[:：]?\s*$/;
const EXCLUDED_ANYWHERE = /税別|税抜き?|外税|[+＋]\s*(?:税|tax)|税\s*[+＋]|plus\s*tax|tax\s*excl/i;
const GAP_CHARS = String.raw`[\s／/・、,，()（）〜~～\-ー:：|｜]`;
const GAP_WORDS = String.raw`(?:本体|税別|税抜き?|外税|税込み?(?:価格)?|内税|総額|[+＋]\s*(?:税|tax))`;
/** What may stand between an amount and the included amount after it that pairs with it (「1,000円+税（税込1,100円）」). */
const PAIR_GAP = new RegExp(String.raw`^${GAP_CHARS}*(?:${GAP_WORDS}${GAP_CHARS}*)*$`, "i");
/**
 * Review #360 M2: the total written first — 「税込1,080円（本体1,000円）」「1,080円（税込）本体1,000円」「1,080円（税抜1,000円）」:
 * an amount labelled as the base price right after an included amount pairs with it backwards.
 */
const PAIR_GAP_BACK = new RegExp(String.raw`^${GAP_CHARS}*(?:${GAP_WORDS}${GAP_CHARS}*)*(?:本体|税抜き?|税別)\s*[:：]?\s*$`);

export type PriceAmount = { text: string; class: AmountClass };

/** Every amount in a price text, each with its own class. */
export function priceAmounts(text: string): PriceAmount[] {
  const t = text.trim();
  const strong = [...t.matchAll(STRONG_RE)].map((m) => ({ text: m[0], start: m.index!, end: m.index! + m[0].length }));
  const inStrong = (i: number) => strong.some((a) => i >= a.start && i < a.end);
  const listOnly = ONLY_AMOUNTS.test(t);
  const weak = [...t.matchAll(DIGITS_RE)]
    .map((m) => ({ text: m[0], start: m.index!, end: m.index! + m[0].length }))
    .filter((a) => !inStrong(a.start) && !COUNTER_AFTER.test(t.slice(a.end)))
    .filter((a) => {
      if (listOnly) return true;
      const before = t.slice(0, a.start);
      const after = t.slice(a.end);
      // a digit run counts when a tax word is directly next to it
      return INCLUDED_BEFORE.test(before) || INCLUDED_AFTER.test(after) || EXCLUDED_AFTER.test(after) || EXCLUDED_BEFORE.test(before);
    });
  const found = [...strong, ...weak].sort((a, b) => a.start - b.start);
  const classes: AmountClass[] = found.map((a) => {
    const before = t.slice(0, a.start);
    const after = t.slice(a.end);
    if (INCLUDED_BEFORE.test(before) || INCLUDED_AFTER.test(after)) return "included";
    if (EXCLUDED_AFTER.test(after) || EXCLUDED_BEFORE.test(before)) return "excluded";
    return "bare";
  });
  for (let i = found.length - 2; i >= 0; i--) {
    if (classes[i] === "included") continue;
    const next = classes[i + 1];
    if ((next === "included" || next === "paired") && PAIR_GAP.test(t.slice(found[i]!.end, found[i + 1]!.start))) classes[i] = "paired";
  }
  for (let i = 1; i < found.length; i++) {
    if (classes[i] === "included" || classes[i] === "paired") continue;
    if (classes[i - 1] === "included" && PAIR_GAP_BACK.test(t.slice(found[i - 1]!.end, found[i]!.start))) classes[i] = "paired";
  }
  const excludedText = EXCLUDED_ANYWHERE.test(t);
  return found.map((a, n) => ({ text: a.text.trim(), class: classes[n] === "bare" && excludedText ? "excluded" : classes[n]! }));
}

export function classifyPrice(text: string): PriceClass {
  const t = text.trim();
  if (t === "") return "empty";
  const amounts = priceAmounts(t);
  if (amounts.length === 0) return "no_amount";
  const open = amounts.filter((a) => a.class !== "included" && a.class !== "paired");
  if (open.length === 0) return "tax_included";
  return open.some((a) => a.class === "excluded") ? "tax_excluded_only" : "no_tax_wording";
}

export type PriceFinding = { item: string; name: string; field: string; text: string; class: PriceClass; amounts: string[] };
export type PriceReport = { status: "ok" | "owner_check"; counts: Record<PriceClass, number>; findings: PriceFinding[] };

/**
 * The 総額表示 report over what the page shows (as content-model.ts viewOf — visible items in visible categories).
 * Each finding names the amounts that are not shown tax-inclusive. Advice only.
 */
export function priceDisplayReport(content: { categories: readonly Category[]; menu: readonly MenuItem[] }): PriceReport {
  const counts: Record<PriceClass, number> = { tax_included: 0, tax_excluded_only: 0, no_tax_wording: 0, no_amount: 0, empty: 0 };
  const findings: PriceFinding[] = [];
  const shownCategories = new Set(content.categories.filter((c) => c.visible).map((c) => c.id));
  const look = (m: MenuItem, field: string, text: string) => {
    const c = classifyPrice(text);
    counts[c]++;
    if (c === "tax_excluded_only" || c === "no_tax_wording")
      findings.push({ item: m.id, name: m.name, field, text, class: c, amounts: priceAmounts(text).filter((a) => a.class === "excluded" || a.class === "bare").map((a) => a.text) });
  };
  for (const m of content.menu.filter((x) => x.visible && shownCategories.has(x.category))) {
    look(m, "priceDisplay", m.priceDisplay);
    for (const [n, s] of (m.sizes ?? []).entries()) look(m, `sizes.${n}.priceDisplay`, s.priceDisplay);
  }
  return { status: findings.length ? "owner_check" : "ok", counts, findings };
}
