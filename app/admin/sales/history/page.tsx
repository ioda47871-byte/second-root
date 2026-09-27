import DncControl from "@/components/admin/DncControl";
import styles from "@/components/admin/admin.module.css";
import { requireAdminPage } from "@/lib/admin/auth";
import { loadHistory, loadMetrics } from "@/lib/admin/history";
import { formatDate } from "@/lib/admin/pipeline";
import { CATEGORY_LABEL } from "@/lib/sales/demo-content";
import { DIMENSION_LABEL, formatYen, groupMetrics, rate, valueLabel } from "@/lib/sales/metrics";
import { createAuthClient } from "@/lib/supabase/server";

// 履歴: every prepared shop with its outcome, plus funnel metrics by
// channel / category / website status / follow-up (MVP_SPEC §9).

const STATUS = { drafted: "未送信", sent: "返信待ち", replied: "返信あり", meeting: "商談中", won: "成約", lost: "失注" } as const;
const CHANNEL = { instagram: "Instagram", email: "メール" } as const;

export default async function HistoryPage() {
  await requireAdminPage();
  let history, metrics;
  try {
    const supabase = await createAuthClient();
    [history, metrics] = await Promise.all([loadHistory(supabase), loadMetrics(supabase)]);
  } catch {
    return (
      <p className={styles.error} role="alert">
        読み込めませんでした。時間をおいて再読み込みしてください。
      </p>
    );
  }

  return (
    <>
      <h1 className={styles.h1}>履歴</h1>
      <h2 className={styles.h2}>成果（送信済みの初回営業）</h2>
      {metrics.length === 0 ? (
        <p className={styles.muted}>まだ送信済みの営業はありません。</p>
      ) : (
        groupMetrics(metrics).map((group) => (
          <div key={group.dimension} className={styles.tableWrap}>
            <table className={styles.metrics}>
              <caption className={styles.muted} style={{ textAlign: "left", padding: "8px 6px" }}>
                {DIMENSION_LABEL[group.dimension]}
              </caption>
              <thead>
                <tr>
                  <th scope="col">条件</th>
                  <th scope="col">送信</th>
                  <th scope="col">返信率</th>
                  <th scope="col">商談</th>
                  <th scope="col">成約</th>
                  <th scope="col">成約額</th>
                </tr>
              </thead>
              <tbody>
                {group.rows.map((row) => (
                  <tr key={`${row.dimension}-${row.value}`}>
                    <th scope="row">{valueLabel(row.value)}</th>
                    <td>{row.sent}</td>
                    <td>{rate(row.replied, row.sent)}</td>
                    <td>{row.meetings}</td>
                    <td>
                      {row.won}（{rate(row.won, row.sent)}）
                    </td>
                    <td>{formatYen(row.wonAmountJpy)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}

      <h2 className={styles.h2}>店舗（新しい順）</h2>
      {history.length === 0 ? (
        <p className={styles.muted}>まだ営業候補はありません。</p>
      ) : (
        <ul className={styles.list}>
          {history.map((item) => (
            <li key={item.prospectId} className={styles.card} data-testid="history-item">
              <h3 className={styles.itemTitle}>{item.shopName}</h3>
              <div className={styles.badges}>
                <span className={styles.badge}>{STATUS[item.status]}</span>
                <span className={styles.badge}>{CHANNEL[item.channel]}</span>
                <span className={styles.badge}>{CATEGORY_LABEL[item.category]}</span>
                {item.doNotContact && <span className={`${styles.badge} ${styles.badgeWarn}`}>DNC</span>}
              </div>
              <p className={styles.meta}>
                送信: {formatDate(item.sentAt)}
                {item.status === "won" && item.wonAmountJpy !== null ? `・成約 ${formatYen(item.wonAmountJpy)}` : ""}
              </p>
              <details className={styles.details}>
                <summary>詳細</summary>
                <a className={styles.secondary} href={`/admin/preview/${item.prospectId}`}>
                  デモを確認
                </a>
                <DncControl key={String(item.doNotContact)} prospectId={item.prospectId} doNotContact={item.doNotContact} />
              </details>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
