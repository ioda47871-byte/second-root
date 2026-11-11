/**
 * DEV-196d (spec §4.6・§6.1・§7.2・§8.1・§8.3・§9.2–§9.5): what the admin demo version screen shows, derived from the
 * rows the admin's RLS session reads (sales_demo_versions, sales_demo_version_files, sales_demo_images,
 * sales_demo_quality_reviews, the shop's send approvals).
 *
 * Mirrors the database's own rules so the screen never offers what the database would refuse, and is stricter where
 * it cannot tell (fail closed):
 *  - previewable: canAdminPreview (status draft / approved / superseded, not revoked, within expires_at) AND every
 *    photo's rights previewable now (sales_demo_image_previewable: an allowed status, not revoked, rights_expiry not
 *    before today in JST). One unusable image hides the whole version (§8.1: never shown with holes).
 *  - any decision (approve / changes requested / reject) needs what sales_review_demo_version checks for every
 *    decision; approving also needs both required renders, no open send (§9.5) and, per Low (c), the admin's own
 *    confirmation for every AI concept image.
 *  - facts unknown (the current facts hash could not be read) is not "same": it blocks nothing here (the database
 *    decides) but the screen must not claim the facts are unchanged.
 *
 * Nothing here repeats free text from a row: provenance is reduced to a date, a yes/no and a hash prefix.
 *
 * Pure: rows in, view out.
 */
import { jstDate } from "@/lib/sales/dates";
import { RIGHTS_BLOCKED_LABEL, AI_CONCEPT_BADGE, REVOKE_REASONS, RIGHTS_STATUS_LABEL, VERSION_STATUS_LABEL, type RevokeReason } from "./admin-messages";
import { validatorCodes } from "./compare";
import { REQUIRED_RENDERS, RENDER_VIEWPORTS, roleOfName, type RenderViewport } from "./manifest";
import { QUALITY_CHECKLIST_ITEMS, type QualityChecklistItem, type QualityDecision } from "./quality";
import { ADMIN_PREVIEW_STATUSES, ADMIN_RIGHTS_LABELS, RIGHTS_STATUSES, SHARE_PHOTOS_ENABLED, type RightsStatus } from "./rights";
import { canAdminPreview, VERSION_STATUSES, type VersionStatus } from "./version-state";

/**
 * Mirrors sales_demo_versioned_sharing_enabled() (DEV-196c: constant false until the dedicated artifact origin,
 * DEV-196g). A literal, not an option.
 */
export const VERSIONED_SHARING_ENABLED = false as const;

export type VersionRowDb = {
  id: string;
  demo_id: string;
  version_no: number;
  parent_version_id: string | null;
  origin: string;
  worker_commit: string | null;
  facts_sha256: string;
  bundle_sha256: string;
  status: string;
  validator_result: unknown;
  structure_descriptor: unknown;
  rights_summary: unknown;
  expires_at: string;
  revoked_at: string | null;
  revoke_code: string | null;
  created_at: string;
};

export type VersionFileDb = {
  version_id: string;
  path: string;
  role: string;
  sha256: string;
  bytes: number;
  content_type: string;
  width: number | null;
  height: number | null;
  image_id: string | null;
};

export type DemoImageDb = {
  id: string;
  sha256: string;
  width: number;
  height: number;
  format: string;
  source_kind: string;
  rights_status: string;
  depicts_real_shop: boolean;
  depicts_identifiable_person: boolean;
  depicts_real_product: boolean;
  depicts_real_interior: boolean;
  depicts_real_equipment: boolean;
  no_factual_impersonation_confirmed_at: string | null;
  rights_expiry: string | null;
  provenance: unknown;
  revoked_at: string | null;
};

export type QualityReviewDb = {
  id: string;
  version_id: string;
  decision: string;
  state: string;
  checklist: unknown;
  viewed_renders_sha256: unknown;
  reviewed_at: string;
  withdrawn_at: string | null;
  invalidated_at: string | null;
  invalidated_reason: string | null;
  /** what the review was given (sales_demo_version_send_block requires both to match the version) */
  bundle_sha256: string;
  facts_sha256: string;
};

export type SendApprovalDb = { id: string; outreach_id: string; state: string; demo_version_id: string | null };

export type RenderView = { viewport: RenderViewport; urlPath: string; sha256: string; width: number; height: number };

export type ProvenanceSummary = { generatedOn: string | null; hasApprovalId: boolean; promptShaPrefix: string | null };

