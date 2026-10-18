import { LIMITS } from "./types";

// Today's work queue (MVP_SPEC §3.1): at most 5 actions, due email
// follow-ups first, then unsent initial drafts (oldest first). DNC shops never
// appear. DEV-048: drafts that can be sent now come before drafts still
// waiting for their AI design, so waiting drafts never hide sendable ones.

export type QueueItem = {
  kind: "follow_up" | "initial";
  prospectId: string;
  doNotContact: boolean;
  /** Follow-up: initial sent_at. Initial: draft created_at. */
  since: Date;
  /** DEV-048: false while the draft waits for its AI design (absent = sendable). */
  sendable?: boolean;
};

export function selectWorkQueue<T extends QueueItem>(items: T[], limit: number = LIMITS.workQueue): T[] {
  const eligible = items.filter((i) => !i.doNotContact);
  const byAge = (a: T, b: T) => a.since.getTime() - b.since.getTime();
  const followUps = eligible.filter((i) => i.kind === "follow_up").sort(byAge);
  const waiting = (i: T) => (i.sendable === false ? 1 : 0);
  const initials = eligible.filter((i) => i.kind === "initial").sort((a, b) => waiting(a) - waiting(b) || byAge(a, b));
  return [...followUps, ...initials].slice(0, limit);
}

/** New actionable slots left today given how many were created today (JST). */
export function remainingDailyCapacity(createdToday: number): number {
  return Math.max(0, LIMITS.dailyNewActionable - createdToday);
}
