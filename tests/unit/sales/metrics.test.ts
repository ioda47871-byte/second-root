import { describe, expect, it } from "vitest";
import { formatYen, groupMetrics, rate, valueLabel, type MetricRow } from "@/lib/sales/metrics";

describe("metrics helpers", () => {
  it("formats rates and handles zero", () => {
    expect(rate(1, 3)).toBe("33%");
    expect(rate(0, 0)).toBe("-");
  });

  it("groups by dimension in a fixed order, biggest first", () => {
    const rows: MetricRow[] = [
      { dimension: "channel", value: "email", sent: 2, replied: 1, meetings: 0, won: 0, wonAmountJpy: 0 },
      { dimension: "total", value: "all", sent: 5, replied: 2, meetings: 1, won: 1, wonAmountJpy: 100000 },
      { dimension: "channel", value: "instagram", sent: 3, replied: 1, meetings: 1, won: 1, wonAmountJpy: 100000 },
    ];
    expect(groupMetrics(rows).map((g) => [g.dimension, g.rows.map((r) => r.value)])).toEqual([
      ["total", ["all"]],
      ["channel", ["instagram", "email"]],
    ]);
  });

  it("labels values in Japanese and formats yen", () => {
    expect(valueLabel("not_found")).toBe("サイトなし");
    expect(valueLabel("baked_goods")).toBe("焼菓子店");
    expect(formatYen(198000)).toBe("¥198,000");
  });
});
