import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { aiDesignEnabled, initialSendAllowed, isDesignStatus } from "@/lib/sales/design";
import { DEFAULT_EMAIL_SUBJECT } from "@/lib/sales/draft";
import { buildMailto, composeDm, composeEmailBody, instagramOpenUrl } from "@/lib/sales/messages";
import type { Channel } from "@/lib/sales/types";
import { demoUrl } from "./today";

// DEV-195: the one place the full text of an initial message is composed —
// the text the owner sees on the today card, the text the approval records,
// and the text the mail app / clipboard receives. The approval action
// recomposes it from the database and refuses if it differs from what the
// owner was shown. Nothing here sends anything.

export type InitialSendInput = {
  channel: Channel;
  shopName: string;
  subject: string | null;
  body: string;
  publicEmail: string | null;
  instagramUrl: string | null;
  instagramHandle: string | null;
  demoToken: string | null;
};

export type InitialSend =
  | { channel: "email"; recipient: string; subject: string; body: string; mailto: string }
  | { channel: "instagram"; recipient: string; subject: null; body: string; openUrl: string };

/** The composed message, or null when it cannot be composed (no demo, bad recipient, too long for mailto). */
export function composeInitialSend(input: InitialSendInput): InitialSend | null {
  if (!input.demoToken) return null;
  try {
    if (input.channel === "email") {
      if (!input.publicEmail) return null;
      const subject = input.subject ?? DEFAULT_EMAIL_SUBJECT;
      const body = composeEmailBody({ shopName: input.shopName, message: input.body, demoUrl: demoUrl(input.demoToken) });
      const mailto = buildMailto({ to: input.publicEmail, subject, body });
      return { channel: "email", recipient: input.publicEmail, subject, body, mailto };
    }
    if (!input.instagramUrl || !input.instagramHandle) return null;
    const body = composeDm({ message: input.body, demoUrl: demoUrl(input.demoToken) });
    return { channel: "instagram", recipient: input.instagramHandle, subject: null, body, openUrl: instagramOpenUrl(input.instagramUrl) };
  } catch {
    return null;
  }
}

/** The mail app / Instagram link for an approved snapshot (its stored text, exactly). */
export function approvedSendLink(snapshot: { channel: Channel; recipient: string; subject: string | null; body: string }, instagramUrl: string | null): string | null {
  try {
    if (snapshot.channel === "email") return buildMailto({ to: snapshot.recipient, subject: snapshot.subject ?? DEFAULT_EMAIL_SUBJECT, body: snapshot.body });
    return instagramUrl ? instagramOpenUrl(instagramUrl) : null;
  } catch {
    return null;
  }
}

/** facts_pack: sales_demos.content->>facts_pack (DEV-263a, the test-recipient gate) */
type DemoRow = { public_token: string; disabled_at: string | null; design_status?: unknown; facts_pack?: string | null };
export type InitialRow = {
  id: string;
  kind: string;
  status: string;
  channel: Channel;
  subject: string | null;
  body: string;
  draft_version: number;
  prospect: {
    name: string;
    public_email: string | null;
    instagram_url: string | null;
    instagram_handle: string | null;
    demo: DemoRow | DemoRow[] | null;
  } | null;
};

/** The unsent initial draft and what its message is composed from, through the admin's session (RLS). */
export async function loadInitial(supabase: SupabaseClient, outreachId: string): Promise<InitialRow | null> {
  const { data, error } = await supabase
    .from("sales_outreaches")
    .select(
      `id, kind, status, channel, subject, body, draft_version,
       prospect:sales_prospects!inner(name, public_email, instagram_url, instagram_handle, demo:sales_demos(public_token, disabled_at, facts_pack:content->>facts_pack${aiDesignEnabled() ? ", design_status" : ""}))`,
    )
    .eq("id", outreachId)
    .maybeSingle();
  if (error || !data) return null;
  return data as unknown as InitialRow;
}

export const demoOf = (row: InitialRow) => (Array.isArray(row.prospect?.demo) ? row.prospect.demo[0] : row.prospect?.demo) ?? null;

/** The message exactly as the today card composes it for this draft (lib/admin/initial-send.ts). */
export function composedFor(row: InitialRow, body = row.body, subject = row.subject) {
  const demo = demoOf(row);
  return composeInitialSend({
    channel: row.channel,
    shopName: row.prospect?.name ?? "",
    subject,
    body,
    publicEmail: row.prospect?.public_email ?? null,
    instagramUrl: row.prospect?.instagram_url ?? null,
    instagramHandle: row.prospect?.instagram_handle ?? null,
    demoToken: demo && !demo.disabled_at ? demo.public_token : null,
  });
}

/** DEV-030: with the AI design step on, a demo still waiting for or getting its design is not sent. */
export function designWaiting(row: InitialRow): boolean {
  if (!aiDesignEnabled()) return false;
  const demo = demoOf(row);
  const status = demo && isDesignStatus(demo.design_status) ? demo.design_status : null;
  return !initialSendAllowed(true, status);
}