export type ImageView = {
  imageId: string | null;
  path: string;
  sha256: string;
  width: number | null;
  height: number | null;
  /** effective now: revoked / expired re-derived from the dates, anything unrecognised → unknown */
  rightsStatus: RightsStatus;
  rightsLabel: string;
  previewable: boolean;
  /** the fixed §8.1 label the trusted frame shows beside the image (null when none applies) */
  adminLabel: string | null;
  aiConcept: boolean;
  aiBadge: string | null;
  sourceKind: string | null;
  /** an AI concept image needs the admin's per-image confirmation on this screen before approving (Low c) */
  needsImpersonationConfirm: boolean;
  provenance: ProvenanceSummary | null;
};

export type ReviewView = {
  id: string;
  decision: QualityDecision | null;
  state: "active" | "withdrawn" | "invalidated" | null;
  reviewedAt: string;
  /** a fixed code; show it only through INVALIDATED_REASON_LABEL, never as text */
  invalidatedReason: string | null;
  checklist: Partial<Record<QualityChecklistItem, "ok" | "ng">>;
};

export type ReviewBlocker = "VERSION_NOT_REVIEWABLE" | "DEMO_DISABLED" | "FACTS_CHANGED" | "VALIDATOR_NOT_OK" | "RIGHTS_NOT_PREVIEWABLE";
/**
 * RENDER_UNVIEWABLE: the version has a render file the screen cannot show (an unknown viewport or no dimensions).
 * sales_review_demo_version demands that every render of the version was viewed before approving, so the screen does
 * not offer an approval the database would refuse.
 */
export type ApproveBlocker = ReviewBlocker | "FACTS_UNKNOWN" | "RENDER_MISSING" | "RENDER_UNVIEWABLE" | "APPROVAL_OPEN";
export type UnshareableReason = "versioned_sharing_disabled" | "ai_images" | "photos_not_shareable";

/**
 * Low (d): why sales_demo_version_send_block refuses this shop's send approvals because of its approved version, in
 * the database's order. `reasons` is filled for demo_not_shareable only. `factsUnknown`: the current facts hash could
 * not be read, so the screen cannot rule out demo_facts_changed (the database decides; the screen does not claim the
 * facts are unchanged).
 */
export type SendBlockCode = "demo_version_unavailable" | "demo_quality_not_approved" | "demo_facts_changed" | "demo_not_shareable";
export type SendStop = { code: SendBlockCode; reasons: UnshareableReason[]; factsUnknown: boolean };

/** At most this many lineage rows are listed; the rest are counted in lineageHidden. */
export const LINEAGE_DISPLAY_LIMIT = 200;

export type VersionView = {
  id: string;
  versionNo: number;
  parentId: string | null;
  parentVersionNo: number | null;
  /** the parent row is not among this demo's versions */
  parentMissing: boolean;
  status: VersionStatus | null;
  statusLabel: string;
  origin: string;
  workerCommit: string | null;
  bundleSha256: string;
  createdAt: string;
  expiresAt: string;
  revoked: boolean;
  /** the fixed reason a revoked version was revoked for (REVOKE_REASONS only; anything else → null) */
  revokeCode: RevokeReason | null;
  previewable: boolean;
  renders: RenderView[];
  missingRequiredRenders: RenderViewport[];
  images: ImageView[];
  validator: { ok: boolean; codes: string[] };
  facts: "same" | "changed" | "unknown";
  reviews: ReviewView[];
  activeApproval: ReviewView | null;
  reviewBlockers: ReviewBlocker[];
  approveBlockers: ApproveBlocker[];
  /** AI concept images whose per-image confirmation the admin must give before approving */
  impersonationConfirmImageIds: string[];
  revocable: boolean;
  unshareableReasons: UnshareableReason[];
};

export type DemoVersionsView = {
  versions: VersionView[];
  approvedVersionId: string | null;
  /** §9.5: send approvals of this shop in send_opened (to settle on the Today screen first) */
  openSends: { approvalId: string; outreachId: string }[];
  /**
   * Low (d): the shop has an approved version id, so its send approvals are refused for this reason (re-derived like
   * sales_demo_version_send_block). null: no approved version (sending uses the React demo as before).
   */
  sendStop: SendStop | null;
  lineage: { id: string; versionNo: number; depth: number }[];
  /** lineage rows beyond LINEAGE_DISPLAY_LIMIT (shown as "and N more") */
  lineageHidden: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AI_STATUSES: readonly RightsStatus[] = ["ai_demo_internal", "ai_concept_internal", "ai_share_approved"];

const asStatus = (s: string): VersionStatus | null => ((VERSION_STATUSES as readonly string[]).includes(s) ? (s as VersionStatus) : null);
const time = (s: string | null) => (s === null ? null : new Date(s));
/** An unparseable time counts as already past (fail closed, like canAdminPreview with NaN). */
const expired = (expiresAt: string, now: Date) => {
  const t = Date.parse(expiresAt);
  return !Number.isFinite(t) || t <= now.getTime();
};
const SHA256 = /^[0-9a-f]{64}$/;

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}

