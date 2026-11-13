/**
 * DEV-199e (owner Issue #258, decision ①: send blocking): the server's side of the copy review store and the copy send
 * gate of a demo version. Pure apart from sha256: the rows come from the database (./store.ts loads them), the audit is
 * re-run here on the stored bytes.
 *
 * Two jobs:
 *
 *   planCopyAppend — before a review is stored (lib/demo-version-package/import.ts): the DEV-199a / DEV-199d handoff,
 *     both checks, never one alone —
 *       1. copyReviewAppendBlockers(EVERY stored review of the shop, in stored order, the submitted review,
 *          { ownerRevision: the owner's revise decision for the last round of its chain, from the owner's store });
 *       2. checkCopyQualityReview(submitted, its files, { previous: the stored chain (review, copy record, page HTML
 *          and CSS, ownerRevision), photoUrls: the page's photo URLs }), and the gate copyGateSendBlockers with the
 *          same `previous` and `photoUrls` and no owner approval (stored as the review's gate_blockers).
 *     The database enforces the order rules again (sales_check_copy_review_write); it cannot re-run the audit.
 *
 *   evaluateVersionCopyGate — before a send of a quality-approved version (app/admin/sales/_actions/send.ts): the same
 *     refusals as the database's sales_copy_send_block, plus the audit re-run on the stored bytes with the stored chain
 *     and the owner's approval (copyGateSendBlockers). The database refuses on its own whatever this says.
 *
 * Owner records come only from the owner's store (sales_demo_copy_owner_decisions, written by a signed-in admin):
 * never from a package or a generator.
 */
import { createHash } from "node:crypto";
import {
  checkCopyQualityReview,
  copyGateSendBlockers,
  copyReviewAppendBlockers,
  copyVerdict,
  CopyQualityReview,
  nextCopyStep,
  type CopyQualityFiles,
  type OwnerCopyApproval,
  type PriorRound,
} from "@/lib/design-agent/quality-pipeline/copy-quality-review";
import type { CopySendCode } from "./labels";

export { COPY_SEND_CODES, COPY_SEND_LABEL, type CopySendCode } from "./labels";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** A row of sales_demo_copy_reviews (the columns the server reads). */
export type StoredCopyReview = {
  id: string;
  seq: number;
  demo_id: string;
  shop_id: string;
  lane: string;
  round: number;
  previous_review_id: string | null;
  copy_verdict: string;
  next_step: string;
  facts_sha256: string;
  facts_content_sha256: string;
  copy_sha256: string;
  page_html_sha256: string;
  page_css_sha256: string;
  review_sha256: string;
  gate_blockers: string[];
  review_text: string;
  copy_record_text: string;
  facts_pack_text: string;
  page_html_text: string;
  page_css_text: string;
};

/** A row of sales_demo_copy_owner_decisions. */
export type StoredOwnerDecision = {
  id: string;
  review_id: string;
  version_id: string;
  decision: "approve" | "revise" | "reject";
  review_sha256: string;
  facts_sha256: string;
  copy_sha256: string;
  page_html_sha256: string;
  page_css_sha256: string;
};

/** Everything stored for one shop: reviews in stored order, the owner's decisions, the facts-path checks. */
export type ShopCopyState = {
  reviews: StoredCopyReview[];
  decisions: StoredOwnerDecision[];
  /** the facts-path checks: the review's facts pack, and the demo's facts when the check was made (PR #262 M2) */
  factsChecks: { review_id: string; facts_sha256: string; demo_facts_sha256: string }[];
};

/** One round to store, as text (UTF-8, exactly the bytes reviewed). */
export type CopyCandidate = { review: string; copyRecord: string; factsPack: string; pageHtml: string; pageCss: string };

const parseJson = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

/** The owner's decision as copy-quality-review's OwnerCopyApproval (shop id from the review it was made on). */
export function ownerApprovalOf(d: StoredOwnerDecision, q: Pick<StoredCopyReview, "shop_id">): OwnerCopyApproval {
  return { shop_id: q.shop_id, facts_sha256: d.facts_sha256, copy_sha256: d.copy_sha256, page_html_sha256: d.page_html_sha256, page_css_sha256: d.page_css_sha256, decision: d.decision };
}

