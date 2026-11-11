"use client";
/**
 * DEV-196d-5: the renders, the live page and the quality form share one state — which renders were scrolled to their
 * very end (RenderPane's load- and size-gated sentinel). The form gets exactly that; it cannot be ticked by hand.
 */
import { useCallback, useState } from "react";
import LiveFrame from "./LiveFrame";
import PreviewTabs from "./PreviewTabs";
import QualityReviewForm, { type ReviewVersion } from "./QualityReviewForm";
import RenderPane, { type RenderItem } from "./RenderPane";
import styles from "./demo.module.css";

export default function ReviewWorkspace({
  prospectId,
  renders,
  frameSrc,
  frameTitle,
  review,
}: {
  prospectId: string;
  renders: RenderItem[];
  frameSrc: string;
  frameTitle: string;
  /** null: no decision can be made on this version now (the form is not shown) */
  review: ReviewVersion | null;
}) {
  const [viewed, setViewed] = useState<ReadonlySet<RenderItem["viewport"]>>(new Set());
  const onViewed = useCallback((v: RenderItem["viewport"]) => setViewed((s) => (s.has(v) ? s : new Set([...s, v]))), []);
  return (
    <>
      <PreviewTabs
        renders={renders.length ? <RenderPane renders={renders} onViewed={onViewed} /> : <p className={styles.note}>描画画像がありません。</p>}
        live={<LiveFrame src={frameSrc} title={frameTitle} />}
      />
      {review && <QualityReviewForm prospectId={prospectId} version={review} viewed={viewed} />}
    </>
  );
}
