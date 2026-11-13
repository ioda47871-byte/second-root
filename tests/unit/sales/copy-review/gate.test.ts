import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  chainOf,
  evaluateVersionCopyGate,
  ownerRevisionsOf,
  planCopyAppend,
  type ShopCopyState,
  type StoredCopyReview,
  type StoredOwnerDecision,
  type VersionCopyGateInput,
} from "@/lib/sales/copy-review/gate";
import { COPY_SEND_CODES, COPY_SEND_LABEL } from "@/lib/sales/copy-review/labels";
import { SEND_ERROR_LABEL, sendErrorMessage } from "@/lib/sales/approval";
import { auditReviseChain, candidateOf, cleanRound0, fictionalRound0, json, otherRound0, ownerReviseChain, type Round } from "../../../support/copy-review-fixture";

// DEV-199e (Issue #258 decision ①): the server side of the copy review store (what may be appended) and the copy send
// gate of a demo version. The database side is tests/integration/demo-copy-send-guard.test.ts.

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const NO_PHOTOS: ReadonlySet<string> = new Set();
const VERSION = "aaaaaaaa-0000-4000-8000-000000000001";
const empty = (): ShopCopyState => ({ reviews: [], decisions: [], factsChecks: [] });

/** Stores the rounds in order through planCopyAppend (as the importer does), with stable ids. */
function store(rounds: Round[], o: { state?: ShopCopyState; factsChecked?: boolean } = {}): ShopCopyState {
  const s = o.state ?? empty();
  for (const r of rounds) {
    const plan = planCopyAppend(s, candidateOf(r), NO_PHOTOS);
    if (!plan.ok) throw new Error(`fixture not appendable: ${plan.codes.join(",")}`);
    if (plan.replay) continue;
    const row: StoredCopyReview = { ...plan.row, id: `review-${s.reviews.length}`, demo_id: "demo-1" };
    s.reviews.push(row);
    if (o.factsChecked !== false) s.factsChecks.push({ review_id: row.id, facts_sha256: row.facts_sha256 });
  }
  return s;
}

const decide = (q: StoredCopyReview, decision: StoredOwnerDecision["decision"], over: Partial<StoredOwnerDecision> = {}): StoredOwnerDecision => ({
  id: `decision-${q.id}`,
  review_id: q.id,
  version_id: VERSION,
  decision,
  review_sha256: q.review_sha256,
  facts_sha256: q.facts_sha256,
  copy_sha256: q.copy_sha256,
  page_html_sha256: q.page_html_sha256,
  page_css_sha256: q.page_css_sha256,
  ...over,
});

const gateInput = (s: ShopCopyState, q: StoredCopyReview, over: Partial<VersionCopyGateInput> = {}): VersionCopyGateInput => ({
  versionId: VERSION,
  photoUrls: NO_PHOTOS,
  pageHtmlSha256: q.page_html_sha256,
  pageCssSha256: q.page_css_sha256,
  linkedReviewId: q.id,
  state: s,
  ...over,
});

