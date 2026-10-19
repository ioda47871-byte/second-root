import OutcomeActions from "@/components/admin/OutcomeActions";
import styles from "@/components/admin/admin.module.css";
import { requireAdminPage } from "@/lib/admin/auth";
import { formatDate, loadPipeline } from "@/lib/admin/pipeline";
import { elapsedDaysLabel } from "@/lib/sales/followup";
import { createAuthClient } from "@/lib/supabase/server";

// 商談: replies that may become meetings, and meetings awaiting an outcome,
// with the JST calendar days since the reply / the meeting start (DEV-056).

const REPLY = { interested: "興味あり", question: "質問", meeting_request: "商談希望", decline: "断り", other: "その他" } as const;

export default async function MeetingsPage() {
  await requireAdminPage();
  const now = new Date();
  const since = (what: string, iso: string | null) => elapsedDaysLabel(what, iso ? new Date(iso) : null, now);
  let items;
  try {
    items = await loadPipeline(await createAuthClient(), ["replied", "meeting"]);
  } catch {
    return (
      <>
        <h1 className={styles.h1}>商談</h1>
        <p className={styles.error} role="alert">
          読み込めませんでした。時間をおいて再読み込みしてください。
        </p>
      </>
    );
  }
  return (
    <>
      <h1 className={styles.h1}>商談</h1>
      {items.length === 0 ? (
        <p className={styles.muted}>進行中の返信・商談はありません。</p>
      ) : (
        <ul className={styles.list}>
          {items.map((item) => (
            <li key={item.outreachId} className={styles.card} data-testid="meeting-item">
              <h2 className={styles.itemTitle}>{item.shopName}</h2>
              <p className={styles.meta}>
                {item.status === "meeting" ? `商談中（${formatDate(item.meetingAt)}〜）` : `返信: ${item.replyType ? REPLY[item.replyType] : "-"}（${formatDate(item.repliedAt)}）`}
              </p>
              <div className={styles.badges}>
                <span className={styles.badge} data-testid="meeting-elapsed">
                  {item.status === "meeting" ? since("商談開始", item.meetingAt) : since("返信", item.repliedAt)}
                </span>
              </div>
              <OutcomeActions outreachId={item.outreachId} status={item.status as "replied" | "meeting"} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
