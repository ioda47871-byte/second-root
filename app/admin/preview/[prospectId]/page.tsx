import { notFound } from "next/navigation";
import { renderDesignedDemo } from "@/components/demo/renderDemo";
import styles from "@/components/admin/admin.module.css";
import { requireAdminPage } from "@/lib/admin/auth";
import { toDemoView } from "@/lib/sales/demo-content";
import { aiDesignEnabled, DESIGN_FALLBACK_NOTE, DESIGN_STATUS_LABEL, isDesignStatus, renderableProfile } from "@/lib/sales/design";
import { createAuthClient } from "@/lib/supabase/server";

// Admin-only preview of a shop's demo, including unsent demos that the
// public /demo/[token] URL does not show yet (MVP_SPEC §7). Reads through
// the admin's own session, so row level security applies.
// DEV-030: with the AI design step on, it shows the demo exactly as the
// public page would draw it (the checked design profile when ready) and the
// design state; off, the query and the page are the legacy ones.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = {
  template: unknown;
  content: unknown;
  expires_at: string | null;
  disabled_at: string | null;
  design_status?: unknown;
  design_profile?: unknown;
};

export default async function DemoPreviewPage({ params }: PageProps<"/admin/preview/[prospectId]">) {
  await requireAdminPage();

  const { prospectId } = await params;
  if (!UUID.test(prospectId)) notFound();
  const enabled = aiDesignEnabled();
  const supabase = await createAuthClient();
  const { data } = await supabase
    .from("sales_demos")
    .select(enabled ? "template, content, expires_at, disabled_at, design_status, design_profile" : "template, content, expires_at, disabled_at")
    .eq("prospect_id", prospectId)
    .maybeSingle();
  const row = data as unknown as Row | null;
  const demo = row ? toDemoView(row.template, row.content) : null;
  if (!row || !demo) notFound();

  const status = row.disabled_at
    ? "無効化済み（公開 URL では表示されません）"
    : row.expires_at === null
      ? "未送信（公開 URL ではまだ表示されません）"
      : "送信済み（公開中または期限切れ）";
  const profile = renderableProfile({ enabled, status: row.design_status, profile: row.design_profile });
  const design = enabled && isDesignStatus(row.design_status) ? row.design_status : null;
  const designNote =
    design === null
      ? null
      : design === "ready" && !profile
        ? "AIデザイン: 保存された内容を使えないため、既存テンプレートで表示しています"
        : design === "blocked" || design === "failed"
          ? `AIデザイン: ${DESIGN_STATUS_LABEL[design]}（${DESIGN_FALLBACK_NOTE}）`
          : `AIデザイン: ${DESIGN_STATUS_LABEL[design]}`;

  return (
    <>
      <p className={styles.previewBar} role="status">
        管理者プレビュー：{status}
        {designNote && (
          <>
            <br />
            <span data-testid="preview-design-status">{designNote}</span>
          </>
        )}
      </p>
      {renderDesignedDemo(demo, profile)}
    </>
  );
}
