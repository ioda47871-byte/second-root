import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendText, type SendOutcome } from "./graph";

// 「この内容で返信」 (DEV-023): reserve → Send API → record, with the admin's
// own session (the database checks the admin, the 24-hour window, matching
// and DNC, and makes retries safe; see migration 001100).

export type ReplyOutcome =
  | { kind: "sent" }
  | { kind: "already_sent" }
  | { kind: "in_flight" }
  | { kind: "unknown" }
  | { kind: "failed"; errorCode: string }
  | { kind: "refused"; code: string }
  | { kind: "record_failed" };

type Begun = { send_id: string; status: string; replayed: boolean; account_id?: string; igsid?: string; body?: string };

export async function sendApprovedReply(supabase: SupabaseClient, draftId: string): Promise<ReplyOutcome> {
  const { data, error } = await supabase.rpc("sales_ig_begin_send", { p_draft_id: draftId });
  if (error) return { kind: "refused", code: (error.message ?? "").split(":")[0].trim() };
  const begun = data as Begun;
  if (begun.replayed) {
    if (begun.status === "sent") return { kind: "already_sent" };
    if (begun.status === "sending") return { kind: "in_flight" };
    return { kind: "unknown" };
  }
  const result: SendOutcome = await sendText(begun.account_id!, begun.igsid!, begun.body!);
  const { error: finishError } = await supabase.rpc("sales_ig_finish_send", {
    p_send_id: begun.send_id,
    p_outcome: result.outcome,
    p_meta_message_id: result.outcome === "sent" ? result.messageId : null,
    p_error_code: result.outcome === "sent" ? null : result.errorCode,
  });
  // Unrecorded outcome: the reservation turns into "unknown" after 2
  // minutes and is never resent automatically.
  if (finishError) return { kind: "record_failed" };
  if (result.outcome === "sent") return { kind: "sent" };
  if (result.outcome === "failed") return { kind: "failed", errorCode: result.errorCode };
  return { kind: "unknown" };
}