describe("planCopyAppend: copyReviewAppendBlockers against every stored review AND checkCopyQualityReview with the stored chain", () => {
  it("the first review of a shop must be round 0; its gate (without an owner) is only OWNER_APPROVAL_MISSING", () => {
    const r0 = cleanRound0();
    const plan = planCopyAppend(empty(), candidateOf(r0), NO_PHOTOS);
    expect(plan).toMatchObject({ ok: true, replay: null, gateBlockers: ["OWNER_APPROVAL_MISSING"] });
    if (plan.ok) expect(plan.row).toMatchObject({ round: 0, copy_verdict: "approve_candidate", next_step: "owner_review", review_sha256: sha(json(r0.review)), lane: "real_shop_proposal" });
    // a round 1 with nothing stored
    const [, r1] = auditReviseChain();
    expect(planCopyAppend(empty(), candidateOf(r1), NO_PHOTOS)).toMatchObject({ ok: false, codes: expect.arrayContaining(["FIRST_REVIEW_NOT_ROUND_0", "REVIEW_INVALID", "REVISION_WITHOUT_PREVIOUS"]) });
  });

  it("the same review again is a replay (exact bytes); a different text under the same review is refused", () => {
    const r0 = cleanRound0();
    const s = store([r0]);
    expect(planCopyAppend(s, candidateOf(r0), NO_PHOTOS)).toMatchObject({ ok: true, replay: { id: "review-0" } });
    expect(planCopyAppend(s, { ...candidateOf(r0), pageCss: "p{}\n" }, NO_PHOTOS)).toEqual({ ok: false, codes: ["COPY_REPLAY_DIFFERS"] });
  });

  it("round-0 replay: a second round 0 for the same shop, lane and facts content is refused (ROUND_0_ALREADY_STORED)", () => {
    const s = store([cleanRound0()]);
    const plan = planCopyAppend(s, candidateOf(otherRound0()), NO_PHOTOS);
    expect(plan).toMatchObject({ ok: false, codes: expect.arrayContaining(["ROUND_0_ALREADY_STORED"]) });
  });

  it("an audit revise chain: round 1 follows the stored round 0 and passes the re-audit with the stored chain", () => {
    const [r0, r1] = auditReviseChain();
    const s = store([r0]);
    expect(s.reviews[0]).toMatchObject({ next_step: "revise", copy_verdict: "revise" });
    const plan = planCopyAppend(s, candidateOf(r1), NO_PHOTOS);
    expect(plan).toMatchObject({ ok: true, gateBlockers: ["OWNER_APPROVAL_MISSING"] });
    if (plan.ok) expect(plan.row).toMatchObject({ round: 1, previous_review_id: "review-0", copy_verdict: "approve_candidate" });
    // a forged round 1 (its verdict changed) does not match the re-run audit
    const forged = { ...candidateOf(r1), review: json({ ...r1.review, axes: { ...r1.review.axes, usefulness: { ...r1.review.axes.usefulness, score: 0 } } }) };
    expect(planCopyAppend(s, forged, NO_PHOTOS)).toMatchObject({ ok: false, codes: expect.arrayContaining(["REVIEW_INVALID", "REVIEW_DOES_NOT_MATCH_AUDIT"]) });
  });

  it("after owner review, the next round needs the owner's revise request from the owner's store (bound to that round)", () => {
    const [g0, g1] = ownerReviseChain();
    const s = store([g0]);
    expect(planCopyAppend(s, candidateOf(g1), NO_PHOTOS)).toMatchObject({ ok: false, codes: expect.arrayContaining(["LAST_ROUND_DOES_NOT_ALLOW_REVISION", "REVIEW_INVALID", "REVISION_AFTER_NON_REVISE"]) });
    // an approve, or a revise bound to other hashes, does not open a revision
    expect(planCopyAppend({ ...s, decisions: [decide(s.reviews[0]!, "approve")] }, candidateOf(g1), NO_PHOTOS)).toMatchObject({ ok: false });
    expect(planCopyAppend({ ...s, decisions: [decide(s.reviews[0]!, "revise", { copy_sha256: "4".repeat(64) })] }, candidateOf(g1), NO_PHOTOS)).toMatchObject({ ok: false });
    const asked: ShopCopyState = { ...s, decisions: [decide(s.reviews[0]!, "revise")] };
    expect(planCopyAppend(asked, candidateOf(g1), NO_PHOTOS)).toMatchObject({ ok: true });
    // the package check gets exactly these requests (never from the package)
    expect(ownerRevisionsOf(asked)).toEqual([{ shop_id: g0.review.shop_id, facts_sha256: g0.review.facts_sha256, copy_sha256: g0.review.copy_sha256, page_html_sha256: g0.review.page_html_sha256, page_css_sha256: g0.review.page_css_sha256, decision: "revise" }]);
    expect(ownerRevisionsOf({ ...s, decisions: [decide(s.reviews[0]!, "approve")] })).toEqual([]);
  });

  it("the store of one shop holds one shop: a review of another shop id is refused", () => {
    const s = store([cleanRound0()]);
    expect(chainOf(s, "real_shop_proposal", s.reviews[0]!.facts_content_sha256)).toHaveLength(1);
    expect(planCopyAppend(s, candidateOf(fictionalRound0()), NO_PHOTOS)).toMatchObject({ ok: false, codes: expect.arrayContaining(["STORED_REVIEW_OF_ANOTHER_SHOP"]) });
  });
});

