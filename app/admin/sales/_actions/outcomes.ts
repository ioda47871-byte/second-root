"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/admin/auth";
import { REPLY_TYPES } from "@/lib/sales/types";
import { createAuthClient } from "@/lib/supabase/server";

// 返信 / 商談 / 成約 / 失注 (MVP_SPEC §5). Every action checks the admin itself;
// the database checks again and enforces the state machine.

export type OutcomeResult = { ok: true } | { ok: false; error: string };

const id = z.uuid();

async function call(fn: string, args: Record<string, unknown>): Promise<OutcomeResult> {
  const supabase = await createAuthClient();
  const { error } = await supabase.rpc(fn, args);
  if (error) {
    if (error.message.includes("won_amount_required")) return { ok: false, error: "成約金額（1円以上の整数）を入力してください。" };
    if (error.message.includes("refusal_requires_decline")) return { ok: false, error: "「今後の連絡を拒否」は「断り」のときだけ選べます。" };
    return { ok: false, error: "記録できませんでした。画面を再読み込みしてください。" };
  }
  revalidatePath("/admin/sales", "layout");
  return { ok: true };
}

const replySchema = z.object({
  outreachId: id,
  replyType: z.enum(REPLY_TYPES),
  futureContactRefused: z.boolean(),
});

export async function recordReply(input: z.input<typeof replySchema>): Promise<OutcomeResult> {
  await requireAdmin();
  const parsed = replySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "返信の種類を選んでください。" };
  const { outreachId, replyType, futureContactRefused } = parsed.data;
  return call("sales_record_reply", {
    p_outreach_id: outreachId,
    p_reply_type: replyType,
    p_future_contact_refused: futureContactRefused,
  });
}

export async function markMeeting(outreachId: string): Promise<OutcomeResult> {
  await requireAdmin();
  if (!id.safeParse(outreachId).success) return { ok: false, error: "対象が見つかりません。" };
  return call("sales_mark_meeting", { p_outreach_id: outreachId });
}

export async function markWon(outreachId: string, amountJpy: number): Promise<OutcomeResult> {
  await requireAdmin();
  if (!id.safeParse(outreachId).success) return { ok: false, error: "対象が見つかりません。" };
  if (!Number.isInteger(amountJpy) || amountJpy <= 0 || amountJpy > 100_000_000) {
    return { ok: false, error: "成約金額（1円以上の整数）を入力してください。" };
  }
  return call("sales_mark_won", { p_outreach_id: outreachId, p_amount_jpy: amountJpy });
}

export async function markLost(outreachId: string, reason: string): Promise<OutcomeResult> {
  await requireAdmin();
  if (!id.safeParse(outreachId).success) return { ok: false, error: "対象が見つかりません。" };
  return call("sales_mark_lost", { p_outreach_id: outreachId, p_reason: reason.slice(0, 500) });
}
