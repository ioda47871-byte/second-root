/**
 * DEV-196d-3 (spec §4.6): the shop's versions in lineage order (each version followed by its descendants), with the
 * status in the owner's words. Revoked and expired versions are greyed out and carry no link to a preview.
 */
import Link from "next/link";
import type { DemoVersionsView, VersionView } from "@/lib/sales/demo-version/view-model";
import styles from "./demo.module.css";

const date = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "日付不明" : new Date(t).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" });
};

export default function VersionList({ view, prospectId, selectedId }: { view: DemoVersionsView; prospectId: string; selectedId: string | null }) {
  const byId = new Map<string, VersionView>(view.versions.map((v) => [v.id, v]));
  return (
    <ol className={styles.versions} aria-label="版の一覧（系譜の順）">
      {view.lineage.map(({ id, depth }) => {
        const v = byId.get(id);
        if (!v) return null;
        const gone = v.revoked || v.status === "expired" || v.status === "rejected";
        return (
          <li key={id} style={{ marginLeft: `${Math.min(depth, 6) * 14}px` }} data-version={v.versionNo} data-status={v.status ?? "unknown"}>
            <Link
              href={`/admin/sales/demos/${prospectId}?v=${v.id}`}
              className={`${styles.versionLink} ${gone ? styles.versionGone : ""}`}
              aria-current={v.id === selectedId ? "page" : undefined}
            >
              <strong>v{v.versionNo}</strong>
              <span className={styles.tag}>{v.statusLabel}</span>
              {view.approvedVersionId === v.id && <span className={styles.tag}>送信に使う承認版</span>}
              {v.parentVersionNo !== null && <span className={styles.sub}>v{v.parentVersionNo} から</span>}
              {v.parentMissing && <span className={styles.sub}>元の版は一覧にありません</span>}
              <span className={styles.sub}>{date(v.createdAt)}</span>
            </Link>
          </li>
        );
      })}
      {view.lineageHidden > 0 && <li className={styles.sub}>ほか {view.lineageHidden} 件の版（古いもの）は表示していません</li>}
    </ol>
  );
}
