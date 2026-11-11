"use client";
/** DEV-196d-3: renders (the basis) and the live page, as two tabs. The live frame is mounted only when chosen. */
import { useState, type ReactNode } from "react";
import styles from "./demo.module.css";

export default function PreviewTabs({ renders, live }: { renders: ReactNode; live: ReactNode | null }) {
  const [tab, setTab] = useState<"renders" | "live">("renders");
  return (
    <div>
      <div className={styles.tabs} role="tablist" aria-label="表示">
        <button type="button" role="tab" id="tab-renders" aria-controls="panel-renders" aria-selected={tab === "renders"} className={styles.tab} onClick={() => setTab("renders")}>
          描画画像（判断の基準）
        </button>
        {live !== null && (
          <button type="button" role="tab" id="tab-live" aria-controls="panel-live" aria-selected={tab === "live"} className={styles.tab} onClick={() => setTab("live")}>
            生の頁
          </button>
        )}
      </div>
      <div role="tabpanel" id="panel-renders" aria-labelledby="tab-renders" hidden={tab !== "renders"}>
        {renders}
      </div>
      {live !== null && tab === "live" && (
        <div role="tabpanel" id="panel-live" aria-labelledby="tab-live">
          {live}
        </div>
      )}
    </div>
  );
}
