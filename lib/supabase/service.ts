import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Service-role client for server code only (ingest API, public demo reads).
// Never import this from a client component; `server-only` makes that a
// build error. The key must never reach the browser or Operational Claude.

export function createServiceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase service client is not configured");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