/** sales_demo_image_previewable, re-derived at `now`; the status the screen shows. */
export function effectiveRights(img: Pick<DemoImageDb, "revoked_at" | "rights_status" | "rights_expiry"> | null, now: Date): { status: RightsStatus; previewable: boolean } {
  if (!img) return { status: "unknown", previewable: false };
  if (img.revoked_at !== null) return { status: "revoked", previewable: false };
  const status = (RIGHTS_STATUSES as readonly string[]).includes(img.rights_status) ? (img.rights_status as RightsStatus) : "unknown";
  if (status === "unknown" || status === "revoked") return { status, previewable: false };
  if (img.rights_expiry !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(img.rights_expiry) || img.rights_expiry < jstDate(now))) return { status: "expired", previewable: false };
  return { status, previewable: ADMIN_PREVIEW_STATUSES.includes(status) };
}

/** §8.2: only a date, whether an approval id is recorded, and the first 8 hex of the prompt hash. No model, no text. */
export function provenanceSummary(p: unknown): ProvenanceSummary | null {
  if (typeof p !== "object" || p === null || Array.isArray(p)) return null;
  const o = p as Record<string, unknown>;
  const at = typeof o.generated_at === "string" && /^\d{4}-\d{2}-\d{2}T/.test(o.generated_at) ? o.generated_at.slice(0, 10) : null;
  const prompt = typeof o.prompt_sha256 === "string" && /^[0-9a-f]{64}$/.test(o.prompt_sha256) ? o.prompt_sha256.slice(0, 8) : null;
  return { generatedOn: at, hasApprovalId: typeof o.approval_id === "string" && o.approval_id.length > 0, promptShaPrefix: prompt };
}

function reviewView(r: QualityReviewDb): ReviewView {
  const checklist: Partial<Record<QualityChecklistItem, "ok" | "ng">> = {};
  if (typeof r.checklist === "object" && r.checklist !== null && !Array.isArray(r.checklist)) {
    for (const k of QUALITY_CHECKLIST_ITEMS) {
      const v = (r.checklist as Record<string, unknown>)[k];
      if (v === "ok" || v === "ng") checklist[k] = v;
    }
  }
  return {
    id: r.id,
    decision: r.decision === "approved" || r.decision === "rejected" || r.decision === "changes_requested" ? r.decision : null,
    state: r.state === "active" || r.state === "withdrawn" || r.state === "invalidated" ? r.state : null,
    reviewedAt: r.reviewed_at,
    invalidatedReason: r.invalidated_reason,
    checklist,
  };
}

/** Why a version cannot be shared now (§8.3). Today versioned sharing itself is off, so it always has a reason. */
export function unshareableReasons(images: readonly { rightsStatus: RightsStatus }[]): UnshareableReason[] {
  const reasons: UnshareableReason[] = [];
  if (!(VERSIONED_SHARING_ENABLED as boolean)) reasons.push("versioned_sharing_disabled");
  if (images.some((i) => AI_STATUSES.includes(i.rightsStatus))) reasons.push("ai_images");
  if (images.length > 0 && !(SHARE_PHOTOS_ENABLED as boolean)) reasons.push("photos_not_shareable");
  return reasons;
}