describe("evaluateVersionCopyGate: every refusal, then the happy path", () => {
  const approved = () => {
    const s = store([cleanRound0()]);
    const q = s.reviews[0]!;
    s.decisions.push(decide(q, "approve"));
    return { s, q };
  };

  it("happy path: real shop, approve_candidate, facts from the facts path, the version's page, owner approved this review on this version", () => {
    const { s, q } = approved();
    expect(evaluateVersionCopyGate(gateInput(s, q))).toEqual({ ok: true });
  });

  it("no stored review linked to the version", () => {
    const { s, q } = approved();
    expect(evaluateVersionCopyGate(gateInput(s, q, { linkedReviewId: null }))).toMatchObject({ ok: false, code: "demo_copy_review_missing" });
  });

  it("the facts pack was not compared with the facts path", () => {
    const s = store([cleanRound0()], { factsChecked: false });
    const q = s.reviews[0]!;
    s.decisions.push(decide(q, "approve"));
    expect(evaluateVersionCopyGate(gateInput(s, q))).toMatchObject({ ok: false, code: "demo_copy_facts_not_from_facts_path" });
  });

  it("stale: the version's files differ from the reviewed page, or a later round followed", () => {
    const { s, q } = approved();
    expect(evaluateVersionCopyGate(gateInput(s, q, { pageCssSha256: sha("p{}\n") }))).toMatchObject({ ok: false, code: "demo_copy_review_stale" });
    expect(evaluateVersionCopyGate(gateInput(s, q, { pageHtmlSha256: null }))).toMatchObject({ ok: false, code: "demo_copy_review_stale" });
    const later: StoredCopyReview = { ...q, id: "review-later", round: 1 };
    expect(evaluateVersionCopyGate(gateInput({ ...s, reviews: [...s.reviews, later] }, q))).toMatchObject({ ok: false, code: "demo_copy_review_stale" });
  });

  it("not passed: a round asking for revision, or the fictional lane", () => {
    const [r0] = auditReviseChain();
    const s = store([r0]);
    s.decisions.push(decide(s.reviews[0]!, "approve"));
    expect(evaluateVersionCopyGate(gateInput(s, s.reviews[0]!))).toMatchObject({ ok: false, code: "demo_copy_review_not_passed" });
    const f = store([fictionalRound0()]);
    f.decisions.push(decide(f.reviews[0]!, "approve"));
    expect(evaluateVersionCopyGate(gateInput(f, f.reviews[0]!))).toMatchObject({ ok: false, code: "demo_copy_review_not_passed" });
  });

  it("the stored gate found more than the missing owner approval", () => {
    const { s, q } = approved();
    const blocked = { ...q, gate_blockers: ["OWNER_APPROVAL_MISSING", "REVIEW_INVALID"] };
    expect(evaluateVersionCopyGate(gateInput({ ...s, reviews: [blocked] }, blocked))).toMatchObject({ ok: false, code: "demo_copy_send_blocked" });
  });

  it("owner confirmation missing: none, revise / reject, or made on another version", () => {
    const s = store([cleanRound0()]);
    const q = s.reviews[0]!;
    expect(evaluateVersionCopyGate(gateInput(s, q))).toMatchObject({ ok: false, code: "demo_copy_owner_confirmation_missing" });
    for (const d of [decide(q, "revise"), decide(q, "reject"), decide(q, "approve", { version_id: "aaaaaaaa-0000-4000-8000-000000000002" })])
      expect(evaluateVersionCopyGate(gateInput({ ...s, decisions: [d] }, q))).toMatchObject({ ok: false, code: "demo_copy_owner_confirmation_missing" });
  });

  it("owner confirmation bound to other hashes", () => {
    const s = store([cleanRound0()]);
    const q = s.reviews[0]!;
    expect(evaluateVersionCopyGate(gateInput({ ...s, decisions: [decide(q, "approve", { review_sha256: "5".repeat(64) })] }, q))).toMatchObject({ ok: false, code: "demo_copy_owner_confirmation_mismatch" });
    expect(evaluateVersionCopyGate(gateInput({ ...s, decisions: [decide(q, "approve", { copy_sha256: "5".repeat(64) })] }, q))).toMatchObject({ ok: false, code: "demo_copy_owner_confirmation_mismatch" });
  });

  it("the audit is re-run on the stored bytes: an edited stored text is refused even with every flag set", () => {
    const { s, q } = approved();
    const edited = { ...q, copy_record_text: `${q.copy_record_text} ` };
    expect(evaluateVersionCopyGate(gateInput({ ...s, reviews: [edited] }, edited))).toMatchObject({ ok: false, code: "demo_copy_send_blocked", details: expect.arrayContaining(["REVIEW_INVALID", "REVIEW_STALE_COPY"]) });
  });

  it("a revised chain passes only with its stored earlier round (the chain is part of the re-audit)", () => {
    const [r0, r1] = auditReviseChain();
    const s = store([r0, r1]);
    const q = s.reviews[1]!;
    s.decisions.push(decide(q, "approve"));
    expect(evaluateVersionCopyGate(gateInput(s, q))).toEqual({ ok: true });
    // without round 0 in the store the re-audit refuses round 1
    const alone: ShopCopyState = { reviews: [q], decisions: s.decisions, factsChecks: s.factsChecks };
    expect(evaluateVersionCopyGate(gateInput(alone, q))).toMatchObject({ ok: false, code: "demo_copy_send_blocked", details: expect.arrayContaining(["REVISION_WITHOUT_PREVIOUS"]) });
  });
});

