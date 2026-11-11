"use client";
/**
 * DEV-196d-3 (spec §6.7・§6.8): the version's page itself, live, in a sandboxed frame. `sandbox=""` with no allow-*
 * token (opaque origin, no script, no form, no popup), no `allow` attribute, no srcdoc, no referrer. The artifact
 * route backs it with the CSP `sandbox` directive. The renders are the basis for judging (fonts differ by device).
 */
import { useState } from "react";
import { RENDERS_ARE_THE_BASIS_TEXT } from "@/lib/sales/demo-version/admin-messages";
import styles from "./demo.module.css";

const WIDTHS = { pc: 1440, sp: 390 } as const;

export default function LiveFrame({ src, title }: { src: string; title: string }) {
  const [width, setWidth] = useState<keyof typeof WIDTHS>("pc");
  return (
    <div>
      <div className={styles.tabs} role="group" aria-label="頁の幅">
        {(Object.keys(WIDTHS) as (keyof typeof WIDTHS)[]).map((k) => (
          <button key={k} type="button" className={styles.tab} aria-pressed={width === k} onClick={() => setWidth(k)}>
            {k === "pc" ? "PC 1440" : "SP 390"}
          </button>
        ))}
      </div>
      <div className={styles.frameBox}>
        <iframe
          className={styles.frame}
          src={src}
          title={title}
          sandbox=""
          referrerPolicy="no-referrer"
          loading="lazy"
          style={{ width: `${WIDTHS[width]}px` }}
          data-frame-width={WIDTHS[width]}
        />
      </div>
      <p className={styles.note}>{RENDERS_ARE_THE_BASIS_TEXT}</p>
    </div>
  );
}
