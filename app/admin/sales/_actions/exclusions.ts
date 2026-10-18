"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/admin/auth";
import { emailDigest } from "@/lib/sales/email-digest";
import { parseExclusion, type ExclusionInput } from "@/lib/sales/exclusions";
import { createAuthClient } from "@/lib/supabase/server";

// DEV-049: add / remove an exclusion — human admin only. The database checks
// the admin again (SECURITY DEFINER + sales_assert_admin) and the shape.
// DEV-050: an email leaves this function only as its digest; nothing here
// logs or echoes the input, and `next dev`'s Server Function argument log is
// off (next.config.ts logging.serverFunctions).

export type ExclusionResult = { ok: true } | { ok: false; error: string };

// Missing fields are empty; an over-long or non-string field is refused
// (never silently dropped, which would save an entry without that key).
const field = z.string().max(1000).optional();
const inputSchema = z.object({
  label: field,
  reason: field,
  note: field,
  instagram: field,
  website: field,
  email: field,
  name: field,
  address: field,
});

export async function addExclusion(raw: ExclusionInput): Promise<ExclusionResult> {
  await requireAdmin();
  const checked = inputSchema.safeParse(raw ?? {});
  if (!checked.success) return { ok: false, error: "入力が長すぎるか、形式が正しくありません。" };
  const d = checked.data;
  const input: ExclusionInput = { ...d, label: d.label ?? "", reason: d.reason ?? "" };
  const parsed = parseExclusion(input);
  if (!parsed.ok) return parsed;
  const v = parsed.value;
  const supabase = await createAuthClient();
  const { error } = await supabase.rpc("sales_add_exclusion", {
    p_label: v.label,
    p_reason: v.reason,
    p_note: v.note,
    p_instagram_handle: v.instagramHandle,
    p_website_domain: v.websiteDomain,
    p_email_digest: v.normalizedEmail ? emailDigest(v.normalizedEmail) : null,
    p_normalized_name: v.normalizedName,
    p_normalized_address: v.normalizedAddress,
  });
  if (error) {
    if (error.message.includes("already_excluded")) return { ok: false, error: "同じ Instagram・サイト・メール・店名+住所がすでに除外リストにあります。" };
    return { ok: false, error: "追加できませんでした。入力を確認して、もう一度お試しください。" };
  }
  revalidatePath("/admin/sales", "layout");
  return { ok: true };
}

export async function removeExclusion(id: string): Promise<ExclusionResult> {
  await requireAdmin();
  if (!z.uuid().safeParse(id).success) return { ok: false, error: "対象が見つかりません。" };
  const supabase = await createAuthClient();
  const { error } = await supabase.rpc("sales_remove_exclusion", { p_id: id });
  if (error) return { ok: false, error: "削除できませんでした。画面を再読み込みしてください。" };
  revalidatePath("/admin/sales", "layout");
  return { ok: true };
}
