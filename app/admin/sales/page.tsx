import InstagramSend from "@/components/admin/InstagramSend";
import TodayCard from "@/components/admin/TodayCard";
import styles from "@/components/admin/admin.module.css";
import { requireAdminPage } from "@/lib/admin/auth";
import { demoUrl, loadTodayQueue, type TodayItem } from "@/lib/admin/today";
import { composeDm, instagramOpenUrl } from "@/lib/sales/messages";
import { LIMITS } from "@/lib/sales/types";
import { createAuthClient } from "@/lib/supabase/server";

/** The one big action for a queue item (DEV-010 Instagram; email in DEV-011, follow-up in DEV-014). */
function actionFor(item: TodayItem) {
  if (item.kind === "initial" && item.channel === "instagram" && item.instagramUrl && item.demoToken) {
    try {
      return (
        <InstagramSend
          outreachId={item.outreachId}
          dmText={composeDm({ message: item.body, demoUrl: demoUrl(item.demoToken) })}
          instagramUrl={instagramOpenUrl(item.instagramUrl)}
        />
      );
    } catch {
      return null;
    }
  }
  return null;
}

export default async function TodayPage() {
  await requireAdminPage();
  const now = new Date();
  let items;
  try {
    items = await loadTodayQueue(await createAuthClient(), now);
  } catch {
    return (
      <>
        <h1 className={styles.h1}>今日やること</h1>
        <p className={styles.error} role="alert">
          今日の一覧を読み込めませんでした。時間をおいて再読み込みしてください。
        </p>
      </>
    );
  }

  return (
    <>
      <h1 className={styles.h1}>今日やること</h1>
      <p className={styles.count}>
        {items.length} / {LIMITS.workQueue} 件
      </p>
      {items.length === 0 ? (
        <p className={styles.muted}>今日の作業はありません。</p>
      ) : (
        <ul className={styles.list}>
          {items.map((item) => (
            <TodayCard key={`${item.kind}-${item.outreachId}`} item={item} now={now} action={actionFor(item)} />
          ))}
        </ul>
      )}
    </>
  );
}
