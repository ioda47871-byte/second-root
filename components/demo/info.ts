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

/**
 * Approximate width of a shop name in em, so the hero can set it as large
 * as the column allows (CSS divides the column width by this). Full-width
 * characters are 1em; Latin letters, digits and spaces are narrower.
 */
export function nameUnits(name: string): number {
  const em = [...name].reduce((sum, ch) => {
    if (ch === " ") return sum + 0.3;
    if (/[A-Z0-9]/.test(ch)) return sum + 0.7;
    if (/[a-z]/.test(ch)) return sum + 0.56;
    if (/[\u0021-\u024f]/.test(ch)) return sum + 0.5;
    return sum + 1;
  }, 0);
  return Math.min(40, Math.max(3, Math.round(em * 1.06 * 10) / 10));
}

/** Inline custom property the hero headings size themselves from. */
export function nameStyle(name: string): CSSProperties {
  return { "--units": nameUnits(name) } as CSSProperties;
}

/** "01", "02", … for numbered lists (template ornament, not shop data). */
export function ordinal(index: number): string {
  return String(index + 1).padStart(2, "0");
}
