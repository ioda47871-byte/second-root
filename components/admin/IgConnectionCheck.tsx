"use client";

import { useState, useTransition } from "react";
import { checkIgConnection, type IgResult } from "@/app/admin/sales/_actions/instagram";
import styles from "./admin.module.css";

// 「Instagram 連携を確認」 (DEV-024): after the Meta setup, the admin can
// check that receiving and sending are configured. Read-only; no message
// is sent and no secret value is ever shown.

export default function IgConnectionCheck() {
  const [result, setResult] = useState<IgResult | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className={styles.confirm}>
      <button
        type="button"
        className={styles.linkButton}
        disabled={pending}
        onClick={() => {
          setResult(null);
          start(async () => setResult(await checkIgConnection()));
        }}
      >
        {pending ? "確認中…" : "Instagram 連携を確認"}
      </button>
      <p className={result && !result.ok ? styles.error : styles.muted} role="status">
        {result ? (result.ok ? result.message ?? "" : result.error) : ""}
      </p>
    </div>
  );
}
