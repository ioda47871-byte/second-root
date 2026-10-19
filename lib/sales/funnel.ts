import { addDays, jstDate } from "@/lib/sales/dates";
import { DESIGN_STATUSES, type DesignStatus } from "@/lib/sales/design";
import { rate } from "@/lib/sales/metrics";
import { REPLY_TYPES, type ReplyType } from "@/lib/sales/types";

// DEV-057: one sales funnel from preparation to won (MVP_SPEC §9). The
// counts per Asia/Tokyo preparation day come from the sales_funnel_daily /
// sales_design_daily SQL views; this sums a period and derives rates in plain
// code. No AI.

export const FUNNEL_PERIODS = ["30d", "all"] as const;
export type FunnelPeriod = (typeof FUNNEL_PERIODS)[number];
export const DEFAULT_FUNNEL_PERIOD: FunnelPeriod = "30d";
export const FUNNEL_PERIOD_LABEL: Record<FunnelPeriod, string> = { "30d": "直近 30 日", all: "全期間" };
/** 直近 30 日 = today (JST) and the 29 days before it. */
export const RECENT_DAYS = 30;

/** ?period=… → a known period; anything else (missing, repeated, unknown) is the default. */
export function parseFunnelPeriod(raw: unknown): FunnelPeriod {
  return typeof raw === "string" && (FUNNEL_PERIODS as readonly string[]).includes(raw) ? (raw as FunnelPeriod) : DEFAULT_FUNNEL_PERIOD;
}

/** The first JST preparation day (YYYY-MM-DD) in the period, or null for 全期間. */
export function periodSince(period: FunnelPeriod, now: Date): string | null {
  return period === "all" ? null : jstDate(addDays(now, -(RECENT_DAYS - 1)));
}

export type FunnelDay = {
  preparedOn: string;
  prepared: number;
  skipped: number;
  unsent: number;
  sent: number;
  replied: number;
  meetings: number;
  won: number;
  wonAmountJpy: number;
  replies: Record<ReplyType, number>;
  dnc: number;
};

export type FunnelTotals = Omit<FunnelDay, "preparedOn">;

const inPeriod = (preparedOn: string, since: string | null) => since === null || preparedOn >= since;

export function emptyFunnel(): FunnelTotals {
  return {
    prepared: 0,
    skipped: 0,
    unsent: 0,
    sent: 0,
    replied: 0,
    meetings: 0,
    won: 0,
    wonAmountJpy: 0,
    replies: Object.fromEntries(REPLY_TYPES.map((t) => [t, 0])) as Record<ReplyType, number>,
    dnc: 0,
  };
}

export function sumFunnel(days: FunnelDay[], since: string | null): FunnelTotals {
  const total = emptyFunnel();
  for (const day of days) {
    if (!inPeriod(day.preparedOn, since)) continue;
    total.prepared += day.prepared;
    total.skipped += day.skipped;
    total.unsent += day.unsent;
    total.sent += day.sent;
    total.replied += day.replied;
    total.meetings += day.meetings;
    total.won += day.won;
    total.wonAmountJpy += day.wonAmountJpy;
    total.dnc += day.dnc;
    for (const t of REPLY_TYPES) total.replies[t] += day.replies[t];
  }
  return total;
}

export type FunnelStage = {
  key: "prepared" | "skipped" | "sent" | "replied" | "meetings" | "won";
  label: string;
  count: number;
  /** The stage the rate is taken against; null for the first stage. */
  base: FunnelStage["key"] | null;
  rate: string | null;
};

/**
 * The stages in order. 見送り is a branch out of 準備 (closed before
 * sending), so both 見送り and 送信 are rated against 準備; every later stage
 * against the stage just before it.
 */
export function funnelStages(t: FunnelTotals): FunnelStage[] {
  const stage = (key: FunnelStage["key"], label: string, count: number, base: FunnelStage["key"] | null, of: number | null): FunnelStage => ({
    key,
    label,
    count,
    base,
    rate: of === null ? null : rate(count, of),
  });
  return [
    stage("prepared", "準備", t.prepared, null, null),
    stage("skipped", "見送り", t.skipped, "prepared", t.prepared),
    stage("sent", "送信", t.sent, "prepared", t.prepared),
    stage("replied", "返信", t.replied, "sent", t.sent),
    stage("meetings", "商談", t.meetings, "replied", t.replied),
    stage("won", "成約", t.won, "meetings", t.meetings),
  ];
}

export const REPLY_TYPE_LABEL: Record<ReplyType, string> = {
  interested: "興味あり",
  question: "質問",
  meeting_request: "商談希望",
  decline: "断り",
  other: "その他",
};

export type DesignDay = { preparedOn: string; status: DesignStatus; errorCode: string | null; demos: number };
export type DesignTotals = { total: number; byStatus: Record<DesignStatus, number>; topErrors: Array<{ code: string; count: number }> };

/** AI design results of the period's demos, and the most frequent blocked / failed codes. */
export function sumDesign(days: DesignDay[], since: string | null, topN = 3): DesignTotals {
  const byStatus = Object.fromEntries(DESIGN_STATUSES.map((s) => [s, 0])) as Record<DesignStatus, number>;
  const errors = new Map<string, number>();
  let total = 0;
  for (const day of days) {
    if (!inPeriod(day.preparedOn, since)) continue;
    total += day.demos;
    byStatus[day.status] += day.demos;
    if (day.errorCode && (day.status === "blocked" || day.status === "failed")) {
      errors.set(day.errorCode, (errors.get(day.errorCode) ?? 0) + day.demos);
    }
  }
  const topErrors = [...errors]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
    .slice(0, topN);
  return { total, byStatus, topErrors };
}
