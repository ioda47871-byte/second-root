/**
 * DEV-199b (Issue #258): the copy review of the selected version — the audit's round, lane, copy verdict and next step,
 * its findings (with the audit's own reason) and revision findings (what a revision changed, for the owner), whether
 * its facts came from the facts path, the gate's send blockers, the owner's decision if recorded, and the send gate's
 * real stop reason. Text from the rows is shown as text only (React escapes it). The decision form appears only with
 * the quality-review write flag (`decisionEnabled`).
 */
import { COPY_FINDING_LABEL, COPY_STEP_LABEL } from "@/lib/sales/copy-review/labels";
import type { CopyReviewView } from "@/lib/sales/copy-review/view";
import CopyDecisionForm from "./CopyDecisionForm";
import styles from "./demo.module.css";

const LANE_LABEL: Record<string, string> = { real_shop_proposal: "実店舗への提案", quality_research_fictional: "架空の研究用（送信しない）" };
const VERDICT_LABEL: Record<string, string> = { approve_candidate: "承認候補", revise: "改稿", hold: "保留", fail: "不合格" };
const DECISION_LABEL: Record<string, string> = { approve: "文章を承認", revise: "改稿を依頼", reject: "却下" };

export default function CopyReviewPanel({
  data,
  prospectId,
  versionId,
  versionNo,
  decisionEnabled,
}: {
  data: { kind: "ok"; view: CopyReviewView } | { kind: "error" };
  prospectId: string;
  versionId: string;
  versionNo: number;
  decisionEnabled: boolean;
}) {
  if (data.kind === "error") {
    return (
      <section className={styles.panel} aria-labelledby="copy-h" data-copy-review="error">
        <h2 id="copy-h" className={styles.h2}>
          v{versionNo} の文章の品質監査
        </h2>
        <p className={styles.alert} role="alert">
          文章の監査を読み込めませんでした。画面を再読み込みしてください。
        </p>
      </section>
    );
  }
  const { review, decision, sendBlock, refusals } = data.view;
  return (
    <section className={styles.panel} aria-labelledby="copy-h" data-copy-review={review ? "present" : "none"}>
      <h2 id="copy-h" className={styles.h2}>
        v{versionNo} の文章の品質監査
      </h2>
      {sendBlock && (
        <p className={styles.warn} role="status" data-copy-send-block={sendBlock.code}>
          送信の門（文章）: {sendBlock.label}
        </p>
      )}
      {!review ? (
        <p className={styles.note}>この版には文章の品質監査がありません（版の経路では送れません）。</p>
      ) : (
        <>
          <dl className={styles.list} data-copy-round={review.round} data-copy-step={review.nextStep}>
            <dt>回</dt>
            <dd>
              round {review.round}
              {review.superseded && "（この後に新しい改稿の監査があります）"}
            </dd>
            <dt>経路</dt>
            <dd>{LANE_LABEL[review.lane] ?? review.lane}</dd>
            <dt>文章の判定</dt>
            <dd data-copy-verdict={review.copyVerdict}>{VERDICT_LABEL[review.copyVerdict] ?? review.copyVerdict}</dd>
            <dt>次の段</dt>
            <dd>{COPY_STEP_LABEL[review.nextStep] ?? review.nextStep}</dd>
            <dt>事実の保存先との照合</dt>
            <dd data-facts-from-facts-path={String(review.factsFromFactsPath)}>
              {review.factsFromFactsPath ? "照合済み" : "未照合（店舗の事実の保存先がまだ無いため、確認・送信の対象になりません）"}
            </dd>
            <dt>送信を止める理由（監査の門）</dt>
            <dd data-copy-gate-blockers={review.gateBlockers.join(" ")}>{review.gateBlockers.length ? review.gateBlockers.join("・") : "なし"}</dd>
            <dt>オーナーの確認</dt>
            <dd data-copy-owner-decision={decision?.decision ?? "none"}>
              {decision ? `${DECISION_LABEL[decision.decision] ?? decision.decision}${decision.forThisVersion ? "" : "（別の版で記録）"}` : "未確認"}
            </dd>
          </dl>
          {review.findings.length > 0 && (
            <>
              <h3 className={styles.h2}>指摘</h3>
              <ul className={styles.list} data-copy-findings="">
                {review.findings.map((f, i) => (
                  <li key={`${f.code}-${i}`} data-copy-finding={f.code} data-severity={f.severity}>
                    {COPY_FINDING_LABEL[f.code] ?? f.code}（{f.severity}）
                    {f.texts.length > 0 && <>: 「{f.texts.join("」「")}」</>}
                    <span className={styles.note}> {f.reason}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {review.revisionFindings.length > 0 && (
            <>
              <h3 className={styles.h2}>改稿で変わったこと（オーナー向けの注記）</h3>
              <ul className={styles.list} data-copy-revision-findings="">
                {review.revisionFindings.map((f, i) => (
                  <li key={`${f.code}-${i}`} data-copy-revision-finding={f.code} data-severity={f.severity}>
                    {f.code}（{f.severity}）{f.item && ` 項目 ${f.item}`}
                    {f.detail && <span className={styles.note}> {f.detail}</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
          {decisionEnabled && !decision && (
            <CopyDecisionForm target={{ prospectId, versionId, reviewId: review.id, hashes: review.hashes, refusals }} />
          )}
        </>
      )}
    </section>
  );
}
