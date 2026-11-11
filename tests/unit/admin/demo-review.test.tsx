import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import QualityReviewForm, { type ReviewVersion } from "@/components/admin/demo/QualityReviewForm";
import ReviewHistory, { invalidatedText } from "@/components/admin/demo/ReviewHistory";
import {
  AI_CONCEPT_BADGE,
  APPROVAL_STOPS_SENDING_BEFORE,
  INVALID_NOTE_MESSAGE,
  NO_IMPERSONATION_STATEMENT,
  REVIEW_REFUSAL_LABEL,
  SEND_STOP_ACKNOWLEDGEMENT,
} from "@/lib/sales/demo-version/admin-messages";
import { EMPHASISED_ITEMS, QUALITY_CHECKLIST_ITEMS } from "@/lib/sales/demo-version/quality";
import { REVIEW_EMPHASISED, REVIEW_ITEMS } from "@/lib/sales/demo-version/review-client";
import { checkReview, normaliseNote, ReviewInput, type ReviewRefusal } from "@/lib/sales/demo-version/review-input";
import { buildDemoVersionsView, type DemoImageDb, type VersionFileDb, type VersionRowDb } from "@/lib/sales/demo-version/view-model";

// DEV-196d-5: the quality decision — the input's shape, the server's re-check against the version as re-derived from
// the database, the core submit (through the RPC only), the server action's flag / admin order, and the form's
// markup (nothing starts checked, approve disabled).

const NOW = new Date("2026-11-11T03:00:00Z");
const DEMO = "00000000-0000-4000-8000-0000000000d1";
const PROSPECT = "00000000-0000-4000-8000-0000000000c1";
const IMG = "00000000-0000-4000-8000-000000000501";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const h = (c: string) => c.repeat(64);
const FACTS = h("f");
const ALL_OK = Object.fromEntries(QUALITY_CHECKLIST_ITEMS.map((k) => [k, "ok"])) as Record<(typeof QUALITY_CHECKLIST_ITEMS)[number], "ok" | "ng">;

const version = (over: Partial<VersionRowDb> = {}): VersionRowDb => ({
  id: id(1), demo_id: DEMO, version_no: 1, parent_version_id: null, origin: "manual_import", worker_commit: "abcdef1", facts_sha256: FACTS,
  bundle_sha256: h("1"), status: "draft", validator_result: { ok: true, codes: [] }, structure_descriptor: null, rights_summary: null,
  expires_at: "2027-01-01T00:00:00Z", revoked_at: null, revoke_code: null, created_at: "2026-11-10T00:00:00Z", ...over,
});
const files = (ai = false): VersionFileDb[] => [
  { version_id: id(1), path: "page/index.html", role: "html", sha256: h("2"), bytes: 10, content_type: "text/html", width: null, height: null, image_id: null },
  { version_id: id(1), path: "page/style.css", role: "css", sha256: h("3"), bytes: 10, content_type: "text/css", width: null, height: null, image_id: null },
  { version_id: id(1), path: "renders/desktop_1440.webp", role: "render", sha256: h("a"), bytes: 10, content_type: "image/webp", width: 1440, height: 4000, image_id: null },
  { version_id: id(1), path: "renders/mobile_390.webp", role: "render", sha256: h("b"), bytes: 10, content_type: "image/webp", width: 390, height: 4000, image_id: null },
  ...(ai ? [{ version_id: id(1), path: "page/photos/hero-desktop.webp", role: "photo", sha256: h("c"), bytes: 10, content_type: "image/webp", width: 10, height: 10, image_id: IMG }] : []),
];
const aiImage = (over: Partial<DemoImageDb> = {}): DemoImageDb => ({
  id: IMG, sha256: h("c"), width: 10, height: 10, format: "webp", source_kind: "ai_concept_internal", rights_status: "ai_concept_internal",
  depicts_real_shop: false, depicts_identifiable_person: false, depicts_real_product: false, depicts_real_interior: false, depicts_real_equipment: false,
  no_factual_impersonation_confirmed_at: "2026-11-10T00:00:00Z", rights_expiry: null, provenance: null, revoked_at: null, ...over,
});
const viewOf = (o: { ai?: boolean; images?: DemoImageDb[]; facts?: string | null; v?: Partial<VersionRowDb>; openSend?: boolean } = {}) =>
  buildDemoVersionsView({
    versions: [version(o.v)],
    files: files(o.ai),
    images: o.images ?? (o.ai ? [aiImage()] : []),
    reviews: [],
    approvals: o.openSend ? [{ id: id(800), outreach_id: id(801), state: "send_opened", demo_version_id: null }] : [],
    approvedVersionId: null,
    demoDisabled: false,
    currentFactsSha256: o.facts === undefined ? FACTS : o.facts,
    now: NOW,
  }).versions[0]!;

