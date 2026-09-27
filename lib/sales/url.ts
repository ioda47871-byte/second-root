// URL validation (docs/SECURITY.md §3). Only http(s) URLs without
// credentials are accepted; everything else (javascript:, data:, file:, …)
// is rejected. The server never fetches these URLs.

const MAX_URL_LENGTH = 2048;

export function parseSafeHttpUrl(input: unknown): URL | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (!url.hostname || !url.hostname.includes(".")) return null;
  return url;
}

export function isSafeHttpUrl(input: unknown): input is string {
  return parseSafeHttpUrl(input) !== null;
}

/** Lower-cased host without a leading "www.", used as a dedupe key. */
export function websiteDomain(input: string): string | null {
  const url = parseSafeHttpUrl(input);
  if (!url) return null;
  return url.hostname.toLowerCase().replace(/^www\./, "");
}

const INSTAGRAM_HOSTS = new Set(["instagram.com", "www.instagram.com"]);
const INSTAGRAM_RESERVED = new Set(["p", "reel", "reels", "explore", "stories", "tv", "accounts", "direct", "about", "developer", "legal"]);
const HANDLE_PATTERN = /^[a-z0-9._]{1,30}$/;

/** Canonical Instagram profile: { url: https://www.instagram.com/<handle>/, handle }. */
export function parseInstagramProfile(input: unknown): { url: string; handle: string } | null {
  const url = parseSafeHttpUrl(input);
  if (!url || url.protocol !== "https:" || !INSTAGRAM_HOSTS.has(url.hostname.toLowerCase())) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 1) return null;
  const handle = segments[0].toLowerCase();
  if (!HANDLE_PATTERN.test(handle) || INSTAGRAM_RESERVED.has(handle)) return null;
  return { url: `https://www.instagram.com/${handle}/`, handle };
}
