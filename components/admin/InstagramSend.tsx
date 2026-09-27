"use client";

import { useState, useTransition } from "react";
import { markSent } from "@/app/admin/sales/_actions/send";
import styles from "./admin.module.css";

// DMを送る: copy the message and open the shop's Instagram. Opening is not
// sending — the admin comes back and taps 送信済み (MVP_SPEC §4.1).

export default function InstagramSend({ outreachId, dmText, instagramUrl }: { outreachId: string; dmText: string; instagramUrl: string }) {
  const [opened, setOpened] = useState(false);
  const [copied, setCopied] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // Both the copy and the new tab start synchronously inside the tap, so
  // mobile browsers (iOS Safari) keep treating them as user-initiated.
  function openDm() {
    let copy: Promise<void>;
    try {
      copy = navigator.clipboard.writeText(dmText);
    } catch {
      copy = Promise.reject(new Error("clipboard unavailable"));
    }
    copy.then(
      () => setCopied(true),
      () => setCopied(false),
    );
    window.open(instagramUrl, "_blank", "noopener,noreferrer");
    setOpened(true);
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
      <button type="button" className={styles.primary} onClick={openDm}>
        DMを送る
      </button>
      {opened && (
        <>
          <p className={styles.muted} role="status">
            {copied
              ? "営業文をコピーしました。プロフィールに「DM不可」「営業お断り」等がないか確認してから貼り付けて送信し、戻って「送信済み」を押してください。"
              : "コピーできませんでした。下の文面を選択してコピーし、Instagram で送信してください。"}
          </p>
          {copied === false && <textarea className={styles.input} readOnly rows={8} value={dmText} aria-label="DM の文面" />}
          <a className={styles.linkButton} href={instagramUrl} target="_blank" rel="noopener noreferrer">
            Instagram が開かない場合はこちら
          </a>
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
