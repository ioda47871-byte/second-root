import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
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
