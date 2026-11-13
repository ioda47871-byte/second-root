import "server-only";
/**
 * DEV-196g (spec §6.1・§6.4・§6.6・§6.8・§9.4, owner decision 2026-11-10): what the share page `/demo/[publicToken]`
 * shows while versioned sharing is on (SALES_DEMO_SHARE_ENABLED; the caller does not call this when it is off, so the
 * page is then exactly what it was before).
 *
 * The database decides (sales_resolve_demo_share, service role — the one authority; the artifact route asks it again
 * for every file):
 *  - "version": the version a `sent` approval pinned at send approval. The page draws only the trusted outer frame
 *    (the MVP_SPEC §7 notice) and a sandboxed iframe of `/demo-frame/p/<30-min view token>/index.html` on the dedicated
 *    artifact origin. Settings missing or malformed → not found (never the React demo instead).
 *  - "legacy": no sent approval pinned a version → the existing React demo, unchanged.
 *  - "none" / anything unreadable → not found. Never another version, the newest version or the React demo.
 *
 * Only the shop's name (for the notice and the title) is read besides the decision; no internal id leaves the server
 * except inside the signed token.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { isWellFormedDemoToken } from "./demo";
import { demoShareConfig, type Env } from "./demo-version/flags";
import { signViewToken } from "./demo-version/view-token";

export type ShareOuter =
  | { kind: "legacy" }
  | { kind: "not_found" }
  | { kind: "version"; frameSrc: string; artifactOrigin: string; shopName: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * PR #267 M1: the share flag is off — may the page draw the React demo? Only when the database answers `legacy` (no
 * sent approval pinned a version). A pinned demo (`version`, or `none`) is not found, never the React demo in its place.
 * A database without the DEV-196c resolver (the function is missing: no version can exist there) is `legacy`, so a
 * project the version migrations were not applied to keeps its React demos; any other error is not found.
 */
/**
 * DEV-263e (PR #267 delta Low, PR #268 L3): "the resolver is missing" is PostgREST's PGRST202 (no such function in the
 * schema cache) or Postgres' 42883 (undefined function), in both cases only when the message names
 * `sales_resolve_demo_share(` itself — 42883 also covers an operator or a helper missing inside a function that exists,
 * and a PGRST202 about another function is not this; both stay not found.
 */
export function resolverMissing(error: { code?: string; message?: string }): boolean {
  if (error.code !== "PGRST202" && error.code !== "42883") return false;
  return typeof error.message === "string" && error.message.includes("sales_resolve_demo_share(");
}

export async function resolveLegacyOnly(db: SupabaseClient, token: string): Promise<boolean> {
  if (!isWellFormedDemoToken(token)) return false;
  try {
    const { data, error } = await db.rpc("sales_resolve_demo_share", { p_public_token: token });
    if (error) return resolverMissing(error);
    return (data as { mode?: unknown } | null)?.mode === "legacy";
  } catch {
    return false;
  }
}

export async function resolveShareOuter(db: SupabaseClient, token: string, o: { env: Env; now: Date }): Promise<ShareOuter> {
  const config = demoShareConfig(o.env);
  // the caller checks the flag first; this answer only keeps a stray call harmless
  if (!config.enabled) return { kind: "legacy" };
  if (!isWellFormedDemoToken(token)) return { kind: "not_found" };
  try {
    const { data, error } = await db.rpc("sales_resolve_demo_share", { p_public_token: token });
    const r = data as { mode?: unknown; version_id?: unknown } | null;
    if (error || !r) return { kind: "not_found" };
    if (r.mode === "legacy") return { kind: "legacy" };
    if (r.mode !== "version" || typeof r.version_id !== "string" || !UUID.test(r.version_id)) return { kind: "not_found" };
    if (!config.ready) return { kind: "not_found" };
    const d = await db.from("sales_demos").select("id, content").eq("public_token", token).maybeSingle();
    const row = d.data as { id?: unknown; content?: unknown } | null;
    if (d.error || !row || typeof row.id !== "string" || !UUID.test(row.id)) return { kind: "not_found" };
    const content = row.content && typeof row.content === "object" && !Array.isArray(row.content) ? (row.content as Record<string, unknown>) : {};
    const name = typeof content.name === "string" ? content.name.trim().slice(0, 80) : "";
    if (!name) return { kind: "not_found" };
    const viewToken = signViewToken({ scope: "p", versionId: r.version_id, demoId: row.id, now: o.now, key: config.key });
    return { kind: "version", frameSrc: `${config.artifactOrigin}/demo-frame/p/${viewToken}/index.html`, artifactOrigin: config.artifactOrigin, shopName: name };
  } catch {
    return { kind: "not_found" };
  }
}
