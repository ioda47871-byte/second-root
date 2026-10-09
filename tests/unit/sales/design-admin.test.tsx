import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import TodayCard from "@/components/admin/TodayCard";
import type { TodayItem } from "@/lib/admin/today";
import { DESIGN_STATUSES, type DesignStatus } from "@/lib/sales/design";

// DEV-030 admin UX: the today card shows the demo's AI design state and,
// when ready, a direct way to the demo preview. A legacy item (no design
// state, or the step off) renders exactly as before.

const now = new Date("2026-10-10T00:00:00Z");

function item(designStatus: DesignStatus | null, kind: "initial" | "follow_up" = "initial"): TodayItem {
  return {
    kind,
    prospectId: "11111111-2222-4333-8444-555555555555",
    doNotContact: false,
    since: now,
    outreachId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    channel: "instagram",
    shopName: "テスト工房",
    category: "bakery",
    ward: "中区",
    subject: null,
    body: "テスト用の営業文です。",
    instagramUrl: "https://www.instagram.com/test_shop/",
    publicEmail: null,
    demoToken: "A".repeat(43),
    sentAt: kind === "follow_up" ? now.toISOString() : null,
    designStatus,
  };
}

const render = (i: TodayItem) => renderToStaticMarkup(<TodayCard item={i} now={now} action={<button>DMを送る</button>} />);

describe("TodayCard design state", () => {
  it.each([
    ["pending", "AIデザイン待ち"],
    ["processing", "AIデザイン生成中"],
    ["ready", "デモ確認可能"],
    ["blocked", "デザインBLOCKED"],
    ["failed", "AIデザイン失敗"],
  ] as const)("%s → %s", (status, label) => {
    const html = render(item(status));
    expect(html).toContain(`data-design="${status}"`);
    expect(html).toContain(label);
  });

  it("ready links straight to the demo preview; blocked / failed say the existing template is used", () => {
    expect(render(item("ready"))).toContain('data-testid="design-preview"');
    expect(render(item("ready"))).toContain('href="/admin/preview/11111111-2222-4333-8444-555555555555"');
    for (const s of ["blocked", "failed"] as const) expect(render(item(s))).toContain("既存テンプレートのデモで送れます");
    for (const s of DESIGN_STATUSES.filter((s) => s !== "ready")) expect(render(item(s))).not.toContain('data-testid="design-preview"');
  });

  it("a legacy item and a follow-up show no design state at all", () => {
    const legacy = render(item(null));
    expect(legacy).not.toContain("data-design");
    expect(legacy).not.toContain("AIデザイン");
    expect(render(item("pending", "follow_up"))).not.toContain("data-design");
  });
});
