"use client";

import { useState, useTransition } from "react";
import { approveSend, markSendOpened, markSent, withdrawApproval } from "@/app/admin/sales/_actions/send";
import { APPROVAL_STATE_LABEL, type OpenedVia } from "@/lib/sales/approval";
import { copyText, openInstagram, openMail, type OpenDeps, type PendingWindow } from "@/lib/sales/open-send";
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
  /** mailto: (email) or the Instagram profile (instagram), built from the approved text; null if it cannot be. */
  link: string | null;
};

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
}: {
  outreachId: string;
  draftVersion: number;
  composed: ComposedMessage;
  approval: ApprovalProps | null;
  /**
   * PR #239 M2: an opened approval whose shop is now DNC / excluded. Only the
   * confirm (if it really was sent) and 送らなかった are offered.
   */
  blockedWarning?: string[] | null;
}) {
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
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

  const stale = approval.staleReasons.length > 0;
  const blocked = approval.state === "send_opened" && blockedWarning !== null && blockedWarning.length > 0;
  const canOpen = !stale && !blocked && approval.link !== null;

  const openMailApp = (e: { preventDefault(): void }) => {
    e.preventDefault();
    if (!approval.link) return;
    const link = approval.link;
    setError(null);
    start(async () => {
      const outcome = await openMail(link, deps(approval.id));
      if (outcome.kind === "refused") refused(outcome.error);
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
          送信画面を開いた後に、この店舗は送れない状態になりました（{blockedWarning!.join("・")}）。もう送らないでください。
          開いた後に実際に送った場合だけ「手動で送信済みにする」を押してください（送れない状態だったことも記録され、フォローは出ません）。送っていなければ「送らなかった」を押してください。
        </p>
      )}
      {stale ? (
        <p className={styles.error} role="alert" data-testid="approval-stale">
          この承認は使えません（{approval.staleReasons.join("・")}）。「送らなかった」で取り消してから、もう一度承認してください。
        </p>
      ) : blocked ? null : approval.link ? (
        composed.channel === "email" ? (
          <a className={styles.primaryLink} href={approval.link} onClick={openMailApp} aria-disabled={pending || undefined}>
            メールを作成
          </a>
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
      {canOpen && (
        <button type="button" className={styles.linkButton} onClick={copy} disabled={pending}>
          文面をコピー
        </button>
      )}
      <p className={styles.muted} role="status">
        {note ?? ""}
      </p>
      {approval.state === "send_opened" && !stale && (
        <>
          <p className={styles.muted}>送信したら「手動で送信済みにする」を押してください。開いただけでは送信済みになりません。</p>
          <button
            type="button"
            className={styles.secondary}
            disabled={pending}
            data-testid="confirm-sent"
            onClick={() => run(() => markSent(outreachId, approval.id))}
          >
            {pending ? "記録中…" : "手動で送信済みにする"}
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
