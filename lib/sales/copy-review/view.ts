/**
 * DEV-199b (owner Issue #258, 2/3): what the admin demo version screen shows of a version's copy review, from the rows
 * the store read (./store.ts loadVersionCopyContext). Pure: the decisions are gate.ts's (the send gate and the owner's
 * decision refusals), the database decides again.
 *
 * The screen shows the review linked to the version (round, lane, copy verdict, next step, findings with the audit's
 * reasons, the revision findings — the owner's notes on what a revision changed —, whether its facts came from the
 * facts path, the gate's send blockers), the owner's decision if one is recorded, the send gate's real stop reason, and
 * per decision why it would be refused. No facts path exists yet: facts_from_facts_path is false for every stored
 * review, so the decision is always refused (COPY_FACTS_NOT_FROM_FACTS_PATH) and the copy is never sendable.
 */
import { COPY_DECISIONS, copyDecisionRefusals, evaluateVersionCopyGate, storeFactsChecks, type CopyDecision, type VersionCopyGateInput } from "./gate";
import { COPY_SEND_LABEL, type CopySendCode } from "./labels";

export type CopyFindingView = { code: string; severity: string; reason: string; texts: string[] };
export type CopyRevisionFindingView = { code: string; severity: string; item: string | null; detail: string | null };

export type CopyReviewView = {
  review: null | {
    id: string;
    round: number;
    lane: string;
    copyVerdict: string;
    nextStep: string;
    factsFromFactsPath: boolean;
    findings: CopyFindingView[];
    revisionFindings: CopyRevisionFindingView[];
    gateBlockers: string[];
    /** what the owner's decision is bound to (the action sends these back; the server and the database compare) */
    hashes: { review: string; facts: string; copy: string; pageHtml: string; pageCss: string };
    /** a later round of the same chain exists */
    superseded: boolean;
  };
  decision: null | { decision: CopyDecision; forThisVersion: boolean };
  sendBlock: null | { code: CopySendCode; label: string; details: string[] };
  refusals: Record<CopyDecision, string[]>;
};

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

function parsed(text: string): { findings: CopyFindingView[]; revisionFindings: CopyRevisionFindingView[] } {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { findings: [], revisionFindings: [] };
  }
  const o = (v ?? {}) as { findings?: unknown; revision_findings?: unknown };
  const findings = (Array.isArray(o.findings) ? o.findings : []).slice(0, 200).map((f: { code?: unknown; severity?: unknown; reason?: unknown; texts?: unknown }) => ({
    code: str(f?.code, 70),
    severity: str(f?.severity, 10),
    reason: str(f?.reason, 400),
    texts: (Array.isArray(f?.texts) ? f.texts : []).slice(0, 5).map((t: unknown) => str(t, 200)).filter(Boolean),
  }));
  const revisionFindings = (Array.isArray(o.revision_findings) ? o.revision_findings : []).slice(0, 80).map((f: { code?: unknown; severity?: unknown; item?: unknown; detail?: unknown }) => ({
    code: str(f?.code, 70),
    severity: str(f?.severity, 10),
    item: typeof f?.item === "string" ? f.item.slice(0, 41) : null,
    detail: typeof f?.detail === "string" ? f.detail.slice(0, 120) : null,
  }));
  return { findings, revisionFindings };
}

export function buildCopyReviewView(i: VersionCopyGateInput): CopyReviewView {
  const q = i.linkedReviewId ? i.state.reviews.find((r) => r.id === i.linkedReviewId) : undefined;
  const gate = evaluateVersionCopyGate(i);
  const sendBlock = gate.ok ? null : { code: gate.code, label: COPY_SEND_LABEL[gate.code], details: gate.details.slice(0, 40) };
  const refusals = Object.fromEntries(COPY_DECISIONS.map((d) => [d, copyDecisionRefusals(i, d)])) as Record<CopyDecision, string[]>;
  if (!q) return { review: null, decision: null, sendBlock, refusals };
  const d = i.state.decisions.find((x) => x.review_id === q.id);
  return {
    review: {
      id: q.id,
      round: q.round,
      lane: q.lane,
      copyVerdict: q.copy_verdict,
      nextStep: q.next_step,
      factsFromFactsPath: storeFactsChecks(i.state, q).length > 0,
      ...parsed(q.review_text),
      gateBlockers: q.gate_blockers,
      hashes: { review: q.review_sha256, facts: q.facts_sha256, copy: q.copy_sha256, pageHtml: q.page_html_sha256, pageCss: q.page_css_sha256 },
      superseded: i.state.reviews.some((r) => r.lane === q.lane && r.facts_content_sha256 === q.facts_content_sha256 && r.round > q.round),
    },
    decision: d ? { decision: d.decision, forThisVersion: d.version_id === i.versionId } : null,
    sendBlock,
    refusals,
  };
}
