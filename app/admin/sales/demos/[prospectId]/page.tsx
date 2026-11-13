import Link from "next/link";
import { notFound } from "next/navigation";
import CopyReviewPanel from "@/components/admin/demo/CopyReviewPanel";
import FactsPanel from "@/components/admin/demo/FactsPanel";
import type { RenderItem } from "@/components/admin/demo/RenderPane";
import ReviewHistory from "@/components/admin/demo/ReviewHistory";
import ReviewWorkspace from "@/components/admin/demo/ReviewWorkspace";
import VersionLifecycle from "@/components/admin/demo/VersionLifecycle";
import RightsPanel from "@/components/admin/demo/RightsPanel";
import TokenExpiry from "@/components/admin/demo/TokenExpiry";
import VersionList from "@/components/admin/demo/VersionList";
import VersionNotices from "@/components/admin/demo/VersionNotices";
import styles from "@/components/admin/demo/demo.module.css";
import { requireAdminPage } from "@/lib/admin/auth";
import { loadVersionCopyReview } from "@/lib/admin/demo-copy-review";
import { loadDemoVersionsPage, type PreviewUnavailable } from "@/lib/admin/demo-versions";
import { createAuthClient } from "@/lib/supabase/server";
import { DEMO_VERSION_ERROR_LABEL, NO_VERSIONS_TEXT, QUALITY_REVIEW_DISABLED_TEXT, REVOKE_REASON_LABEL, RIGHTS_BLOCKED_LABEL } from "@/lib/sales/demo-version/admin-messages";
import { demoQualityReviewEnabled, demoVersionsEnabled } from "@/lib/sales/demo-version/flags";
import { VIEW_TOKEN_TTL_SECONDS } from "@/lib/sales/demo-version/view-token";

// DEV-196d-3 (spec §6.1・§7.2・§8.1・§9): the read-only admin page of a shop's demo versions — the lineage, the
// PC1440 / SP390 full-page renders (the basis for judging), the live page in a sandboxed frame, the shop's facts, the
// rights of every photo, and why sending is stopped. No action here: approving is DEV-196d-5, revoking DEV-196d-6.
// Behind SALES_DEMO_VERSIONS_ENABLED (off by default → 404). Reads through the admin's own session (RLS).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const UNAVAILABLE_TEXT: Record<PreviewUnavailable, string> = {
  signing_key_missing: DEMO_VERSION_ERROR_LABEL.signing_key_missing!,
  signing_key_invalid: "閲覧の署名鍵の形が正しくないため、描画画像と頁を表示できません。",
  artifact_origin_invalid: "成果物の専用の配信元の設定の形が正しくないため、描画画像と頁を表示できません。",
};

