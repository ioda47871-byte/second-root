"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/admin/auth";
import { createAuthClient } from "@/lib/supabase/server";

// Manual DNC and its removal — human admin only (MVP_SPEC §6). Operational
// Claude has no path to these.

export type DncResult = { ok: true } | { ok: false; error: string };

async function call(fn: "sales_set_dnc" | "sales_clear_dnc", prospectId: string): Promise<DncResult> {
  await requireAdmin();
  if (!z.uuid().safeParse(prospectId).success) return { ok: false, error: "対象が見つかりません。" };
  const supabase = await createAuthClient();
  const { error } = await supabase.rpc(fn, { p_prospect_id: prospectId });
  if (error) return { ok: false, error: "変更できませんでした。画面を再読み込みしてください。" };
  revalidatePath("/admin/sales", "layout");
  return { ok: true };
}

export async function setDnc(prospectId: string): Promise<DncResult> {
  return call("sales_set_dnc", prospectId);
}

export async function clearDnc(prospectId: string): Promise<DncResult> {
  return call("sales_clear_dnc", prospectId);
}
