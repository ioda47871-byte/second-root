"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/admin/auth";
import { composedFor, loadInitial } from "@/lib/admin/initial-send";
import { sendErrorMessage } from "@/lib/sales/approval";
import { checkDraftMessage, DRAFT_PROBLEM_LABEL } from "@/lib/sales/draft";
import { checkInsight, INSIGHT_KINDS, INSIGHT_PROBLEM_LABEL, type InsightKind } from "@/lib/sales/insights";
import { createAuthClient } from "@/lib/supabase/server";

// DEV-195: the owner edits an unsent initial draft and the shop's notes
// (selection rationale / improvement hypothesis). Each action checks the
// admin itself and the text as the composer does; the database checks the
// admin, the state and the bounds again, and keeps the edit history.

export type DraftResult = { ok: true; message?: string } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FOUND: DraftResult = { ok: false, error: "対象が見つかりません。画面を再読み込みしてください。" };

/** 文面を保存. `draftVersion` is the revision the owner edited; a newer one (another tab) is not overwritten. */
export async function editDraft(outreachId: string, draftVersion: number, subject: string | null, body: string): Promise<DraftResult> {
  await requireAdmin();
  if (!UUID.test(outreachId) || !Number.isInteger(draftVersion) || typeof body !== "string" || body.length > 5000) return NOT_FOUND;
  if (subject !== null && (typeof subject !== "string" || subject.length > 500)) return NOT_FOUND;
  const supabase = await createAuthClient();
  const row = await loadInitial(supabase, outreachId);
  if (!row || row.kind !== "initial") return NOT_FOUND;
  if (row.status !== "drafted") return { ok: false, error: sendErrorMessage("not_editable") };
  const checked = checkDraftMessage({ channel: row.channel, subject, body });
  if (!checked.ok) return { ok: false, error: DRAFT_PROBLEM_LABEL[checked.reason] };
  // The edited message must still compose into a sendable message (mailto length, recipient, demo).
  if (!composedFor(row, checked.body, checked.subject)) {
    return { ok: false, error: "この文面ではメール / DM を作れません（長すぎるか、宛先・デモが正しくありません）。" };
  }
  const { data, error } = await supabase.rpc("sales_update_outreach_draft", {
    p_outreach_id: outreachId,
    p_draft_version: draftVersion,
    p_subject: checked.subject,
    p_body: checked.body,
  });
  if (error) return { ok: false, error: sendErrorMessage(error.message, "保存できませんでした。画面を再読み込みしてください。") };
  revalidatePath("/admin/sales");
  const replayed = (data as { replayed?: boolean } | null)?.replayed === true;
  return { ok: true, message: replayed ? "変更はありませんでした。" : "文面を保存しました。送る前にもう一度承認してください。" };
}

/** 選んだ理由 / 改善の仮説 (owner). An empty text removes the note (shown as 未確認 again). */
export async function setInsight(prospectId: string, kind: InsightKind, body: string): Promise<DraftResult> {
  await requireAdmin();
  if (!UUID.test(prospectId) || !(INSIGHT_KINDS as readonly string[]).includes(kind) || typeof body !== "string" || body.length > 2000) return NOT_FOUND;
  const checked = checkInsight(body);
  if (!checked.ok) return { ok: false, error: INSIGHT_PROBLEM_LABEL[checked.reason] };
  const supabase = await createAuthClient();
  const { error } = await supabase.rpc("sales_set_prospect_insight", { p_prospect_id: prospectId, p_kind: kind, p_body: checked.body ?? "" });
  if (error) return { ok: false, error: "保存できませんでした。画面を再読み込みしてください。" };
  revalidatePath("/admin/sales");
  return { ok: true, message: checked.body ? "保存しました。" : "削除しました（未確認に戻りました）。" };
}
