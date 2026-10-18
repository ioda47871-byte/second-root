"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/admin/auth";
import { parseExclusion, type ExclusionInput } from "@/lib/sales/exclusions";
import { createAuthClient } from "@/lib/supabase/server";

// DEV-049: add / remove an exclusion — human admin only. The database checks
// the admin again (SECURITY DEFINER + sales_assert_admin) and the shape.

export type ExclusionResult = { ok: true } | { ok: false; error: string };

const text = z.string().max(1000).catch("");

export async function addExclusion(raw: ExclusionInput): Promise<ExclusionResult> {
  await requireAdmin();
  const input: ExclusionInput = {
    label: text.parse(raw?.label),
    reason: text.parse(raw?.reason),
    note: text.parse(raw?.note),
    instagram: text.parse(raw?.instagram),
    website: text.parse(raw?.website),
    email: text.parse(raw?.email),
    name: text.parse(raw?.name),
    address: text.parse(raw?.address),
  };
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
    p_public_email: v.publicEmail,
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
