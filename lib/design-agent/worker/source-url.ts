// Which pages the design worker may open (DEV-028 worker). Only the public
// profile page of one Instagram account: https, instagram.com or
// www.instagram.com, a single username path segment. Anything else (other
// hosts, IPs, localhost, credentials, ports, post / reel / login paths) is
// refused before a browser is started. Query and fragment are dropped.

const HOSTS = new Set(["instagram.com", "www.instagram.com"]);
export const USERNAME = /^(?!.*\.\.)(?!\.)[A-Za-z0-9._]{1,30}(?<!\.)$/;
/** First path segments that are Instagram pages, not accounts. */
const RESERVED = new Set([
  "p", "reel", "reels", "tv", "stories", "explore", "accounts", "direct", "about", "legal", "developer",
  "web", "challenge", "api", "graphql", "emails", "session", "privacy", "terms", "help", "static", "oauth",
]);

export type ProfileSource = { url: string; username: string };

export function parseInstagramProfileUrl(raw: unknown): ProfileSource | null {
  if (typeof raw !== "string" || raw.length > 200 || /\s/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") return null;
  if (!HOSTS.has(url.hostname)) return null;
  const segments = url.pathname.split("/");
  // "/name" or "/name/" only.
  if (segments[0] !== "" || segments.length > 3 || (segments.length === 3 && segments[2] !== "")) return null;
  const username = segments[1] ?? "";
  if (!USERNAME.test(username) || RESERVED.has(username.toLowerCase())) return null;
  return { url: `https://www.instagram.com/${username}/`, username };
}

/**
 * Whether a page the browser ended up on is still Instagram (after redirects).
 * Login and challenge pages are Instagram too; the capture treats them as a
 * wall separately.
 */
export function isInstagramUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.username === "" && url.password === "" && url.port === "" && HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}
