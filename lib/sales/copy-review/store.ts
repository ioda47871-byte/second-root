/**
 * DEV-199e: reading the copy review store and recording into it, with whatever Supabase client the caller has (the
 * importer: the local service role; the send action: the signed-in admin, whose RLS allows reading these tables). No
 * environment is read here. The decisions are made by ./gate.ts and, again, by the database.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { ArtifactManifest, CSS_NAME, HTML_NAME, photoUrlPaths } from "@/lib/sales/demo-version/manifest";
import { versionSchemaMissing } from "@/lib/sales/version-schema";
import { evaluateVersionCopyGate, type CopyCandidate, type ShopCopyState, type StoredCopyReview, type StoredOwnerDecision, type VersionCopyGate, type VersionCopyGateInput } from "./gate";

export class CopyStoreError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const REVIEW_COLUMNS =
  "id, seq, demo_id, shop_id, lane, round, previous_review_id, copy_verdict, next_step, facts_sha256, facts_content_sha256, copy_sha256, page_html_sha256, page_css_sha256, review_sha256, gate_blockers, review_text, copy_record_text, facts_pack_text, page_html_text, page_css_text";
const DECISION_COLUMNS = "id, review_id, version_id, decision, review_sha256, facts_sha256, copy_sha256, page_html_sha256, page_css_sha256";

/** Every stored review of the demo's shop (stored order), the owner's decisions on them and the facts-path checks. */
export async function loadShopCopyState(client: SupabaseClient, demoId: string): Promise<ShopCopyState> {
  if (!UUID.test(demoId)) throw new CopyStoreError("COPY_STORE_DEMO_INVALID");
  const demo = await client.from("sales_demos").select("prospect_id").eq("id", demoId).maybeSingle();
  const prospectId = (demo.data as { prospect_id?: unknown } | null)?.prospect_id;
  if (demo.error || typeof prospectId !== "string") throw new CopyStoreError("COPY_STORE_DEMO_NOT_FOUND");
  const reviews = await client.from("sales_demo_copy_reviews").select(REVIEW_COLUMNS).eq("prospect_id", prospectId).order("seq", { ascending: true });
  if (reviews.error || !Array.isArray(reviews.data)) throw new CopyStoreError("COPY_STORE_READ_FAILED");
  const rows = reviews.data as unknown as StoredCopyReview[];
  if (!rows.length) return { reviews: [], decisions: [], factsChecks: [] };
  const ids = rows.map((r) => r.id);
  const [decisions, checks] = await Promise.all([
    client.from("sales_demo_copy_owner_decisions").select(DECISION_COLUMNS).in("review_id", ids),
    client.from("sales_demo_copy_facts_checks").select("review_id, facts_sha256, demo_facts_sha256").in("review_id", ids),
  ]);
  if (decisions.error || checks.error || !Array.isArray(decisions.data) || !Array.isArray(checks.data)) throw new CopyStoreError("COPY_STORE_READ_FAILED");
  return {
    reviews: rows.map((r) => ({ ...r, seq: Number(r.seq) })),
    decisions: decisions.data as unknown as StoredOwnerDecision[],
    factsChecks: checks.data as unknown as ShopCopyState["factsChecks"],
  };
}

export type RecordedCopyReview = { review_id: string; round: number; previous_review_id: string | null; replayed: boolean; copy_verdict: string; next_step: string; facts_from_facts_path: boolean; linked_version_id: string | null };

/** sales_record_copy_review (service role only): one round, after planCopyAppend said it may be stored. */
export async function recordCopyReview(
  client: SupabaseClient,
  a: { demoId: string; versionId: string | null; candidate: CopyCandidate; gateBlockers: string[]; factsFromFactsPath: boolean },
): Promise<RecordedCopyReview> {
  const { data, error } = await client.rpc("sales_record_copy_review", {
    p_demo_id: a.demoId,
    p_version_id: a.versionId,
    p_review: a.candidate.review,
    p_copy_record: a.candidate.copyRecord,
    p_facts_pack: a.candidate.factsPack,
    p_page_html: a.candidate.pageHtml,
    p_page_css: a.candidate.pageCss,
    p_gate_blockers: a.gateBlockers,
    p_facts_from_facts_path: a.factsFromFactsPath,
  });
  if (error || !data) throw new CopyStoreError(`COPY_RECORD_REFUSED:${(error?.message ?? "no_result").split(":")[0]}`);
  return data as RecordedCopyReview;
}

