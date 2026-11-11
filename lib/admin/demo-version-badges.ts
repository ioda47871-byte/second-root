import "server-only";
/**
 * DEV-196d-7: the demo version state of every shop on the Today screen, for its badge and the send-stop explanation.
 *
 *  - Flag off (the default): returns null and reads NOTHING — the Today card renders exactly as before.
 *  - Flag on: ONE request for all the shops on the page (sales_demos with their versions, files, images and quality
 *    decisions embedded), through the admin's own session (RLS). No service role, no per-shop query.
 *  - Any failure: every shop gets "unknown" (a neutral badge); the Today card is never broken by it.
 *
 * The current facts hash is NOT read here (it needs the service role): the explanation says the facts check is left
 * to the version page, and never claims the facts are unchanged.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { demoVersionBadge, type DemoVersionBadge } from "@/lib/sales/demo-version/badge";
import { demoVersionsEnabled, type Env } from "@/lib/sales/demo-version/flags";
import { buildDemoVersionsView, type DemoImageDb, type QualityReviewDb, type VersionFileDb, type VersionRowDb } from "@/lib/sales/demo-version/view-model";

export type TodayDemoVersion = ({ kind: "ok" } & DemoVersionBadge) | { kind: "unknown" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Versions read per shop (the newest; the badge needs the newest and the approved one). */
export const TODAY_VERSIONS_PER_SHOP = 20;

const VERSION_COLUMNS =
  "id, demo_id, version_no, parent_version_id, origin, worker_commit, facts_sha256, bundle_sha256, status, validator_result, structure_descriptor, rights_summary, expires_at, revoked_at, revoke_code, created_at";
const FILE_COLUMNS = "version_id, path, role, sha256, bytes, content_type, width, height, image_id";
const IMAGE_COLUMNS =
  "id, sha256, width, height, format, source_kind, rights_status, depicts_real_shop, depicts_identifiable_person, depicts_real_product, depicts_real_interior, depicts_real_equipment, no_factual_impersonation_confirmed_at, rights_expiry, provenance, revoked_at";
const REVIEW_COLUMNS = "id, version_id, decision, state, checklist, viewed_renders_sha256, reviewed_at, withdrawn_at, invalidated_at, invalidated_reason, bundle_sha256, facts_sha256";

/** The one embedded select (versions by their demo_id: sales_demos also points at a version through approved_version_id). */
export const TODAY_DEMO_SELECT =
  `id, prospect_id, approved_version_id, disabled_at, ` +
  `sales_demo_versions!sales_demo_versions_demo_id_fkey(${VERSION_COLUMNS}, ` +
  `sales_demo_version_files(${FILE_COLUMNS}, sales_demo_images(${IMAGE_COLUMNS})), ` +
  `sales_demo_quality_reviews!sales_demo_quality_reviews_version_id_fkey(${REVIEW_COLUMNS}))`;

type FileRow = VersionFileDb & { sales_demo_images: DemoImageDb | null };
type VersionRow = VersionRowDb & { sales_demo_version_files: FileRow[] | null; sales_demo_quality_reviews: QualityReviewDb[] | null };
type DemoRow = { id: string; prospect_id: string; approved_version_id: string | null; disabled_at: string | null; sales_demo_versions: VersionRow[] | null };

export async function loadTodayDemoVersions(supabase: SupabaseClient, prospectIds: readonly string[], o: { env: Env; now: Date }): Promise<Map<string, TodayDemoVersion> | null> {
  if (!demoVersionsEnabled(o.env)) return null;
  const ids = [...new Set(prospectIds.filter((id) => UUID.test(id)))];
  const out = new Map<string, TodayDemoVersion>();
  if (ids.length === 0) return out;
  const unknown = () => new Map(ids.map((id) => [id, { kind: "unknown" } as TodayDemoVersion]));
  try {
    const { data, error } = await supabase
      .from("sales_demos")
      .select(TODAY_DEMO_SELECT)
      .in("prospect_id", ids)
      .order("version_no", { referencedTable: "sales_demo_versions", ascending: false })
      .limit(TODAY_VERSIONS_PER_SHOP, { referencedTable: "sales_demo_versions" });
    if (error || !Array.isArray(data)) return unknown();
    const byProspect = new Map((data as unknown as DemoRow[]).map((d) => [d.prospect_id, d]));
    for (const id of ids) {
      const d = byProspect.get(id);
      if (!d) {
        out.set(id, { kind: "ok", state: "none", versionNo: null, sendStop: null });
        continue;
      }
      const versions = d.sales_demo_versions ?? [];
      const files = versions.flatMap((v) => v.sales_demo_version_files ?? []);
      const images = files.flatMap((f) => (f.sales_demo_images ? [f.sales_demo_images] : []));
      const reviews = versions.flatMap((v) => v.sales_demo_quality_reviews ?? []);
      const view = buildDemoVersionsView({
        versions,
        files,
        images,
        reviews,
        approvals: [],
        approvedVersionId: d.approved_version_id,
        demoDisabled: d.disabled_at !== null,
        currentFactsSha256: null,
        now: o.now,
      });
      out.set(id, { kind: "ok", ...demoVersionBadge(view) });
    }
    return out;
  } catch {
    return unknown();
  }
}
