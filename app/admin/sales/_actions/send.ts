"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/admin/auth";
import { composeFollowUp } from "@/lib/admin/followup";
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
  const { error } = await supabase.rpc("sales_mark_follow_up_sent", {
    p_outreach_id: outreachId,
    p_subject: draft.subject,
    p_body: draft.body,
  });
  if (error) {
    const message = error.message.includes("do_not_contact")
      ? "この店舗は営業不要（DNC）のため送信済みにできません。"
      : error.message.includes("not_due")
        ? "フォローの条件（初回から5日・返信なし）を満たしていません。画面を再読み込みしてください。"
        : "送信済みにできませんでした。画面を再読み込みしてください。";
    return { ok: false, error: message };
  }
  revalidatePath("/admin/sales");
  return { ok: true };
}
