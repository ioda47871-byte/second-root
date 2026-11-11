import EmailSend from "@/components/admin/EmailSend";
import InitialSend from "@/components/admin/InitialSend";
import SendRecordNotice from "@/components/admin/SendRecordNotice";
import TodayCard from "@/components/admin/TodayCard";
import styles from "@/components/admin/admin.module.css";
import { requireAdminPage } from "@/lib/admin/auth";
import { loadTodayDemoVersions } from "@/lib/admin/demo-version-badges";
import { composeFollowUp } from "@/lib/admin/followup";
import { approvedSendLink, composeInitialSend } from "@/lib/admin/initial-send";
import { loadTodayQueue, type TodayItem } from "@/lib/admin/today";
import { aiDesignEnabled, initialSendAllowed } from "@/lib/sales/design";
import type { SendState } from "@/lib/sales/evidence";
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
function sendBlocked(kind: TodayItem["kind"], state: SendState) {
  // DEV-197: 未確認 (unknown) is not a confirmed reason: say that it could not
  // be checked, and still offer nothing to send (fail closed).
  return (
    <p className={styles.muted} role="status" data-testid="send-blocked" data-send-state={state}>
      {state === "unknown"
        ? "送信できるか確認できませんでした（上の「未確認」の項目）。再読み込みしてください。確認できるまで送信の操作は出しません。"
        : "送信できない理由があるため、送信の操作は出していません（上の理由を確認してください）。"}
      {kind === "follow_up"
        ? "送らない場合は、下の「営業不要（DNC）にする」で一覧から外せます。"
        : "送らない場合は、「詳細」の「見送る」か「営業不要（DNC）にする」で一覧から外せます。"}
    </p>
  );
}

/** The one big action for a queue item: Instagram DM, email, or the one email follow-up. */
function actionFor(item: TodayItem) {
  if (item.kind === "follow_up") {
    if (!item.evidence.contact.sendable) return sendBlocked("follow_up", item.evidence.contact.state);
    if (item.channel !== "email" || !item.publicEmail || !item.demoToken) return cannotCompose("フォローメール");
    const draft = composeFollowUp({ shopName: item.shopName, publicEmail: item.publicEmail, initialSubject: item.subject, demoToken: item.demoToken });
    try {
      return <EmailSend outreachId={item.outreachId} mailto={buildMailto(draft)} draft={draft} kind="follow_up" label="フォローメールを作成" />;
    } catch {
      return cannotCompose("フォローメール");
    }
  }
  // PR #239 M2: once the send screen was opened, the owner may already have
  // sent it. Its controls (手動で送信済みにする / 送らなかった) stay on the card
  // whatever has changed since, with a warning when the shop can no longer be
  // contacted; the database still decides what it records.
  const approval = item.approval;
  const opened = approval?.state === "send_opened";
  if (!opened) {
    // DEV-030: a demo still waiting for or getting its AI design is not sent
    // yet (the link would show a page that is about to change).
    if (!initialSendAllowed(aiDesignEnabled(), item.designStatus)) {
      return (
        <p className={styles.muted} role="status" data-testid="design-wait">
          AIデザインの完成を待っています。完成するまで送信できません。
        </p>
      );
    }
    if (!item.evidence.contact.sendable) return sendBlocked("initial", item.evidence.contact.state);
  }
  // DEV-197: for an opened approval the words follow the three states. Only a
  // confirmed DNC / exclusion may claim the after-the-fact record (that is what
  // the database stores as blocked_after_open); anything else not sendable is
  // a check the card cannot settle, and the database decides.
  const contact = item.evidence.contact;
  const blockedWarning = opened && contact.block === "confirmed" ? contact.blockers : null;
  const checkWarning =
    opened && contact.state !== "sendable" && contact.block !== "confirmed"
      ? { state: contact.state, reasons: contact.blockers, blockPossible: contact.block === "unknown" }
      : null;
  // DEV-195: approve the exact text → open the owner's own app → confirm the
  // manual send. The same composer builds the text shown, approved and sent.
  const composed = opened
    ? { channel: item.channel, recipient: approval.recipient, subject: approval.subject, body: approval.body }
    : composeInitialSend({
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
  return (
    <InitialSend
      blockedWarning={blockedWarning}
      checkWarning={checkWarning}
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
              textStale: approval.textStale ?? true,
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
  let supabase;
  try {
    supabase = await createAuthClient();
    items = await loadTodayQueue(supabase, now);
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

  // DEV-196d-7: the demo version badges — only with the flag on (off: null, nothing is read); one request for every
  // shop on the page; a failure gives neutral badges and never breaks the list.
  const demoVersions = await loadTodayDemoVersions(supabase, items.map((i) => i.prospectId), { env: process.env, now });

  // DEV-197: SendRecordNotice wraps everything (also the empty list) so the
  // notice of what was stored survives the card leaving the list.
  return (
    <>
      <h1 className={styles.h1}>今日やること</h1>
      <SendRecordNotice>
        <p className={styles.count}>
          {items.length} / {LIMITS.workQueue} 件
        </p>
        {items.length === 0 ? (
          <p className={styles.muted}>今日の作業はありません。</p>
        ) : (
          <ul className={styles.list}>
            {items.map((item) => (
              <TodayCard
                key={`${item.kind}-${item.outreachId}`}
                item={item}
                now={now}
                action={actionFor(item)}
                {...(demoVersions ? { demoVersion: demoVersions.get(item.prospectId) ?? { kind: "unknown" as const } } : {})}
              />
            ))}
          </ul>
        )}
      </SendRecordNotice>
    </>
  );
}