const input = (over: Partial<ReviewInput> = {}): ReviewInput => ({
  prospectId: PROSPECT,
  versionId: id(1),
  decision: "approved",
  checklist: ALL_OK,
  viewedRenders: { desktop_1440: h("a"), mobile_390: h("b") },
  bundleSha256: h("1"),
  impersonation: [],
  acknowledgedSendStop: true,
  note: null,
  ...over,
});

describe("ReviewInput: the shape the server accepts", () => {
  it("needs every one of the 7 answers (no default), known keys only, and well-formed ids and hashes", () => {
    expect(ReviewInput.safeParse(input()).success).toBe(true);
    const { not_a_copy: _drop, ...six } = ALL_OK;
    for (const bad of [
      { checklist: six },
      { checklist: { ...ALL_OK, extra: "ok" } },
      { checklist: { ...ALL_OK, not_a_copy: "yes" } },
      { viewedRenders: { desktop_1440: "short" } },
      { viewedRenders: { watch_200: h("a") } },
      { versionId: "x" },
      { decision: "maybe" },
      { impersonation: [{ imageId: IMG }] },
      { acknowledgedSendStop: "yes" },
    ]) expect(ReviewInput.safeParse({ ...input(), ...bad }).success, JSON.stringify(bad)).toBe(false);
    expect(ReviewInput.safeParse({ ...input(), stray: 1 }).success).toBe(false);
  });
});

