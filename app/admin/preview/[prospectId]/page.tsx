import Link from "next/link";
import { notFound } from "next/navigation";
import { renderDemo } from "@/components/demo/renderDemo";
import { pickVariant, resolveVariant, VARIANTS } from "@/components/demo/variant";
import styles from "@/components/admin/admin.module.css";
import { requireAdminPage } from "@/lib/admin/auth";
import { toDemoView } from "@/lib/sales/demo-content";
import { createAuthClient } from "@/lib/supabase/server";

// Admin-only preview of a shop's demo, including unsent demos that the
// public /demo/[token] URL does not show yet (MVP_SPEC §7). Reads through
// the admin's own session, so row level security applies. `?variant=` shows
// another art direction of the same template for comparison; the public
// page always uses the shop's own (components/demo/variant.ts).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VARIANT_LABEL: Record<string, string> = {
  luxury: "Editorial luxury",
  pop: "American pop",
  minimal: "Minimal boutique",
  classic: "Classic",
};

export default async function DemoPreviewPage({ params, searchParams }: PageProps<"/admin/preview/[prospectId]">) {
  await requireAdminPage();

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

  const requested = (await searchParams).variant;
  const variant = resolveVariant(demo, typeof requested === "string" ? requested : null);
  const own = pickVariant(demo);
  const options: readonly string[] = VARIANTS[demo.template];

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
      {options.length > 1 && (
        <nav className={styles.variantBar} aria-label="デザインの比較">
          {options.map((v) => (
            <Link key={v} href={`?variant=${v}`} aria-current={v === variant ? "page" : undefined} className={styles.variantLink}>
              {VARIANT_LABEL[v] ?? v}
              {v === own ? "（この店舗の既定）" : ""}
            </Link>
          ))}
        </nav>
      )}
      {renderDemo(demo, variant)}
    </>
  );
}
