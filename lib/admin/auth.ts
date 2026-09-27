import "server-only";
import { redirect } from "next/navigation";
import { createAuthClient } from "@/lib/supabase/server";

// Admin gate for /admin/sales. Signed-in is not enough: the user must be on
// the sales_admins allowlist (checked by the database).

export type AdminSession = { userId: string; email: string | null };

export async function getAdminState(): Promise<{ kind: "anonymous" } | { kind: "forbidden"; email: string | null } | { kind: "admin"; session: AdminSession }> {
  let supabase;
  try {
    supabase = await createAuthClient();
  } catch {
    // Not configured: nobody is signed in (fail closed).
    return { kind: "anonymous" };
  }
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return { kind: "anonymous" };
  const { data: isAdmin, error: rpcError } = await supabase.rpc("is_sales_admin");
  if (rpcError || isAdmin !== true) return { kind: "forbidden", email: data.user.email ?? null };
  return { kind: "admin", session: { userId: data.user.id, email: data.user.email ?? null } };
}

/** For admin pages and actions: redirects to login, or throws for non-admins. */
export async function requireAdmin(): Promise<AdminSession> {
  const state = await getAdminState();
  if (state.kind === "anonymous") redirect("/admin/login");
  if (state.kind === "forbidden") throw new Error("forbidden");
  return state.session;
}
