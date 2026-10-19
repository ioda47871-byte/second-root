import { describe, expect, it } from "vitest";
import { jstCalendarDaysBetween } from "@/lib/sales/dates";
import { elapsedDaysLabel, followUpDueAt, followUpStatus, followUpStatusLabel, isFollowUpDue } from "@/lib/sales/followup";

// DEV-056: days since sending / reply / meeting and the follow-up state shown
// on the 返信 and 商談 tabs. JST calendar days; Japan has no DST.

const at = (iso: string) => new Date(iso);

describe("jstCalendarDaysBetween", () => {
  it.each([
    ["same JST date, 00:00 to 23:59", "2026-10-09T15:00:00Z", "2026-10-10T14:59:59Z", 0],
    ["23:59:59 JST to 00:00 JST the next day", "2026-10-10T14:59:59Z", "2026-10-10T15:00:00Z", 1],
    ["same UTC date but across JST midnight", "2026-10-10T14:00:00Z", "2026-10-10T16:00:00Z", 1],
    ["across a UTC date but the same JST date", "2026-10-10T23:00:00Z", "2026-10-11T01:00:00Z", 0],
    ["a week", "2026-10-10T03:00:00Z", "2026-10-17T02:00:00Z", 7],
    ["across a month and year end", "2026-12-30T16:00:00Z", "2027-01-01T15:00:00Z", 2],
    // US DST ends on 2026-11-01 and Europe's on 2026-10-25: no effect on JST.
    ["across foreign DST changes", "2026-10-24T15:00:00Z", "2026-11-02T15:00:00Z", 9],
  ])("%s", (_, from, to, days) => {
    expect(jstCalendarDaysBetween(at(from), at(to))).toBe(days);
  });

  it("is negative when `to` is earlier", () => {
    expect(jstCalendarDaysBetween(at("2026-10-12T03:00:00Z"), at("2026-10-10T03:00:00Z"))).toBe(-2);
  });
});

describe("elapsedDaysLabel", () => {
  it("says 本日 on the same JST date and N 日 after", () => {
    expect(elapsedDaysLabel("送信", at("2026-10-09T15:00:00Z"), at("2026-10-10T14:59:59Z"))).toBe("本日送信");
    expect(elapsedDaysLabel("送信", at("2026-10-10T14:59:59Z"), at("2026-10-10T15:00:00Z"))).toBe("送信から 1 日");
    expect(elapsedDaysLabel("返信", at("2026-10-01T03:00:00Z"), at("2026-10-11T03:00:00Z"))).toBe("返信から 10 日");
  });
  it("never shows a negative count or a missing date as a number", () => {
    expect(elapsedDaysLabel("商談開始", at("2026-10-12T03:00:00Z"), at("2026-10-10T03:00:00Z"))).toBe("本日商談開始");
    expect(elapsedDaysLabel("返信", null, at("2026-10-10T03:00:00Z"))).toBe("返信: -");
  });
});

describe("followUpStatus", () => {
  // Sent 2026-10-10 12:00 JST: the follow-up is due from 2026-10-15 12:00 JST.
  const sentAt = at("2026-10-10T03:00:00Z");
  const base = { channel: "email" as const, status: "sent" as const, sentAt, hasFollowUp: false, doNotContact: false, demoPublic: true };

  it("is due exactly when isFollowUpDue is (the 5-day rule is not duplicated)", () => {
    for (const now of ["2026-10-15T02:59:59Z", "2026-10-15T03:00:00Z", "2026-10-20T03:00:00Z"]) {
      expect(followUpStatus(base, at(now)).kind === "due").toBe(isFollowUpDue(base, at(now)));
    }
    expect(followUpDueAt(sentAt).toISOString()).toBe("2026-10-15T03:00:00.000Z");
  });

  it.each([
    ["the next day", "2026-10-11T03:00:00Z", 4],
    ["just after JST midnight on day 1", "2026-10-10T15:00:00Z", 4],
    ["just before JST midnight before the due day", "2026-10-14T14:59:59Z", 1],
    ["the due day, before the due time", "2026-10-15T02:59:59Z", 0],
  ])("counts JST calendar days to the due moment: %s", (_, now, daysLeft) => {
    expect(followUpStatus(base, at(now))).toEqual({ kind: "waiting", daysLeft });
  });

  it("days since sending plus days left is always 5 while waiting", () => {
    const late = { ...base, sentAt: at("2026-10-10T14:30:00Z") }; // 23:30 JST
    const now = at("2026-10-10T15:30:00Z"); // 00:30 JST the next day
    expect(jstCalendarDaysBetween(late.sentAt, now)).toBe(1);
    expect(followUpStatus(late, now)).toEqual({ kind: "waiting", daysLeft: 4 });
  });

  it.each([
    ["Instagram", { channel: "instagram" as const }, "instagram"],
    ["a sent follow-up", { hasFollowUp: true }, "sent"],
    ["DNC", { doNotContact: true }, "dnc"],
    ["already replied", { status: "replied" as const }, "none"],
    ["no send date", { sentAt: null }, "none"],
  ])("%s", (_, patch, kind) => {
    expect(followUpStatus({ ...base, ...patch }, at("2026-10-20T03:00:00Z")).kind).toBe(kind);
  });

  it("is not offered when the demo is no longer public (§4.3)", () => {
    expect(followUpStatus({ ...base, demoPublic: false }, at("2026-10-20T03:00:00Z")).kind).toBe("demo_unavailable");
    // Before day 5 the demo state does not matter yet.
    expect(followUpStatus({ ...base, demoPublic: false }, at("2026-10-11T03:00:00Z")).kind).toBe("waiting");
  });

  it("labels each state", () => {
    expect(followUpStatusLabel({ kind: "waiting", daysLeft: 3 })).toBe("フォロー期限まで 3 日");
    expect(followUpStatusLabel({ kind: "waiting", daysLeft: 0 })).toBe("本日フォロー可能になります");
    expect(followUpStatusLabel({ kind: "due" })).toContain("フォロー可能");
    expect(followUpStatusLabel({ kind: "sent" })).toBe("フォロー送信済み");
    expect(followUpStatusLabel({ kind: "instagram" })).toBe("Instagram はフォローなし");
  });
});
