/**
 * Owner decision 2026-11-26: prices stay free text, with NO automatic tax calculation; the owner gets a check of the
 * consumer-facing tax-inclusive total price display (総額表示). This is that check. It READS the price texts and
 * reports; it never rewrites a price, never computes one and never stops a build (advice for the owner and the shop).
 *
 * Each price text (an item's priceDisplay, and each size's when the shop uses sizes) is put in one class:
 *   tax_included       SHOWS a tax-inclusive amount: 税込 / 税込み / 内税 / 総額 right before an amount
 *                      (「税込1,080円」「総額 550円」), or （税込）/（込）/ 税込 right after an amount (「324円（税込）」)
 *   tax_excluded_only  names a tax-exclusive price (税別 / 税抜 / 外税 / +税 / +tax) and shows no tax-inclusive amount —
 *                      a 総額表示 problem the owner should take up with the shop
 *   no_tax_wording     has an amount but says nothing about tax: it may already be the total (the law does not
 *                      require the word 税込), so the owner confirms with the shop
 *   no_amount          no amount (時価, 店頭にて, お問い合わせください) — nothing to check
 *   empty              no price shown
 * 込み alone (送料込み, 申込み, サービス料込み) and a bare 総額 / 税込 that is not attached to an amount
 * (「総額表示は店頭で」「税込価格は店頭で」) do not count. The rules are wording heuristics, not a legal judgement.
 */
import type { Category, MenuItem } from "./content-model";

export type PriceClass = "tax_included" | "tax_excluded_only" | "no_tax_wording" | "no_amount" | "empty";

/** An amount: digits (half- or full-width, with separators) with ¥ before or 円 after, or kanji numerals with 円. */
const AMOUNT = String.raw`(?:[¥￥]\s*[0-9０-９][0-9０-９,，.．]*|[0-9０-９][0-9０-９,，.．]*\s*円|[0-9０-９][0-9０-９,，]*|[〇一二三四五六七八九十百千万壱弐参]+\s*円)`;
const HAS_AMOUNT = new RegExp(AMOUNT);
/** A tax-inclusive amount actually shown. */
const INCLUDED_SHOWN = [
  new RegExp(String.raw`(?:税込み?|内税|総額)\s*[:：]?\s*${AMOUNT}`),
  new RegExp(String.raw`${AMOUNT}\s*[（(]\s*(?:税込み?|内税|込)\s*[）)]`),
  new RegExp(String.raw`${AMOUNT}\s*(?:税込み?|内税)`),
];
const EXCLUDED = /税別|税抜き?|外税|[+＋]\s*(?:税|tax)|税\s*[+＋]|plus\s*tax|tax\s*excl/i;

export function classifyPrice(text: string): PriceClass {
  const t = text.trim();
  if (t === "") return "empty";
  if (!HAS_AMOUNT.test(t)) return "no_amount";
  if (INCLUDED_SHOWN.some((r) => r.test(t))) return "tax_included";
  if (EXCLUDED.test(t)) return "tax_excluded_only";
  return "no_tax_wording";
}

export type PriceFinding = { item: string; name: string; field: string; text: string; class: PriceClass };
export type PriceReport = { status: "ok" | "owner_check"; counts: Record<PriceClass, number>; findings: PriceFinding[] };

/**
 * The 総額表示 report over what the page shows (review L3: as content-model.ts viewOf — visible items in visible
 * categories). Advice only.
 */
export function priceDisplayReport(content: { categories: readonly Category[]; menu: readonly MenuItem[] }): PriceReport {
  const counts: Record<PriceClass, number> = { tax_included: 0, tax_excluded_only: 0, no_tax_wording: 0, no_amount: 0, empty: 0 };
  const findings: PriceFinding[] = [];
  const shownCategories = new Set(content.categories.filter((c) => c.visible).map((c) => c.id));
  const look = (m: MenuItem, field: string, text: string) => {
    const c = classifyPrice(text);
    counts[c]++;
    if (c === "tax_excluded_only" || c === "no_tax_wording") findings.push({ item: m.id, name: m.name, field, text, class: c });
  };
  for (const m of content.menu.filter((x) => x.visible && shownCategories.has(x.category))) {
    look(m, "priceDisplay", m.priceDisplay);
    for (const [n, s] of (m.sizes ?? []).entries()) look(m, `sizes.${n}.priceDisplay`, s.priceDisplay);
  }
  return { status: findings.length ? "owner_check" : "ok", counts, findings };
}
