"use client";

import { useState, useTransition } from "react";
import { approveSend, markSendOpened, markSent, withdrawApproval } from "@/app/admin/sales/_actions/send";
import { APPROVAL_STATE_LABEL, type OpenedVia } from "@/lib/sales/approval";
import { copyText, openInstagram, openMail, type OpenDeps, type PendingWindow } from "@/lib/sales/open-send";
import { useSendRecordNotice } from "./SendRecordNotice";
import type { Channel } from "@/lib/sales/types";
import styles from "./admin.module.css";

// DEV-195: the manual send of an initial message, in three steps the
// database records separately (MVP_SPEC §4):
//   1. この内容で送信を承認 — the exact recipient / subject / body shown here.
//   2. メールを作成 / DMを送る / 文面をコピー — opens the owner's own app, but
//      only after the server recorded 「送信画面を開いた」 (every guard runs
//      again first; PR #239 M1). It is never recorded as a send.
//   3. 手動で送信済みにする — only after the owner really sent it.
// Nothing is sent by the system. The approved text is what the mail app /
// clipboard receives.

export type ComposedMessage = { channel: Channel; recipient: string; subject: string | null; body: string };

export type ApprovalProps = {
  id: string;
  state: "approved" | "send_opened";
  recipient: string;
  subject: string | null;
  body: string;
  approvedLabel: string;
  openedLabel: string | null;
  staleReasons: string[];
  /**
   * DEV-197: the text revision or channel changed since approval. Such an
   * approval is never recorded as sent; a demo / recipient change can be, but
   * only after a block (absent = treated as changed: fail safe).
   */
  textStale?: boolean;
  /** mailto: (email) or the Instagram profile (instagram), built from the approved text; null if it cannot be. */
  link: string | null;
};

/**
 * DEV-197: an opened approval whose shop is not sendable now, without a
 * confirmed DNC / exclusion. `state` unknown: a check could not be determined;
 * blocked: another confirmed reason. `blockPossible`: DNC or the exclusion
 * list itself could not be determined (the database may still record a block).
 */
export type CheckWarning = { state: "blocked" | "unknown"; reasons: string[]; blockPossible: boolean };

function Preview({ message }: { message: ComposedMessage }) {
  return (
    <div className={styles.sendPreview} data-testid="send-preview">
      <p className={styles.muted}>
        宛先: <span data-testid="send-recipient">{message.channel === "email" ? message.recipient : `@${message.recipient}`}</span>
      </p>
      {message.subject !== null && <p className={styles.muted}>件名: {message.subject}</p>}
      <textarea className={styles.input} readOnly rows={8} value={message.body} aria-label="送る文面" />
    </div>
  );
}

