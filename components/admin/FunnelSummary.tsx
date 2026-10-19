import styles from "@/components/admin/admin.module.css";
import { DESIGN_STATUSES, DESIGN_STATUS_LABEL, designErrorLabel } from "@/lib/sales/design";
import {
  FUNNEL_PERIODS,
  FUNNEL_PERIOD_LABEL,
  REPLY_TYPE_LABEL,
  funnelStages,
  type DesignTotals,
  type FunnelPeriod,
  type FunnelTotals,
} from "@/lib/sales/funnel";
import { formatYen, rate } from "@/lib/sales/metrics";
import { REPLY_TYPES } from "@/lib/sales/types";

// DEV-057: 準備 → 見送り / 送信 → 返信 → 商談 → 成約 for one period (MVP_SPEC §9),
// the reply types, DNC and (with the AI design step on) the design results.

const STAGE_LABEL = { prepared: "準備", skipped: "見送り", sent: "送信", replied: "返信", meetings: "商談", won: "成約" } as const;

export const FUNNEL_HEADING = "ファネル（初回営業・準備した日で集計）";

export function PeriodSwitch({ period }: { period: FunnelPeriod }) {
  return (
    <nav className={styles.segmented} aria-label="集計期間">
      {FUNNEL_PERIODS.map((p) => (
        <a key={p} href={`/admin/sales/history?period=${p}`} className={styles.segment} aria-current={p === period ? "page" : undefined}>
          {FUNNEL_PERIOD_LABEL[p]}
        </a>
      ))}
    </nav>
  );
}

export default function FunnelSummary({ period, totals, design }: { period: FunnelPeriod; totals: FunnelTotals; design: DesignTotals | null }) {
  const label = FUNNEL_PERIOD_LABEL[period];
  return (
    <section aria-labelledby="funnel-heading" data-testid="funnel" data-period={period}>
      <h2 id="funnel-heading" className={styles.h2}>
        {FUNNEL_HEADING}
      </h2>
      <PeriodSwitch period={period} />
      {totals.prepared === 0 ? (
        <p className={styles.muted}>{label}に準備した営業はありません。</p>
      ) : (
        <>
          <div className={styles.tableWrap} tabIndex={0} role="region" aria-label={`ファネル: ${label}`}>
            <table className={styles.metrics}>
              <caption className={`${styles.muted} ${styles.caption}`}>{label}</caption>
              <thead>
                <tr>
                  <th scope="col">段階</th>
                  <th scope="col">件数</th>
                  <th scope="col">前段から</th>
                </tr>
              </thead>
              <tbody>
                {funnelStages(totals).map((s) => (
                  <tr key={s.key} data-stage={s.key}>
                    <th scope="row">{s.label}</th>
                    <td>{s.count}</td>
                    <td>{s.base === null ? "-" : `${s.rate}（÷${STAGE_LABEL[s.base]}）`}</td>
                  </tr>
                ))}
                <tr data-stage="amount">
                  <th scope="row">成約金額</th>
                  <td colSpan={2}>{formatYen(totals.wonAmountJpy)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className={styles.meta}>
            未送信（下書きのまま）{totals.unsent} 件・DNC（営業不要）{totals.dnc} 件
          </p>

          <div className={styles.tableWrap} tabIndex={0} role="region" aria-label={`返信の種類: ${label}`}>
            <table className={styles.metrics}>
              <caption className={`${styles.muted} ${styles.caption}`}>返信の種類</caption>
              <thead>
                <tr>
                  <th scope="col">種類</th>
                  <th scope="col">件数</th>
                  <th scope="col">返信に占める率</th>
                </tr>
              </thead>
              <tbody>
                {REPLY_TYPES.map((t) => (
                  <tr key={t} data-reply={t}>
                    <th scope="row">{REPLY_TYPE_LABEL[t]}</th>
                    <td>{totals.replies[t]}</td>
                    <td>{rate(totals.replies[t], totals.replied)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {design && (
        <div className={styles.tableWrap} tabIndex={0} role="region" aria-label={`AI デザインの結果: ${label}`} data-testid="design-outcomes">
          <table className={styles.metrics}>
            <caption className={`${styles.muted} ${styles.caption}`}>AI デザインの結果</caption>
            <thead>
              <tr>
                <th scope="col">結果</th>
                <th scope="col">件数</th>
                <th scope="col">率</th>
              </tr>
            </thead>
            <tbody>
              {DESIGN_STATUSES.map((s) => (
                <tr key={s} data-design={s}>
                  <th scope="row">{DESIGN_STATUS_LABEL[s]}</th>
                  <td>{design.byStatus[s]}</td>
                  <td>{rate(design.byStatus[s], design.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {design.topErrors.length > 0 && (
            <ul className={styles.errorCodes} aria-label="止まった・失敗した理由（多い順）">
              {design.topErrors.map((e) => (
                <li key={e.code} data-code={e.code}>
                  {designErrorLabel(e.code)}（{e.code}）: {e.count} 件
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
