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

  async function openDm() {
    try {
      await navigator.clipboard.writeText(dmText);
      setCopied(true);
    } catch {
      setCopied(false);
    }
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
              ? "営業文をコピーしました。Instagram で貼り付けて送信したら、戻って「送信済み」を押してください。"
              : "コピーできませんでした。下の文面を選択してコピーし、Instagram で送信してください。"}
          </p>
          {copied === false && <textarea className={styles.input} readOnly rows={8} value={dmText} aria-label="DM の文面" />}
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