export function buildDemoVersionsView(o: {
  versions: readonly VersionRowDb[];
  files: readonly VersionFileDb[];
  images: readonly DemoImageDb[];
  reviews: readonly QualityReviewDb[];
  approvals: readonly SendApprovalDb[];
  approvedVersionId: string | null;
  demoDisabled: boolean;
  /** sales_demo_facts_sha256 of the demo now; null when it could not be read */
  currentFactsSha256: string | null;
  now: Date;
}): DemoVersionsView {
  const byId = new Map(o.versions.map((v) => [v.id, v]));
  const imagesById = new Map(o.images.map((i) => [i.id, i]));
  const filesByVersion = groupBy(o.files, (f) => f.version_id);
  const reviewsByVersion = groupBy(o.reviews, (r) => r.version_id);
  const factsKnown = o.currentFactsSha256 !== null && SHA256.test(o.currentFactsSha256);
  const openSends = o.approvals.filter((a) => a.state === "send_opened").map((a) => ({ approvalId: a.id, outreachId: a.outreach_id }));

  const versions = [...o.versions]
    .sort((a, b) => b.version_no - a.version_no)
    .map((v): VersionView => {
      const status = asStatus(v.status);
      const files = filesByVersion.get(v.id) ?? [];
      const renders: RenderView[] = RENDER_VIEWPORTS.flatMap((viewport) => {
        const f = files.find((x) => x.path === `renders/${viewport}.webp` && x.role === "render");
        return f && f.width !== null && f.height !== null ? [{ viewport, urlPath: f.path, sha256: f.sha256, width: f.width, height: f.height }] : [];
      });
      const images: ImageView[] = files
        .filter((f) => f.role === "photo" && roleOfName(f.path)?.role === "photo")
        .sort((a, b) => (a.path < b.path ? -1 : 1))
        .map((f) => {
          const img = f.image_id ? imagesById.get(f.image_id) ?? null : null;
          // the file must be this image (sha256) or its rights say nothing about these bytes
          const bound = img !== null && img.sha256 === f.sha256 ? img : null;
          const r = effectiveRights(bound, o.now);
          const aiConcept = r.status === "ai_concept_internal" && bound?.source_kind === "ai_concept_internal";
          return {
            imageId: bound?.id ?? null,
            path: f.path,
            sha256: f.sha256,
            width: f.width,
            height: f.height,
            rightsStatus: r.status,
            rightsLabel: r.previewable ? RIGHTS_STATUS_LABEL[r.status] : RIGHTS_BLOCKED_LABEL,
            previewable: r.previewable,
            adminLabel: r.previewable ? ADMIN_RIGHTS_LABELS[r.status] ?? null : null,
            aiConcept,
            aiBadge: aiConcept ? AI_CONCEPT_BADGE : null,
            sourceKind: bound?.source_kind ?? null,
            needsImpersonationConfirm: aiConcept && r.previewable,
            provenance: aiConcept ? provenanceSummary(bound!.provenance) : null,
          };
        });
      const versionRow = { id: v.id, demo_id: v.demo_id, status: status ?? "rejected", revoked_at: time(v.revoked_at), expires_at: new Date(v.expires_at) };
      const statusPreviewable = status !== null && canAdminPreview(versionRow, o.now);
      const rightsPreviewable = images.every((i) => i.previewable);
      const validator = validatorCodes(v.validator_result);
      const facts = !factsKnown ? "unknown" : o.currentFactsSha256 === v.facts_sha256 ? "same" : "changed";
      const reviews = [...(reviewsByVersion.get(v.id) ?? [])]
        .sort((a, b) => (a.reviewed_at < b.reviewed_at ? 1 : -1))
        .map(reviewView);
      const activeApproval = reviews.find((r) => r.decision === "approved" && r.state === "active") ?? null;

      const reviewBlockers: ReviewBlocker[] = [];
      const reviewableStatus = status === "draft" || status === "superseded";
      if (!reviewableStatus || v.revoked_at !== null || expired(v.expires_at, o.now)) reviewBlockers.push("VERSION_NOT_REVIEWABLE");
      if (o.demoDisabled) reviewBlockers.push("DEMO_DISABLED");
      if (facts === "changed") reviewBlockers.push("FACTS_CHANGED");
      if (!validator.ok) reviewBlockers.push("VALIDATOR_NOT_OK");
      if (!rightsPreviewable) reviewBlockers.push("RIGHTS_NOT_PREVIEWABLE");
      const missingRequiredRenders = REQUIRED_RENDERS.filter((r) => !renders.some((x) => x.viewport === r));
      const approveBlockers: ApproveBlocker[] = [...reviewBlockers];
      // the owner rule: facts that cannot be confirmed fail safe (a rejection or a change request stays possible)
      if (facts === "unknown") approveBlockers.push("FACTS_UNKNOWN");
      if (missingRequiredRenders.length) approveBlockers.push("RENDER_MISSING");
      if (files.some((f) => f.role === "render" && !renders.some((r) => r.urlPath === f.path))) approveBlockers.push("RENDER_UNVIEWABLE");
      if (openSends.length) approveBlockers.push("APPROVAL_OPEN");

      const parent = v.parent_version_id ? byId.get(v.parent_version_id) ?? null : null;
      return {
        id: v.id,
        versionNo: v.version_no,
        parentId: v.parent_version_id,
        parentVersionNo: parent?.version_no ?? null,
        parentMissing: v.parent_version_id !== null && parent === null,
        status,
        statusLabel: status ? VERSION_STATUS_LABEL[status] : "不明な状態",
        origin: v.origin,
        workerCommit: v.worker_commit && /^[0-9a-f]{7,40}$/.test(v.worker_commit) ? v.worker_commit : null,
        bundleSha256: v.bundle_sha256,
        createdAt: v.created_at,
        expiresAt: v.expires_at,
        revoked: v.revoked_at !== null || status === "revoked",
        revokeCode: v.revoke_code !== null && (REVOKE_REASONS as readonly string[]).includes(v.revoke_code) ? (v.revoke_code as RevokeReason) : null,
        previewable: statusPreviewable && rightsPreviewable && UUID.test(v.id) && UUID.test(v.demo_id),
        renders,
        missingRequiredRenders,
        images,
        validator,
        facts,
        reviews,
        activeApproval,
        reviewBlockers,
        approveBlockers,
        impersonationConfirmImageIds: images.filter((i) => i.needsImpersonationConfirm && i.imageId).map((i) => i.imageId!),
        revocable: status === "draft" || status === "approved" || status === "superseded",
        unshareableReasons: unshareableReasons(images),
      };
    });

  const fullLineage = lineage(o.versions);
  return {
    versions,
    approvedVersionId: o.approvedVersionId,
    openSends,
    sendStop: sendStop(o, versions, factsKnown),
    lineage: fullLineage.slice(0, LINEAGE_DISPLAY_LIMIT),
    lineageHidden: Math.max(0, fullLineage.length - LINEAGE_DISPLAY_LIMIT),
  };
}

