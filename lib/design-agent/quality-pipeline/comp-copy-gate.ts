/**
 * DEV-199b (owner Issue #258, 2/3): the copy quality gate of the comp lane. A comp goes to the owner (its comp review
 * says `show_owner`) only when the copy audit of exactly its files (copy_quality_review_v1, DEV-199a) is valid and its
 * next step is `owner_review` (copy verdict approve_candidate). Nothing here audits: it calls the existing functions.
 *
 *   - the review must be valid for these exact files, with its whole revision chain (checkCopyQualityReview, which
 *     re-runs the audit and every validateCopyRevision step), AND appendable in order after the earlier rounds
 *     (copyReviewAppendBlockers: round 0 first, round = chain length, linked to the last copy, the last round allows a
 *     revision). Both, never one alone (DEV-199a handoff, round 7). A tampered, stale or hand-written review is
 *     `refused`.
 *   - nextCopyStep decides what follows: `owner_review` → may be shown to the owner; `revise` → a local revision (the
 *     next round, at most MAX_COPY_REVISION_ROUNDS); `stop_hold` → stops with the hold reasons (missing facts are never
 *     invented, the cap reached); `stop_fail` → terminal (no revision follows a fail).
 *   - an honest `fail` (the review names the failed revision step itself) is `stop_fail`, not `refused`, as the store
 *     does (lib/sales/copy-review/gate.ts planCopyAppend).
 *   - the comp lane has no owner store: an owner revise request is never read here, so a real-shop round at owner
 *     review is not revised in this lane (closed side). Sending is never decided here: `sendable` is always false and
 *     `sendBlockers` is copyGateSendBlockers with no owner approval (OWNER_APPROVAL_MISSING at least; the fictional
 *     research lane always FICTIONAL_RESEARCH_NOT_SENDABLE).
 *
 * Pure: no file, network, process or model. The caller (scripts/design-artifact/comp-copy.ts) reads the files.
 */
import {
  checkCopyQualityReview,
  copyGateSendBlockers,
  copyReviewAppendBlockers,
  copyVerdict,
  CopyQualityReview,
  MAX_COPY_REVISION_ROUNDS,
  nextCopyStep,
  type CopyQualityFiles,
  type PriorRound,
  type Verdict,
} from "./copy-quality-review";

export type CompCopyStep = "owner_review" | "revise" | "stop_hold" | "stop_fail" | "refused";

export type CompCopyGate = {
  step: CompCopyStep;
  /** only `owner_review`: the comp may be shown to the owner (never a send, never a quality claim) */
  mayShowOwner: boolean;
  /** why the review was refused (step `refused`), or the codes that stop / revise it */
  codes: string[];
  round: number | null;
  lane: CopyQualityReview["lane"] | null;
  /** the copy verdict (COPY_APPROVAL_MISSING aside) */
  copyVerdict: Verdict | null;
  /** the finding codes to fix (revise) or the reasons it stops (hold / fail), with their severity */
  findings: Array<{ code: string; severity: string; reason: string }>;
  revisionFindings: CopyQualityReview["revision_findings"];
  sendable: false;
  sendBlockers: string[];
};

export type CompCopyGateInput = {
  files: CopyQualityFiles;
  /** the parsed copy-review.json of the current files; null when there is none */
  review: unknown | null;
  /** the earlier rounds, in order (round 0 … n-1), each with its review and files */
  previous: readonly PriorRound[];
  /** the photo URLs the comp may reference: the comp lane allows none */
  photoUrls?: ReadonlySet<string>;
};

const refused = (codes: string[], round: number | null = null): CompCopyGate => ({
  step: "refused",
  mayShowOwner: false,
  codes: [...new Set(codes)],
  round,
  lane: null,
  copyVerdict: null,
  findings: [],
  revisionFindings: [],
  sendable: false,
  sendBlockers: ["COPY_REVIEW_REFUSED"],
});

