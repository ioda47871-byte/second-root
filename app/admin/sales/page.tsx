import styles from "@/components/admin/admin.module.css";
import { requireAdminPage } from "@/lib/admin/auth";

export default async function Page() {
  await requireAdminPage();
  return (
    <>
      <h1 className={styles.h1}>今日やること</h1>
      <p className={styles.muted}>DEV-009 で今日の作業キュー（最大5件）を表示します。</p>
    </>
  );
}
