/**
 * DEV-196d-7: the Today card's demo version badge, the link to the version page, and — display only — why this shop's
 * send approval is stopped by its approved version (sales_demo_version_send_block, the database decides; nothing here
 * changes the send action, its gating or its RPC). Fixed labels only. Rendered only when the flag is on.
 */
import { DEMO_VERSION_BADGE_LABEL, DEMO_VERSION_BADGE_UNKNOWN, SEND_BLOCK_LABEL, TODAY_FACTS_NOT_CHECKED, TODAY_SEND_STOP_TITLE, UNSHAREABLE_REASON_LABEL } from "@/lib/sales/demo-version/admin-messages";
import type { TodayDemoVersion } from "@/lib/admin/demo-version-badges";
import styles from "./admin.module.css";

export function DemoVersionBadge({ value }: { value: TodayDemoVersion }) {
  if (value.kind === "unknown") {
    return (
      <span className={styles.badge} data-testid="demo-version-badge" data-demo-version="unknown">
        {DEMO_VERSION_BADGE_UNKNOWN}
      </span>
    );
  }
  const warn = value.state === "revoked" || value.state === "changes_requested" || value.state === "rejected_by_admin" || value.state === "validator_rejected" || value.state === "expired";
  return (
    <span className={`${styles.badge} ${warn ? styles.badgeWarn : value.state === "approved" ? styles.badgeOk : ""}`} data-testid="demo-version-badge" data-demo-version={value.state}>
      デモの版: {DEMO_VERSION_BADGE_LABEL[value.state]}
      {value.versionNo !== null ? `（v${value.versionNo}）` : ""}
    </span>
  );
}

export function DemoVersionLink({ prospectId }: { prospectId: string }) {
  return (
    <a className={styles.secondary} href={`/admin/sales/demos/${prospectId}`} data-testid="demo-versions-link">
      デモの版を確認
    </a>
  );
}

export function DemoSendStopNotice({ value }: { value: TodayDemoVersion }) {
  if (value.kind !== "ok" || !value.sendStop) return null;
  const stop = value.sendStop;
  return (
    <div className={styles.error} role="status" data-testid="demo-send-stop" data-send-stop={stop.code}>
      <p style={{ margin: 0 }}>{TODAY_SEND_STOP_TITLE}</p>
      <p style={{ margin: "4px 0 0" }}>{SEND_BLOCK_LABEL[stop.code]}</p>
      {stop.code === "demo_not_shareable" && stop.reasons.length > 0 && (
        <ul className={styles.blockers}>
          {stop.reasons.map((r) => (
            <li key={r}>{UNSHAREABLE_REASON_LABEL[r]}</li>
          ))}
        </ul>
      )}
      {stop.factsUnknown && <p className={styles.muted}>{TODAY_FACTS_NOT_CHECKED}</p>}
    </div>
  );
}
