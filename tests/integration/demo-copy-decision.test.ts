import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadVersionCopyReview, submitCopyDecision } from "@/lib/admin/demo-copy-review";
import { importPackage, type PackageStore } from "@/lib/demo-version-package/import";
import { buildPackage, type DemoVersionPackage } from "@/lib/demo-version-package/package";
import { auditReviseChain, cleanRound0, json, type Round } from "../support/copy-review-fixture";
import { candidate, createUser, db, makeAdmin, resetSalesData, rpc, serviceClient, signedInClient, verifiedRun } from "./helpers";

// DEV-199b (Issue #258, 2/3): the owner's copy decision through the server's core (lib/admin/demo-copy-review.ts) on the
// LOCAL stack, as a signed-in admin (RLS reads, sales_decide_copy_review as auth.uid()). The made-up real-shop sample
// only; no network, no model, no real send. The facts path is a test stand-in (trustedFactsPack): none exists in the app.

const COPY_TABLES = ["sales_demo_copy_reviews", "sales_demo_copy_facts_checks", "sales_demo_version_copy_links", "sales_demo_copy_owner_decisions"];
const ENV = { SALES_DEMO_VERSIONS_ENABLED: "true", SALES_DEMO_QUALITY_REVIEW_ENABLED: "true" };

let admin: SupabaseClient;
let outsider: SupabaseClient;
let adminId: string;

async function shop() {
  const runId = randomUUID();
  await verifiedRun(runId, { c01: candidate() });
  await rpc("sales_run_begin_persist", { p_run_id: runId });
  const r = await rpc<{ prospect_id: string }>("sales_persist_candidate", { p_run_id: runId, p_key: "c01" });
  await rpc("sales_run_finalize", { p_run_id: runId });
  const { rows } = await db.query("select id from public.sales_demos where prospect_id = $1", [r.prospect_id]);
  return { prospectId: r.prospect_id, demoId: rows[0].id as string };
}
type Shop = Awaited<ReturnType<typeof shop>>;

const memoryStore = (): PackageStore => {
  const objects = new Map<string, Uint8Array>();
  return { download: async (k) => objects.get(k) ?? null, upload: async (k, b) => void objects.set(k, b) };
};
const png = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: { r: Math.floor(Math.random() * 255), g: 9, b: 9 } } }).png().toBuffer();

async function pkgOf(r: Round): Promise<DemoVersionPackage> {
  return buildPackage({
    html: String(r.files.pageHtml),
    css: String(r.files.pageCss),
    renders: { desktop_1440: new Uint8Array(await png(1440, 900)), mobile_390: new Uint8Array(await png(390, 900)) },
    source: "test",
    copy: { factsPack: r.files.factsPack, copyRecord: r.files.copyRecord, review: json(r.review), rounds: [] },
  });
}

async function imported(s: Shop, r: Round, trusted: boolean) {
  const res = await importPackage(await pkgOf(r), { client: serviceClient(), store: memoryStore(), demoId: s.demoId, trustedFactsPack: trusted ? r.files.factsPack : null });
  return { versionId: res.versionId, reviewId: res.storedCopy!.review_id };
}

async function inputFor(s: Shop, versionId: string, reviewId: string, decision: string, over: Record<string, unknown> = {}) {
  const q = (await db.query("select * from public.sales_demo_copy_reviews where id = $1", [reviewId])).rows[0];
  return { prospectId: s.prospectId, versionId, reviewId, decision, reviewSha256: q.review_sha256, factsSha256: q.facts_sha256, copySha256: q.copy_sha256, pageHtmlSha256: q.page_html_sha256, pageCssSha256: q.page_css_sha256, note: null, ...over };
}

const decisions = async (reviewId: string) => (await db.query("select * from public.sales_demo_copy_owner_decisions where review_id = $1", [reviewId])).rows;

beforeAll(async () => {
  await resetSalesData();
  adminId = await createUser("copy-decision-admin@test.example.com");
  await makeAdmin(adminId);
  await createUser("copy-decision-outsider@test.example.com");
  admin = await signedInClient("copy-decision-admin@test.example.com");
  outsider = await signedInClient("copy-decision-outsider@test.example.com");
});
beforeEach(async () => {
  await db.query(
    `truncate ${COPY_TABLES.map((t) => `public.${t}`).join(", ")}, public.sales_demo_quality_reviews, public.sales_demo_version_files, public.sales_demo_versions, public.sales_demo_images, public.sales_exclusions, public.sales_outreach_approvals, public.sales_outreach_draft_edits, public.sales_prospect_insights, public.sales_outreaches, public.sales_demos, public.sales_sources, public.sales_prospects, public.sales_agent_runs cascade`,
  );
});
afterAll(resetSalesData);

