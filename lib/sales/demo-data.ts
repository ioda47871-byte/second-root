import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DesignProfile } from "@/lib/design-agent/profile";
import { isDemoPublic, isWellFormedDemoToken } from "./demo";
import { toDemoView, type DemoView } from "./demo-content";
import { aiDesignEnabled, renderableProfile } from "./design";

// Loads a demo for the public /demo/[publicToken] page. Only the columns
// needed to decide visibility and render are selected — never prospect,
// outreach or run data, never internal ids. Unsent (expires_at null),
// expired and disabled demos are indistinguishable from unknown tokens.
//
// DEV-030: with the AI design step on, a demo whose design is ready is drawn
// with its stored DesignProfile, checked again here (renderableProfile);
// anything else uses the existing template. With the step off the query and
// the result are exactly the legacy ones (no design column is read).

export type PublicDemo = { view: DemoView; profile: DesignProfile | null };

const LEGACY_COLUMNS = "template, content, expires_at, disabled_at, keep_alive";
const DESIGN_COLUMNS = `${LEGACY_COLUMNS}, design_status, design_profile`;

type Row = {
  template: unknown;
  content: unknown;
  expires_at: string | null;
  disabled_at: string | null;
  keep_alive: boolean | null;
  design_status?: unknown;
  design_profile?: unknown;
};

export async function loadPublicDemo(
  db: SupabaseClient,
  token: string,
  now: Date = new Date(),
  env: Record<string, string | undefined> = process.env,
): Promise<PublicDemo | null> {
  if (!isWellFormedDemoToken(token)) return null;
  const enabled = aiDesignEnabled(env);
  const { data, error } = await db
    .from("sales_demos")
    .select(enabled ? DESIGN_COLUMNS : LEGACY_COLUMNS)
    .eq("public_token", token)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as unknown as Row;
  const visible = isDemoPublic(
    {
      expiresAt: row.expires_at ? new Date(row.expires_at) : null,
      disabledAt: row.disabled_at ? new Date(row.disabled_at) : null,
      keepAlive: Boolean(row.keep_alive),
    },
    now,
  );
  if (!visible) return null;
  const view = toDemoView(row.template, row.content);
  if (!view) return null;
  return { view, profile: renderableProfile({ enabled, status: row.design_status, profile: row.design_profile }) };
}
