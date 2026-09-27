import styles from "@/components/admin/admin.module.css";

export default function Page() {
  return (
    <>
      <h1 className={styles.h1}>今日やること</h1>
      <p className={styles.muted}>DEV-009 で今日の作業キュー（最大5件）を表示します。</p>
    </>
  );
}
