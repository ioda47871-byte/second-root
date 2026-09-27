import { daysBetween } from "./dates";
import { LIMITS, type Channel, type OutreachStatus } from "./types";

// 5-day email follow-up eligibility (MVP_SPEC §4.3): email only, once, only
// while the shop has not replied, never for DNC.

export type FollowUpInput = {
  channel: Channel;
  status: OutreachStatus;
  sentAt: Date | null;
  hasFollowUp: boolean;
  doNotContact: boolean;
};

export function isFollowUpDue(input: FollowUpInput, now: Date): boolean {
  return (
    input.channel === "email" &&
    input.status === "sent" &&
    input.sentAt !== null &&
    !input.hasFollowUp &&
    !input.doNotContact &&
    daysBetween(input.sentAt, now) >= LIMITS.followUpAfterDays
  );
}
