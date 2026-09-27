import EmailSend from "@/components/admin/EmailSend";
import InstagramSend from "@/components/admin/InstagramSend";
import TodayCard from "@/components/admin/TodayCard";
import styles from "@/components/admin/admin.module.css";
import { requireAdminPage } from "@/lib/admin/auth";
import { demoUrl, loadTodayQueue, type TodayItem } from "@/lib/admin/today";
import { buildMailto, composeDm, composeEmailBody, instagramOpenUrl } from "@/lib/sales/messages";
import { LIMITS } from "@/lib/sales/types";
import { createAuthClient } from "@/lib/supabase/server";

const DEFAULT_SUBJECT = "ホームページのご提案（Second Root）";

/** Never silently drop the action: say why nothing can be sent. */
function cannotCompose(what: string) {
  return (
    <p className={styles.error} role="alert">
      文面が長すぎるか宛先が正しくないため、{what}を作成できません。
    </p>
  );
}

/** The one big action for a queue item (Instagram, email; follow-up in DEV-014). */
function actionFor(item: TodayItem) {
  if (item.kind === "initial" && item.channel === "email" && item.publicEmail && item.demoToken) {
    const draft = {
      to: item.publicEmail,
      subject: item.subject ?? DEFAULT_SUBJECT,
      body: composeEmailBody({ shopName: item.shopName, message: item.body, demoUrl: demoUrl(item.demoToken) }),
    };
    try {
      return <EmailSend outreachId={item.outreachId} mailto={buildMailto(draft)} draft={draft} />;
    } catch {
      return cannotCompose("メール");
    }
  }
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
      return cannotCompose("DM");
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
