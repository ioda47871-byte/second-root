"use server";

import { redirect } from "next/navigation";
import { createAuthClient } from "@/lib/supabase/server";

// Email + password only (MVP). The error never says which part was wrong.

export type LoginState = { error: string | null };

export async function signIn(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password || email.length > 254 || password.length > 200) {
    return { error: "メールアドレスまたはパスワードが正しくありません。" };
  }
  let supabase;
  try {
    supabase = await createAuthClient();
  } catch {
    return { error: "現在ログインできません。" };
  }
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { error: "メールアドレスまたはパスワードが正しくありません。" };
  redirect("/admin/sales");
}

export async function signOut(): Promise<void> {
  try {
    const supabase = await createAuthClient();
    await supabase.auth.signOut();
  } catch {
    // Nothing to sign out of.
  }
  redirect("/admin/login");
}
