/**
 * DEV-196d-3 (spec §4.6): the shop's versions in lineage order (each version followed by its descendants), with the
 * status in the owner's words. Revoked and expired versions — expired by status or by expires_at, an unreadable
 * expires_at counting as expired — are greyed out and carry no link (no view token is issued for them anyway).
 */
import Link from "next/link";
import type { DemoVersionsView, VersionView } from "@/lib/sales/demo-version/view-model";
import styles from "./demo.module.css";

const date = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "日付不明" : new Date(t).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" });
};

/** Revoked, or expired by status or by expires_at (unreadable → expired). */
export function versionGone(v: Pick<VersionView, "revoked" | "status" | "expiresAt">, now: Date): boolean {
  const t = Date.parse(v.expiresAt);
  return v.revoked || v.status === "revoked" || v.status === "expired" || Number.isNaN(t) || t <= now.getTime();
}

export default function VersionList({ view, prospectId, selectedId, now }: { view: DemoVersionsView; prospectId: string; selectedId: string | null; now: Date }) {
  const byId = new Map<string, VersionView>(view.versions.map((v) => [v.id, v]));
  return (
    <ol className={styles.versions} aria-label="版の一覧（系譜の順）">
      {view.lineage.map(({ id, depth }) => {
        const v = byId.get(id);
        if (!v) return null;
        const gone = versionGone(v, now);
        const body = (
          <>
            <strong>v{v.versionNo}</strong>
              <span className={styles.tag}>{v.statusLabel}</span>
              {view.approvedVersionId === v.id && <span className={styles.tag}>送信に使う承認版</span>}
              {v.parentVersionNo !== null && <span className={styles.sub}>v{v.parentVersionNo} から</span>}
              {v.parentMissing && <span className={styles.sub}>元の版は一覧にありません</span>}
            <span className={styles.sub}>{date(v.createdAt)}</span>
            {gone && <span className={styles.sub}>表示しません</span>}
          </>
        );
        return (
          <li key={id} style={{ marginLeft: `${Math.min(depth, 6) * 14}px` }} data-version={v.versionNo} data-status={v.status ?? "unknown"} data-gone={gone ? "true" : "false"}>
            {gone ? (
              <div className={`${styles.versionLink} ${styles.versionGone}`} aria-current={v.id === selectedId ? "page" : undefined}>
                {body}
              </div>
            ) : (
              <Link href={`/admin/sales/demos/${prospectId}?v=${v.id}`} className={styles.versionLink} aria-current={v.id === selectedId ? "page" : undefined}>
                {body}
              </Link>
            )}
          </li>
        );
      })}
      {view.lineageHidden > 0 && <li className={styles.sub}>ほか {view.lineageHidden} 件の版（古いもの）は表示していません</li>}
    </ol>
  );
}