/** Every owner revise request of the shop, for verifyPackageCopy's chain inside a package. */
export function ownerRevisionsOf(state: ShopCopyState): OwnerCopyApproval[] {
  return state.decisions.flatMap((d) => {
    const q = state.reviews.find((r) => r.id === d.review_id);
    return d.decision === "revise" && q ? [ownerApprovalOf(d, q)] : [];
  });
}

/** The stored chain of a shop, lane and facts content, in round order. */
export function chainOf(state: ShopCopyState, lane: string, factsContentSha256: string): StoredCopyReview[] {
  return state.reviews.filter((r) => r.lane === lane && r.facts_content_sha256 === factsContentSha256).sort((a, b) => a.round - b.round);
}

const filesOf = (q: Pick<StoredCopyReview, "facts_pack_text" | "copy_record_text" | "page_html_text" | "page_css_text">): CopyQualityFiles => ({
  factsPack: q.facts_pack_text,
  copyRecord: q.copy_record_text,
  pageHtml: q.page_html_text,
  pageCss: q.page_css_text,
});

/** The stored rounds as PriorRound, each with the owner's revise request for it (from the owner's store only). */
export function priorRoundsOf(state: ShopCopyState, rounds: readonly StoredCopyReview[]): PriorRound[] {
  return rounds.map((q) => {
    const d = state.decisions.find((x) => x.review_id === q.id && x.decision === "revise");
    return { review: parseJson(q.review_text), copyRecord: q.copy_record_text, pageHtml: q.page_html_text, pageCss: q.page_css_text, ownerRevision: d ? ownerApprovalOf(d, q) : null };
  });
}

export type AppendPlan =
  | { ok: true; replay: StoredCopyReview | null; gateBlockers: string[]; row: StoredCopyReview }
  | { ok: false; codes: string[] };

/**
 * May this round be stored for the shop? `replay` is the stored row when exactly this review is already stored. The
 * returned `row` stands in for the stored row (a pending id) so the next round of the same package can be planned.
 */
export function planCopyAppend(state: ShopCopyState, c: CopyCandidate, photoUrls: ReadonlySet<string>): AppendPlan {
  const parsed = CopyQualityReview.safeParse(parseJson(c.review));
  if (!parsed.success) return { ok: false, codes: ["REVIEW_SCHEMA"] };
  const r = parsed.data;
  const reviewSha = sha256(c.review);
  const stored = state.reviews.find((q) => q.review_sha256 === reviewSha);
  if (stored) {
    const same = stored.copy_record_text === c.copyRecord && stored.facts_pack_text === c.factsPack && stored.page_html_text === c.pageHtml && stored.page_css_text === c.pageCss;
    return same ? { ok: true, replay: stored, gateBlockers: stored.gate_blockers, row: stored } : { ok: false, codes: ["COPY_REPLAY_DIFFERS"] };
  }
  const chain = chainOf(state, r.lane, r.facts_content_sha256);
  const last = chain.at(-1);
  const lastRevision = last ? state.decisions.find((d) => d.review_id === last.id && d.decision === "revise") : undefined;
  const codes = copyReviewAppendBlockers(
    state.reviews.map((q) => parseJson(q.review_text)),
    r,
    { ownerRevision: last && lastRevision ? ownerApprovalOf(lastRevision, last) : null },
  );
  // PR #262 M1: a fail is terminal for the facts content (any lane), and one facts content has one lane
  const sameFacts = state.reviews.filter((q) => q.facts_content_sha256 === r.facts_content_sha256);
  if (sameFacts.some((q) => q.next_step === "stop_fail")) codes.push("STORED_FAIL_IS_TERMINAL");
  if (sameFacts.some((q) => q.lane !== r.lane)) codes.push("CHAIN_LANE_SWITCH");
  const files: CopyQualityFiles = { factsPack: c.factsPack, copyRecord: c.copyRecord, pageHtml: c.pageHtml, pageCss: c.pageCss };
  const previous = priorRoundsOf(state, chain);
  const check = checkCopyQualityReview(r, files, { previous, photoUrls });
  // a failed review is stored too (honest: the only findings are the failed revision step the review names itself)
  const named = new Set(r.revision_findings.filter((x) => x.severity === "fail").map((x) => x.code));
  const honestFail = r.verdict === "fail" && check.codes.every((code) => code === "REVISION_INVALID" || named.has(code));
  if (!check.ok && !honestFail) codes.push("REVIEW_INVALID", ...check.codes);
  if (codes.length) return { ok: false, codes: [...new Set(codes)] };
  const gateBlockers = copyGateSendBlockers(r, files, null, { previous, photoUrls });
  const row: StoredCopyReview = {
    id: `pending-${reviewSha}`,
    seq: (state.reviews.at(-1)?.seq ?? 0) + 1,
    demo_id: state.reviews[0]?.demo_id ?? "",
    shop_id: r.shop_id,
    lane: r.lane,
    round: r.round,
    previous_review_id: last?.id ?? null,
    copy_verdict: copyVerdict(r),
    next_step: nextCopyStep(r),
    facts_sha256: r.facts_sha256,
    facts_content_sha256: r.facts_content_sha256,
    copy_sha256: r.copy_sha256,
    page_html_sha256: r.page_html_sha256,
    page_css_sha256: r.page_css_sha256,
    review_sha256: reviewSha,
    gate_blockers: gateBlockers,
    review_text: c.review,
    copy_record_text: c.copyRecord,
    facts_pack_text: c.factsPack,
    page_html_text: c.pageHtml,
    page_css_text: c.pageCss,
  };
  return { ok: true, replay: null, gateBlockers, row };
}

