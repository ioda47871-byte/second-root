/**
 * DEV-196d-5: the version's quality decisions, newest first. Decision, state and the reason an approval became invalid
 * are shown only through their fixed labels (INVALIDATED_REASON_LABEL) — never a row's text.
 */
import { INVALIDATED_REASON_LABEL, QUALITY_DECISION_LABEL, REVIEW_STATE_LABEL } from "@/lib/sales/demo-version/admin-messages";
import type { ReviewView } from "@/lib/sales/demo-version/view-model";
import styles from "./demo.module.css";

const when = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "日時不明" : new Date(t).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
};

export function invalidatedText(code: string | null): string | null {
  if (code === null) return null;
  return Object.hasOwn(INVALIDATED_REASON_LABEL, code) ? INVALIDATED_REASON_LABEL[code]! : "理由を表示できません";
}

export default function ReviewHistory({ reviews }: { reviews: ReviewView[] }) {
  if (reviews.length === 0) return null;
  return (
    <section className={styles.panel} aria-labelledby="history-h">
      <h2 id="history-h" className={styles.h2}>
        この版の判定の記録
      </h2>
      <ol className={styles.versions}>
        {reviews.map((r) => (
          <li key={r.id} className={styles.sub} data-review={r.decision ?? "unknown"} data-review-state={r.state ?? "unknown"}>
            {when(r.reviewedAt)}・{r.decision ? QUALITY_DECISION_LABEL[r.decision] : "不明な判定"}・{r.state ? REVIEW_STATE_LABEL[r.state] : "不明"}
            {r.state === "invalidated" && <>（{invalidatedText(r.invalidatedReason)}）</>}
          </li>
        ))}
      </ol>
    </section>
  );
}
