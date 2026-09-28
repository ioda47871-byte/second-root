"use client";

import { useState, useTransition } from "react";
import { clearDnc, setDnc } from "@/app/admin/sales/_actions/dnc";
import styles from "./admin.module.css";

// Manual DNC on / off with an explicit confirmation step.

export default function DncControl({ prospectId, doNotContact }: { prospectId: string; doNotContact: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function run() {
    setError(null);
    start(async () => {
      const result = doNotContact ? await clearDnc(prospectId) : await setDnc(prospectId);
      if (!result.ok) setError(result.error);
      setConfirming(false);
    });
  }

  const label = doNotContact ? "DNC を解除" : "営業不要（DNC）にする";
  return (
    <div className={styles.actions}>
      {!confirming ? (
        <button type="button" className={styles.secondary} onClick={() => setConfirming(true)}>
          {label}
        </button>
      ) : (
        <>
          <p className={styles.muted}>
            {doNotContact ? "DNC を解除します。デモは無効のままです。よろしいですか？" : "今後この店舗へ営業しません。デモも非公開になります。よろしいですか？"}
          </p>
          <button type="button" className={styles.primary} onClick={run} disabled={pending}>
            {pending ? "変更中…" : `はい、${label}`}
          </button>
          <button type="button" className={styles.linkButton} onClick={() => setConfirming(false)}>
            やめる
          </button>
        </>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