export type VersionCopyGateInput = {
  versionId: string;
  /** the photo URLs of the version's page (photoUrlPaths(manifest)): the same set the import audited with */
  photoUrls: ReadonlySet<string>;
  /** sha256 of the version's page/index.html and page/style.css (sales_demo_version_files) */
  /** the version's facts_sha256 (sales_demo_versions): the facts-path check must be made on these facts (PR #262 M2) */
  versionFactsSha256: string | null;
  pageHtmlSha256: string | null;
  pageCssSha256: string | null;
  /** sales_demo_version_copy_links.review_id of the version, or null */
  linkedReviewId: string | null;
  state: ShopCopyState;
};

export type VersionCopyGate = { ok: true } | { ok: false; code: CopySendCode; details: string[] };

/**
 * Why the copy of this version may NOT be sent (ok: the copy gate does not block; the design review, the rights, the
 * facts and the send path keep their own gates). Same order as sales_copy_send_block.
 */
export function evaluateVersionCopyGate(i: VersionCopyGateInput): VersionCopyGate {
  const no = (code: CopySendCode, details: string[] = []): VersionCopyGate => ({ ok: false, code, details });
  const q = i.linkedReviewId ? i.state.reviews.find((r) => r.id === i.linkedReviewId) : undefined;
  if (!q) return no("demo_copy_review_missing");
  const checks = i.state.factsChecks.filter((c) => c.review_id === q.id && c.facts_sha256 === q.facts_sha256);
  if (!checks.length) return no("demo_copy_facts_not_from_facts_path");
  if (!checks.some((c) => c.demo_facts_sha256 === i.versionFactsSha256)) return no("demo_copy_facts_stale");
  const chain = chainOf(i.state, q.lane, q.facts_content_sha256);
  if (q.page_html_sha256 !== i.pageHtmlSha256 || q.page_css_sha256 !== i.pageCssSha256 || chain.some((r) => r.round > q.round)) return no("demo_copy_review_stale");
  if (q.lane !== "real_shop_proposal" || q.copy_verdict !== "approve_candidate") return no("demo_copy_review_not_passed");
  if (q.gate_blockers.some((b) => b !== "OWNER_APPROVAL_MISSING")) return no("demo_copy_send_blocked", q.gate_blockers);
  const d = i.state.decisions.find((x) => x.review_id === q.id);
  if (!d || d.decision !== "approve" || d.version_id !== i.versionId) return no("demo_copy_owner_confirmation_missing");
  if (d.review_sha256 !== q.review_sha256 || sha256(q.review_text) !== q.review_sha256) return no("demo_copy_owner_confirmation_mismatch");
  // the audit again, on the stored bytes, with the stored chain and the owner's approval
  const previous = priorRoundsOf(i.state, chain.filter((r) => r.round < q.round));
  const blockers = copyGateSendBlockers(parseJson(q.review_text), filesOf(q), ownerApprovalOf(d, q), { previous, photoUrls: i.photoUrls });
  if (blockers.includes("OWNER_APPROVAL_FOR_OTHER_INPUTS")) return no("demo_copy_owner_confirmation_mismatch", blockers);
  if (blockers.length) return no("demo_copy_send_blocked", blockers);
  return { ok: true };
}
