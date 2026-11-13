import "server-only";
/**
 * DEV-196d-3 (spec §6.1・§7.2・§8.1・§9.2–§9.5): what the read-only admin demo version page reads.
 *
 * Every row comes through the ADMIN'S OWN SESSION (RLS: sales_*_admin_read), with one exception: the demo's current
 * facts hash (sales_demo_facts_sha256, executable by service_role only) is read with the service role, as a PostgREST
 * computed field of that one demo, after the page has checked the admin. If that read fails, the facts are "unknown"
 * (never "same"; approving is then blocked by the view model's FACTS_UNKNOWN).
 *
 * View tokens (15 min, scope `a`) are signed only for versions the view model says are previewable (not revoked, not
 * expired, every photo's rights usable now), and only when the signing key is set. No token, no Storage URL and no
 * key reaches the page otherwise.
 */
import { createAuthClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import type { CopySendCode } from "@/lib/sales/copy-review/labels";
import { loadVersionCopyGate } from "@/lib/sales/copy-review/store";
import { demoShareEnabled, demoVersionsConfig, type Env } from "@/lib/sales/demo-version/flags";
import { buildDemoVersionsView, type DemoImageDb, type DemoVersionsView, type QualityReviewDb, type SendApprovalDb, type VersionFileDb, type VersionRowDb } from "@/lib/sales/demo-version/view-model";
import { signViewToken } from "@/lib/sales/demo-version/view-token";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** More versions than this for one shop are not listed (the newest are). */
export const MAX_VERSIONS = 100;

export type DemoVersionsPage =
  | { kind: "not_found" }
  | { kind: "error" }
  | {
      kind: "ok";
      prospectId: string;
      shopName: string | null;
      demoId: string;
      demoDisabled: boolean;
      content: unknown;
      template: unknown;
      view: DemoVersionsView;
      /** version id → view token; empty when no preview can be served (previewUnavailable says why) */
      tokens: Record<string, string>;
      previewUnavailable: PreviewUnavailable | null;
      truncated: boolean;
      /** the rows as read (server-side only; the compare page derives its diffs from them) */
      rows: { versions: VersionRowDb[]; files: VersionFileDb[] };
    };

/**
 * Why no render, photo or frame can be shown at all: the signing key is not set / malformed, or the dedicated artifact
 * origin is malformed. A valid artifact origin (set for sharing, DEV-196g) keeps the admin preview on the app origin
 * (the admin-only interim, spec §6.8; lib/demo-frame/serve.ts refuses scope `a` on the artifact origin).
 */
export type PreviewUnavailable = "signing_key_missing" | "signing_key_invalid" | "artifact_origin_invalid";

type Client = Awaited<ReturnType<typeof createAuthClient>>;

/** The demo's facts hash now, via the service role (computed field); null on any failure. */
async function currentFactsSha256(demoId: string): Promise<string | null> {
  try {
    const { data, error } = await createServiceClient().from("sales_demos").select("id, facts:sales_demo_facts_sha256").eq("id", demoId).maybeSingle();
    const facts = (data as { id?: string; facts?: unknown } | null)?.facts;
    return !error && typeof facts === "string" && SHA256.test(facts) ? facts : null;
  } catch {
    return null;
  }
}

/**
 * DEV-196g (PR #267 L4): the database half of the share switch (sales_demo_versioned_sharing_enabled(), executable by
 * the service role only), read after the page checked the admin and only when the server flag is on. Any failure is
 * false (the screen then never claims sharing is on).
 */
export async function dbVersionedSharingEnabled(): Promise<boolean> {
  try {
    const { data, error } = await createServiceClient().rpc("sales_demo_versioned_sharing_enabled");
    return !error && data === true;
  } catch {
    return false;
  }
}

/**
 * The cheap gate the segment's layout runs BEFORE the page streams (a notFound() inside the loading boundary would
 * answer 200; Next "loading.js › Status Codes"): the flag, the id's shape, and that the shop has a demo — through
 * the admin's own session. true: render the page.
 */
export async function demoVersionsPageExists(prospectId: string, o: { env: Env; client?: Client }): Promise<boolean> {
  if (!UUID.test(prospectId) || !demoVersionsConfig(o.env).enabled) return false;
  const supabase = o.client ?? (await createAuthClient());
  const { data, error } = await supabase.from("sales_demos").select("id").eq("prospect_id", prospectId).maybeSingle();
  // an error is not "absent": the page then shows its error state
  return error ? true : data !== null;
}

/**
 * Coordinator decision 2026-11-11 (#248): the service-role facts read is allowed only (1) server-only, (2) after the
 * flag check and the admin check — here, after the admin's own RLS read returned this demo (a non-admin session sees
 * no row and never gets here; the page and layout also call requireAdminPage first), (3) for the single demo id that
 * read returned for the validated prospect id, (4) returning only the hash, (5) never sent to the client (the view
 * model turns it into same / changed / unknown), and (6) any failure (error, throw, not a sha256) is "unknown", which
 * blocks approving.
 */
async function readFactsSafely(read: (demoId: string) => Promise<string | null>, demoId: string): Promise<string | null> {
  try {
    const h = await read(demoId);
    return typeof h === "string" && SHA256.test(h) ? h : null;
  } catch {
    return null;
  }
}

export async function loadDemoVersionsPage(
  prospectId: string,
  o: { env: Env; now: Date; client?: Client; factsSha256?: (demoId: string) => Promise<string | null>; dbSharing?: () => Promise<boolean> },
): Promise<DemoVersionsPage> {
  if (!UUID.test(prospectId)) return { kind: "not_found" };
  const config = demoVersionsConfig(o.env);
  if (!config.enabled) return { kind: "not_found" };
  const supabase = o.client ?? (await createAuthClient());

  const prospect = await supabase.from("sales_prospects").select("id, name").eq("id", prospectId).maybeSingle();
  if (prospect.error) return { kind: "error" };
  if (!prospect.data) return { kind: "not_found" };
  const demo = await supabase.from("sales_demos").select("id, template, content, disabled_at, approved_version_id").eq("prospect_id", prospectId).maybeSingle();
  if (demo.error) return { kind: "error" };
  if (!demo.data) return { kind: "not_found" };
  const d = demo.data as { id: string; template: unknown; content: unknown; disabled_at: string | null; approved_version_id: string | null };

  const versions = await supabase
    .from("sales_demo_versions")
    .select("id, demo_id, version_no, parent_version_id, origin, worker_commit, facts_sha256, bundle_sha256, status, validator_result, structure_descriptor, rights_summary, expires_at, revoked_at, revoke_code, created_at")
    .eq("demo_id", d.id)
    .order("version_no", { ascending: false })
    .limit(MAX_VERSIONS + 1);
  if (versions.error) return { kind: "error" };
  const rows = (versions.data ?? []) as VersionRowDb[];
  const truncated = rows.length > MAX_VERSIONS;
  const listed = rows.slice(0, MAX_VERSIONS);
  const ids = listed.map((v) => v.id);

  let files: VersionFileDb[] = [];
  let images: DemoImageDb[] = [];
  let reviews: QualityReviewDb[] = [];
  if (ids.length) {
    const f = await supabase.from("sales_demo_version_files").select("version_id, path, role, sha256, bytes, content_type, width, height, image_id").in("version_id", ids);
    if (f.error) return { kind: "error" };
    files = (f.data ?? []) as VersionFileDb[];
    const imageIds = [...new Set(files.map((x) => x.image_id).filter((x): x is string => x !== null))];
    if (imageIds.length) {
      const i = await supabase
        .from("sales_demo_images")
        .select("id, sha256, width, height, format, source_kind, rights_status, depicts_real_shop, depicts_identifiable_person, depicts_real_product, depicts_real_interior, depicts_real_equipment, no_factual_impersonation_confirmed_at, rights_expiry, provenance, revoked_at")
        .in("id", imageIds);
      if (i.error) return { kind: "error" };
      images = (i.data ?? []) as DemoImageDb[];
    }
    const r = await supabase
      .from("sales_demo_quality_reviews")
      .select("id, version_id, decision, state, checklist, viewed_renders_sha256, reviewed_at, withdrawn_at, invalidated_at, invalidated_reason, bundle_sha256, facts_sha256")
      .in("version_id", ids);
    if (r.error) return { kind: "error" };
    reviews = (r.data ?? []) as QualityReviewDb[];
  }
  const a = await supabase.from("sales_outreach_approvals").select("id, outreach_id, state, demo_version_id").eq("prospect_id", prospectId);
  if (a.error) return { kind: "error" };
  const approvals = (a.data ?? []) as SendApprovalDb[];

  const factsNow = await readFactsSafely(o.factsSha256 ?? currentFactsSha256, d.id);
  // PR #267 L4: the screen says sharing is on only when the server flag AND the database switch are on
  const sharing = demoShareEnabled(o.env) && (await (o.dbSharing ?? dbVersionedSharingEnabled)());
  const build = (copySendBlock?: CopySendCode | null) =>
    buildDemoVersionsView({
      versions: listed,
      files,
      images,
      reviews,
      approvals,
      approvedVersionId: d.approved_version_id,
      demoDisabled: d.disabled_at !== null,
      currentFactsSha256: factsNow,
      copySendBlock,
      versionedSharingEnabled: sharing,
      now: o.now,
    });
  let view = build();
  // DEV-199b (DEV-199e L2′): the copy send gate is the last step of the send block. Only when every earlier step passes
  // (the view then says "unverifiable" for the unread copy) is the approved version's copy gate read, through the
  // admin's session; a read failure stays demo_copy_review_unverifiable. While versioned sharing is off (DEV-196g) the
  // send stops at demo_not_shareable first, so this read does not happen.
  if (view.sendStop?.code === "demo_copy_review_unverifiable" && d.approved_version_id !== null) {
    const gate = await loadVersionCopyGate(supabase, d.approved_version_id);
    view = build(gate.ok ? null : gate.code);
  }

  const tokens: Record<string, string> = {};
  if (config.key && config.artifactOrigin.kind !== "invalid") {
    for (const v of view.versions) {
      // a disabled demo serves nothing (the artifact route refuses it too)
      if (v.previewable && d.disabled_at === null) tokens[v.id] = signViewToken({ scope: "a", versionId: v.id, demoId: d.id, now: o.now, key: config.key });
    }
  }
  const previewUnavailable: PreviewUnavailable | null = !config.key
    ? config.keyProblem === "invalid"
      ? "signing_key_invalid"
      : "signing_key_missing"
    : config.artifactOrigin.kind === "invalid"
      ? "artifact_origin_invalid"
      : null;

  return {
    kind: "ok",
    prospectId,
    shopName: typeof (prospect.data as { name?: unknown }).name === "string" ? ((prospect.data as { name: string }).name) : null,
    demoId: d.id,
    demoDisabled: d.disabled_at !== null,
    content: d.content,
    template: d.template,
    view,
    tokens,
    previewUnavailable,
    truncated,
    rows: { versions: listed, files },
  };
}
