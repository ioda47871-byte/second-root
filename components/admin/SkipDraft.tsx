"use client";

import { useState, useTransition } from "react";
import { skipDraft } from "@/app/admin/sales/_actions/outcomes";
import styles from "./admin.module.css";

// DEV-048: 送らない初回の下書きを今日の一覧から外す（確認つき、理由は任意）.

export default function SkipDraft({ outreachId }: { outreachId: string }) {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function run() {
    setError(null);
    start(async () => {
      const result = await skipDraft(outreachId, reason);
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <div className={styles.actions}>
      {!confirming ? (
        <button type="button" className={styles.secondary} onClick={() => setConfirming(true)} data-testid="skip-draft">
          見送る
        </button>
      ) : (
        <div className={styles.confirm}>
          <label className={styles.label}>
            見送る理由（任意）
            <input className={styles.input} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <p className={styles.muted}>この下書きは送らずに閉じます。元に戻せません。</p>
          <button type="button" className={styles.secondary} disabled={pending} onClick={run}>
            {pending ? "記録中…" : "はい、見送る"}
          </button>
          <button type="button" className={styles.linkButton} onClick={() => setConfirming(false)}>
            やめる
          </button>
        </div>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
