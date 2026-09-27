import styles from "@/components/admin/admin.module.css";
import { requireAdminPage } from "@/lib/admin/auth";

export default async function Page() {
  await requireAdminPage();
  return (
    <>
      <h1 className={styles.h1}>商談</h1>
      <p className={styles.muted}>DEV-012 で商談・成約・失注を記録します。</p>
    </>
  );
}
