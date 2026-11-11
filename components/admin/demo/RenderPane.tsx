"use client";
/**
 * DEV-196d-3 (spec §7.2): the full-page renders, PC1440 and SP390 (and tablet 768 when drawn), each in its own scroll
 * box so the whole page is reachable and nothing is cropped. PC can be fitted to the box or shown at actual size; SP
 * is always 1:1 (390 CSS px). A sentinel under each image marks "viewed to the end" once it has been scrolled into
 * view inside its box; DEV-196d-5 uses that to enable the viewed confirmation.
 */
import { useEffect, useRef, useState } from "react";
import styles from "./demo.module.css";

export type RenderItem = { viewport: "desktop_1440" | "tablet_768" | "mobile_390"; src: string; width: number; height: number };

export const RENDER_LABEL: Record<RenderItem["viewport"], string> = {
  desktop_1440: "PC 1440",
  tablet_768: "タブレット 768",
  mobile_390: "SP 390",
};

function Render({ item, onViewed }: { item: RenderItem; onViewed?: (viewport: RenderItem["viewport"]) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const [viewed, setViewed] = useState(false);
  const [fit, setFit] = useState(item.viewport === "desktop_1440");

  useEffect(() => {
    if (viewed || !box.current || !end.current || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setViewed(true);
          onViewed?.(item.viewport);
        }
      },
      { root: box.current, threshold: 0 },
    );
    io.observe(end.current);
    return () => io.disconnect();
  }, [viewed, item.viewport, onViewed]);

  const label = RENDER_LABEL[item.viewport];
  const isPc = item.viewport === "desktop_1440";
  return (
    <figure className={`${styles.render} ${item.viewport === "tablet_768" ? styles.renderTablet : ""}`} data-render={item.viewport} data-viewed={viewed ? "true" : "false"}>
      <figcaption className={styles.renderHead}>
        <strong>
          {label}（全ページ {item.width}×{item.height}）
        </strong>
        {isPc && (
          <button type="button" className={styles.tab} aria-pressed={!fit} onClick={() => setFit((f) => !f)}>
            {fit ? "実寸で見る" : "枠に合わせる"}
          </button>
        )}
        <span className={viewed ? styles.viewedDone : styles.viewed} role="status">
          {viewed ? "最後まで表示しました" : "最後まで見ていません"}
        </span>
      </figcaption>
      <div ref={box} className={styles.scroll} tabIndex={0} aria-label={`${label} の描画画像（スクロールで全ページ）`} data-scroll={item.viewport}>
        {/* eslint-disable-next-line @next/next/no-img-element -- the server-checked render bytes, served by the artifact route */}
        <img
          src={item.src}
          alt={`${label} の全ページの描画`}
          width={item.width}
          height={item.height}
          className={isPc && fit ? styles.fit : undefined}
          style={isPc && fit ? undefined : { width: `${item.width}px` }}
          decoding="async"
          referrerPolicy="no-referrer"
        />
        <div ref={end} className={styles.sentinel} data-sentinel={item.viewport} aria-hidden="true" />
      </div>
    </figure>
  );
}

export default function RenderPane({ renders, onViewed }: { renders: RenderItem[]; onViewed?: (viewport: RenderItem["viewport"]) => void }) {
  return (
    <div className={styles.renders}>
      {renders.map((r) => (
        <Render key={r.viewport} item={r} onViewed={onViewed} />
      ))}
    </div>
  );
}
