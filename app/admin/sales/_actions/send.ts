"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/admin/auth";
import { createAuthClient } from "@/lib/supabase/server";

// 送信済み (MVP_SPEC §4). Only called after the human has actually sent the
// DM / email in another app. The database function checks the admin again,
// DNC, eligibility and the state machine.

export type SendResult = { ok: true } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function markSent(outreachId: string): Promise<SendResult> {
  await requireAdmin();
  if (!UUID.test(outreachId)) return { ok: false, error: "対象が見つかりません。" };
  const supabase = await createAuthClient();
  const { error } = await supabase.rpc("sales_mark_sent", { p_outreach_id: outreachId });
  if (error) {
    const message = error.message.includes("do_not_contact")
      ? "この店舗は営業不要（DNC）のため送信済みにできません。"
      : "送信済みにできませんでした。画面を再読み込みしてください。";
    return { ok: false, error: message };
  }
  revalidatePath("/admin/sales");
  return { ok: true };
}