export function compCopyGate(i: CompCopyGateInput): CompCopyGate {
  if (i.review === null || i.review === undefined) return refused(["COPY_REVIEW_MISSING"]);
  const parsed = CopyQualityReview.safeParse(i.review);
  if (!parsed.success) return refused(["COPY_REVIEW_SCHEMA"]);
  const r = parsed.data;
  if (i.previous.length > MAX_COPY_REVISION_ROUNDS) return refused(["COPY_ROUNDS_OVER_CAP"], r.round);
  const photoUrls = i.photoUrls ?? new Set<string>();
  // the comp lane has no owner store: an owner record handed in with a round is never used
  const previous: PriorRound[] = i.previous.map((p) => ({ ...p, ownerRevision: null }));
  const codes: string[] = [];
  // order: this round after the earlier rounds as a store would hold them (no owner revision in the comp lane); the
  // earlier rounds' own order and links are checked again by checkCopyQualityReview's chain
  const append = copyReviewAppendBlockers(previous.map((p) => p.review), r, {});
  codes.push(...append);
  const check = checkCopyQualityReview(r, i.files, { previous, photoUrls });
  // an honest fail: the only problems are the failed revision step the review names itself (as planCopyAppend), and
  // only when the review is appendable and every earlier round re-checks cleanly on its own files (PR #264 review L:
  // a REVISION_INVALID from a broken earlier round is never excused as this round's named failure)
  const named = new Set(r.revision_findings.filter((x) => x.severity === "fail").map((x) => x.code));
  const earlierClean = () =>
    previous.every((p, k) => checkCopyQualityReview(p.review, { factsPack: i.files.factsPack, copyRecord: p.copyRecord, pageHtml: p.pageHtml, pageCss: p.pageCss }, { previous: previous.slice(0, k), photoUrls }).ok);
  const honestFail = r.verdict === "fail" && append.length === 0 && check.codes.every((c) => c === "REVISION_INVALID" || named.has(c)) && earlierClean();
  if (!check.ok && !honestFail) codes.push(...check.codes);
  if (codes.length) return refused(codes, r.round);

  const step = nextCopyStep(r);
  const verdict = copyVerdict(r);
  const open = r.findings.filter((f) => f.code !== "COPY_APPROVAL_MISSING");
  const why =
    step === "stop_fail"
      ? open.filter((f) => f.severity === "fail")
      : step === "stop_hold" && verdict === "hold"
        ? open.filter((f) => f.severity === "hold")
        : open;
  const stopCodes = step === "stop_hold" && verdict === "revise" ? ["COPY_REVISION_CAP_REACHED"] : [];
  return {
    step,
    mayShowOwner: step === "owner_review",
    codes: [...new Set([...stopCodes, ...why.map((f) => f.code)])],
    round: r.round,
    lane: r.lane,
    copyVerdict: verdict,
    findings: why.map((f) => ({ code: f.code, severity: f.severity, reason: f.reason })),
    revisionFindings: r.revision_findings,
    sendable: false,
    sendBlockers: copyGateSendBlockers(r, i.files, null, { previous, photoUrls }),
  };
}

/**
 * The codes a comp review's verdict gets from the copy gate: `show_owner` needs a copy review at owner review. Any other
 * comp verdict (revise, drop) is not held back by the copy (it is not shown to the owner).
 */
export function compShowOwnerCodes(compVerdict: unknown, gate: CompCopyGate | null): string[] {
  if (compVerdict !== "show_owner") return [];
  if (!gate) return ["SHOW_WITHOUT_COPY_REVIEW"];
  if (gate.mayShowOwner) return [];
  const step = gate.step === "refused" ? "COPY_REVIEW_REFUSED" : `COPY_${gate.step.toUpperCase()}`;
  return ["SHOW_WITHOUT_COPY_APPROVE_CANDIDATE", step, ...gate.codes.map((c) => `COPY_${c}`.slice(0, 70))];
}
