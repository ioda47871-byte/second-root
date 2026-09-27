import { normalizeEmail } from "./normalize";
import { parseInstagramProfile, parseSafeHttpUrl } from "./url";

// Outreach text builders (MVP_SPEC §4). The human always sends; these only
// pre-fill the mail app or the clipboard. Never used with Resend.

export const SECOND_ROOT_SIGNATURE = ["──", "Second Root（セカンドルート）", "名古屋の小さなお店のホームページ制作", "https://secondroot.jp"].join("\n");

export const DEMO_DISCLAIMER = "※ Second Root が作成したご提案用のデモです。貴店の公式サイトではありません。";
export const EMAIL_OPT_OUT = "今後このようなご連絡が不要でしたら、このメールにその旨ご返信ください。以後ご連絡いたしません。";
export const DM_OPT_OUT = "ご不要でしたら、その旨お知らせください。以後ご連絡いたしません。";

/** Keeps mailto: URLs within what common mail apps accept. */
export const MAX_MAILTO_LENGTH = 8000;

export type EmailDraft = { to: string; subject: string; body: string };

function assertDemoUrl(demoUrl: string): string {
  if (!parseSafeHttpUrl(demoUrl)) throw new Error("invalid demo url");
  return demoUrl;
}

export function composeEmailBody(input: { shopName: string; message: string; demoUrl: string }): string {
  return [
    `${input.shopName} ご担当者様`,
    "",
    input.message.trim(),
    "",
    "ご提案用のデモページ:",
    assertDemoUrl(input.demoUrl),
    DEMO_DISCLAIMER,
    "",
    EMAIL_OPT_OUT,
    "",
    SECOND_ROOT_SIGNATURE,
  ].join("\n");
}

export function composeFollowUpBody(input: { shopName: string; demoUrl: string }): string {
  return [
    `${input.shopName} ご担当者様`,
    "",
    "先日、ホームページのご提案をお送りした Second Root です。",
    "お忙しいところ恐れ入ります。ご提案用のデモページを改めてお送りします。",
    "",
    assertDemoUrl(input.demoUrl),
    DEMO_DISCLAIMER,
    "",
    "ご連絡はこの1回限りとし、以後こちらからお送りすることはありません。",
    EMAIL_OPT_OUT,
    "",
    SECOND_ROOT_SIGNATURE,
  ].join("\n");
}

export function followUpSubject(initialSubject: string): string {
  return initialSubject.startsWith("Re:") ? initialSubject : `Re: ${initialSubject}`;
}

/**
 * mailto: URL with recipient, subject and body pre-filled (RFC 6068).
 * The recipient must be a single valid address so nothing can be injected
 * into other headers.
 */
export function buildMailto(draft: EmailDraft): string {
  const to = normalizeEmail(draft.to);
  if (!to || to.includes("?") || to.includes("&") || to.includes(",")) throw new Error("invalid recipient");
  // RFC 6068: every line break is CRLF; lone surrogates would make
  // encodeURIComponent throw, so they are replaced first.
  const wellFormed = (s: string) => s.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd");
  const crlf = (s: string) => wellFormed(s).replace(/\r\n|\r|\n/g, "\r\n");
  const url = `mailto:${encodeURIComponent(to).replace(/%40/g, "@")}?subject=${encodeURIComponent(
    wellFormed(draft.subject).replace(/[\r\n]+/g, " "),
  )}&body=${encodeURIComponent(crlf(draft.body))}`;
  if (url.length > MAX_MAILTO_LENGTH) throw new Error("mailto too long");
  return url;
}

export function composeDm(input: { message: string; demoUrl: string }): string {
  return [input.message.trim(), "", assertDemoUrl(input.demoUrl), DEMO_DISCLAIMER, "", DM_OPT_OUT, "", "Second Root（セカンドルート）"].join("\n");
}

/** The only URL the "DMを送る" button opens. */
export function instagramOpenUrl(profileUrl: string): string {
  const profile = parseInstagramProfile(profileUrl);
  if (!profile) throw new Error("invalid instagram url");
  return profile.url;
}
