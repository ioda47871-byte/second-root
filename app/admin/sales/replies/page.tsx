import styles from "@/components/admin/admin.module.css";
import { requireAdminPage } from "@/lib/admin/auth";

export default async function Page() {
  await requireAdminPage();
  return (
    <>
      <h1 className={styles.h1}>返信</h1>
      <p className={styles.muted}>DEV-012 で返信の記録と分類を行います。</p>
    </>
  );
}
