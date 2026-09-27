import "server-only";

// Calls to the official Instagram Graph API (docs/INSTAGRAM_MESSAGING.md §9).
// Only this fixed host is ever contacted, and only with ids we received from
// Meta (digits) — never a URL taken from a payload or a draft (no SSRF).

export const GRAPH_BASE = "https://graph.instagram.com/v26.0";
const IGSID = /^[0-9]{1,32}$/;
const USERNAME = /^[A-Za-z0-9._]{1,30}$/;

function accessToken(): string | null {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  return token && token.length >= 20 ? token : null;
}

/**
 * The sender's Instagram username (available after they messaged us).
 * Returns null when not configured, on any error, or for an odd response:
 * the thread then simply stays unmatched (fail closed).
 */
export async function fetchUsername(igsid: string): Promise<string | null> {
  const token = accessToken();
  if (!token || !IGSID.test(igsid)) return null;
  try {
    const res = await fetch(`${GRAPH_BASE}/${igsid}?fields=username`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { username?: unknown };
    return typeof json.username === "string" && USERNAME.test(json.username) ? json.username : null;
  } catch {
    return null;
  }
}
