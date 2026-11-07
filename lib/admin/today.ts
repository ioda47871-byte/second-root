import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ReviewSummarySchema, type ReviewSummary } from "@/lib/design-agent/review-summary";
import { aiDesignEnabled, initialSendAllowed, isDesignStatus, type DesignStatus } from "@/lib/sales/design";
import { emailDigest } from "@/lib/sales/email-digest";
import { buildTodayEvidence, matchExclusions, type ExclusionRow, type SourceRow, type TodayEvidence } from "@/lib/sales/evidence";
import { isFollowUpDue } from "@/lib/sales/followup";
import { selectWorkQueue, type QueueItem } from "@/lib/sales/queue";
import { LIMITS, type Category, type Channel, type WebsiteStatus } from "@/lib/sales/types";

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
  /** DEV-053: why a design is blocked / failed (e.g. QUALITY_NOT_ACCEPTED); null otherwise or with the step off. */
  designErrorCode: string | null;
  /** DEV-058: the design's review summary (ready / blocked only, re-validated); null otherwise or with the step off. */
  designReview: ReviewSummary | null;
  /**
   * DEV-194: why the shop is listed, its sources and research date, and the
   * contact verdict (the same rules the server applies when it is marked sent).
   */
  evidence: TodayEvidence;
};

// DEV-048: with the AI design step on, drafts waiting for a design must not
// hide sendable ones behind the limit, so more drafts are read and ordered in
// TypeScript (selectWorkQueue). With the step off the query is the legacy one.
const DESIGN_DRAFT_SCAN = 50;

type DemoRow = { public_token: string; disabled_at: string | null; design_status?: unknown; design_error_code?: unknown; design_review?: unknown };

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
    address: string | null;
    normalized_name: string | null;
    normalized_address: string | null;
    website_status: WebsiteStatus | null;
    website_domain: string | null;
    instagram_handle: string | null;
    recommended_channel: Channel | null;
    created_at: string | null;
    sources: SourceRow[] | null;
    demo: DemoRow | DemoRow[] | null;
  } | null;
};

// With the AI design step off (DEV-030) the demo part is exactly the legacy one.
// DEV-194: the prospect's stored channel facts and its sources are read for the
// card's evidence, through the same admin session (RLS: admin read only).
export function todaySelect(design: boolean): string {
  return `id, prospect_id, kind, channel, status, subject, body, sent_at, created_at,
  prospect:sales_prospects!inner(name, category, ward, do_not_contact, instagram_url, public_email,
    address, normalized_name, normalized_address, website_status, website_domain, instagram_handle, recommended_channel, created_at,
    sources:sales_sources(field, value, source_url, source_type, verified_at),
    demo:sales_demos(public_token, disabled_at${design ? ", design_status, design_error_code, design_review" : ""}))`;
}

const EXCLUSION_SELECT = "reason, instagram_handle, website_domain, email_digest, normalized_name, normalized_address";

/** DEV-058: a stored summary is shown only on a finished design and only while it is still the agreed shape. */
function reviewOf(status: DesignStatus | null, value: unknown): ReviewSummary | null {
  if (status !== "ready" && status !== "blocked") return null;
  const parsed = ReviewSummarySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function loadTodayQueue(supabase: SupabaseClient, now: Date = new Date()): Promise<TodayItem[]> {
  const limit = LIMITS.workQueue;
  const design = aiDesignEnabled();
  const SELECT = todaySelect(design);
  // Due follow-ups are computed in SQL (view sales_followup_due), so nothing
  // is truncated before filtering; at most `limit` of each kind is needed.
  const [due, drafts] = await Promise.all([
    supabase.from("sales_followup_due").select("outreach_id").order("sent_at").limit(limit),
    supabase.from("sales_outreaches").select(SELECT).eq("kind", "initial").eq("status", "drafted")
      .eq("prospect.do_not_contact", false).order("created_at").limit(design ? DESIGN_DRAFT_SCAN : limit),
  ]);
  if (due.error || drafts.error) throw new Error("queue_unavailable");
  const dueIds = (due.data ?? []).map((r) => r.outreach_id as string);
  let dueRows: Row[] = [];
  if (dueIds.length > 0) {
    const res = await supabase.from("sales_outreaches").select(SELECT).in("id", dueIds).eq("prospect.do_not_contact", false);
    if (res.error) throw new Error("queue_unavailable");
    dueRows = (res.data ?? []) as unknown as Row[];
  }

  // DEV-194: the admin's exclusion list (admin read only). Persist already
  // refused excluded shops; this catches an exclusion added after the draft.
  // A read failure is not hidden: every card's verdict becomes 未確認 (blocked).
  const allRows = [...dueRows, ...((drafts.data ?? []) as unknown as Row[])];
  let exclusions: ExclusionRow[] | null = [];
  if (allRows.length > 0) {
    const ex = await supabase.from("sales_exclusions").select(EXCLUSION_SELECT);
    exclusions = ex.error ? null : ((ex.data ?? []) as unknown as ExclusionRow[]);
  }

  const toItem = (row: Row, kind: "initial" | "follow_up"): TodayItem | null => {
    const p = row.prospect;
    if (!p) return null;
    const demo = Array.isArray(p.demo) ? p.demo[0] : p.demo;
    const designStatus = design && demo && isDesignStatus(demo.design_status) ? demo.design_status : null;
    const demoToken = demo && !demo.disabled_at ? demo.public_token : null;
    const evidence = buildTodayEvidence({
      kind,
      outreachStatus: row.status,
      channel: row.channel,
      category: p.category ?? null,
      ward: p.ward ?? null,
      address: p.address ?? null,
      doNotContact: typeof p.do_not_contact === "boolean" ? p.do_not_contact : null,
      websiteStatus: p.website_status ?? null,
      websiteDomain: p.website_domain ?? null,
      instagramUrl: p.instagram_url ?? null,
      instagramHandle: p.instagram_handle ?? null,
      publicEmail: p.public_email ?? null,
      recommendedChannel: p.recommended_channel ?? null,
      registeredAt: p.created_at ?? null,
      sources: Array.isArray(p.sources) ? p.sources : null,
      designEnabled: design,
      designStatus,
      demoAvailable: demoToken !== null,
      exclusion: matchExclusions(
        {
          instagramHandle: p.instagram_handle ?? null,
          websiteDomain: p.website_domain ?? null,
          emailDigest: p.public_email ? emailDigest(p.public_email) : null,
          normalizedName: p.normalized_name ?? null,
          normalizedAddress: p.normalized_address ?? null,
        },
        exclusions,
      ),
    });
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
      demoToken,
      sentAt: row.sent_at,
      designStatus,
      designErrorCode:
        designStatus && (designStatus === "blocked" || designStatus === "failed") && typeof demo?.design_error_code === "string"
          ? demo.design_error_code
          : null,
      designReview: kind === "initial" ? reviewOf(designStatus, demo?.design_review) : null,
      sendable: kind === "follow_up" || initialSendAllowed(design, designStatus),
      evidence,
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
