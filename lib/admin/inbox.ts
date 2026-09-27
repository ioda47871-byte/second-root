import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReplyType } from "@/lib/sales/types";

// Instagram reply inbox for the admin (DEV-022), read with the admin's own
// session (row level security applies). Everything is plain text.

export type InboxItem = {
  threadId: string;
  draftId: string | null;
  draftStatus: string | null;
  /** 後で対応 and not yet due again (a snooze lasts 24 hours). */
  snoozed: boolean;
  /** The draft answers an older message: a newer one arrived since. */
  stale: boolean;
  sendId: string | null;
  matched: boolean;
  username: string | null;
  shopName: string | null;
  prospectId: string | null;
  initialOutreachId: string | null;
  initialOutreachStatus: string | null;
  lastInboundAt: string | null;
  windowOpen: boolean;
  messages: Array<{ direction: "inbound" | "outbound"; text: string | null; attachmentTypes: string[]; sentAt: string }>;
  replyType: ReplyType | null;
  body: string | null;
  dncCandidate: boolean;
  doNotContact: boolean;
  reviewReasons: string[];
};

type ThreadRow = {
  id: string;
  username: string | null;
  match_status: "matched" | "unmatched" | "ignored";
  prospect_id: string | null;
  last_inbound_at: string | null;
  prospect: {
    name: string;
    do_not_contact: boolean;
    outreach: Array<{ id: string; kind: string; status: string }> | null;
  } | null;
  messages: Array<{ id: string; direction: "inbound" | "outbound"; text: string | null; attachment_types: string[]; sent_at: string; received_at: string; deleted_at: string | null }>;
  drafts: Array<{ id: string; message_id: string; status: string; snoozed_until: string | null; reply_type: ReplyType; body: string; dnc_candidate: boolean; review_reasons: string[]; created_at: string; sends: Array<{ id: string; status: string; updated_at: string }> }>;
};

const OPEN = new Set(["pending", "snoozed", "failed", "unknown", "sending"]);
// A send still waiting for its outcome comes first: it must be settled
// before a newer draft is shown.
const IN_FLIGHT = new Set(["unknown", "sending"]);

/** Newest first by time (ISO strings compared as instants), then id. */
function newestFirst<T extends { id: string }>(time: (x: T) => string, ...more: Array<(x: T) => string>) {
  return (a: T, b: T) => {
    for (const f of [time, ...more]) {
      const d = Date.parse(f(b)) - Date.parse(f(a));
      if (d !== 0) return d;
    }
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  };
}
const WINDOW_MS = 24 * 60 * 60 * 1000;

export async function loadInbox(supabase: SupabaseClient, now: Date = new Date(), limit = 50): Promise<InboxItem[]> {
  const { data, error } = await supabase
    .from("sales_ig_threads")
    .select(
      `id, username, match_status, prospect_id, last_inbound_at,
       prospect:sales_prospects(name, do_not_contact, outreach:sales_outreaches(id, kind, status)),
       messages:sales_ig_messages(id, direction, text, attachment_types, sent_at, received_at, deleted_at),
       drafts:sales_ig_drafts(id, message_id, status, snoozed_until, reply_type, body, dnc_candidate, review_reasons, created_at, sends:sales_ig_sends(id, status, updated_at))`,
    )
    .neq("match_status", "ignored")
    .not("last_inbound_at", "is", null)
    .order("last_inbound_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error("inbox_unavailable");

  return ((data ?? []) as unknown as ThreadRow[]).map((t) => {
    const drafts = [...(t.drafts ?? [])].sort(newestFirst((d) => d.created_at));
    const draft = drafts.find((d) => IN_FLIGHT.has(d.status)) ?? drafts.find((d) => OPEN.has(d.status)) ?? null;
    const sends = [...(draft?.sends ?? [])].sort(newestFirst((s) => s.updated_at));
    const send = sends.find((s) => IN_FLIGHT.has(s.status)) ?? sends[0] ?? null;
    // Same order as the database uses for "the latest message".
    const latestInbound = (t.messages ?? [])
      .filter((m) => m.direction === "inbound" && !m.deleted_at)
      .sort(newestFirst((m) => m.sent_at, (m) => m.received_at))[0];
    const initial = t.prospect?.outreach?.find((o) => o.kind === "initial") ?? null;
    const messages = [...(t.messages ?? [])]
      .filter((m) => !m.deleted_at)
      .sort((a, b) => Date.parse(a.sent_at) - Date.parse(b.sent_at))
      .slice(-10)
      .map((m) => ({ direction: m.direction, text: m.text, attachmentTypes: m.attachment_types, sentAt: m.sent_at }));
    return {
      threadId: t.id,
      draftId: draft?.id ?? null,
      draftStatus: draft?.status ?? null,
      snoozed: draft?.status === "snoozed" && draft.snoozed_until !== null && Date.parse(draft.snoozed_until) > now.getTime(),
      stale: draft !== null && ["pending", "snoozed", "failed"].includes(draft.status) && draft.message_id !== latestInbound?.id,
      sendId: send?.id ?? null,
      matched: t.match_status === "matched",
      username: t.username,
      shopName: t.prospect?.name ?? null,
      prospectId: t.prospect_id,
      initialOutreachId: initial?.id ?? null,
      initialOutreachStatus: initial?.status ?? null,
      lastInboundAt: t.last_inbound_at,
      windowOpen: t.last_inbound_at !== null && now.getTime() - Date.parse(t.last_inbound_at) < WINDOW_MS,
      messages,
      replyType: draft?.reply_type ?? null,
      body: draft?.body ?? null,
      dncCandidate: draft?.dnc_candidate ?? false,
      doNotContact: t.prospect?.do_not_contact ?? false,
      reviewReasons: draft?.review_reasons ?? [],
    };
  });
}

/** Shops contacted on Instagram that an unmatched conversation may belong to. */
export async function loadMatchCandidates(supabase: SupabaseClient): Promise<Array<{ prospectId: string; name: string; handle: string }>> {
  const { data, error } = await supabase
    .from("sales_outreaches")
    .select("prospect_id, prospect:sales_prospects!inner(name, instagram_handle, do_not_contact)")
    .eq("kind", "initial")
    .eq("channel", "instagram")
    .not("sent_at", "is", null)
    .eq("prospect.do_not_contact", false)
    .order("sent_at", { ascending: false })
    .limit(200);
  if (error) throw new Error("inbox_unavailable");
  return ((data ?? []) as unknown as Array<{ prospect_id: string; prospect: { name: string; instagram_handle: string } }>).map((r) => ({
    prospectId: r.prospect_id,
    name: r.prospect.name,
    handle: r.prospect.instagram_handle,
  }));
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "-";
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}