export default async function DemoVersionsPage({ params, searchParams }: PageProps<"/admin/sales/demos/[prospectId]">) {
  if (!demoVersionsEnabled(process.env)) notFound();
  await requireAdminPage();
  const { prospectId } = await params;
  const sp = await searchParams;
  const wanted = typeof sp.v === "string" && UUID.test(sp.v) ? sp.v : null;

  const now = new Date();
  // DEV-196k: the quality-review writes have their own flag; without it this page is preview only (no forms)
  const reviewEnabled = demoQualityReviewEnabled(process.env);
  const data = await loadDemoVersionsPage(prospectId, { env: process.env, now });
  if (data.kind === "not_found") notFound();
  if (data.kind === "error") {
    return (
      <div className={styles.page}>
        <h1 className={styles.title}>デモの版</h1>
        <p className={styles.alert} role="alert">
          版を読み込めませんでした。画面を再読み込みしてください。
        </p>
      </div>
    );
  }

  const { view, tokens } = data;
  const selected = view.versions.find((v) => v.id === wanted) ?? view.versions.find((v) => tokens[v.id]) ?? view.versions[0] ?? null;
  const token = selected ? tokens[selected.id] ?? null : null;
  const base = token ? `/demo-frame/a/${token}/` : null;
  const renders: RenderItem[] = selected && base ? selected.renders.map((r) => ({ viewport: r.viewport, src: `${base}${r.urlPath}`, width: r.width, height: r.height })) : [];
  // DEV-199b: the selected version's copy review (read through the admin's session); the decision form needs the
  // quality-review write flag as well
  const copy = selected ? await loadVersionCopyReview(await createAuthClient(), selected.id) : null;

  return (
    <div className={styles.page} data-demo-versions-page="">
      <div>
        <p className={styles.sub}>
          <Link href={`/admin/preview/${data.prospectId}`}>React のデモのプレビュー</Link>
        </p>
        <h1 className={styles.title}>デモの版{data.shopName ? `：${data.shopName}` : ""}</h1>
        {data.demoDisabled && (
          <p className={styles.alert} role="alert">
            このデモは無効化されています（管理者の判断または配信停止の依頼）。版は表示しません。
          </p>
        )}
      </div>

      <VersionNotices view={view} version={selected} />

      {view.versions.length === 0 ? (
        <section className={styles.panel} data-empty="no-versions">
          <p style={{ margin: 0 }}>{NO_VERSIONS_TEXT}</p>
          <p className={styles.note}>送信には今までどおり React のデモが使われます。</p>
        </section>
      ) : (
        <section className={styles.panel} aria-labelledby="versions-h">
          <h2 id="versions-h" className={styles.h2}>
            版
          </h2>
          <VersionList view={view} prospectId={data.prospectId} selectedId={selected?.id ?? null} now={now} />
          {data.truncated && <p className={styles.note}>版が多いため、新しい 100 件だけを表示しています。</p>}
          {view.versions.length >= 2 && (
            <p className={styles.note}>
              <Link href={`/admin/sales/demos/${data.prospectId}/compare${selected ? `?b=${selected.id}` : ""}`}>版を比べる</Link>
            </p>
          )}
        </section>
      )}

      {selected && (
        <section className={styles.panel} aria-labelledby="preview-h" data-selected-version={selected.versionNo}>
          <h2 id="preview-h" className={styles.h2}>
            v{selected.versionNo}（{selected.statusLabel}）
          </h2>
          {data.previewUnavailable ? (
            <p className={styles.alert} role="alert" data-preview-unavailable={data.previewUnavailable}>
              {UNAVAILABLE_TEXT[data.previewUnavailable]}
            </p>
          ) : !base ? (
            <p className={styles.alert} role="alert" data-preview-unavailable="version">
              {selected.revoked
                ? `この版は取り消し済みです（理由: ${selected.revokeCode ? REVOKE_REASON_LABEL[selected.revokeCode] : "理由不明"}）。表示しません。ほかの版や React のデモへは切り替えません。`
                : selected.images.some((i) => !i.previewable)
                  ? `${RIGHTS_BLOCKED_LABEL}の画像を含むため、この版は表示しません。`
                  : "この版は今は表示できません（期限切れ・アップロード中・不採用・デモの無効のどれかです）。"}
            </p>
          ) : (
            <>
              <TokenExpiry seconds={VIEW_TOKEN_TTL_SECONDS.a} />
              {selected.missingRequiredRenders.length > 0 && (
                <p className={styles.warn} role="status">
                  {DEMO_VERSION_ERROR_LABEL.render_missing}
                </p>
              )}
              <ReviewWorkspace
                prospectId={data.prospectId}
                renders={renders}
                frameSrc={`${base}index.html`}
                frameTitle={`v${selected.versionNo} の頁（sandbox）`}
                review={
                  // a decision is offered only when the database would take one (the server re-checks everything)
                  reviewEnabled && selected.reviewBlockers.length === 0
                    ? {
                        id: selected.id,
                        versionNo: selected.versionNo,
                        bundleSha256: selected.bundleSha256,
                        renders: selected.renders.map((r) => ({ viewport: r.viewport, sha256: r.sha256 })),
                        approveBlockers: selected.approveBlockers,
                        reviewBlockers: selected.reviewBlockers,
                        aiImages: selected.images
                          .filter((i) => i.aiConcept && i.imageId)
                          .map((i) => ({ imageId: i.imageId!, sha256: i.sha256, path: i.path, thumbSrc: i.previewable ? `${base}${i.path.slice("page/".length)}` : null })),
                      }
                    : null
                }
              />
            </>
          )}
        </section>
      )}

      {selected && !selected.revoked && !reviewEnabled && (selected.revocable || selected.activeApproval || selected.reviewBlockers.length === 0) && (
        <p className={styles.note} role="status" data-review-disabled="">
          {QUALITY_REVIEW_DISABLED_TEXT}
        </p>
      )}
      {selected && !selected.revoked && reviewEnabled && (selected.revocable || selected.activeApproval) && (
        <VersionLifecycle
          prospectId={data.prospectId}
          version={{
            id: selected.id,
            versionNo: selected.versionNo,
            bundleSha256: selected.bundleSha256,
            revocable: selected.revocable,
            activeApprovalId: selected.activeApproval?.id ?? null,
            isApprovedVersion: view.approvedVersionId === selected.id,
          }}
          openSends={view.openSends.length}
          unsentLegacyApprovals={view.unsentLegacyApprovals}
        />
      )}
      {selected && copy && <CopyReviewPanel data={copy} prospectId={data.prospectId} versionId={selected.id} versionNo={selected.versionNo} decisionEnabled={reviewEnabled && !selected.revoked && !data.demoDisabled} />}
      {selected && <ReviewHistory reviews={selected.reviews} />}
      <FactsPanel content={data.content} facts={selected?.facts ?? null} />
      {selected && <RightsPanel images={selected.images} photoBase={base} />}
    </div>
  );
}
