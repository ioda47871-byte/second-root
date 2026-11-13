import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CopyReviewPanel from "@/components/admin/demo/CopyReviewPanel";
import { copyDecisionRefusals, planCopyAppend, type ShopCopyState, type StoredCopyReview, type VersionCopyGateInput } from "@/lib/sales/copy-review/gate";
import { COPY_DECISION_REFUSAL_LABEL, COPY_SEND_LABEL } from "@/lib/sales/copy-review/labels";
import { buildCopyReviewView } from "@/lib/sales/copy-review/view";
import { QUALITY_REVIEW_DISABLED_TEXT } from "@/lib/sales/demo-version/admin-messages";
import { auditReviseChain, candidateOf, cleanRound0, fictionalRound0, type Round } from "../../support/copy-review-fixture";

// DEV-199b (Issue #258, 2/3): the copy review panel of a demo version and the owner's copy decision — the view built
// from the store's rows, the decision refusals (the database's rules plus the facts path and the re-run audit for an
// approval), the core submit (stale hashes refused, only sales_decide_copy_review, bound to the stored hashes), the
// server action's flag / admin order, and the panel's markup. Synthetic fixtures only.

const DEMO = "00000000-0000-4000-8000-0000000000d1";
const PROSPECT = "00000000-0000-4000-8000-0000000000c1";
const VERSION = "00000000-0000-4000-8000-0000000000a1";
const REVIEW = "00000000-0000-4000-8000-0000000000e1";
const FACTS = "f".repeat(64);
const empty = (): ShopCopyState => ({ reviews: [], decisions: [], factsChecks: [] });

function rowOf(r: Round, id = REVIEW, state = empty()): StoredCopyReview {
  const plan = planCopyAppend(state, candidateOf(r), new Set());
  if (!plan.ok) throw new Error(plan.codes.join(","));
  return { ...plan.row, id, demo_id: DEMO };
}

function ctx(o: { round?: Round; row?: StoredCopyReview; factsChecked?: boolean | string; extra?: Partial<ShopCopyState> } = {}): VersionCopyGateInput & { demoId: string } {
  const row = o.row ?? rowOf(o.round ?? cleanRound0());
  const checked = o.factsChecked ?? true;
  return {
    demoId: DEMO,
    versionId: VERSION,
    photoUrls: new Set(),
    versionFactsSha256: FACTS,
    pageHtmlSha256: row.page_html_sha256,
    pageCssSha256: row.page_css_sha256,
    linkedReviewId: row.id,
    state: {
      reviews: [row, ...(o.extra?.reviews ?? [])],
      decisions: o.extra?.decisions ?? [],
      factsChecks: checked ? [{ review_id: row.id, facts_sha256: row.facts_sha256, demo_facts_sha256: typeof checked === "string" ? checked : FACTS }] : [],
    },
  };
}

