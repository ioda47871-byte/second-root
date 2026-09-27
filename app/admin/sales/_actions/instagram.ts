"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/admin/auth";
import { demoUrl } from "@/lib/admin/today";
import { checkDraft } from "@/lib/instagram/draft";
import { sendApprovedReply } from "@/lib/instagram/reply";
import type { ReplyType } from "@/lib/sales/types";
import { createAuthClient } from "@/lib/supabase/server";

// Instagram reply inbox actions (DEV-022 / DEV-023). Every action checks the
// admin itself; the database checks again. A reply is only ever sent here,
// after the human tapped 「この内容で返信」, through the official Send API.

export type IgResult = { ok: true; message?: string } | { ok: false; error: string };

const id = z.uuid();
const NOT_FOUND = "対象が見つかりません。画面を再読み込みしてください。";

const BEGIN_ERRORS: Record<string, string> = {
  window_closed: "相手の最後のメッセージから24時間を過ぎたため、公式APIでは返信できません。Instagram アプリから手動で返信してください。",
  unmatched: "店舗と照合してから返信してください。",
  do_not_contact: "この店舗は営業不要（DNC）のため返信できません。",
  not_sendable: "この返信案はすでに処理済みです。画面を再読み込みしてください。",
  not_found: NOT_FOUND,
  stale_draft: "新しいメッセージが届いたため、この返信案は使えません。画面を再読み込みしてください。",
  too_many_attempts: "何度も失敗しているため送信を止めました。Instagram アプリから手動で返信してください。",
  invalid_draft: "返信文に入れられない内容（連絡先やデモ以外のリンク）があります。編集してください。",
};

const DRAFT_ERRORS: Record<string, string> = {
  empty: "返信文を入力してください。",
  too_long: "長すぎます（Instagram は約300文字まで）。",
  contact_details: "メールアドレスや電話番号は入れられません。",
  link_not_allowed: "この店舗のデモ以外の URL は入れられません。",
  invalid_reply_type: NOT_FOUND,
};

function done(message?: string): IgResult {
  revalidatePath("/admin/sales/replies");
  return { ok: true, message };
}

function codeOf(message: string | undefined): string {
  return (message ?? "").split(":")[0].trim();
}

/** @param shownBody the text the admin saw: a draft changed elsewhere (another tab) is not sent unseen. */
export async function sendIgReply(draftId: string, shownBody: string): Promise<IgResult> {
  await requireAdmin();
  if (!id.safeParse(draftId).success || typeof shownBody !== "string") return { ok: false, error: NOT_FOUND };
  const supabase = await createAuthClient();
  // The text is checked again right before sending, whoever last changed it.
  const current = await loadDraft(supabase, draftId);
  if (!current) return { ok: false, error: NOT_FOUND };
  if (current.body !== shownBody) return { ok: false, error: "返信文がほかの画面で変更されています。画面を再読み込みして内容を確認してください。" };
  // (A send already in progress is only looked up, never sent again.)
  if (current.status !== "sending" && !recheck(current, current.body).ok) return { ok: false, error: BEGIN_ERRORS.invalid_draft };
  const outcome = await sendApprovedReply(supabase, draftId);
  switch (outcome.kind) {
    case "sent":
      return done("送信しました。");
    case "already_sent":
      return done("この返信は送信済みです。");
    case "in_flight":
      return { ok: false, error: "送信中です。少し待ってから画面を再読み込みしてください。" };
    case "refused":
      return { ok: false, error: BEGIN_ERRORS[outcome.code] ?? "送信を開始できませんでした。画面を再読み込みしてください。" };
    case "record_failed":
      return { ok: false, error: "送信結果を記録できませんでした。Instagram で送信されたか確認してください。" };
    case "failed":
      revalidatePath("/admin/sales/replies");
      return {
        ok: false,
        error:
          outcome.errorCode === "not_configured"
            ? "Instagram との連携がまだ設定されていません（送信していません）。"
            : outcome.errorCode.startsWith("meta_190")
              ? "Instagram の接続が切れています（アクセストークンの期限切れ）。送信していません。Instagram 連携の設定を更新してください。"
              : "送信できませんでした（Instagram 側で受け付けられませんでした）。内容や状況を確認して、もう一度お試しください。",
      };
    case "unknown":
      revalidatePath("/admin/sales/replies");
      return { ok: false, error: "送信されたか確認できませんでした。Instagram アプリで確認し、「送信されていた」か「送信されていなかった」を押してください。" };
  }
}

