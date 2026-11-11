import Link from "next/link";
import { notFound } from "next/navigation";
import FactsPanel from "@/components/admin/demo/FactsPanel";
import LiveFrame from "@/components/admin/demo/LiveFrame";
import PreviewTabs from "@/components/admin/demo/PreviewTabs";
import RenderPane, { type RenderItem } from "@/components/admin/demo/RenderPane";
import RightsPanel from "@/components/admin/demo/RightsPanel";
import TokenExpiry from "@/components/admin/demo/TokenExpiry";
import VersionList from "@/components/admin/demo/VersionList";
import VersionNotices from "@/components/admin/demo/VersionNotices";
import styles from "@/components/admin/demo/demo.module.css";
import { requireAdminPage } from "@/lib/admin/auth";
import { loadDemoVersionsPage, type PreviewUnavailable } from "@/lib/admin/demo-versions";
import { DEMO_VERSION_ERROR_LABEL, NO_VERSIONS_TEXT, RIGHTS_BLOCKED_LABEL } from "@/lib/sales/demo-version/admin-messages";
import { demoVersionsEnabled } from "@/lib/sales/demo-version/flags";
import { VIEW_TOKEN_TTL_SECONDS } from "@/lib/sales/demo-version/view-token";

// DEV-196d-3 (spec §6.1・§7.2・§8.1・§9): the read-only admin page of a shop's demo versions — the lineage, the
// PC1440 / SP390 full-page renders (the basis for judging), the live page in a sandboxed frame, the shop's facts, the
// rights of every photo, and why sending is stopped. No action here: approving is DEV-196d-5, revoking DEV-196d-6.
// Behind SALES_DEMO_VERSIONS_ENABLED (off by default → 404). Reads through the admin's own session (RLS).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const UNAVAILABLE_TEXT: Record<PreviewUnavailable, string> = {
  signing_key_missing: DEMO_VERSION_ERROR_LABEL.signing_key_missing!,
  signing_key_invalid: "閲覧の署名鍵の形が正しくないため、描画画像と頁を表示できません。",
  artifact_origin_configured: "成果物の専用の配信元が設定されていますが、そこからの表示はまだ有効ではありません。描画画像と頁を表示できません。",
};

export default async function DemoVersionsPage({ params, searchParams }: PageProps<"/admin/sales/demos/[prospectId]">) {
  if (!demoVersionsEnabled(process.env)) notFound();
  await requireAdminPage();
  const { prospectId } = await params;
  const sp = await searchParams;
  const wanted = typeof sp.v === "string" && UUID.test(sp.v) ? sp.v : null;

  const now = new Date();
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
                ? "この版は取り消し済みです。表示しません。ほかの版や React のデモへは切り替えません。"
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
              <PreviewTabs
                renders={renders.length ? <RenderPane renders={renders} /> : <p className={styles.note}>描画画像がありません。</p>}
                live={<LiveFrame src={`${base}index.html`} title={`v${selected.versionNo} の頁（sandbox）`} />}
              />
            </>
          )}
        </section>
      )}

      <FactsPanel content={data.content} facts={selected?.facts ?? null} />
      {selected && <RightsPanel images={selected.images} photoBase={base} />}
    </div>
  );
}
