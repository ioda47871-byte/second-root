import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import FunnelSummary from "@/components/admin/FunnelSummary";
import { emptyFunnel, sumDesign } from "@/lib/sales/funnel";

// DEV-057: the 履歴 funnel section. The design table appears only when the
// page passes design results (AI design step on).

const totals = {
  ...emptyFunnel(),
  prepared: 10,
  skipped: 2,
  unsent: 3,
  sent: 5,
  replied: 2,
  meetings: 1,
  won: 1,
  wonAmountJpy: 198000,
  replies: { interested: 1, question: 0, meeting_request: 1, decline: 0, other: 0 },
  dnc: 1,
};

describe("FunnelSummary", () => {
  it("shows every stage with its count and rate, the amount, reply types and DNC", () => {
    const html = renderToStaticMarkup(<FunnelSummary period="30d" totals={totals} design={null} />);
    expect(html).toContain('data-period="30d"');
    for (const label of ["準備", "見送り", "送信", "返信", "商談", "成約", "成約金額", "¥198,000"]) expect(html).toContain(label);
    expect(html).toContain("50%（÷準備）");
    expect(html).toContain("40%（÷送信）");
    expect(html).toContain("未送信（下書きのまま）3 件・DNC（営業不要）1 件");
    expect(html).toContain("商談希望");
    expect(html).not.toContain('data-testid="design-outcomes"');
  });

  it("marks the current period and links to the other", () => {
    const html = renderToStaticMarkup(<FunnelSummary period="all" totals={totals} design={null} />);
    expect(html).toMatch(/<a href="\/admin\/sales\/history\?period=all" class="[^"]*" aria-current="page">全期間<\/a>/);
    expect(html).toMatch(/<a href="\/admin\/sales\/history\?period=30d" class="[^"]*">直近 30 日<\/a>/);
  });

  it("says when nothing was prepared in the period", () => {
    const html = renderToStaticMarkup(<FunnelSummary period="30d" totals={emptyFunnel()} design={null} />);
    expect(html).toContain("直近 30 日に準備した営業はありません。");
  });

  it("with the AI design step on, shows the design results and the top codes in words", () => {
    const design = sumDesign(
      [
        { preparedOn: "2026-10-01", status: "ready", errorCode: null, demos: 3 },
        { preparedOn: "2026-10-01", status: "blocked", errorCode: "QUALITY_NOT_ACCEPTED", demos: 1 },
      ],
      null,
    );
    const html = renderToStaticMarkup(<FunnelSummary period="all" totals={totals} design={design} />);
    expect(html).toContain('data-testid="design-outcomes"');
    expect(html).toContain("デモ確認可能");
    expect(html).toContain("75%");
    expect(html).toContain('data-code="QUALITY_NOT_ACCEPTED"');
    expect(html).toContain("品質の確認で合格しなかった");
  });

  it("shows an unknown code once, a known one in words with the code", () => {
    const design = sumDesign(
      [
        { preparedOn: "2026-10-01", status: "failed", errorCode: "SOME_NEW_CODE", demos: 2 },
        { preparedOn: "2026-10-01", status: "blocked", errorCode: "QUALITY_NOT_ACCEPTED", demos: 1 },
      ],
      null,
    );
    const html = renderToStaticMarkup(<FunnelSummary period="all" totals={totals} design={design} />);
    expect(html).toContain('<li data-code="SOME_NEW_CODE">SOME_NEW_CODE: 2 件</li>');
    expect(html).not.toContain("SOME_NEW_CODE（SOME_NEW_CODE）");
    expect(html).toContain("（QUALITY_NOT_ACCEPTED）: 1 件");
  });

  it("when the funnel cannot be read, says so and still shows the period switch and the design results", () => {
    const design = sumDesign([{ preparedOn: "2026-10-01", status: "ready", errorCode: null, demos: 1 }], null);
    const html = renderToStaticMarkup(<FunnelSummary period="30d" totals={null} design={design} />);
    expect(html).toContain('data-testid="funnel-error"');
    expect(html).toContain('aria-label="集計期間"');
    expect(html).not.toContain('data-stage="prepared"');
    expect(html).toContain('data-testid="design-outcomes"');
  });

  it("when only the design results cannot be read, the funnel still shows", () => {
    const html = renderToStaticMarkup(<FunnelSummary period="30d" totals={totals} design="unavailable" />);
    expect(html).toContain('data-stage="prepared"');
    expect(html).toContain('data-testid="design-outcomes-error"');
    expect(html).not.toContain('data-testid="design-outcomes"');
    expect(html).not.toContain('data-testid="funnel-error"');
  });
});
