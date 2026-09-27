import { notFound, redirect } from "next/navigation";
import { renderDemo } from "@/components/demo/renderDemo";
import styles from "@/components/admin/admin.module.css";
import { getAdminState } from "@/lib/admin/auth";
import { toDemoView } from "@/lib/sales/demo-content";
import { createAuthClient } from "@/lib/supabase/server";

// Admin-only preview of a shop's demo, including unsent demos that the
// public /demo/[token] URL does not show yet (MVP_SPEC §7). Reads through
// the admin's own session, so row level security applies.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function DemoPreviewPage({ params }: PageProps<"/admin/preview/[prospectId]">) {
  const state = await getAdminState();
  if (state.kind === "anonymous") redirect("/admin/login");
  if (state.kind === "forbidden") notFound();

  const { prospectId } = await params;
  if (!UUID.test(prospectId)) notFound();
  const supabase = await createAuthClient();
  const { data } = await supabase
    .from("sales_demos")
    .select("template, content, expires_at, disabled_at")
    .eq("prospect_id", prospectId)
    .maybeSingle();
  const demo = data ? toDemoView(data.template, data.content) : null;
  if (!data || !demo) notFound();

  const status = data.disabled_at
    ? "無効化済み（公開 URL では表示されません）"
    : data.expires_at === null
      ? "未送信（公開 URL ではまだ表示されません）"
      : "送信済み（公開中または期限切れ）";

  return (
    <>
      <p className={styles.previewBar} role="status">
        管理者プレビュー：{status}
      </p>
      {renderDemo(demo)}
    </>
  );
}