describe("the copy review view and the decision refusals (pure)", () => {
  it("no facts path (today): facts_from_facts_path false, every decision refused, the send gate's real reason", () => {
    const v = buildCopyReviewView(ctx({ factsChecked: false }));
    expect(v.review).toMatchObject({ id: REVIEW, round: 0, lane: "real_shop_proposal", copyVerdict: "approve_candidate", nextStep: "owner_review", factsFromFactsPath: false });
    expect(v.review!.gateBlockers).toEqual(["OWNER_APPROVAL_MISSING"]);
    expect(v.review!.findings.map((f) => f.code)).toEqual(["COPY_APPROVAL_MISSING"]);
    for (const d of ["approve", "revise", "reject"] as const) expect(v.refusals[d]).toEqual(["COPY_FACTS_NOT_FROM_FACTS_PATH"]);
    expect(v.sendBlock).toEqual({ code: "demo_copy_facts_not_from_facts_path", label: COPY_SEND_LABEL.demo_copy_facts_not_from_facts_path, details: [] });
  });

  it("checked on the version's facts, at owner review: every decision may be taken; the send waits for the owner", () => {
    const v = buildCopyReviewView(ctx());
    expect(v.refusals).toEqual({ approve: [], revise: [], reject: [] });
    expect(v.sendBlock?.code).toBe("demo_copy_owner_confirmation_missing");
    expect(v.review!.hashes.review).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a facts check on other facts refuses only the approval (the send gate would refuse it)", () => {
    const c = ctx({ factsChecked: "0".repeat(64) });
    expect(copyDecisionRefusals(c, "approve")).toEqual(["COPY_FACTS_STALE"]);
    expect(copyDecisionRefusals(c, "reject")).toEqual([]);
  });

  it("the fictional research lane, a review not at owner review, a superseded round, a recorded decision and the cap", () => {
    expect(copyDecisionRefusals(ctx({ round: fictionalRound0() }), "approve")).toContain("COPY_FICTIONAL_LANE");
    const [r0, r1] = auditReviseChain();
    const row0 = rowOf(r0);
    expect(copyDecisionRefusals(ctx({ row: row0 }), "reject")).toEqual(["COPY_NOT_AT_OWNER_REVIEW"]);
    const row1 = rowOf(r1, "00000000-0000-4000-8000-0000000000e2", { reviews: [row0], decisions: [], factsChecks: [] });
    const superseded = buildCopyReviewView(ctx({ row: row0, extra: { reviews: [row1] } }));
    expect(superseded.review!.superseded).toBe(true);
    expect(superseded.refusals.reject).toEqual(expect.arrayContaining(["COPY_REVIEW_SUPERSEDED"]));
    expect(superseded.sendBlock?.code).toBe("demo_copy_review_stale");
    // round 1 carries the revision findings (the owner's notes on what the revision changed)
    expect(buildCopyReviewView(ctx({ row: row1 })).review!.round).toBe(1);

    const row = rowOf(cleanRound0());
    const decided = ctx({ row, extra: { decisions: [{ id: "x", review_id: row.id, version_id: VERSION, decision: "reject", review_sha256: row.review_sha256, facts_sha256: row.facts_sha256, copy_sha256: row.copy_sha256, page_html_sha256: row.page_html_sha256, page_css_sha256: row.page_css_sha256 }] } });
    expect(copyDecisionRefusals(decided, "approve")).toEqual(["COPY_DECISION_EXISTS"]);
    expect(buildCopyReviewView(decided).decision).toEqual({ decision: "reject", forThisVersion: true });
    expect(copyDecisionRefusals(ctx({ row: { ...row, round: 2 } }), "revise")).toContain("COPY_REVISION_CAP");
  });

  it("an approval re-runs the audit on the stored bytes: a tampered stored review or page is refused", () => {
    const row = rowOf(cleanRound0());
    expect(copyDecisionRefusals(ctx({ row: { ...row, review_text: row.review_text.replace('"round": 0', '"round":0') } }), "approve")).toEqual(["COPY_SEND_BLOCKERS_REMAIN"]);
    expect(copyDecisionRefusals(ctx({ row: { ...row, page_html_text: `${row.page_html_text} ` } }), "approve")).toEqual(["COPY_SEND_BLOCKERS_REMAIN"]);
    expect(copyDecisionRefusals(ctx({ row: { ...row, gate_blockers: ["OWNER_APPROVAL_MISSING", "REVIEW_NOT_PASSED"] } }), "approve")).toEqual(["COPY_SEND_BLOCKERS_REMAIN"]);
    // the version's page is not the reviewed one
    expect(copyDecisionRefusals({ ...ctx({ row }), pageHtmlSha256: "9".repeat(64) }, "reject")).toEqual(["COPY_REVIEW_NOT_THIS_PAGE"]);
    expect(copyDecisionRefusals({ ...ctx({ row }), linkedReviewId: null }, "reject")).toEqual(["COPY_REVIEW_MISSING"]);
  });
});

// --- the core submit and the server action ---------------------------------------------------------------------------

const S = vi.hoisted(() => ({ admin: true, ctx: null as unknown, ctxCalls: 0, demoId: "00000000-0000-4000-8000-0000000000d1" as string | null, reads: 0 }));
const rpc = vi.fn(async () => ({ data: { decision_id: "d" }, error: null as null | { message: string } }));
function fakeClient() {
  return {
    rpc,
    from: () => {
      S.reads += 1;
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "order"]) b[m] = () => b;
      b.maybeSingle = async () => ({ data: S.demoId ? { id: S.demoId } : null, error: null });
      return b;
    },
  };
}
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", async (original) => ({ ...(await original<typeof import("next/navigation")>()), useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/admin/auth", () => ({
  requireAdmin: vi.fn(async () => {
    if (!S.admin) throw new Error("forbidden");
    return { userId: "u", email: null };
  }),
}));
vi.mock("@/lib/supabase/server", () => ({ createAuthClient: vi.fn(async () => fakeClient()) }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: vi.fn(() => fakeClient()) }));
vi.mock("@/lib/sales/copy-review/store", async (orig) => ({
  ...(await orig<typeof import("@/lib/sales/copy-review/store")>()),
  loadVersionCopyContext: vi.fn(async () => {
    S.ctxCalls += 1;
    if (!S.ctx) throw new Error("COPY_STORE_READ_FAILED");
    return S.ctx;
  }),
}));
const { submitCopyDecision, loadVersionCopyReview } = await import("@/lib/admin/demo-copy-review");
const { decideCopyReview } = await import("@/app/admin/sales/_actions/demo-versions");

