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

/** An amount: ¥ + digits, digits + 円, or kanji numerals + 円 (half- or full-width digits and separators). */
const AMOUNT_RE = /[¥￥]\s*[0-9０-９][0-9０-９,，.．]*(?:\s*円)?|[0-9０-９][0-9０-９,，.．]*\s*円|[〇一二三四五六七八九十百千万壱弐参]+\s*円/g;
/** A text that is only a number (「480」) is an amount too. */
const ONLY_NUMBER = /^[0-9０-９][0-9０-９,，]*$/;
const INCLUDED_BEFORE = /(?:税込み?(?:価格)?|内税|総額)\s*[:：]?\s*$/;
const INCLUDED_AFTER = /^\s*(?:[（(]\s*(?:税込み?(?:価格)?|内税|込|税[・･]?サ(?:ービス料)?込み?)\s*[）)]|税込み?|内税)/;
const EXCLUDED_AFTER = /^\s*(?:[（(]\s*)?(?:税別|税抜き?|外税|[+＋]\s*(?:税|tax)|plus\s*tax|tax\s*excl)/i;
const EXCLUDED_BEFORE = /(?:税別|税抜き?|外税)\s*[:：]?\s*$/;
const EXCLUDED_ANYWHERE = /税別|税抜き?|外税|[+＋]\s*(?:税|tax)|税\s*[+＋]|plus\s*tax|tax\s*excl/i;
/** What may stand between an amount and the included amount that pairs with it. */
const PAIR_GAP = /^[\s／/・、,，()（）〜~～\-ー:：|｜]*(?:(?:本体|税別|税抜き?|外税|税込み?(?:価格)?|内税|総額)[\s／/・、,，()（）〜~～\-ー:：|｜]*)*$/;

export type PriceAmount = { text: string; class: AmountClass };

/** Every amount in a price text, each with its own class. */
export function priceAmounts(text: string): PriceAmount[] {
  const t = text.trim();
  if (ONLY_NUMBER.test(t)) return [{ text: t, class: "bare" }];
  const found = [...t.matchAll(AMOUNT_RE)].map((m) => ({ text: m[0], start: m.index!, end: m.index! + m[0].length }));
  const classes: AmountClass[] = found.map((a) => {
    const before = t.slice(0, a.start);
    const after = t.slice(a.end);
    if (INCLUDED_BEFORE.test(before) || INCLUDED_AFTER.test(after)) return "included";
    if (EXCLUDED_AFTER.test(after) || EXCLUDED_BEFORE.test(before)) return "excluded";
    return "bare";
  });
  for (let i = found.length - 2; i >= 0; i--) {
    if (classes[i] === "included" || classes[i + 1] === undefined) continue;
    const next = classes[i + 1];
    if ((next === "included" || next === "paired") && PAIR_GAP.test(t.slice(found[i]!.end, found[i + 1]!.start))) classes[i] = "paired";
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
