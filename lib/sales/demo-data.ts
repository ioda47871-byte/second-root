import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isDemoPublic, isWellFormedDemoToken } from "./demo";
import { toDemoView, type DemoView } from "./demo-content";

// Loads a demo for the public /demo/[publicToken] page. Only the columns
// needed to decide visibility and render are selected — never prospect,
// outreach or run data, never internal ids. Unsent (expires_at null),
// expired and disabled demos are indistinguishable from unknown tokens.

export async function loadPublicDemo(db: SupabaseClient, token: string, now: Date = new Date()): Promise<DemoView | null> {
  if (!isWellFormedDemoToken(token)) return null;
  const { data, error } = await db
    .from("sales_demos")
    .select("template, content, expires_at, disabled_at, keep_alive")
    .eq("public_token", token)
    .maybeSingle();
  if (error || !data) return null;
  const visible = isDemoPublic(
    {
      expiresAt: data.expires_at ? new Date(data.expires_at) : null,
      disabledAt: data.disabled_at ? new Date(data.disabled_at) : null,
      keepAlive: Boolean(data.keep_alive),
    },
    now,
  );
  if (!visible) return null;
  return toDemoView(data.template, data.content);
}