type DraftRow = {
  id: string;
  status: string;
  body: string;
  reply_type: ReplyType;
  message: { text: string | null } | null;
  thread: { prospect: { demo: DemoRow | DemoRow[] | null } | null } | null;
};
type DemoRow = { public_token: string; disabled_at: string | null; expires_at: string | null; keep_alive: boolean };

async function loadDraft(supabase: Awaited<ReturnType<typeof createAuthClient>>, draftId: string): Promise<DraftRow | null> {
  const { data } = await supabase
    .from("sales_ig_drafts")
    .select("id, status, body, reply_type, message:sales_ig_messages(text), thread:sales_ig_threads(prospect:sales_prospects(demo:sales_demos(public_token, disabled_at, expires_at, keep_alive)))")
    .eq("id", draftId)
    .maybeSingle();
  return data as unknown as DraftRow | null;
}

/** The same checks as for Operational Claude's drafts (lib/instagram/draft.ts). */
function recheck(row: DraftRow, body: string) {
  const demo = Array.isArray(row.thread?.prospect?.demo) ? row.thread?.prospect?.demo[0] : row.thread?.prospect?.demo;
  const live = demo && !demo.disabled_at && demo.expires_at && (demo.keep_alive || Date.parse(demo.expires_at) > Date.now());
  return checkDraft({ replyType: row.reply_type, body, futureContactRefused: false }, live ? demoUrl(demo.public_token) : null, row.message?.text ?? null);
}

export async function editIgDraft(draftId: string, body: string): Promise<IgResult> {
  await requireAdmin();
  if (!id.safeParse(draftId).success || typeof body !== "string" || body.length > 3000) return { ok: false, error: NOT_FOUND };
  const supabase = await createAuthClient();
  const row = await loadDraft(supabase, draftId);
  if (!row) return { ok: false, error: NOT_FOUND };
  const checked = recheck(row, body);
  if (!checked.ok) return { ok: false, error: DRAFT_ERRORS[checked.reason] };
  const { error } = await supabase.rpc("sales_ig_update_draft", {
    p_draft_id: draftId,
    p_body: checked.body,
    p_needs_review: checked.needsHumanReview,
    p_review_reasons: checked.reviewReasons,
  });
  if (error) return { ok: false, error: "保存できませんでした。画面を再読み込みしてください。" };
  return done("返信文を保存しました。");
}

export async function snoozeIgDraft(draftId: string, snooze: boolean): Promise<IgResult> {
  await requireAdmin();
  if (!id.safeParse(draftId).success || typeof snooze !== "boolean") return { ok: false, error: NOT_FOUND };
  const supabase = await createAuthClient();
  const { error } = await supabase.rpc("sales_ig_snooze_draft", { p_draft_id: draftId, p_snooze: snooze });
  if (error) return { ok: false, error: "変更できませんでした。画面を再読み込みしてください。" };
  return done();
}

export async function resolveIgThread(threadId: string, prospectId: string | null): Promise<IgResult> {
  await requireAdmin();
  if (!id.safeParse(threadId).success || (prospectId !== null && !id.safeParse(prospectId).success)) return { ok: false, error: NOT_FOUND };
  const supabase = await createAuthClient();
  const { error } = await supabase.rpc("sales_ig_resolve_thread", { p_thread_id: threadId, p_prospect_id: prospectId });
  if (error) {
    const messages: Record<string, string> = {
      invalid_prospect: "Instagram で営業済みの店舗（営業不要以外）を選んでください。",
      already_resolved: "この会話はすでに照合されています。画面を再読み込みしてください。",
      send_open: "送信結果の確認が残っています。先に「送信されていた / されていなかった」を記録してください。",
    };
    return { ok: false, error: messages[codeOf(error.message)] ?? "変更できませんでした。" };
  }
  return done();
}

export async function resolveIgUnknown(sendId: string, wasSent: boolean): Promise<IgResult> {
  await requireAdmin();
  if (!id.safeParse(sendId).success || typeof wasSent !== "boolean") return { ok: false, error: NOT_FOUND };
  const supabase = await createAuthClient();
  const { error } = await supabase.rpc("sales_ig_resolve_unknown", { p_send_id: sendId, p_was_sent: wasSent });
  if (error) return { ok: false, error: "記録できませんでした。画面を再読み込みしてください。" };
  return done(wasSent ? "送信済みとして記録しました。" : "未送信として記録しました。もう一度送信できます。");
}
