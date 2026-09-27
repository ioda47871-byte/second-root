"use client";

import { useState, useTransition } from "react";
import { markLost, markMeeting, markWon } from "@/app/admin/sales/_actions/outcomes";
import styles from "./admin.module.css";

// replied → 商談へ / 失注, meeting → 成約（金額必須）/ 失注.

export default function OutcomeActions({ outreachId, status }: { outreachId: string; status: "replied" | "meeting" }) {
  const [amount, setAmount] = useState("");
  const [confirmLost, setConfirmLost] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    start(async () => {
      const result = await action();
      if (!result.ok) setError(result.error ?? "記録できませんでした。");
    });
  }

  return (
    <div className={styles.actions}>
      {status === "replied" && (
        <button type="button" className={styles.primary} disabled={pending} onClick={() => run(() => markMeeting(outreachId))}>
          商談へ
        </button>
      )}
      {status === "meeting" && (
        <>
          <label className={styles.label}>
            成約金額（円・税込）
            <input className={styles.input} inputMode="numeric" pattern="[0-9]*" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ""))} />
          </label>
          <button type="button" className={styles.primary} disabled={pending || amount === ""} onClick={() => run(() => markWon(outreachId, Number(amount)))}>
            成約
          </button>
        </>
      )}
      {!confirmLost ? (
        <button type="button" className={styles.secondary} disabled={pending} onClick={() => setConfirmLost(true)}>
          失注
        </button>
      ) : (
        <div className={styles.confirm}>
          <label className={styles.label}>
            失注の理由（任意）
            <input className={styles.input} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <p className={styles.muted}>失注にすると元に戻せません。</p>
          <button type="button" className={styles.secondary} disabled={pending} onClick={() => run(() => markLost(outreachId, reason))}>
            {pending ? "記録中…" : "失注にする"}
          </button>
          <button type="button" className={styles.linkButton} onClick={() => setConfirmLost(false)}>
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
