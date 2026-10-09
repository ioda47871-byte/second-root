import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { aiDesignEnabled, isDesignStatus, type DesignStatus } from "@/lib/sales/design";
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
  /** DEV-030: the demo's AI design state; null for a legacy demo or with the step off. */
  designStatus: DesignStatus | null;
};

type DemoRow = { public_token: string; disabled_at: string | null; design_status?: unknown };

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
    demo: DemoRow | DemoRow[] | null;
  } | null;
};

// With the AI design step off (DEV-030) the query is exactly the legacy one.
function select(design: boolean): string {
  return `id, prospect_id, kind, channel, status, subject, body, sent_at, created_at,
  prospect:sales_prospects!inner(name, category, ward, do_not_contact, instagram_url, public_email,
    demo:sales_demos(public_token, disabled_at${design ? ", design_status" : ""}))`;
}

export async function loadTodayQueue(supabase: SupabaseClient, now: Date = new Date()): Promise<TodayItem[]> {
  const limit = LIMITS.workQueue;
  const design = aiDesignEnabled();
  const SELECT = select(design);
  // Due follow-ups are computed in SQL (view sales_followup_due), so nothing
  // is truncated before filtering; at most `limit` of each kind is needed.
  const [due, drafts] = await Promise.all([
    supabase.from("sales_followup_due").select("outreach_id").order("sent_at").limit(limit),
    supabase.from("sales_outreaches").select(SELECT).eq("kind", "initial").eq("status", "drafted")
      .eq("prospect.do_not_contact", false).order("created_at").limit(limit),
  ]);
  if (due.error || drafts.error) throw new Error("queue_unavailable");
  const dueIds = (due.data ?? []).map((r) => r.outreach_id as string);
  let dueRows: Row[] = [];
  if (dueIds.length > 0) {
    const res = await supabase.from("sales_outreaches").select(SELECT).in("id", dueIds).eq("prospect.do_not_contact", false);
    if (res.error) throw new Error("queue_unavailable");
    dueRows = (res.data ?? []) as unknown as Row[];
  }

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
      // A disabled demo would be a dead link: no send action is offered.
      demoToken: demo && !demo.disabled_at ? demo.public_token : null,
      sentAt: row.sent_at,
      designStatus: design && demo && isDesignStatus(demo.design_status) ? demo.design_status : null,
    };
  };

  // Belt and braces: the same rule in TypeScript (lib/sales/followup.ts).
  const followUpItems = dueRows
    .filter((r) =>
      isFollowUpDue(
        { channel: r.channel, status: "sent", sentAt: r.sent_at ? new Date(r.sent_at) : null, hasFollowUp: false, doNotContact: r.prospect?.do_not_contact ?? true },
        now,
      ),
    )
    .map((r) => toItem(r, "follow_up"));
  const initialItems = ((drafts.data ?? []) as unknown as Row[]).map((r) => toItem(r, "initial"));

  return selectWorkQueue([...followUpItems, ...initialItems].filter((i): i is TodayItem => i !== null), limit);
}

/** Public demo URL shown in messages (the page itself decides visibility). */
export function demoUrl(token: string): string {
  const base = (process.env.SALES_DEMO_BASE_URL ?? "https://secondroot.jp").replace(/\/+$/, "");
  return `${base}/demo/${token}`;
}
