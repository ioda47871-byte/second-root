"use client";

import { useState, useTransition } from "react";
import { editIgDraft, resolveIgThread, resolveIgUnknown, sendIgReply, snoozeIgDraft, type IgResult } from "@/app/admin/sales/_actions/instagram";
import type { ReplyType } from "@/lib/sales/types";
import styles from "./admin.module.css";

// One Instagram conversation in 返信 (DEV-022). Everything shown here —
// the person's messages and the AI draft — is plain text (React escapes it).
// Three main actions: この内容で返信 / 返信文を編集 / 後で対応.

const REPLY_LABEL: Record<ReplyType, string> = {
  interested: "興味あり",
  question: "質問",
  meeting_request: "商談希望",
  decline: "断り",
  other: "その他",
};

const REASON_LABEL: Record<string, string> = {
  price: "金額の表現",
  schedule: "日程・納期の表現",
  contract: "約束・契約の表現",
  dnc_candidate: "今後の連絡を断っている可能性",
};

export type IgCardProps = {
  threadId: string;
  draftId: string | null;
  draftStatus: string | null;
  snoozed: boolean;
  stale: boolean;
  doNotContact: boolean;
  sendId: string | null;
  matched: boolean;
  username: string | null;
  shopName: string | null;
  receivedAt: string;
  windowOpen: boolean;
  messages: Array<{ direction: "inbound" | "outbound"; text: string | null; attachmentTypes: string[]; at: string }>;
  replyType: ReplyType | null;
  body: string | null;
  dncCandidate: boolean;
  reviewReasons: string[];
  candidates: Array<{ prospectId: string; name: string; handle: string }>;
};

