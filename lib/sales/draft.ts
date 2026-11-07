import { checkpointProblem } from "./checkpoint";
import type { Channel } from "./types";

// DEV-195: the rules for the owner-written part of an initial message — the
// same rules the composer applies to Operational Claude's draft in
// prepareCandidate (lib/sales/prepare.ts): subject ≤ 100 (email only; empty
// takes the default), body 1–1200 after trimming, no contact details or links
// (the demo URL, disclaimer, opt-out line and signature are added when the
// message is composed, so they can never be edited away), and no raw HTML,
// embedded data or secrets. sales_update_outreach_draft re-checks the bounds.

export const DEFAULT_EMAIL_SUBJECT = "ホームページのご提案（Second Root）";
export const MAX_SUBJECT_LENGTH = 100;
export const MAX_BODY_LENGTH = 1200;

// Contact details and links never go into facts shown on a demo or into a message.
const EMAIL_LIKE = /[^\s@＠]+[@＠][^\s@＠]+\.[^\s@＠]+/;
const LINK_LIKE = /(https?:|www\.|\b[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|net|org|jp|co|me|io|info|biz|shop|link|site)\b)/i;

export function containsContactOrLink(value: string): boolean {
  const s = value.normalize("NFKC");
  return EMAIL_LIKE.test(s) || LINK_LIKE.test(s);
}

export type DraftProblem = "empty" | "too_long" | "subject_too_long" | "contact_or_link" | "unsafe_content";

export type DraftCheck = { ok: true; subject: string | null; body: string } | { ok: false; reason: DraftProblem };

export function checkDraftMessage(input: { channel: Channel; subject: string | null; body: string }): DraftCheck {
  const body = input.body.trim();
  if (body.length === 0) return { ok: false, reason: "empty" };
  if (body.length > MAX_BODY_LENGTH) return { ok: false, reason: "too_long" };
  let subject: string | null = null;
  if (input.channel === "email") {
    subject = (input.subject ?? "").replace(/[\r\n]+/g, " ").trim() || DEFAULT_EMAIL_SUBJECT;
    if (subject.length > MAX_SUBJECT_LENGTH) return { ok: false, reason: "subject_too_long" };
  }
  if (containsContactOrLink(body) || containsContactOrLink(subject ?? "")) return { ok: false, reason: "contact_or_link" };
  if (checkpointProblem({ subject, body }) !== null) return { ok: false, reason: "unsafe_content" };
  return { ok: true, subject, body };
}

export const DRAFT_PROBLEM_LABEL: Record<DraftProblem, string> = {
  empty: "本文を入力してください。",
  too_long: `本文が長すぎます（${MAX_BODY_LENGTH}文字まで）。`,
  subject_too_long: `件名が長すぎます（${MAX_SUBJECT_LENGTH}文字まで）。`,
  contact_or_link: "メールアドレスや URL は入れられません（デモの URL・署名・配信停止の文は送信時に自動で付きます）。",
  unsafe_content: "入れられない内容（HTML や鍵のような文字列）が含まれています。",
};
