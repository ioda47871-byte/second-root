import { REPLY_TYPES, type ReplyType } from "@/lib/sales/types";

// Checks a reply draft written by Operational Claude before it is stored
// (docs/INSTAGRAM_MESSAGING.md §5). A draft is only ever a suggestion — a
// human approves every reply (DEV-022 / DEV-023) — but the server still
// refuses drafts that add contact details or links, and flags drafts that
// touch price, schedule or contract terms for a closer human look.

/** Instagram accepts at most 1000 UTF-8 bytes of text per message. */
export const MAX_DRAFT_BYTES = 1000;

const EMAIL = /[^\s@＠]+[@＠][^\s@＠]+\.[^\s@＠]+/;
const PHONE = /(\+?81[-\s]?|0)\d{1,4}[-\s(（]?\d{1,4}[-\s)）]?\d{3,4}/;
const URL_LIKE = /(https?:\/\/[^\s）)」』]+|www\.[^\s）)」』]+)/gi;

const REVIEW_RULES: Array<[string, RegExp]> = [
  ["price", /(円|万|料金|価格|費用|見積|値引|割引|無料|タダ|キャンペーン)/],
  ["schedule", /(納期|日程|いつまで|何日|週間|ヶ月|か月|カ月|今週|来週|今月|来月|即日|すぐに公開)/],
  ["contract", /(契約|解約|保証|返金|約束|必ず|確実に|絶対)/],
];

// Explicit refusal of future contact (MVP_SPEC §6). A plain 「今回は結構です」
// is a decline, not this.
const REFUSAL = [
  /(今後|以後|二度と|もう)[^。！!？?\n]{0,12}(連絡|DM|ＤＭ|メッセージ|営業|案内|送信)[^。！!？?\n]{0,8}(しないで|しないでください|不要|いりません|お断り|結構|控えて|やめて|送らないで)/,
  /(営業|勧誘|セールス)[^。！!？?\n]{0,6}(お断り|禁止|不要|迷惑)/,
  /(連絡|DM|ＤＭ|メッセージ)[^。！!？?\n]{0,6}(送らないで|しないでください|迷惑です|やめてください)/,
  /(ブロック|通報)します/,
];

export function detectExplicitRefusal(text: string | null | undefined): boolean {
  if (!text) return false;
  const s = text.normalize("NFKC");
  return REFUSAL.some((r) => r.test(s));
}

export type DraftInput = { replyType: ReplyType; body: string; futureContactRefused: boolean };

export type DraftCheck =
  | { ok: true; body: string; dncCandidate: boolean; needsHumanReview: boolean; reviewReasons: string[] }
  | { ok: false; reason: "empty" | "too_long" | "contact_details" | "link_not_allowed" | "invalid_reply_type" };

/**
 * @param allowedDemoUrl the matched shop's own demo URL, if any: the only
 *   link a draft may contain.
 * @param latestInbound the message being answered (for refusal detection).
 */
export function checkDraft(input: DraftInput, allowedDemoUrl: string | null, latestInbound: string | null): DraftCheck {
  if (!(REPLY_TYPES as readonly string[]).includes(input.replyType)) return { ok: false, reason: "invalid_reply_type" };
  const body = input.body.replace(/\r\n?/g, "\n").trim();
  if (body.length === 0) return { ok: false, reason: "empty" };
  if (new TextEncoder().encode(body).length > MAX_DRAFT_BYTES) return { ok: false, reason: "too_long" };
  const normalized = body.normalize("NFKC");
  if (EMAIL.test(normalized) || PHONE.test(normalized)) return { ok: false, reason: "contact_details" };
  for (const url of normalized.match(URL_LIKE) ?? []) {
    if (!allowedDemoUrl || url.replace(/[.,、。]+$/, "") !== allowedDemoUrl) return { ok: false, reason: "link_not_allowed" };
  }
  const reviewReasons = REVIEW_RULES.filter(([, r]) => r.test(normalized)).map(([name]) => name);
  const dncCandidate = input.futureContactRefused || detectExplicitRefusal(latestInbound);
  if (dncCandidate) reviewReasons.push("dnc_candidate");
  return { ok: true, body, dncCandidate, needsHumanReview: reviewReasons.length > 0, reviewReasons };
}
