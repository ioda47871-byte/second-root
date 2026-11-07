"use client";

import { useState, useTransition } from "react";
import { approveSend, markSendOpened, markSent, withdrawApproval } from "@/app/admin/sales/_actions/send";
import { APPROVAL_STATE_LABEL, type OpenedVia } from "@/lib/sales/approval";
import type { Channel } from "@/lib/sales/types";
import styles from "./admin.module.css";

// DEV-195: the manual send of an initial message, in three steps the
// database records separately (MVP_SPEC §4):
//   1. この内容で送信を承認 — the exact recipient / subject / body shown here.
//   2. メールを作成 / DMを送る / 文面をコピー — opens the owner's own app. This
//      is recorded as 「送信画面を開いた」, never as a send.
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
}: {
  outreachId: string;
  draftVersion: number;
  composed: ComposedMessage;
  approval: ApprovalProps | null;
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

  const recordOpened = (via: OpenedVia) => {
    if (!approval) return;
    setError(null);
    start(async () => {
      const result = await markSendOpened(approval.id, via);
      if (!result.ok) setError(`${result.error} この内容では送らないでください。`);
    });
  };

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
  const copy = () => {
    navigator.clipboard.writeText(approval.body).then(
      () => {
        setNote("文面をコピーしました。");
        recordOpened("copy");
      },
      () => setNote("コピーできませんでした。上の欄を選択してコピーしてください。"),
    );
  };

  // Both the copy and the new tab start synchronously inside the tap, so
  // mobile browsers (iOS Safari) keep treating them as user-initiated.
  const openDm = () => {
    if (!approval.link) return;
    let copied: Promise<void>;
    try {
      copied = navigator.clipboard.writeText(approval.body);
    } catch {
      copied = Promise.reject(new Error("clipboard unavailable"));
    }
    copied.then(
      () => setNote("営業文をコピーしました。プロフィールに「DM不可」「営業お断り」等がないか確認してから貼り付けて送信してください。"),
      () => setNote("コピーできませんでした。上の欄の文面を選択してコピーし、Instagram で送信してください。"),
    );
    window.open(approval.link, "_blank", "noopener,noreferrer");
    recordOpened("instagram_profile");
  };

  return (
    <div data-testid="send-flow" data-step={approval.state} data-approval={approval.id}>
      <p className={styles.muted} data-testid="approval-state">
        {APPROVAL_STATE_LABEL[approval.state]}・承認 {approval.approvedLabel}
        {approval.openedLabel && <>・開いた {approval.openedLabel}</>}
      </p>
      <Preview message={{ channel: composed.channel, recipient: approval.recipient, subject: approval.subject, body: approval.body }} />
      {stale ? (
        <p className={styles.error} role="alert" data-testid="approval-stale">
          この承認は使えません（{approval.staleReasons.join("・")}）。「送らなかった」で取り消してから、もう一度承認してください。
        </p>
      ) : approval.link ? (
        composed.channel === "email" ? (
          <a className={styles.primaryLink} href={approval.link} onClick={() => recordOpened("mailto")}>
            メールを作成
          </a>
        ) : (
          <button type="button" className={styles.primary} onClick={openDm}>
            DMを送る
          </button>
        )
      ) : (
        <p className={styles.error} role="alert">
          送信画面を開けません。画面を再読み込みしてください。
        </p>
      )}
      {!stale && (
        <button type="button" className={styles.linkButton} onClick={copy}>
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
