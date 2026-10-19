import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isDemoPublic } from "@/lib/sales/demo";
import { followUpStatus, type FollowUpStatus } from "@/lib/sales/followup";
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

type DemoRow = { disabled_at: string | null; expires_at: string | null; keep_alive: boolean };

type Row = {
  id: string;
  prospect_id: string;
  channel: Channel;
  status: OutreachStatus;
  reply_type: ReplyType | null;
  sent_at: string | null;
  replied_at: string | null;
  meeting_at: string | null;
  prospect: { name: string; do_not_contact: boolean; demo?: DemoRow | DemoRow[] | null } | null;
};

const COLUMNS = "id, prospect_id, channel, status, reply_type, sent_at, replied_at, meeting_at";

function toItem(r: Row): PipelineItem {
  return {
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
  };
}

export async function loadPipeline(supabase: SupabaseClient, statuses: OutreachStatus[], limit = 100): Promise<PipelineItem[]> {
  const { data, error } = await supabase
    .from("sales_outreaches")
    .select(`${COLUMNS}, prospect:sales_prospects!inner(name, do_not_contact)`)
    .eq("kind", "initial")
    .in("status", statuses)
    .order("sent_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error("pipeline_unavailable");
  return ((data ?? []) as unknown as Row[]).map(toItem);
}

export type AwaitingReplyItem = PipelineItem & { followUp: FollowUpStatus };

/**
 * Sent initial outreaches waiting for a reply (DEV-056), oldest sent first so
 * the longest-waiting shops come first, with their follow-up state. The 5-day
 * rule itself lives in lib/sales/followup.ts; this only reads the data it
 * needs (a sent follow-up row, DNC, demo visibility).
 */
export async function loadAwaitingReplies(supabase: SupabaseClient, now: Date = new Date(), limit = 100): Promise<AwaitingReplyItem[]> {
  const { data, error } = await supabase
    .from("sales_outreaches")
    .select(`${COLUMNS}, prospect:sales_prospects!inner(name, do_not_contact, demo:sales_demos(disabled_at, expires_at, keep_alive))`)
    .eq("kind", "initial")
    .eq("status", "sent")
    .order("sent_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error("pipeline_unavailable");
  const rows = (data ?? []) as unknown as Row[];
  if (rows.length === 0) return [];

  const followed = await supabase
    .from("sales_outreaches")
    .select("prospect_id")
    .eq("kind", "follow_up")
    .eq("status", "sent")
    .in(
      "prospect_id",
      rows.map((r) => r.prospect_id),
    );
  if (followed.error) throw new Error("pipeline_unavailable");
  const hasFollowUp = new Set((followed.data ?? []).map((f) => f.prospect_id as string));

  return rows.map((r) => {
    const item = toItem(r);
    const raw = r.prospect?.demo;
    const demo = Array.isArray(raw) ? raw[0] : raw;
    const demoPublic =
      !!demo &&
      isDemoPublic(
        {
          disabledAt: demo.disabled_at ? new Date(demo.disabled_at) : null,
          expiresAt: demo.expires_at ? new Date(demo.expires_at) : null,
          keepAlive: Boolean(demo.keep_alive),
        },
        now,
      );
    return {
      ...item,
      followUp: followUpStatus(
        {
          channel: item.channel,
          status: item.status,
          sentAt: item.sentAt ? new Date(item.sentAt) : null,
          hasFollowUp: hasFollowUp.has(item.prospectId),
          doNotContact: item.doNotContact,
          demoPublic,
        },
        now,
      ),
    };
  });
}

export function formatDate(iso: string | null): string {
  if (!iso) return "-";
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric" }).format(new Date(iso));
}
