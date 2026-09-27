import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// Per-request Supabase client acting as the signed-in user (anon key +
// session cookies). Row level security decides what it can read; the
// admin allowlist is enforced by the database, not by this code alone.

export function supabaseAuthConfig(): { url: string; anonKey: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return url && anonKey ? { url, anonKey } : null;
}

export async function createAuthClient() {
  // Reading cookies first also makes every admin page render per request.
  const cookieStore = await cookies();
  const config = supabaseAuthConfig();
  if (!config) throw new Error("Supabase auth is not configured");
  return createServerClient(config.url, config.anonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Called from a Server Component: the proxy refreshes the session.
        }
      },
    },
  });
}
