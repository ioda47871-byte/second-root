"use client";

import { useState, useTransition } from "react";
import { markSent } from "@/app/admin/sales/_actions/send";
import styles from "./admin.module.css";

// メールを作成: opens the device's mail app with recipient, subject and body
// (demo URL, signature, opt-out line) pre-filled. The human presses Send
// there, then comes back and taps 送信済み (MVP_SPEC §4.2). Never Resend.

export default function EmailSend({ outreachId, mailto, label = "メールを作成" }: { outreachId: string; mailto: string; label?: string }) {
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function confirmSent() {
    setError(null);
    start(async () => {
      const result = await markSent(outreachId);
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <>
      <a className={styles.primaryLink} href={mailto} onClick={() => setOpened(true)}>
        {label}
      </a>
      {opened && (
        <>
          <p className={styles.muted} role="status">
            メールアプリで送信したら、戻って「送信済み」を押してください。
          </p>
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
