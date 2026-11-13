import { normaliseOrigin } from "./demo-version/csp";

/**
 * DEV-196g (PR #267 L2, §6.8): host gating. A request that came to the configured artifact origin's host is refused
 * unless it is the share artifact route `/demo-frame/p/…` (everything else — admin, the share page, APIs, the site —
 * belongs to the app origin only). Unset or malformed artifact origin → nothing is refused here (no artifact host).
 */
export function artifactHostRefused(o: { host: string | null; pathname: string; artifactOrigin: string | undefined }): boolean {
  const art = normaliseOrigin(o.artifactOrigin ?? null);
  if (art === null || !o.host) return false;
  if (o.host.toLowerCase() !== new URL(art).host) return false;
  return !o.pathname.startsWith("/demo-frame/p/");
}
