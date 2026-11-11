import styles from "@/components/admin/demo/demo.module.css";

// DEV-196d-3: shown while the version rows load.
export default function Loading() {
  return (
    <div className={styles.page} aria-busy="true" aria-live="polite">
      <p className={styles.sub}>版を読み込んでいます…</p>
      <div className={styles.skeleton} style={{ width: "40%" }} />
      <div className={styles.panel}>
        <div className={styles.skeleton} style={{ width: "70%", marginBottom: 8 }} />
        <div className={styles.skeleton} style={{ width: "55%" }} />
      </div>
      <div className={styles.skeletonTall} />
    </div>
  );
}
