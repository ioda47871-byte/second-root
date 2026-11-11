/**
 * DEV-196d-3 (display only; the actions come in DEV-196d-5 / 196d-6): what the admin must know about the selected
 * version and the shop before judging — why it cannot be approved now, that approving stops the shop's sending while
 * versioned sharing is off (DEV-196c Low d), why sending is stopped now, and send screens that must be settled first.
 * Every word comes from the fixed labels; nothing is repeated from a database row.
 */
import Link from "next/link";
import {
  APPROVAL_STOPS_SENDING_BEFORE,
  APPROVE_BLOCKER_LABEL,
  DRAFT_NOT_USED_TEXT,
  SEND_BLOCK_FACTS_UNKNOWN_TEXT,
  SEND_BLOCK_LABEL,
  UNSHAREABLE_REASON_LABEL,
} from "@/lib/sales/demo-version/admin-messages";
import type { DemoVersionsView, VersionView } from "@/lib/sales/demo-version/view-model";
import styles from "./demo.module.css";

export default function VersionNotices({ view, version }: { view: DemoVersionsView; version: VersionView | null }) {
  const stop = view.sendStop;
  return (
    <>
      {stop && (
        <div className={styles.alert} role="alert" data-send-stop={stop.code}>
          <p style={{ margin: 0 }}>{SEND_BLOCK_LABEL[stop.code]}</p>
          {stop.code === "demo_not_shareable" && stop.reasons.length > 0 && (
            <ul className={styles.list}>
              {stop.reasons.map((r) => (
                <li key={r}>{UNSHAREABLE_REASON_LABEL[r]}</li>
              ))}
            </ul>
          )}
          {stop.factsUnknown && <p className={styles.note}>{SEND_BLOCK_FACTS_UNKNOWN_TEXT}</p>}
        </div>
      )}
      {view.openSends.length > 0 && (
        <div className={styles.warn} role="status" data-open-sends={view.openSends.length}>
          <p style={{ margin: 0 }}>この店舗には「送信画面を開いた」送信承認が {view.openSends.length} 件あります。版を変える操作の前に、今日の画面で決着させてください。</p>
          <p className={styles.note}>
            <Link href="/admin/sales">今日の画面へ</Link>
          </p>
        </div>
      )}
      {version && (version.status === "draft" || version.status === "superseded") && (
        <div className={styles.warn} data-approval-warning="before">
          <p style={{ margin: 0 }}>{APPROVAL_STOPS_SENDING_BEFORE}</p>
          <p className={styles.note}>{DRAFT_NOT_USED_TEXT}</p>
        </div>
      )}
      {version && version.approveBlockers.length > 0 && (
        <div className={styles.panel} data-blockers={version.approveBlockers.join(" ")}>
          <h2 className={styles.h2}>この版は今は品質承認できません</h2>
          <ul className={styles.list}>
            {version.approveBlockers.map((b) => (
              <li key={b}>{APPROVE_BLOCKER_LABEL[b]}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
