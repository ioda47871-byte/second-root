"use client";

import { useState, useSyncExternalStore, useTransition } from "react";
import { markSent } from "@/app/admin/sales/_actions/send";
import styles from "./admin.module.css";

// メールを作成: opens the device's mail app with recipient, subject and body
// (demo URL, signature, opt-out line) pre-filled. The human presses Send
// there, then comes back and taps 送信済み (MVP_SPEC §4.2). Never Resend.

type Draft = { to: string; subject: string; body: string };

// "Opened" survives a reload (mobile browsers often reload the tab after
// switching apps), so 送信済み is still offered when the admin comes back.
const openedKey = (outreachId: string) => `sales-email-opened:${outreachId}`;

function rememberOpened(outreachId: string) {
  try {
    sessionStorage.setItem(openedKey(outreachId), "1");
  } catch {
    // Storage unavailable: the admin can open the mail app again.
  }
}

const noSubscription = () => () => {};

function wasOpened(outreachId: string): boolean {
  try {
    return sessionStorage.getItem(openedKey(outreachId)) === "1";
  } catch {
    return false;
  }
}

export default function EmailSend({
  outreachId,
  mailto,
  draft,
  label = "メールを作成",
}: {
  outreachId: string;
  mailto: string;
  draft: Draft;
  label?: string;
}) {
  const [clicked, setClicked] = useState(false);
  // Read after hydration only (the server has no sessionStorage).
  const stored = useSyncExternalStore(noSubscription, () => wasOpened(outreachId), () => false);
  const opened = clicked || stored;
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function open() {
    rememberOpened(outreachId);
    setClicked(true);
  }

  function copy(field: keyof Draft, name: string) {
    navigator.clipboard.writeText(draft[field]).then(
      () => setCopied(`${name}をコピーしました。`),
      () => setCopied("コピーできませんでした。欄を選択してコピーしてください。"),
    );
  }

  function confirmSent() {
    setError(null);
    start(async () => {
      const result = await markSent(outreachId);
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <>
      <a className={styles.primaryLink} href={mailto} onClick={open}>
        {label}
      </a>
      <p className={styles.muted} role="status">
        {opened ? "メールアプリで送信したら、戻って「送信済み」を押してください。" : ""}
      </p>
      {opened && (
        <>
          <details className={styles.details}>
            <summary>メールアプリが開かない場合</summary>
            <label className={styles.label}>
              宛先
              <input className={styles.input} readOnly value={draft.to} />
            </label>
            <button type="button" className={styles.linkButton} onClick={() => copy("to", "宛先")}>
              宛先をコピー
            </button>
            <label className={styles.label}>
              件名
              <input className={styles.input} readOnly value={draft.subject} />
            </label>
            <button type="button" className={styles.linkButton} onClick={() => copy("subject", "件名")}>
              件名をコピー
            </button>
            <label className={styles.label}>
              本文
              <textarea className={styles.input} readOnly rows={10} value={draft.body} />
            </label>
            <button type="button" className={styles.linkButton} onClick={() => copy("body", "本文")}>
              本文をコピー
            </button>
            <p className={styles.muted} role="status">
              {copied ?? ""}
            </p>
          </details>
          <button type="button" className={styles.secondary} onClick={confirmSent} disabled={pending}>
            {pending ? "記録中…" : "送信済み"}
          </button>
        </>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </>
  );
}
