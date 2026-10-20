import { createHash } from "node:crypto";
import { z } from "zod";
import type { DesignProfile } from "../profile";
import { isGuardedShopCss, type GuardedShopCss } from "./guard";

// The local design preview's record of an accepted per-shop stylesheet
// (DEV-072). Written after shopCssOrFallback accepted it (apply.ts); read by
// the preview loader. Kept apart from the render check so the preview route
// never imports browser code.

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export const profileDigest = (profile: DesignProfile) => sha256(stable(profile));

/** `<candidate>.shop-css.json` in a preview run: an accepted stylesheet, bound to its run, candidate and profile. */
export const ShopCssRecordSchema = z.strictObject({
  version: z.literal(1),
  runId: z.string().max(80),
  candidate: z.string().max(40),
  profileSha256: z.string().regex(/^[0-9a-f]{64}$/),
  cssSha256: z.string().regex(/^[0-9a-f]{64}$/),
  css: z.string().max(64 * 1024),
  report: z.strictObject({ accepted: z.literal(true), guard: z.array(z.string()).max(0), render: z.array(z.string()).max(0) }),
});
export type ShopCssRecord = z.infer<typeof ShopCssRecordSchema>;

export function shopCssRecord(runId: string, candidate: string, profile: DesignProfile, css: GuardedShopCss): ShopCssRecord {
  return { version: 1, runId, candidate, profileSha256: profileDigest(profile), cssSha256: sha256(css), css, report: { accepted: true, guard: [], render: [] } };
}

/**
 * The stylesheet of a stored record, or null (fallback) unless it is for this
 * run, candidate and profile, its hash matches, and the guard passes it again
 * unchanged. The render check is not repeated here (it needs Chromium); the
 * record says it passed, and the guard is the security boundary.
 */
export function shopCssFromRecord(raw: unknown, runId: string, candidate: string, profile: DesignProfile): GuardedShopCss | null {
  const parsed = ShopCssRecordSchema.safeParse(raw);
  if (!parsed.success) return null;
  const r = parsed.data;
  if (r.runId !== runId || r.candidate !== candidate || r.profileSha256 !== profileDigest(profile) || r.cssSha256 !== sha256(r.css)) return null;
  return isGuardedShopCss(r.css) ? r.css : null;
}
