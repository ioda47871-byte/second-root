import AdminNav from "@/components/admin/AdminNav";
import styles from "@/components/admin/admin.module.css";
import { getAdminState } from "@/lib/admin/auth";
import { redirect } from "next/navigation";
import { signOut } from "../actions";

// Admin shell: only the allowlisted admin gets past this layout.

export default async function SalesLayout({ children }: LayoutProps<"/admin/sales">) {
  const state = await getAdminState();
  if (state.kind === "anonymous") redirect("/admin/login");

  const logout = (
    <form action={signOut}>
      <button type="submit" className={styles.linkButton}>
        ログアウト
      </button>
    </form>
  );

  if (state.kind === "forbidden") {
    return (
      <div className={`${styles.page} ${styles.center}`}>
        <main className={`${styles.card} ${styles.narrow}`}>
          <h1 className={styles.h1}>権限がありません</h1>
          <p className={styles.muted}>このアカウントは営業管理の管理者として登録されていません。</p>
          {logout}
        </main>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <span className={styles.brand}>Second Root 営業</span>
        {logout}
      </header>
      <main className={styles.main}>{children}</main>
      <AdminNav />
    </div>
  );
}
