"use client";

import { useState, useTransition } from "react";
import { recordReply } from "@/app/admin/sales/_actions/outcomes";
import type { ReplyType } from "@/lib/sales/types";
import styles from "./admin.module.css";

// 返信あり → classify in one step. A plain 断り ends outreach to this shop but
// is not DNC; only 「今後の連絡を拒否された」 sets DNC (MVP_SPEC §5, §6).

const OPTIONS: Array<[ReplyType, string]> = [
  ["interested", "興味あり"],
  ["question", "質問"],
  ["meeting_request", "商談希望"],
  ["decline", "断り"],
  ["other", "その他"],
];

export default function ReplyForm({ outreachId }: { outreachId: string }) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<ReplyType | null>(null);
  const [refused, setRefused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (!open) {
    return (
      <button type="button" className={styles.primary} onClick={() => setOpen(true)}>
        返信あり
      </button>
    );
  }

  function submit() {
    if (!type) return setError("返信の種類を選んでください。");
    setError(null);
    start(async () => {
      const result = await recordReply({ outreachId, replyType: type, futureContactRefused: type === "decline" && refused });
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <fieldset className={styles.form} style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className={styles.muted}>返信の種類</legend>
      {OPTIONS.map(([value, label]) => (
        <label key={value} className={styles.choice}>
          <input type="radio" name={`reply-${outreachId}`} value={value} checked={type === value} onChange={() => setType(value)} />
          {label}
        </label>
      ))}
      {type === "decline" && (
        <label className={styles.choice}>
          <input type="checkbox" checked={refused} onChange={(e) => setRefused(e.target.checked)} />
          今後の連絡を拒否された（営業不要・以後連絡しない）
        </label>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <button type="button" className={styles.primary} onClick={submit} disabled={pending || !type}>
        {pending ? "記録中…" : "記録する"}
      </button>
    </fieldset>
  );
}