export default function InitialSend({
  outreachId,
  draftVersion,
  composed,
  approval,
  blockedWarning = null,
  checkWarning = null,
}: {
  outreachId: string;
  draftVersion: number;
  composed: ComposedMessage;
  approval: ApprovalProps | null;
  /**
   * PR #239 M2: an opened approval whose shop is now DNC / excluded. Only the
   * confirm (if it really was sent) and 送らなかった are offered. DEV-197: only
   * for a confirmed DNC / exclusion (what the database stores as
   * blocked_after_open), never for a check that could not be determined.
   */
  blockedWarning?: string[] | null;
  /** DEV-197: an opened approval not sendable for another reason, or unknown. */
  checkWarning?: CheckWarning | null;
}) {
  const showRecorded = useSendRecordNotice();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /**
   * PR #239 re-review L4a: the mailto exists in the page only after the server
   * recorded the opening (some browsers, e.g. iOS Safari, may not follow the
   * programmatic hand-over after an await; this visible link is the fallback).
   */
  const [recordedMailto, setRecordedMailto] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const run = (action: () => Promise<{ ok: true } | { ok: false; error: string }>) => {
    setError(null);
    start(async () => {
      const result = await action();
      if (!result.ok) setError(result.error);
    });
  };

  const deps = (approvalId: string): OpenDeps => ({
    record: (via: OpenedVia) => markSendOpened(approvalId, via),
    openExternal: (url: string) => {
      // A transient link, so the device hands the URL to the mail app.
      const a = document.createElement("a");
      a.href = url;
      a.rel = "noopener noreferrer";
      a.click();
    },
    copy: (text: string) => navigator.clipboard.writeText(text),
  });

  const refused = (message: string) => setError(`${message} この内容では送らないでください。`);
  const errorLine = error && (
    <p className={styles.error} role="alert">
      {error}
    </p>
  );

  // Step 1: nothing approved yet.
  if (!approval) {
    return (
      <div data-testid="send-flow" data-step="review">
        <Preview message={composed} />
        <p className={styles.muted}>宛先・件名・本文・デモを確認してから承認してください。承認しても送信はされません。</p>
        <button
          type="button"
          className={styles.primary}
          disabled={pending}
          data-testid="approve-send"
          onClick={() => run(() => approveSend(outreachId, draftVersion, { subject: composed.subject, body: composed.body }))}
        >
          {pending ? "記録中…" : "この内容で送信を承認"}
        </button>
        {errorLine}
      </div>
    );
  }

  const opened = approval.state === "send_opened";
  const stale = approval.staleReasons.length > 0;
  const blocked = opened && blockedWarning !== null && blockedWarning.length > 0;
  // DEV-197: unknown / another reason. No new send either; the database decides what it records.
  const check = opened && !blocked && checkWarning !== null ? checkWarning : null;
  const noNewSend = blocked || check !== null;
  const canOpen = !stale && !noNewSend && approval.link !== null;
  // DEV-197 (L2): a real send after a block is recorded even if the demo /
  // recipient changed since approval (never a changed text). Offered where a
  // block is confirmed or cannot be ruled out; otherwise stale still refuses.
  const staleRecordable = stale && approval.textStale === false && (blocked || (check?.blockPossible ?? false));
  const canConfirm = opened && (!stale || staleRecordable);

  const confirm = () => {
    setError(null);
    start(async () => {
      const result = await markSent(outreachId, approval.id);
      if (!result.ok) setError(result.error);
      else showRecorded({ recorded: result.recorded });
    });
  };

  const openMailApp = () => {
    if (!approval.link) return;
    const link = approval.link;
    setError(null);
    setRecordedMailto(null);
    start(async () => {
      const outcome = await openMail(link, deps(approval.id));
      if (outcome.kind === "refused") refused(outcome.error);
      else setRecordedMailto(link);
    });
  };

  const copy = () => {
    setError(null);
    start(async () => {
      const outcome = await copyText(approval.body, deps(approval.id));
      if (outcome.kind === "refused") refused(outcome.error);
      else setNote(outcome.copied ? "文面をコピーしました。" : "コピーできませんでした。上の欄を選択してコピーしてください。");
    });
  };

  // A blank window opens synchronously inside the tap (popup blockers keep
  // allowing it); it goes to the profile only after the server agreed.
  const openDm = () => {
    if (!approval.link) return;
    const link = approval.link;
    const win = window.open("", "_blank");
    if (win) win.opener = null;
    const pending: PendingWindow | null = win
      ? { navigate: (url) => win.location.replace(url), close: () => win.close() }
      : null;
    setError(null);
    start(async () => {
      const outcome = await openInstagram(link, approval.body, pending, deps(approval.id));
      if (outcome.kind === "refused") refused(outcome.error);
      else
        setNote(
          outcome.copied
            ? "営業文をコピーしました。プロフィールに「DM不可」「営業お断り」等がないか確認してから貼り付けて送信してください。"
            : "コピーできませんでした。上の欄の文面を選択してコピーし、Instagram で送信してください。",
        );
    });
  };

  return (
    <div data-testid="send-flow" data-step={approval.state} data-approval={approval.id}>
      <p className={styles.muted} data-testid="approval-state">
        {APPROVAL_STATE_LABEL[approval.state]}・承認 {approval.approvedLabel}
        {approval.openedLabel && <>・開いた {approval.openedLabel}</>}
      </p>
      <Preview message={{ channel: composed.channel, recipient: approval.recipient, subject: approval.subject, body: approval.body }} />
      {blocked && (
        <p className={styles.error} role="alert" data-testid="approval-blocked">
          送信画面を開いた後に、この店舗は送れない状態になりました（{blockedWarning!.join("・")}）。もう送らないでください。ここから送る操作はありません。
          {canConfirm
            ? "開いた後に実際に送っていた場合だけ「送信済みの事実を記録（事後記録）」を押してください。送れない状態だったことも一緒に記録され、この店舗へのフォローは出ません（禁止）。"
            : "承認の後に文面が変わったため、この承認では送信済みを記録できません。"}
          送っていなければ「送らなかった」を押してください。
        </p>
      )}
      {check && (
        <p className={styles.error} role="alert" data-testid={check.state === "unknown" ? "approval-unknown" : "approval-check-failed"}>
          {check.state === "unknown"
            ? `送信できるか確認できませんでした（${check.reasons.join("・")}）。再読み込みしてください。`
            : `送信画面を開いた後に、送れない条件が見つかりました（${check.reasons.join("・")}）。`}
          もう送らないでください。ここから送る操作はありません。
          {canConfirm
            ? "開いた後に実際に送っていた場合だけ「送信済みの事実を記録」を押してください。通常の送信として記録するか、送れない状態（営業不要・除外）の後の事後記録にするかはサーバーが確かめ、記録した内容を画面に表示します。記録できない場合は理由を表示します。"
            : "承認の後に内容が変わったため、この承認では送信済みを記録できません。"}
          送っていなければ「送らなかった」を押してください。
        </p>
      )}
      {stale ? (
        staleRecordable ? (
          <p className={styles.error} role="alert" data-testid="approval-stale" data-recordable="true">
            承認の後に内容が変わりました（{approval.staleReasons.join("・")}）。この承認でもう送らないでください。
            送れない状態（営業不要・除外）の後に実際に送っていた場合だけ、承認した内容（開いた内容）のまま記録でき、内容が変わっていたことも一緒に記録されます。
          </p>
        ) : (
          <p className={styles.error} role="alert" data-testid="approval-stale">
            この承認は使えません（{approval.staleReasons.join("・")}）。「送らなかった」で取り消してから、もう一度承認してください。
          </p>
        )
      ) : noNewSend ? null : approval.link ? (
        composed.channel === "email" ? (
          // A button, not a mailto link: middle-click / long-press "open link"
          // cannot skip the server's record (PR #239 re-review L4a).
          <button type="button" className={styles.primary} onClick={openMailApp} disabled={pending} data-testid="open-mail">
            メールを作成
          </button>
        ) : (
          <button type="button" className={styles.primary} onClick={openDm} disabled={pending}>
            DMを送る
          </button>
        )
      ) : (
        <p className={styles.error} role="alert">
          送信画面を開けません。画面を再読み込みしてください。
        </p>
      )}
      {canOpen && recordedMailto && composed.channel === "email" && (
        <a className={styles.linkButton} href={recordedMailto} data-testid="mail-fallback">
          メールアプリが開かない場合: メールアプリを開く
        </a>
      )}
      {canOpen && (
        <button type="button" className={styles.linkButton} onClick={copy} disabled={pending}>
          文面をコピー
        </button>
      )}
      <p className={styles.muted} role="status">
        {note ?? ""}
      </p>
      {canConfirm && (
        <>
          {!noNewSend && <p className={styles.muted}>送信したら「手動で送信済みにする」を押してください。開いただけでは送信済みになりません。</p>}
          <button
            type="button"
            className={styles.secondary}
            disabled={pending}
            data-testid="confirm-sent"
            data-confirm={blocked ? "after_block" : check ? "server_decides" : "manual"}
            onClick={confirm}
          >
            {pending ? "記録中…" : blocked ? "送信済みの事実を記録（事後記録）" : check ? "送信済みの事実を記録" : "手動で送信済みにする"}
          </button>
        </>
      )}
      <button
        type="button"
        className={styles.linkButton}
        disabled={pending}
        data-testid="withdraw-approval"
        onClick={() => run(() => withdrawApproval(approval.id))}
      >
        送らなかった（承認を取り消す）
      </button>
      {errorLine}
    </div>
  );
}
