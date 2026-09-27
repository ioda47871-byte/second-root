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
      redirect: "error",
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { username?: unknown };
    return typeof json.username === "string" && USERNAME.test(json.username) ? json.username : null;
  } catch {
    return null;
  }
}

export type SendOutcome =
  | { outcome: "sent"; messageId: string }
  | { outcome: "failed"; errorCode: string }
  | { outcome: "unknown"; errorCode: string };

// Meta documents one case where the message WAS sent although the call
// returned an error; everything we cannot classify as a clear refusal is
// treated as "unknown" and never retried automatically.
const SENT_BUT_ERROR_SUBCODES = new Set([1357046]);

/**
 * Sends one text reply with the official Send API. Only ever called after
 * the human approved the text and the database reserved the send.
 */
export async function sendText(accountId: string, igsid: string, text: string): Promise<SendOutcome> {
  const token = accessToken();
  if (!token) return { outcome: "failed", errorCode: "not_configured" };
  if (!IGSID.test(accountId) || !IGSID.test(igsid)) return { outcome: "failed", errorCode: "invalid_recipient" };
  let res: Response;
  try {
    res = await fetch(`${GRAPH_BASE}/${accountId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: { id: igsid }, message: { text } }),
      signal: AbortSignal.timeout(10000),
      cache: "no-store",
      redirect: "error",
    });
  } catch {
    // Timeout or connection loss: Meta may or may not have sent it.
    return { outcome: "unknown", errorCode: "network" };
  }
  let json: { message_id?: unknown; error?: { code?: unknown; error_subcode?: unknown; is_transient?: unknown } } = {};
  try {
    json = await res.json();
  } catch {
    // An unreadable response gives no proof either way.
    return { outcome: "unknown", errorCode: "unreadable_response" };
  }
  if (res.ok && typeof json.message_id === "string" && json.message_id.length > 0 && json.message_id.length <= 512) {
    return { outcome: "sent", messageId: json.message_id };
  }
  const code = typeof json.error?.code === "number" ? json.error.code : null;
  const subcode = typeof json.error?.error_subcode === "number" ? json.error.error_subcode : null;
  if (subcode !== null && SENT_BUT_ERROR_SUBCODES.has(subcode)) return { outcome: "unknown", errorCode: `meta_${subcode}` };
  if (res.status >= 500) return { outcome: "unknown", errorCode: `http_${res.status}` };
  // Meta's generic / temporary errors (code 1 "unknown", 2 "service", or
  // is_transient) give no proof that nothing was sent.
  if (json.error?.is_transient === true || code === 1 || code === 2) return { outcome: "unknown", errorCode: `meta_${code ?? "transient"}` };
  // 4xx with an error body: Meta refused the request (e.g. window closed,
  // permission, bad recipient). Nothing was sent.
  if (res.status >= 400 && code !== null) return { outcome: "failed", errorCode: `meta_${code}${subcode ? `_${subcode}` : ""}` };
  return { outcome: "unknown", errorCode: `http_${res.status}` };
}
