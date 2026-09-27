import styles from "@/components/admin/admin.module.css";
import { requireAdminPage } from "@/lib/admin/auth";

export default async function Page() {
  await requireAdminPage();
  return (
    <>
      <h1 className={styles.h1}>履歴</h1>
      <p className={styles.muted}>DEV-013 で履歴と簡易集計を表示します。</p>
    </>
  );
}
