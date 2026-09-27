import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Channel, OutreachStatus, ReplyType } from "@/lib/sales/types";

// Initial outreaches by stage, for the 返信 and 商談 tabs (admin session, RLS).

export type PipelineItem = {
  outreachId: string;
  prospectId: string;
  shopName: string;
  channel: Channel;
  status: OutreachStatus;
  replyType: ReplyType | null;
  sentAt: string | null;
  repliedAt: string | null;
  meetingAt: string | null;
  doNotContact: boolean;
};

type Row = {
  id: string;
  prospect_id: string;
  channel: Channel;
  status: OutreachStatus;
  reply_type: ReplyType | null;
  sent_at: string | null;
  replied_at: string | null;
  meeting_at: string | null;
  prospect: { name: string; do_not_contact: boolean } | null;
};

export async function loadPipeline(supabase: SupabaseClient, statuses: OutreachStatus[], limit = 100): Promise<PipelineItem[]> {
  const { data, error } = await supabase
    .from("sales_outreaches")
    .select("id, prospect_id, channel, status, reply_type, sent_at, replied_at, meeting_at, prospect:sales_prospects!inner(name, do_not_contact)")
    .eq("kind", "initial")
    .in("status", statuses)
    .order("sent_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error("pipeline_unavailable");
  return ((data ?? []) as unknown as Row[]).map((r) => ({
    outreachId: r.id,
    prospectId: r.prospect_id,
    shopName: r.prospect?.name ?? "",
    channel: r.channel,
    status: r.status,
    replyType: r.reply_type,
    sentAt: r.sent_at,
    repliedAt: r.replied_at,
    meetingAt: r.meeting_at,
    doNotContact: r.prospect?.do_not_contact ?? false,
  }));
}

export function formatDate(iso: string | null): string {
  if (!iso) return "-";
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric" }).format(new Date(iso));
}
