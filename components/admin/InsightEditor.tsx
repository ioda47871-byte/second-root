"use client";

import { useState, useTransition } from "react";
import { setInsight } from "@/app/admin/sales/_actions/draft";
import { MAX_INSIGHT_LENGTH, type InsightKind } from "@/lib/sales/insights";
import styles from "./admin.module.css";

// DEV-195: the owner writes (or clears) the shop's selection rationale /
// improvement hypothesis. Recorded with the owner as the source; an empty
// text removes the note and the card shows 未確認 again.

export default function InsightEditor({ prospectId, kind, label, value }: { prospectId: string; kind: InsightKind; label: string; value: string | null }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value ?? "");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  function save() {
    setMessage(null);
    start(async () => {
      const result = await setInsight(prospectId, kind, text);
      if (result.ok) {
        setEditing(false);
        setMessage({ ok: true, text: result.message ?? "保存しました。" });
      } else setMessage({ ok: false, text: result.error });
    });
  }

  if (!editing) {
    return (
      <>
        <button type="button" className={styles.linkButton} onClick={() => setEditing(true)} data-testid={`edit-insight-${kind}`}>
          {value ? `${label}を編集` : `${label}を記入`}
        </button>
        {message && (
          <p className={message.ok ? styles.muted : styles.error} role={message.ok ? "status" : "alert"}>
            {message.text}
          </p>
        )}
      </>
    );
  }
  return (
    <div className={styles.confirm}>
      <label className={styles.label}>
        {label}（{MAX_INSIGHT_LENGTH}文字まで。分かっていることだけ。空にすると削除）
        <textarea className={styles.input} rows={3} maxLength={MAX_INSIGHT_LENGTH + 50} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <button type="button" className={styles.secondary} disabled={pending} onClick={save} data-testid={`save-insight-${kind}`}>
        {pending ? "保存中…" : "保存"}
      </button>
      <button type="button" className={styles.linkButton} onClick={() => setEditing(false)}>
        やめる
      </button>
      {message && !message.ok && (
        <p className={styles.error} role="alert">
          {message.text}
        </p>
      )}
    </div>
  );
}
