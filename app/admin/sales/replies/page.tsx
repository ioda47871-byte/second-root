import IgReplyCard from "@/components/admin/IgReplyCard";
import ReplyForm from "@/components/admin/ReplyForm";
import styles from "@/components/admin/admin.module.css";
import { requireAdminPage } from "@/lib/admin/auth";
import { formatDateTime, loadInbox, loadMatchCandidates } from "@/lib/admin/inbox";
import { formatDate, loadPipeline } from "@/lib/admin/pipeline";
import { createAuthClient } from "@/lib/supabase/server";

// 返信: Instagram replies received through the official API with the AI
// draft to approve (DEV-022), then sent outreaches waiting for a reply,
// classified by the admin with 返信あり (MVP_SPEC §5).

const CHANNEL = { instagram: "Instagram", email: "メール" } as const;

export default async function RepliesPage() {
  await requireAdminPage();
  let items, inbox, candidates;
  try {
    const supabase = await createAuthClient();
    [items, inbox, candidates] = await Promise.all([loadPipeline(supabase, ["sent"]), loadInbox(supabase), loadMatchCandidates(supabase)]);
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
  const open = inbox.filter((i) => !i.snoozed);
  const later = inbox.filter((i) => i.snoozed);
  const card = (i: (typeof inbox)[number]) => (
    <IgReplyCard
      key={i.threadId}
      threadId={i.threadId}
      draftId={i.draftId}
      draftStatus={i.draftStatus}
      snoozed={i.snoozed}
      stale={i.stale}
      doNotContact={i.doNotContact}
      sendId={i.sendId}
      matched={i.matched}
      username={i.username}
      shopName={i.shopName}
      receivedAt={formatDateTime(i.lastInboundAt)}
      windowOpen={i.windowOpen}
      messages={i.messages.map((m) => ({ direction: m.direction, text: m.text, attachmentTypes: m.attachmentTypes, at: formatDateTime(m.sentAt) }))}
      replyType={i.replyType}
      body={i.body}
      dncCandidate={i.dncCandidate}
      reviewReasons={i.reviewReasons}
      candidates={candidates}
    />
  );
  return (
    <>
      <h1 className={styles.h1}>返信</h1>
      {inbox.length > 0 && (
        <>
          <h2 className={styles.h2}>Instagram の返信</h2>
          {open.length > 0 && <ul className={styles.list}>{open.map(card)}</ul>}
          {later.length > 0 && (
            <details className={styles.details}>
              <summary>後で対応（{later.length}件）</summary>
              <ul className={styles.list}>{later.map(card)}</ul>
            </details>
          )}
          <h2 className={styles.h2}>返信待ち</h2>
        </>
      )}
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
