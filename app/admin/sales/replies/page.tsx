import ReplyForm from "@/components/admin/ReplyForm";
import styles from "@/components/admin/admin.module.css";
import { requireAdminPage } from "@/lib/admin/auth";
import { formatDate, loadPipeline } from "@/lib/admin/pipeline";
import { createAuthClient } from "@/lib/supabase/server";

// 返信: sent outreaches waiting for a reply. Replies are never fetched
// automatically; the admin taps 返信あり after reading one (MVP_SPEC §5).

const CHANNEL = { instagram: "Instagram", email: "メール" } as const;

export default async function RepliesPage() {
  await requireAdminPage();
  let items;
  try {
    items = await loadPipeline(await createAuthClient(), ["sent"]);
  } catch {
    return (
      <>
        <h1 className={styles.h1}>返信</h1>
        <p className={styles.error} role="alert">
          読み込めませんでした。時間をおいて再読み込みしてください。
        </p>
      </>
    );
  }
  return (
    <>
      <h1 className={styles.h1}>返信</h1>
      {items.length === 0 ? (
        <p className={styles.muted}>返信待ちの営業はありません。</p>
      ) : (
        <ul className={styles.list}>
          {items.map((item) => (
            <li key={item.outreachId} className={styles.card} data-testid="reply-item">
              <h2 className={styles.itemTitle}>{item.shopName}</h2>
              <p className={styles.meta}>
                {CHANNEL[item.channel]}・{formatDate(item.sentAt)} 送信
              </p>
              <ReplyForm outreachId={item.outreachId} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
