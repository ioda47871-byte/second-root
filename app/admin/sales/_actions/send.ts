"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/admin/auth";
import { composeFollowUp } from "@/lib/admin/followup";
import { composedFor, designWaiting, loadInitial } from "@/lib/admin/initial-send";
import { errorCode, OPENED_VIA, sendErrorMessage, type OpenedVia } from "@/lib/sales/approval";
import { aiDesignEnabled } from "@/lib/sales/design";
import { createAuthClient } from "@/lib/supabase/server";

// The manual send of an initial message (MVP_SPEC §4, DEV-195):
//   approveSend    この内容で送信を承認 — records the exact snapshot shown
//   markSendOpened the owner opened the mail app / Instagram / copied the text
//   markSent       手動で送信済みにする — the owner confirms they really sent it
//   withdrawApproval 送らなかった
// Nothing here sends a message: the owner always sends from their own app.
// Every action checks the admin itself; the database checks the admin again,
// and every guard (DNC, eligibility, exclusion list, duplicate recipient,
// demo, design gate) at each step.

export type SendResult = { ok: true } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FOUND: SendResult = { ok: false, error: "対象が見つかりません。画面を再読み込みしてください。" };

/**
 * この内容で送信を承認. `shown` is the text the owner saw on the card; the
 * server recomposes it from the database and records it only if it is the
 * same (a draft changed in another tab is never approved unseen).
 */
export async function approveSend(outreachId: string, draftVersion: number, shown: { subject: string | null; body: string }): Promise<SendResult> {
  await requireAdmin();
  if (!UUID.test(outreachId) || !Number.isInteger(draftVersion) || typeof shown?.body !== "string") return NOT_FOUND;
  const supabase = await createAuthClient();
  const row = await loadInitial(supabase, outreachId);
  if (!row || row.kind !== "initial") return NOT_FOUND;
  if (row.status !== "drafted") return { ok: false, error: sendErrorMessage("invalid_transition") };
  if (row.draft_version !== draftVersion) return { ok: false, error: sendErrorMessage("stale_draft") };
  if (designWaiting(row)) return { ok: false, error: sendErrorMessage("design_pending") };
  const composed = composedFor(row);
  if (!composed) return { ok: false, error: "文面が長すぎるか宛先・デモが正しくないため、送る文面を作れません。" };
  if (composed.subject !== (shown.subject ?? null) || composed.body !== shown.body) {
    return { ok: false, error: "表示している文面がほかの画面で変わりました。画面を再読み込みして内容を確認してください。" };
  }
  const { error } = await supabase.rpc("sales_approve_outreach", {
    p_outreach_id: outreachId,
    p_draft_version: draftVersion,
    p_subject: composed.subject,
    p_body: composed.body,
    p_design_enabled: aiDesignEnabled(),
  });
  if (error) return { ok: false, error: sendErrorMessage(error.message, "承認できませんでした。画面を再読み込みしてください。") };
  revalidatePath("/admin/sales");
  return { ok: true };
}

/** The owner opened the send screen (mail app / Instagram) or copied the text. This is not a send. */
export async function markSendOpened(approvalId: string, via: OpenedVia): Promise<SendResult> {
  await requireAdmin();
  if (!UUID.test(approvalId) || !(OPENED_VIA as readonly string[]).includes(via)) return NOT_FOUND;
  const supabase = await createAuthClient();
  const { error } = await supabase.rpc("sales_mark_send_opened", { p_approval_id: approvalId, p_via: via, p_design_enabled: aiDesignEnabled() });
  if (error) return { ok: false, error: sendErrorMessage(error.message) };
  revalidatePath("/admin/sales");
  return { ok: true };
}

/** 送らなかった: the approval is withdrawn; the draft stays unsent and can be approved again. */
export async function withdrawApproval(approvalId: string): Promise<SendResult> {
  await requireAdmin();
  if (!UUID.test(approvalId)) return NOT_FOUND;
  const supabase = await createAuthClient();
  const { error } = await supabase.rpc("sales_withdraw_approval", { p_approval_id: approvalId });
  if (error) return { ok: false, error: sendErrorMessage(error.message) };
  revalidatePath("/admin/sales");
  return { ok: true };
}

