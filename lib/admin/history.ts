import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { aiDesignEnabled, isDesignStatus } from "@/lib/sales/design";
import { periodSince, sumDesign, sumFunnel, type DesignDay, type DesignTotals, type FunnelDay, type FunnelPeriod, type FunnelTotals } from "@/lib/sales/funnel";
import type { MetricRow } from "@/lib/sales/metrics";
import type { Category, Channel, OutreachStatus } from "@/lib/sales/types";

// 履歴 and metrics for the admin (session + RLS; nothing for non-admins).

export type HistoryItem = {
  prospectId: string;
  shopName: string;
  category: Category;
  channel: Channel;
  status: OutreachStatus;
  sentAt: string | null;
  closedAt: string | null;
  wonAmountJpy: number | null;
  doNotContact: boolean;
  createdAt: string;
};

type Row = {
  prospect_id: string;
  channel: Channel;
  status: OutreachStatus;
  sent_at: string | null;
  closed_at: string | null;
  won_amount_jpy: number | null;
  created_at: string;
  prospect: { name: string; category: Category; do_not_contact: boolean } | null;
};

export async function loadHistory(supabase: SupabaseClient, limit = 200): Promise<HistoryItem[]> {
  const { data, error } = await supabase
    .from("sales_outreaches")
    .select("prospect_id, channel, status, sent_at, closed_at, won_amount_jpy, created_at, prospect:sales_prospects!inner(name, category, do_not_contact)")
    .eq("kind", "initial")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error("history_unavailable");
  return ((data ?? []) as unknown as Row[]).map((r) => ({
    prospectId: r.prospect_id,
    shopName: r.prospect?.name ?? "",
    category: r.prospect?.category ?? "bakery",
    channel: r.channel,
    status: r.status,
    sentAt: r.sent_at,
    closedAt: r.closed_at,
    wonAmountJpy: r.won_amount_jpy,
    doNotContact: r.prospect?.do_not_contact ?? false,
    createdAt: r.created_at,
  }));
}

export async function loadMetrics(supabase: SupabaseClient): Promise<MetricRow[]> {
  const { data, error } = await supabase.from("sales_metrics").select("dimension, value, sent, replied, meetings, won, won_amount_jpy");
  if (error) throw new Error("metrics_unavailable");
  return (data ?? []).map((r) => ({
    dimension: r.dimension,
    value: r.value,
    sent: r.sent,
    replied: r.replied,
    meetings: r.meetings,
    won: r.won,
    wonAmountJpy: Number(r.won_amount_jpy),
  }));
}

/**
 * DEV-057: funnel counts per JST preparation day (sales_funnel_daily) from
 * `since` (YYYY-MM-DD) on, or every day for null. RLS: non-admins get none.
 */
export async function loadFunnel(supabase: SupabaseClient, since: string | null): Promise<FunnelDay[]> {
  let query = supabase
    .from("sales_funnel_daily")
    .select(
      "prepared_on, prepared, skipped, unsent, sent, replied, meetings, won, won_amount_jpy, reply_interested, reply_question, reply_meeting_request, reply_decline, reply_other, dnc",
    );
  if (since !== null) query = query.gte("prepared_on", since);
  const { data, error } = await query.order("prepared_on");
  if (error) throw new Error("funnel_unavailable");
  return (data ?? []).map((r) => ({
    preparedOn: String(r.prepared_on),
    prepared: r.prepared,
    skipped: r.skipped,
    unsent: r.unsent,
    sent: r.sent,
    replied: r.replied,
    meetings: r.meetings,
    won: r.won,
    wonAmountJpy: Number(r.won_amount_jpy),
    replies: {
      interested: r.reply_interested,
      question: r.reply_question,
      meeting_request: r.reply_meeting_request,
      decline: r.reply_decline,
      other: r.reply_other,
    },
    dnc: r.dnc,
  }));
}

/**
 * DEV-057: AI design results per JST preparation day (sales_design_daily).
 * Call it only with the AI design step on (the design columns are not read
 * otherwise, lib/sales/design.ts).
 */
export async function loadDesignOutcomes(supabase: SupabaseClient, since: string | null): Promise<DesignDay[]> {
  let query = supabase.from("sales_design_daily").select("prepared_on, design_status, design_error_code, demos");
  if (since !== null) query = query.gte("prepared_on", since);
  const { data, error } = await query.order("prepared_on");
  if (error) throw new Error("design_outcomes_unavailable");
  return (data ?? []).flatMap((r) =>
    isDesignStatus(r.design_status)
      ? [{ preparedOn: String(r.prepared_on), status: r.design_status, errorCode: typeof r.design_error_code === "string" ? r.design_error_code : null, demos: r.demos }]
      : [],
  );
}

/**
 * DEV-057: the 履歴 funnel section. Each part fails on its own so the page
 * still renders everything else: funnel null = sales_funnel_daily could not
 * be read; design null = the AI design step is off (nothing is read),
 * "unavailable" = sales_design_daily could not be read.
 */
export type FunnelSection = { funnel: FunnelTotals | null; design: DesignTotals | null | "unavailable" };

export async function loadFunnelSection(
  supabase: SupabaseClient,
  period: FunnelPeriod,
  now: Date = new Date(),
  designEnabled: boolean = aiDesignEnabled(),
): Promise<FunnelSection> {
  const since = periodSince(period, now);
  const [funnel, design] = await Promise.all([
    loadFunnel(supabase, since).then(
      (days) => sumFunnel(days, since),
      () => null,
    ),
    // Design columns are read only with the AI design step on (lib/sales/design.ts).
    designEnabled
      ? loadDesignOutcomes(supabase, since).then(
          (days) => sumDesign(days, since),
          () => "unavailable" as const,
        )
      : Promise.resolve(null),
  ]);
  return { funnel, design };
}