describe("review-client: the browser's copy of the checklist", () => {
  it("is exactly quality.ts's order and emphasis, and imports nothing (safe for the client bundle)", async () => {
    expect([...REVIEW_ITEMS]).toEqual([...QUALITY_CHECKLIST_ITEMS]);
    expect([...REVIEW_EMPHASISED]).toEqual([...EMPHASISED_ITEMS]);
    const src = (await import("node:fs")).readFileSync("lib/sales/demo-version/review-client.ts", "utf8");
    expect(src).not.toMatch(/^import /m);
    const form = (await import("node:fs")).readFileSync("components/admin/demo/QualityReviewForm.tsx", "utf8");
    // the client form never imports a module that pulls in node built-ins
    expect(form).not.toMatch(/^import (?!type )[^;]*demo-version\/(quality|manifest|review-input|view-model)"/m);
  });
});

describe("normaliseNote (Low a)", () => {
  it("trims, empties to null, refuses file / domain-like words, URLs, email addresses and > 500 characters", () => {
    expect(normaliseNote("  直してください  ")).toEqual({ ok: true, note: "直してください" });
    expect(normaliseNote("   ")).toEqual({ ok: true, note: null });
    expect(normaliseNote(null)).toEqual({ ok: true, note: null });
    for (const bad of ["style.css", "example.com を参考", "https://x", "www.x", "info@example.com", "ｓｔｙｌｅ．ｃｓｓ", "あ".repeat(501)]) expect(normaliseNote(bad).ok, bad).toBe(false);
    for (const good of ["ver 1.0", "1.5倍", "CSS の調整", "あ".repeat(500)]) expect(normaliseNote(good).ok, good).toBe(true);
    expect(REVIEW_REFUSAL_LABEL.INVALID_NOTE).toBe(INVALID_NOTE_MESSAGE);
  });
});

describe("checkReview: the server's re-check against the version as the database shows it now", () => {
  const refusals = (i: Partial<ReviewInput>, v = viewOf()) => checkReview(input(i), v);
  it("a complete approval passes; a change request with an ng passes", () => {
    expect(refusals({})).toEqual([]);
    expect(refusals({ decision: "changes_requested", checklist: { ...ALL_OK, not_a_copy: "ng" }, viewedRenders: {}, acknowledgedSendStop: false })).toEqual([]);
    expect(refusals({ decision: "rejected", checklist: { ...ALL_OK, identity_lock: "ng" }, viewedRenders: {} })).toEqual([]);
  });
  it("refuses: unknown version, stale bundle, blockers, ng on approve, all ok on a send-back, renders not viewed or not this version's, no acknowledgement, bad note", () => {
    const cases: Array<[Partial<ReviewInput>, ReviewRefusal, ReturnType<typeof viewOf>?]> = [
      [{ bundleSha256: h("9") }, "STALE"],
      [{}, "BLOCKED", viewOf({ facts: null })], // facts unknown blocks approving
      [{}, "BLOCKED", viewOf({ openSend: true })],
      [{}, "BLOCKED", viewOf({ v: { status: "approved" } })],
      [{ checklist: { ...ALL_OK, photos_truthful: "ng" } }, "CHECKLIST_HAS_NG"],
      [{ decision: "changes_requested" }, "DECISION_NEEDS_NG"],
      [{ viewedRenders: { desktop_1440: h("a") } }, "RENDER_NOT_VIEWED"],
      [{ viewedRenders: { desktop_1440: h("a"), mobile_390: h("e") } }, "RENDER_NOT_VIEWED"],
      [{ decision: "rejected", checklist: { ...ALL_OK, identity_lock: "ng" }, viewedRenders: { tablet_768: h("e") } }, "RENDER_NOT_VIEWED"],
      [{ acknowledgedSendStop: false }, "SEND_STOP_NOT_ACKNOWLEDGED"],
      [{ note: "style.css" }, "INVALID_NOTE"],
    ];
    for (const [i, code, v] of cases) expect(refusals(i, v), `${code} ${JSON.stringify(i)}`).toContain(code);
    expect(checkReview(input(), undefined)).toEqual(["VERSION_NOT_FOUND"]);
  });
  it("AI concept images: each one by id AND current sha256, nothing missing, nothing extra, no duplicates", () => {
    const v = viewOf({ ai: true });
    expect(checkReview(input(), v)).toEqual(["IMPERSONATION_NOT_CONFIRMED"]);
    expect(checkReview(input({ impersonation: [{ imageId: IMG, sha256: h("c") }] }), v)).toEqual([]);
    expect(checkReview(input({ impersonation: [{ imageId: IMG, sha256: h("d") }] }), v)).toEqual(expect.arrayContaining(["IMPERSONATION_UNKNOWN_IMAGE", "IMPERSONATION_NOT_CONFIRMED"]));
    expect(checkReview(input({ impersonation: [{ imageId: IMG, sha256: h("c") }, { imageId: IMG, sha256: h("c") }] }), v)).toContain("IMPERSONATION_UNKNOWN_IMAGE");
    expect(checkReview(input({ impersonation: [{ imageId: IMG, sha256: h("c") }, { imageId: id(999), sha256: h("c") }] }), v)).toContain("IMPERSONATION_UNKNOWN_IMAGE");
    // unknown / revoked rights: the image is not usable and the version is blocked for every decision
    for (const over of [{ rights_status: "unknown" }, { revoked_at: "2026-11-10T00:00:00Z", rights_status: "revoked" }]) {
      const blocked = viewOf({ ai: true, images: [aiImage(over)] });
      expect(checkReview(input({ impersonation: [{ imageId: IMG, sha256: h("c") }] }), blocked)).toContain("BLOCKED");
      expect(checkReview(input({ decision: "rejected", checklist: { ...ALL_OK, identity_lock: "ng" }, viewedRenders: {} }), blocked)).toContain("BLOCKED");
    }
  });
});

// --- the core submit and the server action --------------------------------------------------------------------------

const rpc = vi.fn(async (_fn: string, _args: Record<string, unknown>) => ({ data: { review_id: id(700), status: "approved", replayed: false }, error: null as { message: string } | null }));
const queries: string[] = [];
function fakeClient(over: Record<string, { data: unknown; error?: { message: string } | null }> = {}, ai = false) {
  const tables: Record<string, { data: unknown; error?: { message: string } | null }> = {
    sales_prospects: { data: { id: PROSPECT, name: "架空の店" } },
    sales_demos: { data: { id: DEMO, template: "bakery_v1", content: {}, disabled_at: null, approved_version_id: null } },
    sales_demo_versions: { data: [version()] },
    sales_demo_version_files: { data: files(ai) },
    sales_demo_images: { data: ai ? [aiImage()] : [] },
    sales_demo_quality_reviews: { data: [] },
    sales_outreach_approvals: { data: [] },
    ...over,
  };
  return {
    rpc,
    from(t: string) {
      queries.push(t);
      const res = tables[t] ?? { data: [] };
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "order", "limit"]) b[m] = () => b;
      b.maybeSingle = async () => ({ data: res.data, error: res.error ?? null });
      b.then = (ok: (v: unknown) => unknown) => ok({ data: res.data, error: res.error ?? null });
      return b;
    },
  };
}

