"use client";
/**
 * DEV-196d-5 (spec §7.2・§8.3・§9, DEV-196c Lows a / c / d): the admin's quality decision on one version.
 *
 * Every condition is the admin's own explicit action, and nothing starts checked: each of the 7 items needs 問題なし or
 * 問題あり (items 3・4・5 are emphasised, with when to answer 問題あり); each AI concept image needs its own
 * 「事実の偽装なし」 confirmation; approving needs the acknowledgement that it stops the shop's sending. 品質承認 is
 * enabled only when all 7 are 問題なし, every render was scrolled to its very end, every image is confirmed, the
 * acknowledgement is ticked and the view model has no blocker. 修正を依頼 / 却下 need at least one 問題あり.
 * The server re-checks all of it (lib/admin/demo-review.ts) — this form only avoids offering what would be refused.
 */
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { reviewDemoVersion } from "@/app/admin/sales/_actions/demo-versions";
import {
  AI_CONCEPT_BADGE,
  APPROVAL_STOPS_SENDING_AFTER,
  APPROVAL_STOPS_SENDING_BEFORE,
  APPROVE_BLOCKER_LABEL,
  CHECKLIST_ANSWER_LABEL,
  CHECKLIST_TEXT,
  INVALID_NOTE_MESSAGE,
  NO_IMPERSONATION_STATEMENT,
  QUALITY_DECISION_LABEL,
  SEND_STOP_ACKNOWLEDGEMENT,
} from "@/lib/sales/demo-version/admin-messages";
import { EMPHASISED_ITEMS, QUALITY_CHECKLIST_ITEMS, type QualityChecklistItem, type QualityDecision } from "@/lib/sales/demo-version/quality";
import { normaliseNote } from "@/lib/sales/demo-version/review-input";
import type { ApproveBlocker } from "@/lib/sales/demo-version/view-model";
import { RENDER_LABEL, type RenderItem } from "./RenderPane";
import styles from "./demo.module.css";

export type ReviewImage = { imageId: string; sha256: string; path: string; thumbSrc: string | null };
export type ReviewVersion = {
  id: string;
  versionNo: number;
  bundleSha256: string;
  renders: (Pick<RenderItem, "viewport"> & { sha256: string })[];
  approveBlockers: ApproveBlocker[];
  reviewBlockers: ApproveBlocker[];
  aiImages: ReviewImage[];
};

type Answer = "ok" | "ng";