describe("the copy review panel and the owner's decision (admin session, local stack)", () => {
  it("no facts path: the panel says so and every decision is refused by the server before the database", async () => {
    const s = await shop();
    const { versionId, reviewId } = await imported(s, cleanRound0(), false);
    const panel = await loadVersionCopyReview(admin as never, versionId);
    expect(panel.kind).toBe("ok");
    if (panel.kind !== "ok") return;
    expect(panel.view.review).toMatchObject({ id: reviewId, round: 0, copyVerdict: "approve_candidate", nextStep: "owner_review", factsFromFactsPath: false, gateBlockers: ["OWNER_APPROVAL_MISSING"] });
    expect(panel.view.sendBlock?.code).toBe("demo_copy_facts_not_from_facts_path");
    for (const d of ["approve", "revise", "reject"]) {
      expect(await submitCopyDecision(await inputFor(s, versionId, reviewId, d), { env: ENV, client: admin as never })).toMatchObject({ ok: false, refusals: ["COPY_FACTS_NOT_FROM_FACTS_PATH"] });
    }
    expect(await decisions(reviewId)).toEqual([]);
  });

  it("with the facts path stand-in: the approval is recorded as the admin, bound to the review and its hashes; a second one is refused", async () => {
    const s = await shop();
    const { versionId, reviewId } = await imported(s, cleanRound0(), true);
    const input = await inputFor(s, versionId, reviewId, "approve", { note: "見出しと事実を確認しました" });
    expect(await submitCopyDecision(input, { env: ENV, client: admin as never })).toEqual({ ok: true, decision: "approve" });
    const [row] = await decisions(reviewId);
    expect(row).toMatchObject({ version_id: versionId, decision: "approve", decided_by: adminId, review_sha256: input.reviewSha256, facts_sha256: input.factsSha256, copy_sha256: input.copySha256, page_html_sha256: input.pageHtmlSha256, page_css_sha256: input.pageCssSha256, note: "見出しと事実を確認しました" });
    const panel = await loadVersionCopyReview(admin as never, versionId);
    expect(panel.kind === "ok" && panel.view.decision).toEqual({ decision: "approve", forThisVersion: true });
    expect(panel.kind === "ok" && panel.view.sendBlock).toBeNull();
    expect(await submitCopyDecision(await inputFor(s, versionId, reviewId, "reject"), { env: ENV, client: admin as never })).toMatchObject({ ok: false, refusals: ["COPY_DECISION_EXISTS"] });
    expect(await decisions(reviewId)).toHaveLength(1);
  });

  it("a stale screen (hash changed) is refused; a review not at owner review is refused; nothing recorded", async () => {
    const s = await shop();
    const { versionId, reviewId } = await imported(s, cleanRound0(), true);
    expect(await submitCopyDecision(await inputFor(s, versionId, reviewId, "approve", { copySha256: "0".repeat(64) }), { env: ENV, client: admin as never })).toMatchObject({ ok: false, refusals: ["COPY_STALE_INPUT"] });
    const s2 = await shop();
    const [r0] = auditReviseChain();
    const rev = await imported(s2, r0, true);
    expect(await submitCopyDecision(await inputFor(s2, rev.versionId, rev.reviewId, "reject"), { env: ENV, client: admin as never })).toMatchObject({ ok: false, refusals: ["COPY_NOT_AT_OWNER_REVIEW"] });
    expect(await decisions(reviewId)).toEqual([]);
    expect(await decisions(rev.reviewId)).toEqual([]);
  });

  it("a version of another shop is refused; a non-admin session reads nothing and cannot record; the flag off reads nothing", async () => {
    const s = await shop();
    const other = await shop();
    const { versionId, reviewId } = await imported(s, cleanRound0(), true);
    expect((await submitCopyDecision({ ...(await inputFor(s, versionId, reviewId, "approve")), prospectId: other.prospectId }, { env: ENV, client: admin as never })).ok).toBe(false);
    expect(await loadVersionCopyReview(outsider as never, versionId)).toEqual({ kind: "error" });
    expect((await submitCopyDecision(await inputFor(s, versionId, reviewId, "approve"), { env: ENV, client: outsider as never })).ok).toBe(false);
    expect((await submitCopyDecision(await inputFor(s, versionId, reviewId, "approve"), { env: { SALES_DEMO_VERSIONS_ENABLED: "true" }, client: admin as never })).ok).toBe(false);
    // the database refuses an outsider on its own too
    const q = (await db.query("select * from public.sales_demo_copy_reviews where id = $1", [reviewId])).rows[0];
    const direct = await outsider.rpc("sales_decide_copy_review", { p_version_id: versionId, p_review_id: reviewId, p_decision: "approve", p_review_sha256: q.review_sha256, p_facts_sha256: q.facts_sha256, p_copy_sha256: q.copy_sha256, p_page_html_sha256: q.page_html_sha256, p_page_css_sha256: q.page_css_sha256, p_note: null });
    expect(direct.error).not.toBeNull();
    expect(await decisions(reviewId)).toEqual([]);
  });
});
