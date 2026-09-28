"use client";

import { useActionState } from "react";
import { signIn, type LoginState } from "../actions";
import styles from "@/components/admin/admin.module.css";

export default function LoginForm() {
  const [state, action, pending] = useActionState<LoginState, FormData>(signIn, { error: null });
  return (
    <form action={action} className={styles.form}>
      <label className={styles.label}>
        メールアドレス
        <input className={styles.input} type="email" name="email" autoComplete="username" required />
      </label>
      <label className={styles.label}>
        パスワード
        <input className={styles.input} type="password" name="password" autoComplete="current-password" required />
      </label>
      {state.error && (
        <p className={styles.error} role="alert">
          {state.error}
        </p>
      )}
      <button className={styles.primary} type="submit" disabled={pending}>
        {pending ? "ログイン中…" : "ログイン"}
      </button>
    </form>
  );
}
