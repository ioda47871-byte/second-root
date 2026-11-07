import type { ReactNode } from "react";
import type { TodayItem } from "@/lib/admin/today";
import { CATEGORY_LABEL } from "@/lib/sales/demo-content";
import { DESIGN_FALLBACK_NOTE, DESIGN_STATUS_LABEL, designErrorLabel, reviewAxisLines, reviewSummaryLine } from "@/lib/sales/design";
import { formatJstDateTime } from "@/lib/sales/evidence";
import DncControl from "./DncControl";
import DraftEditor from "./DraftEditor";
import SkipDraft from "./SkipDraft";
import TodayEvidencePanel from "./TodayEvidencePanel";
import styles from "./admin.module.css";

// One item of today's queue: shop, channel, minimal state and one big
// action; everything else is folded away (MVP_SPEC §8).

const CHANNEL_LABEL = { instagram: "Instagram", email: "メール" } as const;

function daysSince(iso: string, now: Date): number {
  return Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000);
}

export default function TodayCard({ item, now, action }: { item: TodayItem; now: Date; action: ReactNode }) {
  const verdict = item.evidence.contact;
  return (
    <li className={styles.card} data-testid="today-item">
      <h2 className={styles.itemTitle}>{item.shopName}</h2>
      <div className={styles.badges}>
        <span className={styles.badge} data-testid="channel-badge">
          {CHANNEL_LABEL[item.channel]}
        </span>
        {item.kind === "follow_up" ? (
          <span className={`${styles.badge} ${styles.badgeWarn}`} data-testid="state-badge">
            フォロー（初回から{item.sentAt ? daysSince(item.sentAt, now) : "-"}日）
          </span>
        ) : (
          <span className={styles.badge} data-testid="state-badge">
            未送信
          </span>
        )}
        {item.kind === "initial" && item.designStatus && (
          <span
            className={`${styles.badge} ${item.designStatus === "blocked" || item.designStatus === "failed" ? styles.badgeWarn : ""}`}
            data-testid="design-status"
            data-design={item.designStatus}
          >
            {DESIGN_STATUS_LABEL[item.designStatus]}
          </span>
        )}
        {/* DEV-194: the same rules the server applies when this is marked sent. */}
        <span
          className={`${styles.badge} ${verdict.sendable ? styles.badgeOk : styles.badgeNg}`}
          data-testid="contact-verdict"
          data-sendable={verdict.sendable ? "true" : "false"}
        >
          {verdict.badge}
        </span>
      </div>
      {!verdict.sendable && (
        <ul className={styles.blockers} data-testid="contact-blockers">
          {verdict.blockers.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      )}
      {item.kind === "initial" && item.designStatus === "ready" && (
        <a className={styles.secondary} href={`/admin/preview/${item.prospectId}`} data-testid="design-preview">
          AIデザインのデモを確認
        </a>
      )}
      {item.kind === "initial" && (item.designStatus === "blocked" || item.designStatus === "failed") && (
        <p className={styles.muted}>
          {DESIGN_FALLBACK_NOTE}
          {item.designErrorCode && (
            <>
              <br />
              <span data-testid="design-error">理由: {designErrorLabel(item.designErrorCode)}</span>
            </>
          )}
        </p>
      )}
      <div className={styles.actions}>{action}</div>
      {/* DEV-194 review M1: a blocked follow-up has no send action and no 詳細 controls,
          so it would hold a slot for weeks. The existing DNC control (with its own
          confirmation) is the one way to take it off the list. */}
      {item.kind === "follow_up" && !verdict.sendable && (
        <div data-testid="follow-up-dnc">
          <DncControl prospectId={item.prospectId} doNotContact={false} />
        </div>
      )}
      <details className={styles.details}>
        <summary>詳細</summary>
        <p>
          {item.ward ? `名古屋市${item.ward}` : "名古屋市"}・{CATEGORY_LABEL[item.category]}
        </p>
        {item.kind === "initial" && item.designReview && (
          <p className={styles.muted} data-testid="design-review" data-verdict={item.designReview.verdict}>
            {reviewSummaryLine(item.designReview)}
            <br />
            {reviewAxisLines(item.designReview).join("・")}
          </p>
        )}
        <a className={styles.secondary} href={`/admin/preview/${item.prospectId}`}>
          デモを確認
        </a>
        {item.kind === "initial" && (
          <>
            {item.subject && <p>件名: {item.subject}</p>}
            <p className={styles.message}>{item.body}</p>
            <DraftEditor
              outreachId={item.outreachId}
              draftVersion={item.draftVersion}
              channel={item.channel}
              subject={item.subject}
              body={item.body}
              editedLabel={item.editedAt ? `${formatJstDateTime(item.editedAt)} に編集` : null}
              locked={item.approval?.state === "send_opened"}
            />
            <SkipDraft outreachId={item.outreachId} />
            <DncControl prospectId={item.prospectId} doNotContact={false} />
          </>
        )}
      </details>
      <TodayEvidencePanel evidence={item.evidence} prospectId={item.prospectId} />
    </li>
  );
}
