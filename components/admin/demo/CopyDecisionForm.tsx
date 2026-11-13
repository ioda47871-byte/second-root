"use client";
/**
 * DEV-199b (Issue #258): the owner's copy decision on a version's copy review — 文章を承認 / 改稿を依頼 / 却下. Each
 * decision is offered only when the server says it would be taken (the refusals are shown otherwise), and the server
 * checks everything again (decideCopyReview → sales_decide_copy_review). The record is bound to the review and its
 * hashes the screen showed; it cannot be changed afterwards.
 */
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { decideCopyReview } from "@/app/admin/sales/_actions/demo-versions";
import { COPY_DECISION_REFUSAL_LABEL } from "@/lib/sales/copy-review/labels";
import { NOTE_MAX_CHARS } from "@/lib/sales/demo-version/review-client";
import styles from "./demo.module.css";

type Decision = "approve" | "revise" | "reject";
const DECISION_LABEL: Record<Decision, string> = { approve: "文章を承認", revise: "改稿を依頼", reject: "却下" };
const DECISIONS: Decision[] = ["approve", "revise", "reject"];

export type CopyDecisionTarget = {
  prospectId: string;
  versionId: string;
  reviewId: string;
  hashes: { review: string; facts: string; copy: string; pageHtml: string; pageCss: string };
  refusals: Record<Decision, string[]>;
};

export default function CopyDecisionForm({ target }: { target: CopyDecisionTarget }) {
  const router = useRouter();
  const [decision, setDecision] = useState<Decision | null>(null);
  const [note, setNote] = useState("");
  const [result, setResult] = useState<{ kind: "error" | "done"; text: string } | null>(null);
  const [pending, start] = useTransition();
  const submit = () =>
    start(async () => {
      if (!decision) return;
      setResult(null);
      const r = await decideCopyReview({
        prospectId: target.prospectId,
        versionId: target.versionId,
        reviewId: target.reviewId,
        decision,
        reviewSha256: target.hashes.review,
        factsSha256: target.hashes.facts,
        copySha256: target.hashes.copy,
        pageHtmlSha256: target.hashes.pageHtml,
        pageCssSha256: target.hashes.pageCss,
        note: note.trim() === "" ? null : note,
      });
      if (r.ok) {
        setResult({ kind: "done", text: `「${DECISION_LABEL[r.decision]}」を記録しました。記録は変更できません。` });
        setDecision(null);
        router.refresh();
      } else setResult({ kind: "error", text: r.error });
    });

  return (
    <div className={styles.item} data-copy-decision-form="">
      <p style={{ margin: 0 }}>文章の確認（オーナーの判断）。記録は監査とその内容のハッシュに結び付き、変更できません。</p>
      <ul className={styles.list}>
        {DECISIONS.map((d) => (
          <li key={d} data-copy-decision={d} data-copy-decision-refused={target.refusals[d].length ? "" : undefined}>
            <label>
              <input type="radio" name="copy-decision" value={d} disabled={target.refusals[d].length > 0 || pending} checked={decision === d} onChange={() => setDecision(d)} /> {DECISION_LABEL[d]}
            </label>
            {target.refusals[d].length > 0 && (
              <span className={styles.note}>
                （できません: {[...new Set(target.refusals[d].map((c) => COPY_DECISION_REFUSAL_LABEL[c] ?? c))].join(" ")}）
              </span>
            )}
          </li>
        ))}
      </ul>
      <label className={styles.note}>
        メモ（任意、{NOTE_MAX_CHARS} 文字まで。URL・メールアドレスは書けません）
        <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={NOTE_MAX_CHARS} rows={2} disabled={pending} style={{ display: "block", width: "100%" }} />
      </label>
      <button type="button" className={styles.primary} disabled={!decision || pending} onClick={submit}>
        {decision ? `「${DECISION_LABEL[decision]}」を記録する` : "判断を選んでください"}
      </button>
      {result && (
        <p className={result.kind === "error" ? styles.alert : styles.note} role={result.kind === "error" ? "alert" : "status"} data-copy-decision-result={result.kind}>
          {result.text}
        </p>
      )}
    </div>
  );
}