/** sales_demo_version_send_block, re-derived from the rows the screen read (same order of checks). */
function sendStop(
  o: { versions: readonly VersionRowDb[]; reviews: readonly QualityReviewDb[]; approvedVersionId: string | null; currentFactsSha256: string | null; now: Date },
  views: readonly VersionView[],
  factsKnown: boolean,
): SendStop | null {
  if (o.approvedVersionId === null) return null;
  const stop = (code: SendBlockCode, reasons: UnshareableReason[] = []): SendStop => ({ code, reasons, factsUnknown: !factsKnown });
  const v = o.versions.find((x) => x.id === o.approvedVersionId);
  const view = views.find((x) => x.id === o.approvedVersionId);
  // not this demo's row, not approved, revoked or expired (an unparseable expiry counts as expired)
  if (!v || !view || v.status !== "approved" || v.revoked_at !== null || expired(v.expires_at, o.now)) return stop("demo_version_unavailable");
  const hasActiveApproval = o.reviews.some(
    (r) => r.version_id === v.id && r.decision === "approved" && r.state === "active" && r.bundle_sha256 === v.bundle_sha256 && r.facts_sha256 === v.facts_sha256,
  );
  if (!hasActiveApproval) return stop("demo_quality_not_approved");
  if (factsKnown && o.currentFactsSha256 !== v.facts_sha256) return stop("demo_facts_changed");
  // versioned sharing is off (DEV-196g), so a version that got this far is never shareable today
  const reasons = view.unshareableReasons;
  return reasons.length ? stop("demo_not_shareable", reasons) : null;
}

/**
 * Lineage in display order: roots by version number, each followed by its descendants (depth-first, pre-order).
 * Iterative (a long chain never overflows the stack), linear apart from sorting, and cycle-safe.
 */
export function lineage(versions: readonly Pick<VersionRowDb, "id" | "version_no" | "parent_version_id">[]): { id: string; versionNo: number; depth: number }[] {
  type Row = Pick<VersionRowDb, "id" | "version_no" | "parent_version_id">;
  const ids = new Set(versions.map((v) => v.id));
  const children = new Map<string | null, Row[]>();
  for (const v of versions) {
    const parent = v.parent_version_id && ids.has(v.parent_version_id) && v.parent_version_id !== v.id ? v.parent_version_id : null;
    const list = children.get(parent);
    if (list) list.push(v);
    else children.set(parent, [v]);
  }
  for (const list of children.values()) list.sort((a, b) => a.version_no - b.version_no);
  const out: { id: string; versionNo: number; depth: number }[] = [];
  const seen = new Set<string>();
  const stack: { row: Row; depth: number }[] = [];
  const pushChildren = (parent: string | null, depth: number) => {
    const list = children.get(parent) ?? [];
    // reversed, so the lowest version number is popped first
    for (let i = list.length - 1; i >= 0; i--) stack.push({ row: list[i]!, depth });
  };
  pushChildren(null, 0);
  while (stack.length) {
    const { row, depth } = stack.pop()!;
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push({ id: row.id, versionNo: row.version_no, depth });
    pushChildren(row.id, depth + 1);
  }
  // members of a parent cycle (the database forbids it; never drop a row from view)
  for (const v of [...versions].sort((a, b) => a.version_no - b.version_no)) if (!seen.has(v.id)) out.push({ id: v.id, versionNo: v.version_no, depth: 0 });
  return out;
}
