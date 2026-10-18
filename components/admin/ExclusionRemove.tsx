"use client";

import { useState, useTransition } from "react";
import { removeExclusion } from "@/app/admin/sales/_actions/exclusions";
import styles from "./admin.module.css";

// DEV-049: remove an exclusion with an explicit confirmation step.

export default function ExclusionRemove({ id, label }: { id: string; label: string }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <div className={styles.actions}>
      {!confirming ? (
        <button type="button" className={styles.secondary} onClick={() => setConfirming(true)}>
          除外をやめる
        </button>
      ) : (
        <>
          <p className={styles.muted}>「{label}」を除外リストから外します。今後の探索で営業候補になりえます。よろしいですか？</p>
          <button
            type="button"
            className={styles.primary}
            disabled={pending}
            onClick={() =>
              start(async () => {
                const result = await removeExclusion(id);
                if (!result.ok) setError(result.error);
                setConfirming(false);
              })
            }
          >
            {pending ? "変更中…" : "はい、除外をやめる"}
          </button>
          <button type="button" className={styles.linkButton} onClick={() => setConfirming(false)}>
            やめる
          </button>
        </>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
