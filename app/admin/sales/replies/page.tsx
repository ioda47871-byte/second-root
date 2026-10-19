import IgConnectionCheck from "@/components/admin/IgConnectionCheck";
import IgReplyCard from "@/components/admin/IgReplyCard";
import ReplyForm from "@/components/admin/ReplyForm";
import styles from "@/components/admin/admin.module.css";
import { requireAdminPage } from "@/lib/admin/auth";
import { formatDateTime, loadInbox, loadMatchCandidates } from "@/lib/admin/inbox";
import { formatDate, loadAwaitingReplies } from "@/lib/admin/pipeline";
import { elapsedDaysLabel, followUpStatusLabel } from "@/lib/sales/followup";
import { LIMITS } from "@/lib/sales/types";
import { createAuthClient } from "@/lib/supabase/server";

// 返信: Instagram replies received through the official API with the AI
// draft to approve (DEV-022), then sent outreaches waiting for a reply,
// classified by the admin with 返信あり (MVP_SPEC §5). Waiting items are
// oldest sent first, with the days since sending and the follow-up state
// (DEV-056); the follow-up itself is sent from 今日 (§4.3).

const CHANNEL = { instagram: "Instagram", email: "メール" } as const;

export default async function RepliesPage() {
  await requireAdminPage();
  const now = new Date();
  let items, inbox, candidates;
  try {
    const supabase = await createAuthClient();
    [items, inbox, candidates] = await Promise.all([loadAwaitingReplies(supabase, now), loadInbox(supabase), loadMatchCandidates(supabase)]);
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
  const open = inbox.filter((i) => i.needsAction && !i.snoozed);
  const later = inbox.filter((i) => i.needsAction && i.snoozed);
  const followUpDue = items.filter((i) => i.followUp.kind === "due").length;
  const card = (i: (typeof inbox)[number]) => (
    <IgReplyCard
      key={`${i.threadId}:${i.draftId ?? ""}`}
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
      <IgConnectionCheck />
      {open.length + later.length > 0 && (
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
        <>
          <p className={styles.meta} data-testid="reply-summary">
            返信待ち {items.length} 件・うちフォロー可能 {followUpDue} 件（送信の古い順）
            {followUpDue > 0 && <>。フォローは今日の画面に一度に {LIMITS.workQueue} 件まで、古い順で出ます。</>}
          </p>
          <ul className={styles.list}>
            {items.map((item) => (
              <li key={item.outreachId} className={styles.card} data-testid="reply-item">
                <h2 className={styles.itemTitle}>{item.shopName}</h2>
                <p className={styles.meta}>
                  {CHANNEL[item.channel]}・{formatDate(item.sentAt)} 送信
                </p>
                <div className={styles.badges}>
                  <span className={styles.badge} data-testid="reply-elapsed">
                    {elapsedDaysLabel("送信", item.sentAt ? new Date(item.sentAt) : null, now)}
                  </span>
                  <span
                    className={`${styles.badge} ${item.followUp.kind === "due" ? styles.badgeWarn : ""}`}
                    data-testid="reply-followup"
                    data-follow-up={item.followUp.kind}
                  >
                    {followUpStatusLabel(item.followUp)}
                  </span>
                </div>
                <ReplyForm outreachId={item.outreachId} />
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
