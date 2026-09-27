import type { DemoView } from "@/lib/sales/demo-content";

// The shop-information rows a template may show. Only verified values;
// rows without a value are left out (never filled with a placeholder).

export type InfoRow = { key: "hours" | "closedDays" | "address" | "access" | "phone"; label: string; value: string };

export function infoRows(demo: DemoView): InfoRow[] {
  const rows: Array<[InfoRow["key"], string, string | null]> = [
    ["hours", "営業時間", demo.hours],
    ["closedDays", "定休日", demo.closedDays],
    ["address", "住所", demo.address],
    ["access", "アクセス", demo.access],
    ["phone", "電話", demo.phone],
  ];
  return rows.filter((r): r is [InfoRow["key"], string, string] => r[2] !== null).map(([key, label, value]) => ({ key, label, value }));
}

export function areaLabel(demo: DemoView, category: string): string {
  return `${demo.ward ? `名古屋市${demo.ward}の` : "名古屋の"}${category}`;
}
