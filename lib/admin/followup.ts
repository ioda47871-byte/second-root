import "server-only";
import { composeFollowUpBody, followUpSubject } from "@/lib/sales/messages";
import { demoUrl } from "./today";

// The follow-up email (MVP_SPEC §4.3) is composed only here, so the mailto
// the admin opens and the text recorded on 送信済み are always identical.

export const DEFAULT_SUBJECT = "ホームページのご提案（Second Root）";

export type FollowUpDraft = { to: string; subject: string; body: string };

export function composeFollowUp(input: {
  shopName: string;
  publicEmail: string;
  initialSubject: string | null;
  demoToken: string;
}): FollowUpDraft {
  return {
    to: input.publicEmail,
    subject: followUpSubject(input.initialSubject ?? DEFAULT_SUBJECT),
    body: composeFollowUpBody({ shopName: input.shopName, demoUrl: demoUrl(input.demoToken) }),
  };
}
