"use client";

import { useState, useTransition } from "react";
import { addExclusion } from "@/app/admin/sales/_actions/exclusions";
import { EXCLUSION_REASON_LABEL, EXCLUSION_REASONS } from "@/lib/sales/exclusions";
import styles from "./admin.module.css";

// DEV-049: add a shop that must never be prepared for sales.

const EMPTY = { label: "", reason: "existing_customer", note: "", instagram: "", website: "", email: "", name: "", address: "" };

export default function ExclusionForm() {
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, start] = useTransition();
  const set = (key: keyof typeof EMPTY) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(false);
    start(async () => {
      const result = await addExclusion(form);
      if (!result.ok) setError(result.error);
      else {
        setForm(EMPTY);
        setDone(true);
      }
    });
  }

  const field = (key: keyof typeof EMPTY, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className={styles.label}>
      {label}
      <input className={styles.input} value={form[key]} onChange={set(key)} {...props} />
    </label>
  );

  return (
    <form className={styles.card} onSubmit={submit} data-testid="exclusion-form">
      {field("label", "表示名（店名など・必須）", { maxLength: 200, required: true })}
      <label className={styles.label}>
        理由
        <select className={styles.input} value={form.reason} onChange={set("reason")}>
          {EXCLUSION_REASONS.map((r) => (
            <option key={r} value={r}>
              {EXCLUSION_REASON_LABEL[r]}
            </option>
          ))}
        </select>
      </label>
      <p className={styles.muted}>
        照合に使う項目を1つ以上入力してください。どれか1つが一致すれば、その店舗は営業の準備をしません。見つかり方は店舗ごとに違うため、分かる項目（特に Instagram）はできるだけすべて入力してください。
      </p>
      {field("instagram", "Instagram（URL か @ユーザー名）", { maxLength: 200, autoComplete: "off" })}
      {field("website", "公式サイトの URL", { maxLength: 300, inputMode: "url", autoComplete: "off" })}
      {field("email", "メールアドレス（照合用。アドレスそのものは保存せず、後から表示もしません）", { maxLength: 254, inputMode: "email", autoComplete: "off" })}
      {field("name", "店名（住所とセット）", { maxLength: 200, autoComplete: "off" })}
      {field("address", "住所（店名とセット）", { maxLength: 300, autoComplete: "off" })}
      {field("note", "メモ（任意）", { maxLength: 500 })}
      <div className={styles.actions}>
        <button type="submit" className={styles.primary} disabled={pending}>
          {pending ? "追加中…" : "除外リストに追加"}
        </button>
      </div>
      {done && (
        <p className={styles.muted} role="status">
          追加しました。
        </p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
