import { REPLY_TYPES, type ReplyType } from "@/lib/sales/types";

// Checks a reply draft written by Operational Claude before it is stored
// (docs/INSTAGRAM_MESSAGING.md §5). A draft is only ever a suggestion — a
// human approves every reply (DEV-022 / DEV-023) — but the server still
// refuses drafts that add contact details or links, and flags drafts that
// touch price, schedule or contract terms for a closer human look.

/** Instagram accepts at most 1000 UTF-8 bytes of text per message. */
export const MAX_DRAFT_BYTES = 1000;

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
// Digits separated by hyphen-like characters, dots or spaces; never an
// amount (followed by 円 / 万) or part of a longer number.
const PHONE = /(?<!\d)(?:\+?81[-.\s]?|0)\d{1,4}[-.\s(]?\d{1,4}[-.\s)]?\d{3,4}(?![\d円万])/;
// Any URL scheme (also defanged ones like hxxps://) or any domain-like token
// (bare domains, punycode): Instagram turns bare domains into links.
const SCHEME = /[a-z][a-z0-9+.-]*:\/\/|\b(?:mailto|tel|sms|javascript|data|line):/i;
const DOMAIN = /(?:[a-z0-9-]+\.)+(?:[a-z]{2,}|xn--[a-z0-9-]+)(?![a-z0-9-])/i;
// Internationalized domains (ドメイン.jp, 例え.テスト). Only a real dot counts
// here: 「です。次は」 is an ordinary sentence, not a domain.
const IDN_DOMAIN = /[\p{L}\p{N}ー-]+\.(?:[\p{L}ー]{2,}|xn--[a-z0-9-]+)(?![\p{L}\p{N}ー-])/u;
const IPV4 = /(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/;
// Instagram turns @handles into profile links; LINE IDs are contact details.
const HANDLE = /(?<![\w.@])@[a-z0-9._]{1,30}/i;
const LINE_ID = /(?:LINE|ライン)[^\n]{0,6}(?:ID|@|アカウント)/i;

/** NFKC text without invisible format characters (for wording rules). */
function visible(text: string): string {
  return text.replace(/[\p{Cf}\u2028\u2029]/gu, "").normalize("NFKC");
}

/**
 * Unicode-normalized text without invisible format characters (zero-width
 * spaces and joiners would otherwise hide `evil\u200b.com`), every dash made
 * ASCII and, unless `keepIdeographicStop`, every full stop made ".".
 */
function canonical(text: string, keepIdeographicStop = false): string {
  const s = visible(text).replace(/[\u2010-\u2015\u2212\u30fc\uff70\u301c~]/g, "-");
  return keepIdeographicStop ? s : s.replace(/[。｡．]/g, ".");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Removes the demo URL only where it ends cleanly: end of text, space or closing punctuation. */
function withoutDemoUrl(text: string, demoUrl: string | null): string {
  if (!demoUrl) return text;
  return text.replace(new RegExp(`${escapeRegExp(demoUrl)}(?=$|\\s|[。、」』）！？]|[.!?)](?:$|\\s))`, "g"), " ");
}

const REVIEW_RULES: Array<[string, RegExp]> = [
  ["price", /(円|万|料金|価格|費用|見積|値引|割引|無料|タダ|キャンペーン)/],
  ["schedule", /(納期|日程|いつまで|何日|週間|ヶ月|か月|カ月|今週|来週|今月|来月|即日|すぐに公開)/],
  ["contract", /(契約|解約|保証|返金|約束|必ず|確実に|絶対)/],
];

// Explicit refusal of future contact (MVP_SPEC §6). A plain 「今回は結構です」
// is a decline, not this.
const REFUSAL_ENDINGS = "(しないで|してこないで|こないで|送らないで|送ってこないで|不要|いりません|いらない|要らない|お断り|結構|控えて|お控え|ご遠慮|遠慮|やめて|迷惑)";
const REFUSAL = [
  new RegExp(`(今後|以後|二度と|もう|こういう|このような)[^。！!？?\\n]{0,14}(連絡|DM|メッセージ|営業|案内|送信|送って|して)[^。！!？?\\n]{0,10}${REFUSAL_ENDINGS}`),
  /(?<!営業(?:時間|日)[^。！!？?\n]{0,6})(営業|勧誘|セールス)(?!時間|日)[^。！!？?\n]{0,8}(お断り|禁止|不要|迷惑|ご遠慮|遠慮|お控え)/,
  new RegExp(`(連絡|DM|メッセージ)[^。！!？?\\n]{0,8}${REFUSAL_ENDINGS}`),
  /迷惑[^。！!？?\n]{0,6}(やめて|です)/,
  /(ブロック|通報)します/,
];

// Polite phrases that contain refusal words but invite contact.
const NOT_REFUSAL = /遠慮なく|遠慮せず|(迷惑|結構)(では|じゃ)(ない|ありません)|結構(嬉|うれ|楽|たの|良|よ|いい|助か|大事|気に)/g;

export function detectExplicitRefusal(text: string | null | undefined): boolean {
  if (!text) return false;
  const s = visible(text).replace(NOT_REFUSAL, " ");
  // A plain 「結構です」 without contact words is a decline, not a refusal.
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
  const normalized = canonical(body);
  if (EMAIL.test(normalized) || PHONE.test(normalized) || LINE_ID.test(normalized)) return { ok: false, reason: "contact_details" };
  // The shop's own demo URL is the only link allowed; anything link-like left
  // after removing it is refused.
  // The demo URL is removed before full stops are made ASCII, so 「…URL。次」 still ends it cleanly.
  const restStrict = withoutDemoUrl(visible(body), allowedDemoUrl);
  const rest = canonical(restStrict);
  if (
    SCHEME.test(rest) ||
    DOMAIN.test(rest) ||
    IDN_DOMAIN.test(restStrict) ||
    IPV4.test(rest) ||
    HANDLE.test(rest) ||
    /\/demo\/|\.\.|[\\/]\./.test(rest)
  ) {
    return { ok: false, reason: "link_not_allowed" };
  }
  const reviewReasons = REVIEW_RULES.filter(([, r]) => r.test(visible(body))).map(([name]) => name);
  const dncCandidate = input.futureContactRefused || detectExplicitRefusal(latestInbound);
  if (dncCandidate) reviewReasons.push("dnc_candidate");
  return { ok: true, body, dncCandidate, needsHumanReview: reviewReasons.length > 0, reviewReasons };
}