export default function IgReplyCard(props: IgCardProps) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(props.body ?? "");
  const [result, setResult] = useState<IgResult | null>(null);
  const [pending, start] = useTransition();
  const [prospectId, setProspectId] = useState("");

  function run(action: () => Promise<IgResult>, after?: () => void) {
    setResult(null);
    start(async () => {
      const r = await action();
      setResult(r);
      if (r.ok) after?.();
    });
  }

  const latest = [...props.messages].reverse().find((m) => m.direction === "inbound");
  const unknown = props.draftStatus === "unknown";
  const sending = props.draftStatus === "sending";
  const editable = !props.stale && ["pending", "snoozed", "failed"].includes(props.draftStatus ?? "");
  const canSnooze = !props.stale && ["pending", "snoozed"].includes(props.draftStatus ?? "");
  // 「送信中」 left over (e.g. the server stopped mid-send) can be re-checked:
  // the server then reports it as in flight or as unknown, never resends.
  const canSend = props.matched && !props.doNotContact && props.windowOpen && props.draftId !== null && (editable || sending);

  return (
    <li className={styles.card} data-testid="ig-reply-item">
      <h3 className={styles.itemTitle}>{props.shopName ?? (props.username ? `未照合: @${props.username}` : "未照合の相手")}</h3>
      <p className={styles.meta}>Instagram・{props.receivedAt} 受信</p>
      <div className={styles.badges}>
        {props.replyType && <span className={styles.badge}>AI 分類: {REPLY_LABEL[props.replyType]}</span>}
        {props.snoozed && <span className={styles.badge}>後で対応</span>}
        {sending && <span className={styles.badge}>送信中</span>}
        {props.stale && <span className={`${styles.badge} ${styles.badgeWarn}`}>新しいメッセージあり（返信案を準備中）</span>}
        {props.doNotContact && <span className={`${styles.badge} ${styles.badgeWarn}`}>営業不要（DNC）</span>}
        {!props.windowOpen && <span className={`${styles.badge} ${styles.badgeWarn}`}>24時間を過ぎました（手動で返信）</span>}
        {props.dncCandidate && <span className={`${styles.badge} ${styles.badgeWarn}`}>営業不要（DNC）の可能性</span>}
      </div>

      <p className={styles.muted}>相手のメッセージ</p>
      <p className={styles.message}>{latest?.text ?? (latest?.attachmentTypes.length ? `（${latest.attachmentTypes.join("・")}）` : "（本文なし）")}</p>
      {props.messages.length > 1 && (
        <details className={styles.details}>
          <summary>これまでのやりとり</summary>
          <ul className={styles.thread}>
            {props.messages.map((m, i) => (
              <li key={i} className={m.direction === "inbound" ? styles.inbound : styles.outbound}>
                <span className={styles.muted}>{m.direction === "inbound" ? "相手" : "こちら"}・{m.at}</span>
                <span className={styles.threadText}>{m.text ?? `（${m.attachmentTypes.join("・") || "本文なし"}）`}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {props.reviewReasons.length > 0 && (
        <p className={styles.warn} role="note">
          送る前に確認: {props.reviewReasons.map((r) => REASON_LABEL[r] ?? r).join("・")}
          {props.dncCandidate && "。今後の連絡を断っている場合は、返信せず「営業不要（DNC）」にしてください（履歴から設定できます）。"}
        </p>
      )}

      {!props.matched && (
        <div className={styles.confirm}>
          <p className={styles.muted}>どの店舗からの返信か確認してください（自動では決めません）。</p>
          <label className={styles.label}>
            店舗
            <select className={styles.input} value={prospectId} onChange={(e) => setProspectId(e.target.value)}>
              <option value="">選んでください</option>
              {props.candidates.map((c) => (
                <option key={c.prospectId} value={c.prospectId}>
                  {c.name}（@{c.handle}）
                </option>
              ))}
            </select>
          </label>
          <button type="button" className={styles.secondary} disabled={pending || !prospectId} onClick={() => run(() => resolveIgThread(props.threadId, prospectId))}>
            この店舗の返信にする
          </button>
          <button type="button" className={styles.linkButton} disabled={pending} onClick={() => run(() => resolveIgThread(props.threadId, null))}>
            営業と関係ない
          </button>
        </div>
      )}

      {props.draftId && props.body !== null && !unknown && (
        <>
          <p className={styles.muted}>AI 返信案</p>
          {editing ? (
            <label className={styles.label}>
              返信文
              <textarea className={styles.input} rows={6} value={text} maxLength={1000} onChange={(e) => setText(e.target.value)} />
            </label>
          ) : (
            <p className={styles.message} data-testid="ig-draft">
              {props.body}
            </p>
          )}
          <div className={styles.actions}>
            {editing ? (
              <>
                <button type="button" className={styles.primary} disabled={pending} onClick={() => run(() => editIgDraft(props.draftId!, text), () => setEditing(false))}>
                  {pending ? "保存中…" : "保存する"}
                </button>
                <button type="button" className={styles.linkButton} onClick={() => { setEditing(false); setText(props.body ?? ""); }}>
                  やめる
                </button>
              </>
            ) : (
              <>
                <button type="button" className={styles.primary} disabled={pending || !canSend} onClick={() => run(() => sendIgReply(props.draftId!))}>
                  {pending ? "送信中…" : sending ? "送信状況を確認" : "この内容で返信"}
                </button>
                <button type="button" className={styles.secondary} disabled={pending || !editable} onClick={() => setEditing(true)}>
                  返信文を編集
                </button>
                <button
                  type="button"
                  className={styles.linkButton}
                  disabled={pending || !canSnooze}
                  onClick={() => run(() => snoozeIgDraft(props.draftId!, !props.snoozed))}
                >
                  {props.snoozed ? "今すぐ対応に戻す" : "後で対応"}
                </button>
              </>
            )}
          </div>
          {!props.matched && <p className={styles.muted}>店舗を確認すると返信できます。</p>}
        </>
      )}

      {unknown && props.sendId && (
        <div className={styles.confirm} role="alert">
          <p className={styles.error}>送信されたか確認できませんでした。Instagram アプリでこの相手とのやりとりを確認してください。</p>
          <button type="button" className={styles.secondary} disabled={pending} onClick={() => run(() => resolveIgUnknown(props.sendId!, true))}>
            送信されていた
          </button>
          <button type="button" className={styles.secondary} disabled={pending} onClick={() => run(() => resolveIgUnknown(props.sendId!, false))}>
            送信されていなかった
          </button>
        </div>
      )}

      {!props.draftId && props.matched && <p className={styles.muted}>返信案はまだありません（自動で準備されます）。</p>}

      <p className={result && !result.ok ? styles.error : styles.muted} role="status">
        {result ? (result.ok ? result.message ?? "" : result.error) : ""}
      </p>
    </li>
  );
}
