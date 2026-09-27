import { describe, expect, it } from "vitest";
import { demoExpiryFromSent, isDemoPublic, isWellFormedDemoToken } from "@/lib/sales/demo";
import { isFollowUpDue, type FollowUpInput } from "@/lib/sales/followup";
import { remainingDailyCapacity, selectWorkQueue, type QueueItem } from "@/lib/sales/queue";

const now = new Date("2026-10-10T03:00:00Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);

describe("demo visibility", () => {
  it("unsent demos (no expiry yet) are not public", () => {
    expect(isDemoPublic({ expiresAt: null, disabledAt: null, keepAlive: false }, now)).toBe(false);
    expect(isDemoPublic({ expiresAt: null, disabledAt: null, keepAlive: true }, now)).toBe(false);
  });
  it("is public for 30 days after the initial outreach is sent", () => {
    const sentAt = daysAgo(29);
    expect(demoExpiryFromSent(sentAt).getTime() - sentAt.getTime()).toBe(30 * 86_400_000);
    expect(isDemoPublic({ expiresAt: demoExpiryFromSent(sentAt), disabledAt: null, keepAlive: false }, now)).toBe(true);
    expect(isDemoPublic({ expiresAt: demoExpiryFromSent(daysAgo(31)), disabledAt: null, keepAlive: false }, now)).toBe(false);
  });
  it("keep_alive extends a sent demo; disabled always wins", () => {
    const expired = demoExpiryFromSent(daysAgo(60));
    expect(isDemoPublic({ expiresAt: expired, disabledAt: null, keepAlive: true }, now)).toBe(true);
    expect(isDemoPublic({ expiresAt: expired, disabledAt: daysAgo(1), keepAlive: true }, now)).toBe(false);
  });
  it("checks token shape", () => {
    expect(isWellFormedDemoToken("a".repeat(43))).toBe(true);
    expect(isWellFormedDemoToken("123")).toBe(false);
    expect(isWellFormedDemoToken(`${"a".repeat(43)}/`)).toBe(false);
  });
});

describe("5-day email follow-up", () => {
  const due: FollowUpInput = { channel: "email", status: "sent", sentAt: daysAgo(5), hasFollowUp: false, doNotContact: false };
  it("is due 5+ days after an unanswered email", () => {
    expect(isFollowUpDue(due, now)).toBe(true);
  });
  it.each([
    ["before 5 days", { sentAt: daysAgo(4.9) }],
    ["Instagram", { channel: "instagram" as const }],
    ["after a reply", { status: "replied" as const }],
    ["after a decline recorded as lost", { status: "lost" as const }],
    ["already followed up", { hasFollowUp: true }],
    ["DNC", { doNotContact: true }],
    ["never sent", { status: "drafted" as const, sentAt: null }],
  ])("is not due: %s", (_label, patch) => {
    expect(isFollowUpDue({ ...due, ...patch }, now)).toBe(false);
  });
});

describe("work queue and daily capacity", () => {
  const item = (kind: QueueItem["kind"], id: string, age: number, doNotContact = false): QueueItem => ({
    kind,
    prospectId: id,
    since: daysAgo(age),
    doNotContact,
  });

  it("takes at most 5, follow-ups first, oldest first, never DNC", () => {
    const queue = selectWorkQueue([
      item("initial", "i1", 1),
      item("initial", "i2", 3),
      item("follow_up", "f1", 6),
      item("initial", "i3", 2),
      item("follow_up", "f2", 8),
      item("follow_up", "dnc", 9, true),
      item("initial", "i4", 0.5),
      item("initial", "i5", 0.1),
    ]);
    expect(queue.map((q) => q.prospectId)).toEqual(["f2", "f1", "i2", "i3", "i1"]);
  });

  it("does not pad the queue", () => {
    expect(selectWorkQueue([item("initial", "i1", 1)])).toHaveLength(1);
  });

  it("new actionable capacity is 5 per day", () => {
    expect(remainingDailyCapacity(0)).toBe(5);
    expect(remainingDailyCapacity(3)).toBe(2);
    expect(remainingDailyCapacity(7)).toBe(0);
  });
});
