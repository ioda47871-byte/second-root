import { addDays, daysBetween, jstCalendarDaysBetween } from "./dates";
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

/** The moment an initial email becomes eligible for its one follow-up. */
export function followUpDueAt(sentAt: Date): Date {
  return addDays(sentAt, LIMITS.followUpAfterDays);
}

/**
 * Follow-up state of an initial outreach, for the 返信 tab (DEV-056). Display
 * only: whether a follow-up is offered and recorded is still decided by
 * isFollowUpDue, the view sales_followup_due and sales_mark_follow_up_sent.
 * `demoPublic` is the extra §4.3 condition (the follow-up carries the demo URL).
 */
export type FollowUpStatus =
  | { kind: "waiting"; daysLeft: number }
  | { kind: "due" }
  | { kind: "sent" }
  | { kind: "demo_unavailable" }
  | { kind: "instagram" }
  | { kind: "dnc" }
  | { kind: "none" };

export function followUpStatus(input: FollowUpInput & { demoPublic: boolean }, now: Date): FollowUpStatus {
  if (input.channel !== "email") return { kind: "instagram" };
  if (input.hasFollowUp) return { kind: "sent" };
  if (input.doNotContact) return { kind: "dnc" };
  if (input.status !== "sent" || input.sentAt === null) return { kind: "none" };
  if (isFollowUpDue(input, now)) return input.demoPublic ? { kind: "due" } : { kind: "demo_unavailable" };
  // Not due yet, so only the 5 days remain. Counted in JST calendar days:
  // 0 means it becomes due later today.
  return { kind: "waiting", daysLeft: Math.max(0, jstCalendarDaysBetween(now, followUpDueAt(input.sentAt))) };
}

export function followUpStatusLabel(status: FollowUpStatus): string {
  switch (status.kind) {
    case "waiting":
      return status.daysLeft === 0 ? "本日フォロー可能になります" : `フォロー期限まで ${status.daysLeft} 日`;
    case "due":
      return "フォロー可能（今日の画面から送れます）";
    case "sent":
      return "フォロー送信済み";
    case "demo_unavailable":
      return "デモ公開終了のためフォローなし";
    case "instagram":
      return "Instagram はフォローなし";
    case "dnc":
      return "DNC のためフォローなし";
    case "none":
      return "フォロー対象外";
  }
}

/**
 * "送信から N 日" in whole JST calendar days, or "本日送信" on the same JST
 * date (`what` is the event: 送信 / 返信 / 商談開始).
 */
export function elapsedDaysLabel(what: string, at: Date | null, now: Date): string {
  if (!at) return `${what}: -`;
  const days = Math.max(0, jstCalendarDaysBetween(at, now));
  return days === 0 ? `本日${what}` : `${what}から ${days} 日`;
}