/**
 * 手動で送信済みにする (MVP_SPEC §4): only after the owner really sent the
 * approved message from their own app. The database records it only for an
 * opened approval whose snapshot still matches, after every guard again.
 */
export async function markSent(outreachId: string, approvalId: string): Promise<SendResult> {
  await requireAdmin();
  if (!UUID.test(outreachId) || !UUID.test(approvalId)) return NOT_FOUND;
  const supabase = await createAuthClient();
  // DEV-030: with the AI design step on, a demo still waiting for or getting
  // its design cannot be marked sent (the same rule as the today screen).
  if (aiDesignEnabled()) {
    const row = await loadInitial(supabase, outreachId);
    if (!row) return { ok: false, error: "送信済みにできませんでした。画面を再読み込みしてください。" };
    if (designWaiting(row)) return { ok: false, error: "AIデザインの完成前のため送信済みにできません。" };
  }
  const { error } = await supabase.rpc("sales_mark_sent", { p_outreach_id: outreachId, p_approval_id: approvalId, p_design_enabled: aiDesignEnabled() });
  if (error) {
    const message = errorCode(error.message) === "do_not_contact"
      ? "この店舗は営業不要（DNC）のため送信済みにできません。"
      : sendErrorMessage(error.message, "送信済みにできませんでした。画面を再読み込みしてください。");
    return { ok: false, error: message };
  }
  revalidatePath("/admin/sales");
  return { ok: true };
}

type FollowUpRow = {
  subject: string | null;
  prospect: {
    name: string;
    public_email: string | null;
    demo: { public_token: string } | Array<{ public_token: string }> | null;
  } | null;
};

/**
 * 送信済み for the 5-day follow-up (MVP_SPEC §4.3). `outreachId` is the
 * initial email. The text recorded is recomposed here from the database,
 * exactly as the mailto was built; nothing typed by the client is stored.
 */
export async function markFollowUpSent(outreachId: string): Promise<SendResult> {
  await requireAdmin();
  if (!UUID.test(outreachId)) return { ok: false, error: "対象が見つかりません。" };
  const supabase = await createAuthClient();
  const { data, error: loadError } = await supabase
    .from("sales_outreaches")
    .select("subject, prospect:sales_prospects!inner(name, public_email, demo:sales_demos(public_token))")
    .eq("id", outreachId)
    .eq("kind", "initial")
    .maybeSingle();
  const row = data as unknown as FollowUpRow | null;
  const demo = Array.isArray(row?.prospect?.demo) ? row.prospect.demo[0] : row?.prospect?.demo;
  if (loadError || !row?.prospect?.public_email || !demo) return { ok: false, error: "対象が見つかりません。" };

  const draft = composeFollowUp({
    shopName: row.prospect.name,
    publicEmail: row.prospect.public_email,
    initialSubject: row.subject,
    demoToken: demo.public_token,
  });
  const { error } = await supabase.rpc("sales_mark_follow_up_sent", { p_outreach_id: outreachId, p_body: draft.body });
  if (error) {
    const message = error.message.includes("do_not_contact")
      ? "この店舗は営業不要（DNC）のため送信済みにできません。"
      : error.message.includes("excluded")
        ? "除外リストに一致するため送信済みにできません。"
      : error.message.includes("not_due")
        ? "フォローの条件（初回から5日・返信なし）を満たしていません。画面を再読み込みしてください。"
        : error.message.includes("demo_unavailable")
          ? "デモが公開期間外または無効のため、フォローできません。"
          : "送信済みにできませんでした。画面を再読み込みしてください。";
    return { ok: false, error: message };
  }
  revalidatePath("/admin/sales");
  return { ok: true };
}
