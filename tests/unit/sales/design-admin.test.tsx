import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import TodayCard from "@/components/admin/TodayCard";
import type { SupabaseClient } from "@supabase/supabase-js";
import { todaySelect, type TodayItem } from "@/lib/admin/today";
import type { ReviewSummary } from "@/lib/design-agent/review-summary";
import { loadPublicDemo } from "@/lib/sales/demo-data";
import { DESIGN_STATUSES, type DesignStatus, designErrorLabel } from "@/lib/sales/design";

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
    designErrorCode: null,
    designReview: null,
  };
}

const render = (i: TodayItem) => renderToStaticMarkup(<TodayCard item={i} now={now} action={<button>DMを送る</button>} />);

describe("TodayCard design state", () => {
  it("DEV-053: shows why a design is blocked (e.g. the quality gate) and nothing for ready", () => {
    const blocked = render({ ...item("blocked"), designErrorCode: "QUALITY_NOT_ACCEPTED" });
    expect(blocked).toContain('data-testid="design-error"');
    expect(blocked).toContain(designErrorLabel("QUALITY_NOT_ACCEPTED")!);
    expect(render({ ...item("ready"), designErrorCode: null })).not.toContain('data-testid="design-error"');
    expect(render({ ...item("blocked"), designErrorCode: null })).not.toContain('data-testid="design-error"');
  });

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

// DEV-058: the stored review summary, in the card's folded details only.
describe("TodayCard review summary", () => {
  const REVIEW: ReviewSummary = {
    version: 1,
    verdict: "accept",
    total: 19,
    max: 25,
    scores: { brand_fit: 4, visual_quality: 4, hierarchy: 4, mobile_quality: 4, generic_template_feel: 3 },
    rounds: 2,
    confidence: 0.72,
    qualityNotAccepted: false,
  };
  const detailsOf = (html: string) => html.slice(html.indexOf("<details"), html.indexOf("</details>"));

  it("shows the verdict, the total and the rounds, with the axis scores, inside the folded details", () => {
    const html = render({ ...item("ready"), designReview: REVIEW });
    const details = detailsOf(html);
    expect(details).toContain('data-testid="design-review"');
    expect(details).toContain("AI レビュー: accept 19/25（2 回）");
    for (const axis of ["店らしさ 4/5", "見た目 4/5", "情報の階層 4/5", "スマホ 4/5", "テンプレ感（低いほど良い） 3/5", "確信度 0.72"]) expect(details).toContain(axis);
    expect(html.indexOf('data-testid="design-review"')).toBeGreaterThan(html.indexOf("<details"));
  });

  it("a quality-gate block shows its revise summary next to the reason", () => {
    const html = render({ ...item("blocked"), designErrorCode: "QUALITY_NOT_ACCEPTED", designReview: { ...REVIEW, verdict: "revise", total: 15, scores: { ...REVIEW.scores, brand_fit: 2, visual_quality: 2 }, rounds: 3, qualityNotAccepted: true } });
    expect(html).toContain('data-verdict="revise"');
    expect(html).toContain("AI レビュー: revise 15/25（3 回）");
  });

  it("nothing without a summary, for a follow-up, or for a legacy item", () => {
    expect(render(item("ready"))).not.toContain("design-review");
    expect(render({ ...item("pending", "follow_up"), designReview: REVIEW })).not.toContain("design-review");
    expect(render(item(null))).not.toContain("AI レビュー");
  });
});

describe("queries (DEV-058)", () => {
  it("today's query reads design_review only with the step on; off it is the legacy one", () => {
    expect(todaySelect(false)).not.toMatch(/design_/);
    expect(todaySelect(false)).toContain("demo:sales_demos(public_token, disabled_at))");
    expect(todaySelect(true)).toContain("design_status, design_error_code, design_review");
  });

  it("the public demo never reads design_review, with the step on or off", async () => {
    const selects: string[] = [];
    const db = {
      from: () => ({
        select: (columns: string) => {
          selects.push(columns);
          return { eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) };
        },
      }),
    } as unknown as SupabaseClient;
    for (const env of [{}, { SALES_AI_DESIGN_ENABLED: "true" }]) await loadPublicDemo(db, "A".repeat(43), now, env);
    expect(selects).toHaveLength(2);
    for (const s of selects) expect(s).not.toContain("design_review");
  });
});
