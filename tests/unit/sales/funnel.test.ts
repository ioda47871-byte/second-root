import { describe, expect, it } from "vitest";
import {
  emptyFunnel,
  funnelStages,
  parseFunnelPeriod,
  periodSince,
  sumDesign,
  sumFunnel,
  type DesignDay,
  type FunnelDay,
} from "@/lib/sales/funnel";

// DEV-057: funnel rates and the 直近 30 日 (JST) boundary.

function day(preparedOn: string, over: Partial<FunnelDay> = {}): FunnelDay {
  return { preparedOn, ...emptyFunnel(), ...over };
}

describe("parseFunnelPeriod", () => {
  it("accepts only the two known periods and defaults to 直近 30 日", () => {
    expect(parseFunnelPeriod("30d")).toBe("30d");
    expect(parseFunnelPeriod("all")).toBe("all");
    for (const bad of [undefined, "", "7d", "ALL", " all", ["all"], ["30d", "all"], "all; drop"]) {
      expect(parseFunnelPeriod(bad)).toBe("30d");
    }
  });
});

describe("periodSince (JST)", () => {
  it("全期間 has no start", () => {
    expect(periodSince("all", new Date("2026-10-19T03:00:00Z"))).toBeNull();
  });

  it("直近 30 日 is today (JST) and the 29 days before", () => {
    // 2026-10-19 12:00 JST → from 2026-09-20.
    expect(periodSince("30d", new Date("2026-10-19T03:00:00Z"))).toBe("2026-09-20");
  });

  it("follows the JST date, not the UTC date, around midnight", () => {
    // 2026-10-19 23:59:59 JST (14:59:59 UTC) is still the 19th.
    expect(periodSince("30d", new Date("2026-10-19T14:59:59Z"))).toBe("2026-09-20");
    // 2026-10-20 00:00 JST (15:00 UTC the 19th) is the 20th: the window moves a day.
    expect(periodSince("30d", new Date("2026-10-19T15:00:00Z"))).toBe("2026-09-21");
  });

  it("includes the first day of the window and excludes the day before", () => {
    const since = periodSince("30d", new Date("2026-10-19T03:00:00Z"));
    const days = [day("2026-09-19", { prepared: 7 }), day("2026-09-20", { prepared: 2 }), day("2026-10-19", { prepared: 3 })];
    expect(sumFunnel(days, since).prepared).toBe(5);
    expect(sumFunnel(days, null).prepared).toBe(12);
  });
});

describe("sumFunnel / funnelStages", () => {
  it("sums every count and reply type across days", () => {
    const total = sumFunnel(
      [
        day("2026-10-01", { prepared: 3, skipped: 1, unsent: 1, sent: 1, replied: 1, dnc: 1, replies: { ...emptyFunnel().replies, decline: 1 } }),
        day("2026-10-02", {
          prepared: 5,
          sent: 5,
          replied: 2,
          meetings: 1,
          won: 1,
          wonAmountJpy: 150000,
          replies: { ...emptyFunnel().replies, interested: 1, meeting_request: 1 },
        }),
      ],
      null,
    );
    expect(total).toMatchObject({ prepared: 8, skipped: 1, unsent: 1, sent: 6, replied: 3, meetings: 1, won: 1, wonAmountJpy: 150000, dnc: 1 });
    expect(total.replies).toEqual({ interested: 1, question: 0, meeting_request: 1, decline: 1, other: 0 });
  });

  it("rates each stage against the one before; 見送り and 送信 against 準備", () => {
    const stages = funnelStages({ ...emptyFunnel(), prepared: 10, skipped: 2, unsent: 3, sent: 5, replied: 2, meetings: 1, won: 1 });
    expect(stages.map((s) => [s.label, s.count, s.base, s.rate])).toEqual([
      ["準備", 10, null, null],
      ["見送り", 2, "prepared", "20%"],
      ["送信", 5, "prepared", "50%"],
      ["返信", 2, "sent", "40%"],
      ["商談", 1, "replied", "50%"],
      ["成約", 1, "meetings", "100%"],
    ]);
  });

  it("shows - for a rate whose previous stage is empty", () => {
    const stages = funnelStages({ ...emptyFunnel(), prepared: 1, unsent: 1 });
    expect(stages.find((s) => s.key === "replied")?.rate).toBe("-");
    expect(funnelStages(emptyFunnel()).find((s) => s.key === "sent")?.rate).toBe("-");
  });
});

describe("sumDesign", () => {
  const days: DesignDay[] = [
    { preparedOn: "2026-09-01", status: "failed", errorCode: "WORKER_FAILED", demos: 9 },
    { preparedOn: "2026-10-01", status: "ready", errorCode: null, demos: 4 },
    { preparedOn: "2026-10-01", status: "blocked", errorCode: "QUALITY_NOT_ACCEPTED", demos: 2 },
    { preparedOn: "2026-10-02", status: "blocked", errorCode: "NO_VISUAL_SOURCE", demos: 2 },
    { preparedOn: "2026-10-02", status: "failed", errorCode: "DESIGN_STALE", demos: 1 },
    { preparedOn: "2026-10-02", status: "pending", errorCode: null, demos: 1 },
  ];

  it("counts by status and lists the most frequent codes first (ties by code)", () => {
    const t = sumDesign(days, "2026-09-20");
    expect(t.total).toBe(10);
    expect(t.byStatus).toEqual({ pending: 1, processing: 0, ready: 4, blocked: 4, failed: 1 });
    expect(t.topErrors).toEqual([
      { code: "NO_VISUAL_SOURCE", count: 2 },
      { code: "QUALITY_NOT_ACCEPTED", count: 2 },
      { code: "DESIGN_STALE", count: 1 },
    ]);
  });

  it("全期間 includes older days and keeps only the top N codes", () => {
    const t = sumDesign(days, null, 1);
    expect(t.total).toBe(19);
    expect(t.topErrors).toEqual([{ code: "WORKER_FAILED", count: 9 }]);
  });
});
