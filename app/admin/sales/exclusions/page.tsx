import ExclusionForm from "@/components/admin/ExclusionForm";
import ExclusionRemove from "@/components/admin/ExclusionRemove";
import styles from "@/components/admin/admin.module.css";
import { requireAdminPage } from "@/lib/admin/auth";
import { loadExclusions } from "@/lib/admin/exclusions";
import { formatDate } from "@/lib/admin/pipeline";
import { EXCLUSION_REASON_LABEL } from "@/lib/sales/exclusions";
import { createAuthClient } from "@/lib/supabase/server";

// 除外リスト (DEV-049): shops that are never prepared for sales — existing
// customers, partners and the like. Checked when candidates are saved; shops
// already prepared are not changed (use 見送る / DNC on 今日 for those).

export default async function ExclusionsPage() {
  await requireAdminPage();
  let items;
  try {
    items = await loadExclusions(await createAuthClient());
  } catch {
    return (
      <>
        <h1 className={styles.h1}>除外リスト</h1>
        <p className={styles.error} role="alert">
          読み込めませんでした。時間をおいて再読み込みしてください。
        </p>
      </>
    );
  }

  return (
    <>
      <h1 className={styles.h1}>除外リスト</h1>
      <p className={styles.muted}>
        既存のお客様や取引先など、営業しない店舗です。探索で見つかっても営業の準備をしません。すでに準備済みの店舗には影響しないため、必要なら「今日」で見送るか営業不要（DNC）にしてください。
      </p>
      <h2 className={styles.h2}>追加</h2>
      <ExclusionForm />
      <h2 className={styles.h2}>登録済み（{items.length}件）</h2>
      {items.length === 0 ? (
        <p className={styles.muted}>まだ登録はありません。</p>
      ) : (
        <ul className={styles.list}>
          {items.map((item) => (
            <li key={item.id} className={styles.card} data-testid="exclusion-item">
              <h3 className={styles.itemTitle}>{item.label}</h3>
              <div className={styles.badges}>
                <span className={styles.badge}>{EXCLUSION_REASON_LABEL[item.reason]}</span>
                <span className={styles.muted}>登録: {formatDate(item.createdAt)}</span>
              </div>
              <ul className={styles.muted}>
                {item.instagramHandle && <li>Instagram: @{item.instagramHandle}</li>}
                {item.websiteDomain && <li>サイト: {item.websiteDomain}</li>}
                {item.publicEmail && <li>メール: {item.publicEmail}</li>}
                {item.normalizedName && <li>店名+住所: {item.normalizedName} / {item.normalizedAddress}</li>}
              </ul>
              {item.note && <p className={styles.muted}>メモ: {item.note}</p>}
              <ExclusionRemove id={item.id} label={item.label} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