export default function QualityReviewForm({ prospectId, version, viewed }: { prospectId: string; version: ReviewVersion; viewed: ReadonlySet<RenderItem["viewport"]> }) {
  const router = useRouter();
  const [answers, setAnswers] = useState<Partial<Record<QualityChecklistItem, Answer>>>({});
  const [confirmed, setConfirmed] = useState<ReadonlySet<string>>(new Set());
  const [ack, setAck] = useState(false);
  const [note, setNote] = useState("");
  const [result, setResult] = useState<{ kind: "error" | "done"; text: string; decision?: QualityDecision } | null>(null);
  const [pending, start] = useTransition();

  const answered = QUALITY_CHECKLIST_ITEMS.filter((k) => answers[k]).length;
  const allAnswered = answered === QUALITY_CHECKLIST_ITEMS.length;
  const allOk = allAnswered && QUALITY_CHECKLIST_ITEMS.every((k) => answers[k] === "ok");
  const anyNg = QUALITY_CHECKLIST_ITEMS.some((k) => answers[k] === "ng");
  const allViewed = version.renders.length > 0 && version.renders.every((r) => viewed.has(r.viewport));
  const allConfirmed = version.aiImages.every((i) => confirmed.has(i.imageId));
  const noteOk = normaliseNote(note).ok;

  const approveWhy: string[] = [
    ...version.approveBlockers.map((b) => APPROVE_BLOCKER_LABEL[b]),
    ...(allAnswered ? [] : [`7 項目のうち ${7 - answered} 項目が未回答です。`]),
    ...(allAnswered && !allOk ? ["「問題あり」の項目があります。"] : []),
    ...(allViewed ? [] : ["PC と SP の描画画像を、それぞれ一番下まで見ていません。"]),
    ...(allConfirmed ? [] : ["AI 生成の概念画像の「事実の偽装なし」を、画像ごとに確認していません。"]),
    ...(ack ? [] : ["送信承認が止まることの確認がありません。"]),
    ...(noteOk ? [] : ["メモを直してください。"]),
  ];
  const canApprove = approveWhy.length === 0;
  const canSendBack = version.reviewBlockers.length === 0 && allAnswered && anyNg && noteOk;

  const submit = (decision: QualityDecision) => {
    setResult(null);
    start(async () => {
      const viewedRenders = Object.fromEntries(version.renders.filter((r) => viewed.has(r.viewport)).map((r) => [r.viewport, r.sha256]));
      const res = await reviewDemoVersion({
        prospectId,
        versionId: version.id,
        decision,
        checklist: answers,
        viewedRenders,
        bundleSha256: version.bundleSha256,
        impersonation: decision === "approved" ? version.aiImages.filter((i) => confirmed.has(i.imageId)).map((i) => ({ imageId: i.imageId, sha256: i.sha256 })) : [],
        acknowledgedSendStop: decision === "approved" ? ack : false,
        note: note.trim() === "" ? null : note,
      });
      if (!res.ok) setResult({ kind: "error", text: res.error });
      else {
        setResult({ kind: "done", text: res.decision === "approved" ? APPROVAL_STOPS_SENDING_AFTER : `「${QUALITY_DECISION_LABEL[res.decision]}」を記録しました。`, decision: res.decision });
        router.refresh();
      }
    });
  };

  return (
    <section className={styles.panel} aria-labelledby="review-h" data-review-form={version.versionNo}>
      <h2 id="review-h" className={styles.h2}>
        v{version.versionNo} の品質の判定（7 項目）
      </h2>
      <p className={styles.note}>上の描画画像を PC と SP それぞれ一番下まで見てから、項目ごとに答えてください。初めから選ばれている答えはありません。</p>

      {QUALITY_CHECKLIST_ITEMS.map((k, i) => {
        const t = CHECKLIST_TEXT[k];
        const emph = EMPHASISED_ITEMS.includes(k);
        return (
          <fieldset key={k} className={emph ? styles.itemEmph : styles.item} data-item={k} data-answer={answers[k] ?? "none"}>
            <legend>
              {i + 1}. {t.label} {emph && <span className={styles.tag}>特に重要</span>}
            </legend>
            {t.hint && <p className={styles.note}>{t.hint}</p>}
            <div className={styles.answers}>
              {(["ok", "ng"] as const).map((a) => (
                <label key={a} className={styles.answer}>
                  <input type="radio" name={`item-${k}`} value={a} checked={answers[k] === a} onChange={() => setAnswers((x) => ({ ...x, [k]: a }))} />
                  {CHECKLIST_ANSWER_LABEL[a]}
                </label>
              ))}
            </div>
          </fieldset>
        );
      })}

      {version.aiImages.length > 0 && (
        <fieldset className={styles.itemEmph} data-impersonation="">
          <legend>AI 生成の概念画像：画像ごとに確認してください</legend>
          {version.aiImages.map((img) => (
            <label key={img.imageId} className={styles.image} data-confirm-image={img.imageId}>
              {img.thumbSrc ? (
                // eslint-disable-next-line @next/next/no-img-element -- served by the artifact route after its own rights check
                <img className={styles.thumb} src={img.thumbSrc} alt="" width={72} height={72} referrerPolicy="no-referrer" />
              ) : (
                <span className={styles.thumbBlocked}>表示なし</span>
              )}
              <span>
                <span className={styles.tagAi}>{AI_CONCEPT_BADGE}</span> <span className={styles.mono}>{img.path.slice("page/".length)}</span>
                <span style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 6 }}>
                  <input
                    type="checkbox"
                    checked={confirmed.has(img.imageId)}
                    onChange={(e) =>
                      setConfirmed((s) => {
                        const n = new Set(s);
                        if (e.target.checked) n.add(img.imageId);
                        else n.delete(img.imageId);
                        return n;
                      })
                    }
                  />
                  <span>{NO_IMPERSONATION_STATEMENT}</span>
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      )}

      <label className={styles.item} style={{ display: "block" }}>
        <span className={styles.sub}>メモ（任意・500 字まで）</span>
        <textarea className={styles.select} style={{ minHeight: 80, padding: 8 }} value={note} onChange={(e) => setNote(e.target.value)} aria-invalid={!noteOk} aria-describedby={noteOk ? undefined : "note-error"} maxLength={2000} />
        {!noteOk && (
          <span id="note-error" className={styles.unconfirmed} role="alert">
            {INVALID_NOTE_MESSAGE}
          </span>
        )}
      </label>

      <div className={styles.alert} data-approval-warning="form">
        <p style={{ margin: 0 }}>
          <strong>{APPROVAL_STOPS_SENDING_BEFORE}</strong>
        </p>
        <label style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 8, minHeight: 44 }}>
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} data-ack="" />
          <span>{SEND_STOP_ACKNOWLEDGEMENT}</span>
        </label>
      </div>

      <div className={styles.reviewBar} data-review-summary="">
        <span className={styles.sub}>
          7項目 {answered}/7・
          {version.renders.map((r) => `${RENDER_LABEL[r.viewport].split(" ")[0]}${viewed.has(r.viewport) ? "✓" : "–"}`).join("・")}
          {version.aiImages.length > 0 ? `・画像 ${version.aiImages.filter((i) => confirmed.has(i.imageId)).length}/${version.aiImages.length}` : ""}
        </span>
        <div className={styles.tabs} style={{ margin: 0 }}>
          <button type="button" className={styles.primary} disabled={!canApprove || pending} onClick={() => submit("approved")} aria-describedby="approve-why">
            品質承認
          </button>
          <button type="button" className={styles.tab} disabled={!canSendBack || pending} onClick={() => submit("changes_requested")}>
            修正を依頼
          </button>
          <button type="button" className={styles.tab} disabled={!canSendBack || pending} onClick={() => submit("rejected")}>
            却下
          </button>
        </div>
      </div>
      {!canApprove && (
        <ul id="approve-why" className={`${styles.list} ${styles.sub}`} data-approve-why="">
          {approveWhy.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      {result && (
        <p className={result.kind === "error" ? styles.alert : styles.warn} role={result.kind === "error" ? "alert" : "status"} data-review-result={result.kind}>
          {result.text}
        </p>
      )}
    </section>
  );
}