/**
 * Everything the copy gate of one version is decided from (DEV-199b: also what the admin screen and the owner's copy
 * decision read). Throws CopyStoreError on any read failure; `demoId` is the version's own demo.
 */
export async function loadVersionCopyContext(client: SupabaseClient, versionId: string): Promise<VersionCopyGateInput & { demoId: string }> {
  if (!UUID.test(versionId)) throw new CopyStoreError("COPY_STORE_VERSION_INVALID");
  const v = await client.from("sales_demo_versions").select("id, demo_id, manifest, facts_sha256").eq("id", versionId).maybeSingle();
  const row = v.data as { id: string; demo_id: string; manifest: unknown; facts_sha256: string | null } | null;
  const manifest = ArtifactManifest.safeParse(row?.manifest);
  if (v.error || !row || !manifest.success) throw new CopyStoreError("COPY_STORE_VERSION_NOT_FOUND");
  const [files, link] = await Promise.all([
    client.from("sales_demo_version_files").select("path, sha256").eq("version_id", versionId).in("path", [HTML_NAME, CSS_NAME]),
    client.from("sales_demo_version_copy_links").select("review_id").eq("version_id", versionId).maybeSingle(),
  ]);
  if (files.error || link.error || !Array.isArray(files.data)) throw new CopyStoreError("COPY_STORE_READ_FAILED");
  const sha = (p: string) => (files.data as { path: string; sha256: string }[]).find((f) => f.path === p)?.sha256 ?? null;
  const state = await loadShopCopyState(client, row.demo_id);
  return {
    demoId: row.demo_id,
    versionId,
    photoUrls: photoUrlPaths(manifest.data),
    versionFactsSha256: row.facts_sha256 ?? null,
    pageHtmlSha256: sha(HTML_NAME),
    pageCssSha256: sha(CSS_NAME),
    linkedReviewId: (link.data as { review_id?: string } | null)?.review_id ?? null,
    state,
  };
}

/** The copy gate of one version, from the rows (any read failure is a refusal: demo_copy_review_unverifiable). */
export async function loadVersionCopyGate(client: SupabaseClient, versionId: string): Promise<VersionCopyGate> {
  try {
    return evaluateVersionCopyGate(await loadVersionCopyContext(client, versionId));
  } catch {
    return { ok: false, code: "demo_copy_review_unverifiable", details: [] };
  }
}

/** The PostgREST embed outreachCopyGate reads (pinned by the integration test against the real API). */
export const OUTREACH_DEMO_SELECT = "prospect:sales_prospects!inner(demo:sales_demos(approved_version_id))";

/**
 * The copy gate of the demo an initial outreach would send: `legacy` when the demo has no quality-approved version (the
 * React demo, unchanged: no copy gate), otherwise the approved version's gate. When even the demo cannot be read, the
 * path is unknown: `legacy` with `unread` (PR #262 L1) — the server does not refuse a React-demo send for a read error,
 * and the database's own guard still refuses an unconfirmed versioned send. Only a demo known to be on the versioned
 * path fails closed here (demo_copy_review_unverifiable).
 */
export async function outreachCopyGate(client: SupabaseClient, outreachId: string): Promise<{ legacy: true; unread?: true } | ({ legacy: false } & VersionCopyGate)> {
  const unverifiable = { legacy: false as const, ok: false as const, code: "demo_copy_review_unverifiable" as const, details: [] };
  const { data, error } = await client.from("sales_outreaches").select(OUTREACH_DEMO_SELECT).eq("id", outreachId).maybeSingle();
  // DEV-263e (PR #268 H1): a database without the demo-version schema cannot hold a version — the React demo, plainly
  if (error && versionSchemaMissing(error)) return { legacy: true };
  if (error || !data) return { legacy: true, unread: true };
  const prospect = (data as { prospect?: unknown }).prospect as { demo?: unknown } | null | undefined;
  const demo = (Array.isArray(prospect?.demo) ? prospect.demo[0] : prospect?.demo) as { approved_version_id?: unknown } | null | undefined;
  const approved = demo?.approved_version_id;
  if (approved === null || approved === undefined) return { legacy: true };
  if (typeof approved !== "string") return unverifiable;
  return { legacy: false, ...(await loadVersionCopyGate(client, approved)) };
}
