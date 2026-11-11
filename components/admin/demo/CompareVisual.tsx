"use client";
/**
 * DEV-196d-4 (spec §7.2): the two versions' full-page renders, side by side with optionally synced scrolling, or one
 * over the other with an opacity slider. No pixel diff in v1: the admin looks. A render that fails to load is said so
 * (it never shows as an empty match).
 */
import { useRef, useState } from "react";
import styles from "./demo.module.css";

export type CompareRender = { src: string; width: number; height: number } | null;
type Side = { label: string; pc: CompareRender; sp: CompareRender };

function Img({ r, label, onError }: { r: CompareRender; label: string; onError: () => void }) {
  if (!r) return <p className={styles.note}>{label}: 描画画像がありません（または表示できない版です）。</p>;
  // eslint-disable-next-line @next/next/no-img-element -- server-checked render bytes from the artifact route
  return <img src={r.src} alt={`${label} の描画`} width={r.width} height={r.height} className={styles.fit} referrerPolicy="no-referrer" decoding="async" onError={onError} />;
}

export default function CompareVisual({ a, b }: { a: Side; b: Side }) {
  const [viewport, setViewport] = useState<"pc" | "sp">("pc");
  const [mode, setMode] = useState<"side" | "overlay">("side");
  const [sync, setSync] = useState(true);
  const [opacity, setOpacity] = useState(50);
  const [broken, setBroken] = useState<{ a: boolean; b: boolean }>({ a: false, b: false });
  const left = useRef<HTMLDivElement>(null);
  const right = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);

  const ra = viewport === "pc" ? a.pc : a.sp;
  const rb = viewport === "pc" ? b.pc : b.sp;
  const mirror = (from: HTMLDivElement | null, to: HTMLDivElement | null) => {
    if (!sync || !from || !to || syncing.current) return;
    syncing.current = true;
    const ratio = from.scrollTop / Math.max(1, from.scrollHeight - from.clientHeight);
    to.scrollTop = ratio * (to.scrollHeight - to.clientHeight);
    requestAnimationFrame(() => {
      syncing.current = false;
    });
  };

  return (
    <div data-compare-visual={mode} data-compare-viewport={viewport}>
      <div className={styles.tabs} role="group" aria-label="比較の表示">
        <button type="button" className={styles.tab} aria-pressed={viewport === "pc"} onClick={() => setViewport("pc")}>
          PC 1440
        </button>
        <button type="button" className={styles.tab} aria-pressed={viewport === "sp"} onClick={() => setViewport("sp")}>
          SP 390
        </button>
        <button type="button" className={styles.tab} aria-pressed={mode === "side"} onClick={() => setMode("side")}>
          並べる
        </button>
        <button type="button" className={styles.tab} aria-pressed={mode === "overlay"} onClick={() => setMode("overlay")}>
          重ねる
        </button>
        {mode === "side" && (
          <label className={styles.sub} style={{ display: "inline-flex", alignItems: "center", gap: 6, minHeight: 44 }}>
            <input type="checkbox" checked={sync} onChange={(e) => setSync(e.target.checked)} /> 縦の位置を合わせる
          </label>
        )}
      </div>
      {(broken.a || broken.b) && (
        <p className={styles.warn} role="status">
          描画画像を表示できませんでした（{broken.a && broken.b ? "両方" : broken.a ? a.label : b.label}）。表示期限切れの可能性があります。再読み込みしてください。
        </p>
      )}
      {mode === "side" ? (
        <div className={styles.compareSide}>
          {([
            ["a", a, ra, left, right],
            ["b", b, rb, right, left],
          ] as const).map(([key, side, r, self, other]) => (
            <figure key={key} className={styles.render}>
              <figcaption className={styles.renderHead}>
                <strong>{side.label}</strong>
              </figcaption>
              <div ref={self} className={styles.scroll} tabIndex={0} aria-label={`${side.label} の描画（スクロール）`} data-compare-scroll={key} onScroll={() => mirror(self.current, other.current)}>
                <Img r={r} label={side.label} onError={() => setBroken((x) => ({ ...x, [key]: true }))} />
              </div>
            </figure>
          ))}
        </div>
      ) : (
        <div>
          <label className={styles.sub} style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 44 }}>
            {a.label}
            <input type="range" min={0} max={100} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} aria-label={`${b.label} の不透明度`} style={{ flex: 1 }} />
            {b.label}
          </label>
          <div className={styles.scroll} data-compare-scroll="overlay">
            <div style={{ position: "relative" }}>
              <Img r={ra} label={a.label} onError={() => setBroken((x) => ({ ...x, a: true }))} />
              {rb && (
                <div style={{ position: "absolute", inset: 0, opacity: opacity / 100 }} data-overlay-opacity={opacity}>
                  <Img r={rb} label={b.label} onError={() => setBroken((x) => ({ ...x, b: true }))} />
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      <p className={styles.note}>画素の差分は出しません。並べて、または重ねて見比べてください。</p>
    </div>
  );
}
