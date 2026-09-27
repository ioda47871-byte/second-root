// Funnel metrics per sales condition (MVP_SPEC §9). Counts come from the
// sales_metrics SQL view; this only derives rates and labels. No AI.

export type MetricRow = {
  dimension: "channel" | "category" | "website_status" | "follow_up" | "total";
  value: string;
  sent: number;
  replied: number;
  meetings: number;
  won: number;
  wonAmountJpy: number;
};

export function rate(numerator: number, denominator: number): string {
  if (denominator === 0) return "-";
  return `${Math.round((numerator / denominator) * 100)}%`;
}

const VALUE_LABEL: Record<string, string> = {
  instagram: "Instagram",
  email: "メール",
  bakery: "パン屋",
  baked_goods: "焼菓子店",
  cafe: "カフェ",
  present: "サイトあり",
  not_found: "サイトなし",
  unknown: "サイト不明",
  yes: "フォローあり",
  no: "フォローなし",
  all: "合計",
};

export const DIMENSION_LABEL: Record<MetricRow["dimension"], string> = {
  total: "全体",
  channel: "チャネル",
  category: "業種",
  website_status: "公式サイト",
  follow_up: "5日後フォロー",
};

export function valueLabel(value: string): string {
  return VALUE_LABEL[value] ?? value;
}

export function groupMetrics(rows: MetricRow[]): Array<{ dimension: MetricRow["dimension"]; rows: MetricRow[] }> {
  const order: MetricRow["dimension"][] = ["total", "channel", "category", "website_status", "follow_up"];
  return order
    .map((dimension) => ({ dimension, rows: rows.filter((r) => r.dimension === dimension).sort((a, b) => b.sent - a.sent) }))
    .filter((g) => g.rows.length > 0);
}

export function formatYen(amount: number): string {
  return `¥${amount.toLocaleString("ja-JP")}`;
}
