import { redirect } from "next/navigation";
import styles from "@/components/admin/admin.module.css";
import { getAdminState } from "@/lib/admin/auth";
import LoginForm from "./LoginForm";

export default async function LoginPage() {
  const state = await getAdminState();
  if (state.kind === "admin") redirect("/admin/sales");
  return (
    <div className={`${styles.page} ${styles.center}`}>
      <main className={`${styles.card} ${styles.narrow}`}>
        <h1 className={styles.h1}>営業管理にログイン</h1>
        <LoginForm />
      </main>
    </div>
  );
}
