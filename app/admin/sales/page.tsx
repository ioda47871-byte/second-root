import EmailSend from "@/components/admin/EmailSend";
import InitialSend from "@/components/admin/InitialSend";
import TodayCard from "@/components/admin/TodayCard";
import styles from "@/components/admin/admin.module.css";
import { requireAdminPage } from "@/lib/admin/auth";
import { composeFollowUp } from "@/lib/admin/followup";
import { approvedSendLink, composeInitialSend } from "@/lib/admin/initial-send";
import { loadTodayQueue, type TodayItem } from "@/lib/admin/today";
import { aiDesignEnabled, initialSendAllowed } from "@/lib/sales/design";
import { buildMailto } from "@/lib/sales/messages";
import { LIMITS } from "@/lib/sales/types";
import { createAuthClient } from "@/lib/supabase/server";

/** Never silently drop the action: say why nothing can be sent. */
function cannotCompose(what: string) {
  return (
    <p className={styles.error} role="alert">
      文面が長すぎるか宛先が正しくないため、{what}を作成できません。
    </p>
  );
}

/**
 * DEV-194: a card the server would refuse is never offered a send action.
 * The hint names only the controls the card really has (review M1): a
 * follow-up card shows 営業不要（DNC） under this note; an initial card has
 * 見送る and 営業不要（DNC） in 詳細.
 */
function sendBlocked(kind: TodayItem["kind"]) {
  return (
    <p className={styles.muted} role="status" data-testid="send-blocked">
      送信できない理由があるため、送信の操作は出していません（上の理由を確認してください）。
      {kind === "follow_up"
        ? "送らない場合は、下の「営業不要（DNC）にする」で一覧から外せます。"
        : "送らない場合は、「詳細」の「見送る」か「営業不要（DNC）にする」で一覧から外せます。"}
    </p>
  );
}

/** The one big action for a queue item: Instagram DM, email, or the one email follow-up. */
function actionFor(item: TodayItem) {
  if (item.kind === "follow_up") {
    if (!item.evidence.contact.sendable) return sendBlocked("follow_up");
    if (item.channel !== "email" || !item.publicEmail || !item.demoToken) return cannotCompose("フォローメール");
    const draft = composeFollowUp({ shopName: item.shopName, publicEmail: item.publicEmail, initialSubject: item.subject, demoToken: item.demoToken });
    try {
      return <EmailSend outreachId={item.outreachId} mailto={buildMailto(draft)} draft={draft} kind="follow_up" label="フォローメールを作成" />;
    } catch {
      return cannotCompose("フォローメール");
    }
  }
  // DEV-030: a demo still waiting for or getting its AI design is not sent
  // yet (the link would show a page that is about to change).
  if (item.kind === "initial" && !initialSendAllowed(aiDesignEnabled(), item.designStatus)) {
    return (
      <p className={styles.muted} role="status" data-testid="design-wait">
        AIデザインの完成を待っています。完成するまで送信できません。
      </p>
    );
  }
  if (!item.evidence.contact.sendable) return sendBlocked("initial");
  // DEV-195: approve the exact text → open the owner's own app → confirm the
  // manual send. The same composer builds the text shown, approved and sent.
  const composed = composeInitialSend({
    channel: item.channel,
    shopName: item.shopName,
    subject: item.subject,
    body: item.body,
    publicEmail: item.publicEmail,
    instagramUrl: item.instagramUrl,
    instagramHandle: item.instagramHandle,
    demoToken: item.demoToken,
  });
  if (!composed) return cannotCompose(item.channel === "email" ? "メール" : "DM");
  const approval = item.approval;
  return (
    <InitialSend
      outreachId={item.outreachId}
      draftVersion={item.draftVersion}
      composed={{ channel: composed.channel, recipient: composed.recipient, subject: composed.subject, body: composed.body }}
      approval={
        approval
          ? {
              id: approval.id,
              state: approval.state,
              recipient: approval.recipient,
              subject: approval.subject,
              body: approval.body,
              approvedLabel: approval.approvedLabel,
              openedLabel: approval.openedLabel,
              staleReasons: approval.staleReasons,
              link: approvedSendLink(approval, item.instagramUrl),
            }
          : null
      }
    />
  );
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
