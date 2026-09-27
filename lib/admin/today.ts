import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { addDays } from "@/lib/sales/dates";
import { isFollowUpDue } from "@/lib/sales/followup";
import { selectWorkQueue, type QueueItem } from "@/lib/sales/queue";
import { LIMITS, type Category, type Channel } from "@/lib/sales/types";

// Today's work queue for the admin (MVP_SPEC §3.1, §8): at most 5 actions,
// due email follow-ups first, then unsent initial drafts, never DNC shops.
// Reads through the admin's own session, so row level security applies.

export type TodayItem = QueueItem & {
  outreachId: string;
  channel: Channel;
  shopName: string;
  category: Category;
  ward: string | null;
  subject: string | null;
  body: string;
  instagramUrl: string | null;
  publicEmail: string | null;
  demoToken: string | null;
  sentAt: string | null;
};

type Row = {
  id: string;
  prospect_id: string;
  kind: "initial" | "follow_up";
  channel: Channel;
  status: string;
  subject: string | null;
  body: string;
  sent_at: string | null;
  created_at: string;
  prospect: {
    name: string;
    category: Category;
    ward: string | null;
    do_not_contact: boolean;
    instagram_url: string | null;
    public_email: string | null;
    demo: { public_token: string } | Array<{ public_token: string }> | null;
  } | null;
};

const SELECT = `id, prospect_id, kind, channel, status, subject, body, sent_at, created_at,
  prospect:sales_prospects!inner(name, category, ward, do_not_contact, instagram_url, public_email,
    demo:sales_demos(public_token))`;

export async function loadTodayQueue(supabase: SupabaseClient, now: Date = new Date()): Promise<TodayItem[]> {
  const followUpCutoff = addDays(now, -LIMITS.followUpAfterDays).toISOString();
  const [drafts, sentEmails, followUps] = await Promise.all([
    supabase.from("sales_outreaches").select(SELECT).eq("kind", "initial").eq("status", "drafted")
      .eq("prospect.do_not_contact", false).order("created_at").limit(50),
    supabase.from("sales_outreaches").select(SELECT).eq("kind", "initial").eq("status", "sent").eq("channel", "email")
      .lte("sent_at", followUpCutoff).eq("prospect.do_not_contact", false).order("sent_at").limit(50),
    supabase.from("sales_outreaches").select("prospect_id").eq("kind", "follow_up"),
  ]);
  if (drafts.error || sentEmails.error || followUps.error) throw new Error("queue_unavailable");
  const followedUp = new Set((followUps.data ?? []).map((r) => r.prospect_id as string));

  const toItem = (row: Row, kind: "initial" | "follow_up"): TodayItem | null => {
    const p = row.prospect;
    if (!p) return null;
    const demo = Array.isArray(p.demo) ? p.demo[0] : p.demo;
    return {
      kind,
      prospectId: row.prospect_id,
      doNotContact: p.do_not_contact,
      since: new Date(kind === "follow_up" ? row.sent_at! : row.created_at),
      outreachId: row.id,
      channel: row.channel,
      shopName: p.name,
      category: p.category,
      ward: p.ward,
      subject: row.subject,
      body: row.body,
      instagramUrl: p.instagram_url,
      publicEmail: p.public_email,
      demoToken: demo?.public_token ?? null,
      sentAt: row.sent_at,
    };
  };

  const initialItems = ((drafts.data ?? []) as unknown as Row[]).map((r) => toItem(r, "initial"));
  const followUpItems = ((sentEmails.data ?? []) as unknown as Row[])
    .filter((r) =>
      isFollowUpDue(
        {
          channel: r.channel,
          status: "sent",
          sentAt: r.sent_at ? new Date(r.sent_at) : null,
          hasFollowUp: followedUp.has(r.prospect_id),
          doNotContact: r.prospect?.do_not_contact ?? true,
        },
        now,
      ),
    )
    .map((r) => toItem(r, "follow_up"));

  return selectWorkQueue([...followUpItems, ...initialItems].filter((i): i is TodayItem => i !== null));
}

/** Public demo URL shown in messages (the page itself decides visibility). */
export function demoUrl(token: string): string {
  const base = (process.env.SALES_DEMO_BASE_URL ?? "https://secondroot.jp").replace(/\/+$/, "");
  return `${base}/demo/${token}`;
}