const ENV = { SALES_DEMO_VERSIONS_ENABLED: "true", SALES_DEMO_QUALITY_REVIEW_ENABLED: "true" };
function inputFor(c: VersionCopyGateInput, over: Record<string, unknown> = {}) {
  const q = c.state.reviews.find((r) => r.id === c.linkedReviewId)!;
  return { prospectId: PROSPECT, versionId: VERSION, reviewId: q.id, decision: "approve", reviewSha256: q.review_sha256, factsSha256: q.facts_sha256, copySha256: q.copy_sha256, pageHtmlSha256: q.page_html_sha256, pageCssSha256: q.page_css_sha256, note: null, ...over };
}
const submit = (raw: unknown, env: Record<string, string | undefined> = ENV) => submitCopyDecision(raw, { env, client: fakeClient() as never });

beforeEach(() => {
  rpc.mockClear();
  S.admin = true;
  S.ctx = ctx();
  S.ctxCalls = 0;
  S.reads = 0;
  S.demoId = DEMO;
});
afterEach(() => vi.unstubAllEnvs());

describe("submitCopyDecision", () => {
  it("records through sales_decide_copy_review only, bound to the stored review id and its five hashes", async () => {
    const c = S.ctx as VersionCopyGateInput;
    const q = c.state.reviews[0]!;
    expect(await submit({ ...inputFor(c), note: "  見出しを確認しました  " })).toEqual({ ok: true, decision: "approve" });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("sales_decide_copy_review", {
      p_version_id: VERSION,
      p_review_id: q.id,
      p_decision: "approve",
      p_review_sha256: q.review_sha256,
      p_facts_sha256: q.facts_sha256,
      p_copy_sha256: q.copy_sha256,
      p_page_html_sha256: q.page_html_sha256,
      p_page_css_sha256: q.page_css_sha256,
      p_note: "見出しを確認しました",
    });
  });

  it("flag off (either flag): refused before anything is read or written", async () => {
    for (const env of [{}, { SALES_DEMO_VERSIONS_ENABLED: "true" }, { SALES_DEMO_QUALITY_REVIEW_ENABLED: "true" }]) {
      expect(await submit(inputFor(S.ctx as VersionCopyGateInput), env)).toEqual({ ok: false, error: QUALITY_REVIEW_DISABLED_TEXT });
    }
    expect(S.reads).toBe(0);
    expect(S.ctxCalls).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a stale screen (other review, any hash changed), another shop's version, a bad input or note: refused, no write", async () => {
    const c = S.ctx as VersionCopyGateInput;
    for (const k of ["reviewId", "reviewSha256", "factsSha256", "copySha256", "pageHtmlSha256", "pageCssSha256"]) {
      const r = await submit(inputFor(c, { [k]: k === "reviewId" ? "00000000-0000-4000-8000-0000000000e9" : "0".repeat(64) }));
      expect(r, k).toMatchObject({ ok: false, refusals: ["COPY_STALE_INPUT"] });
    }
    S.demoId = "00000000-0000-4000-8000-0000000000d9";
    expect((await submit(inputFor(c))).ok).toBe(false);
    S.demoId = DEMO;
    expect((await submit(inputFor(c, { decision: "accept" }))).ok).toBe(false);
    expect((await submit(inputFor(c, { note: "https://example.com を見て" }))).ok).toBe(false);
    S.ctx = null;
    expect(await submit(inputFor(c))).toMatchObject({ ok: false, refusals: ["COPY_REVIEW_UNREADABLE"] });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("the server's refusals come before the database (no facts path: every decision refused)", async () => {
    S.ctx = ctx({ factsChecked: false });
    for (const decision of ["approve", "revise", "reject"]) {
      const r = await submit(inputFor(S.ctx as VersionCopyGateInput, { decision }));
      expect(r).toEqual({ ok: false, error: COPY_DECISION_REFUSAL_LABEL.COPY_FACTS_NOT_FROM_FACTS_PATH, refusals: ["COPY_FACTS_NOT_FROM_FACTS_PATH"] });
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a database refusal is shown in the owner's words, never the raw message", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "copy_decision_exists" } } as never);
    expect(await submit(inputFor(S.ctx as VersionCopyGateInput))).toEqual({ ok: false, error: COPY_DECISION_REFUSAL_LABEL.COPY_DECISION_EXISTS });
    rpc.mockResolvedValueOnce({ data: null, error: { message: "internal: secret detail" } } as never);
    expect(await submit(inputFor(S.ctx as VersionCopyGateInput))).toEqual({ ok: false, error: "記録できませんでした。画面を再読み込みしてください。" });
  });

  it("the panel loader: a store read failure is an error state, never an empty review", async () => {
    S.ctx = null;
    expect(await loadVersionCopyReview(fakeClient() as never, VERSION)).toEqual({ kind: "error" });
    S.ctx = ctx();
    expect((await loadVersionCopyReview(fakeClient() as never, VERSION)).kind).toBe("ok");
  });
});

describe("decideCopyReview (server action)", () => {
  it("flag off: refused before the admin check, nothing read or written", async () => {
    vi.stubEnv("SALES_DEMO_VERSIONS_ENABLED", "true");
    vi.stubEnv("SALES_DEMO_QUALITY_REVIEW_ENABLED", "false");
    S.admin = false; // would throw if it got that far
    expect(await decideCopyReview(inputFor(S.ctx as VersionCopyGateInput))).toEqual({ ok: false, error: QUALITY_REVIEW_DISABLED_TEXT });
    expect(S.ctxCalls).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("a non-admin is refused (requireAdmin throws), nothing written", async () => {
    vi.stubEnv("SALES_DEMO_VERSIONS_ENABLED", "true");
    vi.stubEnv("SALES_DEMO_QUALITY_REVIEW_ENABLED", "true");
    S.admin = false;
    await expect(decideCopyReview(inputFor(S.ctx as VersionCopyGateInput))).rejects.toThrow("forbidden");
    expect(S.ctxCalls).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("both flags and an admin: recorded", async () => {
    vi.stubEnv("SALES_DEMO_VERSIONS_ENABLED", "true");
    vi.stubEnv("SALES_DEMO_QUALITY_REVIEW_ENABLED", "true");
    expect(await decideCopyReview(inputFor(S.ctx as VersionCopyGateInput, { decision: "reject" }))).toEqual({ ok: true, decision: "reject" });
  });
});

describe("the copy review panel", () => {
  const html = (decisionEnabled: boolean, c = ctx({ factsChecked: false })) =>
    renderToStaticMarkup(<CopyReviewPanel data={{ kind: "ok", view: buildCopyReviewView(c) }} prospectId={PROSPECT} versionId={VERSION} versionNo={3} decisionEnabled={decisionEnabled} />);
  it("shows the verdict, step, facts-path state, gate blockers and the send gate's reason; no form without the write flag", () => {
    const h = html(false);
    expect(h).toContain('data-copy-review="present"');
    expect(h).toContain('data-copy-verdict="approve_candidate"');
    expect(h).toContain('data-facts-from-facts-path="false"');
    expect(h).toContain('data-copy-send-block="demo_copy_facts_not_from_facts_path"');
    expect(h).toContain('data-copy-finding="COPY_APPROVAL_MISSING"');
    expect(h).not.toContain("data-copy-decision-form");
  });
  it("with the write flag: the form, each refused decision disabled with its reason; nothing pre-selected", () => {
    const h = html(true);
    expect(h).toContain("data-copy-decision-form");
    expect((h.match(/data-copy-decision-refused/g) ?? []).length).toBe(3);
    expect((h.match(/disabled=""/g) ?? []).length).toBeGreaterThanOrEqual(4); // three radios and the submit
    expect(h).not.toContain("checked");
    const ok = html(true, ctx());
    expect(ok).not.toContain("data-copy-decision-refused");
  });
  it("no review, and the error state", () => {
    expect(html(true, { ...ctx(), linkedReviewId: null })).toContain('data-copy-review="none"');
    expect(renderToStaticMarkup(<CopyReviewPanel data={{ kind: "error" }} prospectId={PROSPECT} versionId={VERSION} versionNo={3} decisionEnabled />)).toContain('data-copy-review="error"');
  });
});

// DEV-263a (PR #264 review Low): one note limit — the database's (sales_demo_note_valid / normaliseNote) — for the
// input schema and the form
describe("the copy decision note limit", () => {
  it("the input schema and the form take the database's limit", async () => {
    const { CopyDecisionInput } = await import("@/lib/admin/demo-copy-review");
    const { NOTE_MAX_CHARS, normaliseNote } = await import("@/lib/sales/demo-version/review-client");
    expect(NOTE_MAX_CHARS).toBe(500);
    const base = { prospectId: PROSPECT, versionId: VERSION, reviewId: VERSION, decision: "approve", reviewSha256: "a".repeat(64), factsSha256: "a".repeat(64), copySha256: "a".repeat(64), pageHtmlSha256: "a".repeat(64), pageCssSha256: "a".repeat(64) };
    expect(CopyDecisionInput.safeParse({ ...base, note: "あ".repeat(500) }).success).toBe(true);
    expect(normaliseNote("あ".repeat(500)).ok).toBe(true);
    expect(CopyDecisionInput.safeParse({ ...base, note: "あ".repeat(501) }).success).toBe(false);
    expect(normaliseNote("あ".repeat(501)).ok).toBe(false);
    const { readFileSync } = await import("node:fs");
    const form = readFileSync("components/admin/demo/CopyDecisionForm.tsx", "utf8");
    expect(form).toContain("maxLength={NOTE_MAX_CHARS}");
    expect(form).not.toMatch(/maxLength=\{\d+\}/);
  });
});
