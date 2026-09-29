import type { CSSProperties } from "react";
import { CATEGORY_LABEL, type DemoView } from "@/lib/sales/demo-content";
import type { Category } from "@/lib/sales/types";

// The shop-information rows a template may show. Only verified values;
// rows without a value are left out (never filled with a placeholder).

export type InfoRow = { key: "hours" | "closedDays" | "address" | "access" | "phone"; label: string; en: string; value: string };

export function infoRows(demo: DemoView): InfoRow[] {
  const rows: Array<[InfoRow["key"], string, string, string | null]> = [
    ["hours", "営業時間", "Hours", demo.hours],
    ["closedDays", "定休日", "Closed", demo.closedDays],
    ["address", "住所", "Address", demo.address],
    ["access", "アクセス", "Access", demo.access],
    ["phone", "電話", "Tel", demo.phone],
  ];
  return rows
    .filter((r): r is [InfoRow["key"], string, string, string] => r[3] !== null)
    .map(([key, label, en, value]) => ({ key, label, en, value }));
}

/** "名古屋市中区のパン屋" — built only from the verified ward and category. */
export function areaLabel(demo: DemoView): string {
  return `${areaName(demo)}の${CATEGORY_LABEL[demo.category]}`;
}

/** "名古屋市中区", or just "名古屋" when the ward was not verified. */
export function areaName(demo: DemoView): string {
  return demo.ward ? `名古屋市${demo.ward}` : "名古屋";
}

/** Decorative English form of the verified category (a translation, not a claim). */
export const CATEGORY_EN: Record<Category, string> = {
  bakery: "Bakery",
  baked_goods: "Baked Goods",
  cafe: "Cafe",
};

/** Approximate width of a text in em (full-width 1em, Latin narrower). */
function emWidth(text: string): number {
  return [...text].reduce((sum, ch) => {
    if (ch === " ") return sum + 0.3;
    if (/[A-Z0-9]/.test(ch)) return sum + 0.7;
    if (/[a-z]/.test(ch)) return sum + 0.56;
    if (/[\u0021-\u024f]/.test(ch)) return sum + 0.5;
    return sum + 1;
  }, 0);
}

const clampUnits = (em: number) => Math.min(40, Math.max(3, Math.round(em * 1.06 * 10) / 10));

/**
 * Approximate width of a shop name in em, so the hero can set it as large
 * as the column allows (CSS divides the column width by this).
 */
export function nameUnits(name: string): number {
  return clampUnits(emWidth(name));
}

/**
 * Inline custom properties the hero headings size themselves from:
 * --units (whole name on one line) and --word-units (its longest word,
 * which must never be split when the name wraps onto two lines).
 */
export function nameStyle(name: string): CSSProperties {
  const words = name.trim().split(/\s+/);
  // Unspaced Japanese names break at phrase boundaries (word-break:
  // auto-phrase), so allow a line of about 60% of the name.
  const longestWord = words.length === 1 && /[^\u0000-\u024f]/.test(name) ? emWidth(name) * 0.6 : Math.max(...words.map(emWidth));
  return { "--units": nameUnits(name), "--word-units": clampUnits(longestWord) } as CSSProperties;
}

/** "01", "02", … for numbered lists (template ornament, not shop data). */
export function ordinal(index: number): string {
  return String(index + 1).padStart(2, "0");
}

/**
 * Up to two letters drawn from the shop name itself, for a typographic
 * monogram: the initials of the first two Latin words ("EXAMPLE TEST" → "ET"),
 * the initial of a single Latin word, or the first character of a Japanese
 * name. Never anything that is not already in the name.
 */
export function monogram(name: string): string {
  const words = name.split(/[\s・･·.\-_/&+]+/).filter(Boolean);
  const latin = words.filter((w) => /^[A-Za-z0-9]/.test(w));
  if (latin.length >= 2 && latin[0] === words[0]) return (latin[0][0] + latin[1][0]).toUpperCase();
  const first = [...name.trim()][0] ?? "";
  return /[a-z]/.test(first) ? first.toUpperCase() : first;
}
