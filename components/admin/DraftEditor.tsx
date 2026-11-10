"use client";

import { useState, useTransition } from "react";
import { editDraft } from "@/app/admin/sales/_actions/draft";
import { MAX_BODY_LENGTH, MAX_SUBJECT_LENGTH } from "@/lib/sales/draft";
import type { Channel } from "@/lib/sales/types";
import styles from "./admin.module.css";

// DEV-195: 文面を編集 — the owner's own words for the message (and the email
// subject) of an unsent initial draft. The greeting, demo URL, disclaimer,
// opt-out line and signature are added when the message is composed, so they
// are not edited here and can never be removed. Saving withdraws an approval
// of the earlier text (the owner approves again).

export default function DraftEditor({
  outreachId,
  draftVersion,
  channel,
  subject,
  body,
  editedLabel,
  locked,
}: {
  outreachId: string;
  draftVersion: number;
  channel: Channel;
  subject: string | null;
  body: string;
  /** e.g. 「2026/11/07 10:05 に編集」, null when never edited. */
  editedLabel: string | null;
  /** The send screen was opened for the approved text: settle that first. */
  locked: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draftSubject, setDraftSubject] = useState(subject ?? "");
  const [draftBody, setDraftBody] = useState(body);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  function save() {
    setMessage(null);
    start(async () => {
      const result = await editDraft(outreachId, draftVersion, channel === "email" ? draftSubject : null, draftBody);
      if (result.ok) {
        setEditing(false);
        setMessage({ ok: true, text: result.message ?? "保存しました。" });
      } else setMessage({ ok: false, text: result.error });
    });
  }

  return (
    <div className={styles.actions} data-testid="draft-editor">
      {editedLabel && (
        <p className={styles.muted} data-testid="draft-edited">
          文面はオーナーが編集済み（{editedLabel}）
        </p>
      )}
      {locked ? (
        <p className={styles.muted}>送信画面を開いた承認があるため、いまは編集できません（送らなかった場合は「送らなかった」で取り消してください）。</p>
      ) : !editing ? (
        <button type="button" className={styles.secondary} onClick={() => setEditing(true)} data-testid="edit-draft">
          文面を編集
        </button>
      ) : (
        <div className={styles.confirm}>
          {channel === "email" && (
            <label className={styles.label}>
              件名（{MAX_SUBJECT_LENGTH}文字まで。空なら既定の件名）
              <input className={styles.input} maxLength={MAX_SUBJECT_LENGTH} value={draftSubject} onChange={(e) => setDraftSubject(e.target.value)} />
            </label>
          )}
          <label className={styles.label}>
            本文（{MAX_BODY_LENGTH}文字まで。宛名・デモの URL・注記・配信停止の文・署名は自動で付きます）
            <textarea className={styles.input} rows={8} maxLength={MAX_BODY_LENGTH + 200} value={draftBody} onChange={(e) => setDraftBody(e.target.value)} />
          </label>
          <button type="button" className={styles.secondary} disabled={pending} onClick={save} data-testid="save-draft">
            {pending ? "保存中…" : "文面を保存"}
          </button>
          <button type="button" className={styles.linkButton} onClick={() => setEditing(false)}>
            やめる
          </button>
        </div>
      )}
      {message && (
        <p className={message.ok ? styles.muted : styles.error} role={message.ok ? "status" : "alert"}>
          {message.text}
        </p>
      )}
    </div>
  );
}
