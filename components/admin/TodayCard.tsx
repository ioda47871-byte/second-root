import type { ReactNode } from "react";
import type { TodayItem } from "@/lib/admin/today";
import { CATEGORY_LABEL } from "@/lib/sales/demo-content";
import styles from "./admin.module.css";

// One item of today's queue: shop, channel, minimal state and one big
// action; everything else is folded away (MVP_SPEC §8).

const CHANNEL_LABEL = { instagram: "Instagram", email: "メール" } as const;

function daysSince(iso: string, now: Date): number {
  return Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000);
}

export default function TodayCard({ item, now, action }: { item: TodayItem; now: Date; action: ReactNode }) {
  return (
    <li className={styles.card} data-testid="today-item">
      <h2 className={styles.itemTitle}>{item.shopName}</h2>
      <div className={styles.badges}>
        <span className={styles.badge}>{CHANNEL_LABEL[item.channel]}</span>
        {item.kind === "follow_up" ? (
          <span className={`${styles.badge} ${styles.badgeWarn}`}>
            フォロー（初回から{item.sentAt ? daysSince(item.sentAt, now) : "-"}日）
          </span>
        ) : (
          <span className={styles.badge}>未送信</span>
        )}
      </div>
      <div className={styles.actions}>{action}</div>
      <details className={styles.details}>
        <summary>詳細</summary>
        <p>
          {item.ward ? `名古屋市${item.ward}` : "名古屋市"}・{CATEGORY_LABEL[item.category]}
        </p>
        <a className={styles.secondary} href={`/admin/preview/${item.prospectId}`}>
          デモを確認
        </a>
        {item.kind === "initial" && (
          <>
            {item.subject && <p>件名: {item.subject}</p>}
            <p className={styles.message}>{item.body}</p>
          </>
        )}
      </details>
    </li>
  );
}