const auth = vi.hoisted(() => ({ admin: true }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", async (original) => ({ ...(await original<typeof import("next/navigation")>()), useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/admin/auth", () => ({
  requireAdmin: vi.fn(async () => {
    if (!auth.admin) throw new Error("forbidden");
    return { userId: "u", email: null };
  }),
}));
vi.mock("@/lib/supabase/server", () => ({ createAuthClient: vi.fn(async () => fakeClient()) }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: vi.fn(() => fakeClient()) }));
const { submitDemoReview } = await import("@/lib/admin/demo-review");
const { reviewDemoVersion } = await import("@/app/admin/sales/_actions/demo-versions");

const KEY = Buffer.alloc(32, 7).toString("base64");
const ENV = { SALES_DEMO_VERSIONS_ENABLED: "true", SALES_DEMO_VIEW_SIGNING_KEY: KEY };
const submit = (raw: unknown, env: Record<string, string | undefined> = ENV, client = fakeClient()) =>
  submitDemoReview(raw, { env, now: NOW, client: client as never, factsSha256: async () => FACTS });

beforeEach(() => {
  rpc.mockClear();
  queries.length = 0;
  auth.admin = true;
});
afterEach(() => vi.unstubAllEnvs());

describe("submitDemoReview", () => {
  it("writes only through sales_review_demo_version, with exactly the checked values", async () => {
    expect(await submit({ ...input(), note: "  良い構成  " })).toEqual({ ok: true, decision: "approved", replayed: false });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("sales_review_demo_version", {
      p_version_id: id(1),
      p_decision: "approved",
      p_checklist: ALL_OK,
      p_viewed_renders: { desktop_1440: h("a"), mobile_390: h("b") },
      p_bundle_sha256: h("1"),
      p_note: "良い構成",
    });
  });
  it("flag off: refused before anything is read or written", async () => {
    const r = await submit(input(), { ...ENV, SALES_DEMO_VERSIONS_ENABLED: undefined });
    expect(r.ok).toBe(false);
    expect(queries).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("a malformed input, a refused re-check or a missing shop: refused, the RPC is never called", async () => {
    expect((await submit({ ...input(), checklist: {} })).ok).toBe(false);
    expect((await submit(input({ bundleSha256: h("9") }))).ok).toBe(false);
    expect((await submit(input(), ENV, fakeClient({ sales_prospects: { data: null } }))).ok).toBe(false);
    expect((await submit(input(), ENV, fakeClient({}, true))).ok).toBe(false); // AI image not confirmed
    expect(rpc).not.toHaveBeenCalled();
  });
  it("a database refusal is shown in the owner's words (never the raw message)", async () => {
    rpc.mockResolvedValueOnce({ data: null as never, error: { message: "invalid_note" } });
    expect(await submit(input())).toEqual({ ok: false, error: INVALID_NOTE_MESSAGE });
    rpc.mockResolvedValueOnce({ data: null as never, error: { message: "some internal detail: secret" } });
    expect(await submit(input())).toEqual({ ok: false, error: "記録できませんでした。画面を再読み込みしてください。" });
  });
});

describe("reviewDemoVersion (server action)", () => {
  it("flag off: refused before the admin check, nothing written", async () => {
    vi.stubEnv("SALES_DEMO_VERSIONS_ENABLED", "false");
    auth.admin = false; // would throw if it got that far
    expect((await reviewDemoVersion(input())).ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("a non-admin is refused (requireAdmin throws), nothing written", async () => {
    vi.stubEnv("SALES_DEMO_VERSIONS_ENABLED", "true");
    vi.stubEnv("SALES_DEMO_VIEW_SIGNING_KEY", KEY);
    auth.admin = false;
    await expect(reviewDemoVersion(input())).rejects.toThrow("forbidden");
    expect(rpc).not.toHaveBeenCalled();
  });
});

// --- the form and the history ----------------------------------------------------------------------------------------

const reviewVersion = (over: Partial<ReviewVersion> = {}): ReviewVersion => ({
  id: id(1), versionNo: 1, bundleSha256: h("1"), renders: [{ viewport: "desktop_1440", sha256: h("a") }, { viewport: "mobile_390", sha256: h("b") }],
  approveBlockers: [], reviewBlockers: [], aiImages: [], ...over,
});

describe("QualityReviewForm (markup)", () => {
  it("nothing starts checked; 品質承認・修正を依頼・却下 start disabled; items 3・4・5 are emphasised with their hints", () => {
    const html = renderToStaticMarkup(<QualityReviewForm prospectId={PROSPECT} version={reviewVersion()} viewed={new Set()} />);
    expect(html.match(/type="radio"/g)).toHaveLength(14);
    expect(html).not.toMatch(/type="radio"[^>]*checked/);
    expect(html).not.toMatch(/type="checkbox"[^>]*checked/);
    for (const name of ["品質承認", "修正を依頼", "却下"]) expect(html).toMatch(new RegExp(`<button[^>]*disabled=""[^>]*>${name}</button>`));
    for (const k of ["shop_specific_structure", "no_generic_lp_regression", "full_page_information"]) expect(html).toMatch(new RegExp(`class="[^"]*itemEmph[^"]*" data-item="${k}"`));
    expect(html).toContain("店名を別の店に入れ替えても成り立つなら");
    expect(html).toContain(APPROVAL_STOPS_SENDING_BEFORE);
    expect(html).toContain(SEND_STOP_ACKNOWLEDGEMENT);
    expect(html).toContain("7項目 0/7・PC–・SP–");
    expect(html).toContain("7 項目のうち 7 項目が未回答です。");
  });
  it("each AI concept image gets its own unchecked confirmation with the fixed statement and the red badge", () => {
    const html = renderToStaticMarkup(
      <QualityReviewForm prospectId={PROSPECT} version={reviewVersion({ aiImages: [{ imageId: IMG, sha256: h("c"), path: "page/photos/hero-desktop.webp", thumbSrc: "/demo-frame/a/T/photos/hero-desktop.webp" }] })} viewed={new Set(["desktop_1440", "mobile_390"])} />,
    );
    expect(html).toContain(`data-confirm-image="${IMG}"`);
    expect(html).toContain(NO_IMPERSONATION_STATEMENT);
    expect(html).toContain(AI_CONCEPT_BADGE);
    expect(html).toContain("画像 0/1");
    expect(html).toContain("PC✓・SP✓");
  });
  it("blockers are listed as reasons the approval is not offered", () => {
    const html = renderToStaticMarkup(<QualityReviewForm prospectId={PROSPECT} version={reviewVersion({ approveBlockers: ["FACTS_UNKNOWN"] })} viewed={new Set()} />);
    expect(html).toContain("店舗の事実が今どうなっているかを確認できませんでした");
  });
});

describe("ReviewHistory", () => {
  it("decision, state and an invalidation reason only through their fixed labels; an unknown code is never shown raw", () => {
    expect(invalidatedText("facts_changed")).toBe("店舗の事実が変わったため");
    expect(invalidatedText("<script>raw text</script>")).toBe("理由を表示できません");
    expect(invalidatedText(null)).toBeNull();
    const html = renderToStaticMarkup(
      <ReviewHistory
        reviews={[
          { id: id(1), decision: "approved", state: "invalidated", reviewedAt: "2026-11-10T00:00:00Z", invalidatedReason: "free text from a row", checklist: {} },
          { id: id(2), decision: "changes_requested", state: "active", reviewedAt: "2026-11-09T00:00:00Z", invalidatedReason: null, checklist: {} },
        ]}
      />,
    );
    expect(html).not.toContain("free text from a row");
    expect(html).toContain("理由を表示できません");
    expect(html).toContain("修正を依頼");
  });
});
