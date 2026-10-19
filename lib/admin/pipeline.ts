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

/** Rows per request when reading a whole list (below PostgREST's max_rows of 1000). */
export const PIPELINE_PAGE = 500;

/**
 * Every row of an ordered query, page by page, so no item is ever hidden
 * behind a cap. The 返信 tab's 返信あり and the 商談 tab's actions are the only
 * way to move these outreaches on, and an unanswered `sent` outreach never
 * leaves the list by itself. At MVP volume (at most 5 initials a day, one
 * admin) this is one or a few small requests.
 */
async function readAll<T>(page: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: unknown }>, size: number): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += size) {
    const { data, error } = await page(from, from + size - 1);
    if (error) throw new Error("pipeline_unavailable");
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < size) return out;
  }
}

/** All initial outreaches in the given states (no cap, see readAll). */
export async function loadPipeline(supabase: SupabaseClient, statuses: OutreachStatus[], pageSize = PIPELINE_PAGE): Promise<PipelineItem[]> {
  const rows = await readAll<Row>(
    (from, to) =>
      supabase
        .from("sales_outreaches")
        .select(`${COLUMNS}, prospect:sales_prospects!inner(name, do_not_contact)`)
        .eq("kind", "initial")
        .in("status", statuses)
        .order("sent_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
    pageSize,
  );
  return rows.map(toItem);
}

/**
 * 商談 tab order (display only, DEV-056): the stalest first — replies by reply
 * date, meetings by meeting start; a missing date goes last.
 */
export function byStageAge(a: PipelineItem, b: PipelineItem): number {
  const since = (i: PipelineItem) => {
    const t = Date.parse((i.status === "meeting" ? i.meetingAt : i.repliedAt) ?? "");
    return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t;
  };
  return since(a) - since(b) || (a.outreachId < b.outreachId ? -1 : a.outreachId > b.outreachId ? 1 : 0);
}

export type AwaitingReplyItem = PipelineItem & { followUp: FollowUpStatus };

/**
 * All sent initial outreaches waiting for a reply (DEV-056), oldest sent first
 * so the longest-waiting shops come first, with their follow-up state. No cap
 * (see readAll): this list holds the only 返信あり button. The 5-day rule
 * itself lives in lib/sales/followup.ts; this only reads the data it needs (a
 * sent follow-up row, DNC, demo visibility).
 */
export async function loadAwaitingReplies(supabase: SupabaseClient, now: Date = new Date(), pageSize = PIPELINE_PAGE): Promise<AwaitingReplyItem[]> {
  const rows = await readAll<Row>(
    (from, to) =>
      supabase
        .from("sales_outreaches")
        .select(`${COLUMNS}, prospect:sales_prospects!inner(name, do_not_contact, demo:sales_demos(disabled_at, expires_at, keep_alive))`)
        .eq("kind", "initial")
        .eq("status", "sent")
        .order("sent_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
    pageSize,
  );
  if (rows.length === 0) return [];

  // At most one sent follow-up per shop: read them all instead of putting
  // every prospect id in the URL.
  const followed = await readAll<{ prospect_id: string }>(
    (from, to) =>
      supabase.from("sales_outreaches").select("prospect_id").eq("kind", "follow_up").eq("status", "sent").order("id", { ascending: true }).range(from, to),
    pageSize,
  );
  const hasFollowUp = new Set(followed.map((f) => f.prospect_id));

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