describe("labels and wiring", () => {
  it("every refusal has the owner's words, and the send screen maps the database's codes to them", () => {
    for (const c of COPY_SEND_CODES) {
      expect(COPY_SEND_LABEL[c]).toMatch(/送れません/);
      expect(sendErrorMessage(c)).toBe(COPY_SEND_LABEL[c]);
    }
    expect(JSON.stringify(SEND_ERROR_LABEL)).not.toContain("自動送信");
  });

  it("the database's sales_copy_send_block uses exactly these codes (besides the server-only unverifiable)", () => {
    const sql = readFileSync("supabase/migrations/20261113000000_sales_demo_copy_send_guard.sql", "utf8");
    const fn = sql.slice(sql.indexOf("create function public.sales_copy_send_block"), sql.indexOf("create or replace function public.sales_demo_version_send_block"));
    const codes = [...new Set([...fn.matchAll(/return '([a-z_]+)'/g)].map((m) => m[1]))].sort();
    expect(codes).toEqual(COPY_SEND_CODES.filter((c) => c !== "demo_copy_review_unverifiable").slice().sort());
  });

  it("the send action consults the copy gate before the database, and the store never writes an owner decision", () => {
    const send = readFileSync("app/admin/sales/_actions/send.ts", "utf8");
    expect(send.indexOf("outreachCopyGate(")).toBeGreaterThan(0);
    expect(send.indexOf("outreachCopyGate(")).toBeLessThan(send.indexOf('rpc("sales_approve_outreach"'));
    for (const f of ["lib/sales/copy-review/store.ts", "lib/sales/copy-review/gate.ts", "lib/demo-version-package/import.ts"]) {
      const src = readFileSync(f, "utf8");
      expect(src).not.toMatch(/sales_decide_copy_review|sales_demo_copy_owner_decisions"\)\.(insert|update|upsert)/);
      expect(src).not.toMatch(/process\.env|\bfetch\s*\(|child_process|anthropic|openai/i);
    }
  });
});
