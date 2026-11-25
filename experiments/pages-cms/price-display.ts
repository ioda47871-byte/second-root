/**
 * Owner decision 2026-11-26: prices stay free text, with NO automatic tax calculation; the owner gets a check of the
 * consumer-facing tax-inclusive total price display (総額表示). This is that check. It READS the price texts and
 * reports; it never rewrites a price, never computes one and never stops a build (advice for the owner and the shop).
 *
 * Each price text (an item's priceDisplay, and each size's when the shop uses sizes) is put in one class:
 *   tax_included       names a tax-inclusive total (税込 / 税込み / 内税 / 総額 / 込み) — fine
 *   tax_excluded_only  names only a tax-exclusive price (税別 / 税抜 / 外税 / +税) with no tax-inclusive total —
 *                      a 総額表示 problem the owner should take up with the shop
 *   no_tax_wording     has an amount but says nothing about tax: it may already be the total (the law does not
 *                      require the word 税込), so the owner confirms with the shop
 *   no_amount          no number (時価, 店頭にて, お問い合わせください) — nothing to check
 *   empty              no price shown
 * The rules are wording heuristics, not a legal judgement.
 */
import type { MenuItem } from "./content-model";

export type PriceClass = "tax_included" | "tax_excluded_only" | "no_tax_wording" | "no_amount" | "empty";
const INCLUDED = /税込|税込み|内税|総額|込み|込\)|込）/;
const EXCLUDED = /税別|税抜|税抜き|外税|[+＋]\s*税|税\s*[+＋]/;
const AMOUNT = /[0-9０-９]/;

export function classifyPrice(text: string): PriceClass {
  const t = text.trim();
  if (t === "") return "empty";
  if (!AMOUNT.test(t)) return "no_amount";
  if (INCLUDED.test(t)) return "tax_included";
  if (EXCLUDED.test(t)) return "tax_excluded_only";
  return "no_tax_wording";
}

export type PriceFinding = { item: string; name: string; field: string; text: string; class: PriceClass };
export type PriceReport = { status: "ok" | "owner_check"; counts: Record<PriceClass, number>; findings: PriceFinding[] };

/** The 総額表示 report over the visible items (hidden items are not shown, so not reported). Advice only. */
export function priceDisplayReport(menu: readonly MenuItem[]): PriceReport {
  const counts: Record<PriceClass, number> = { tax_included: 0, tax_excluded_only: 0, no_tax_wording: 0, no_amount: 0, empty: 0 };
  const findings: PriceFinding[] = [];
  const look = (m: MenuItem, field: string, text: string) => {
    const c = classifyPrice(text);
    counts[c]++;
    if (c === "tax_excluded_only" || c === "no_tax_wording") findings.push({ item: m.id, name: m.name, field, text, class: c });
  };
  for (const m of menu.filter((x) => x.visible)) {
    look(m, "priceDisplay", m.priceDisplay);
    for (const [n, s] of (m.sizes ?? []).entries()) look(m, `sizes.${n}.priceDisplay`, s.priceDisplay);
  }
  return { status: findings.length ? "owner_check" : "ok", counts, findings };
}
