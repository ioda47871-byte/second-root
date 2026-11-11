import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DemoSendStopNotice, DemoVersionBadge } from "@/components/admin/DemoVersionBadge";
import TodayCard from "@/components/admin/TodayCard";
import type { TodayDemoVersion } from "@/lib/admin/demo-version-badges";
import type { TodayItem } from "@/lib/admin/today";
import { DEMO_VERSION_BADGE_LABEL, DEMO_VERSION_BADGE_UNKNOWN, SEND_BLOCK_LABEL, TODAY_FACTS_NOT_CHECKED, TODAY_SEND_STOP_TITLE } from "@/lib/sales/demo-version/admin-messages";
import { demoVersionBadge } from "@/lib/sales/demo-version/badge";
import { buildDemoVersionsView, type QualityReviewDb, type VersionRowDb } from "@/lib/sales/demo-version/view-model";
import { buildTodayEvidence, type EvidenceInput } from "@/lib/sales/evidence";
import { eligibleInstagramInput } from "../sales/today-evidence-fixture";

// DEV-196d-7: the Today card's demo version badge — the mapping from the view model, the badge / link / send-stop
// markup, and above all: with the flag OFF the card and the page render exactly as before and read nothing more.

const NOW = new Date("2026-11-11T03:00:00Z");
const DEMO = "00000000-0000-4000-8000-0000000000d1";
const PROSPECT = "11111111-2222-4333-8444-555555555555";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const h = (c: string) => c.repeat(64);

const version = (n: number, over: Partial<VersionRowDb> = {}): VersionRowDb => ({
  id: id(n), demo_id: DEMO, version_no: n, parent_version_id: null, origin: "manual_import", worker_commit: "abcdef1", facts_sha256: h("f"),
  bundle_sha256: h(String(n)), status: "draft", validator_result: { ok: true, codes: [] }, structure_descriptor: null, rights_summary: null,
  expires_at: "2027-01-01T00:00:00Z", revoked_at: null, revoke_code: null, created_at: "2026-11-10T00:00:00Z", ...over,
});
const review = (n: number, decision: string, state = "active"): QualityReviewDb => ({
  id: id(700 + n), version_id: id(n), decision, state, checklist: {}, viewed_renders_sha256: {}, reviewed_at: "2026-11-10T00:00:00Z",
  withdrawn_at: null, invalidated_at: null, invalidated_reason: null, bundle_sha256: h(String(n)), facts_sha256: h("f"),
});
const badge = (versions: VersionRowDb[], o: { reviews?: QualityReviewDb[]; approved?: string | null } = {}) =>
  demoVersionBadge(buildDemoVersionsView({ versions, files: [], images: [], reviews: o.reviews ?? [], approvals: [], approvedVersionId: o.approved ?? null, demoDisabled: false, currentFactsSha256: null, now: NOW }));

describe("demoVersionBadge: one fixed state from the view model", () => {
  it("none / awaiting / changes requested / rejected / approved / revoked / uploading / validator rejected / expired", () => {
    expect(badge([])).toEqual({ state: "none", versionNo: null, sendStop: null });
    expect(badge([version(1)]).state).toBe("awaiting_review");
    expect(badge([version(1)], { reviews: [review(1, "changes_requested")] }).state).toBe("changes_requested");
    expect(badge([version(1)], { reviews: [review(1, "rejected")] }).state).toBe("rejected_by_admin");
    expect(badge([version(1)], { reviews: [review(1, "changes_requested", "withdrawn")] }).state).toBe("awaiting_review");
    const approved = badge([version(2, { status: "draft" }), version(1, { status: "approved" })], { reviews: [review(1, "approved")], approved: id(1) });
    expect(approved).toMatchObject({ state: "approved", versionNo: 1 });
    expect(approved.sendStop).toMatchObject({ code: "demo_not_shareable", factsUnknown: true });
    expect(badge([version(1, { status: "revoked", revoked_at: "2026-11-10T00:00:00Z" })]).state).toBe("revoked");
    expect(badge([version(1, { status: "uploading" })]).state).toBe("uploading");
    expect(badge([version(1, { status: "rejected" })]).state).toBe("validator_rejected");
    expect(badge([version(1, { status: "expired" })]).state).toBe("expired");
    // the newest version decides when nothing is approved
    expect(badge([version(1, { status: "revoked", revoked_at: "2026-11-10T00:00:00Z" }), version(2)])).toMatchObject({ state: "awaiting_review", versionNo: 2 });
    // an approved id that is not among the rows: the database says unavailable — the send stop says so
    expect(badge([version(1)], { approved: id(9) }).sendStop).toMatchObject({ code: "demo_version_unavailable" });
  });
});

describe("badge, link and send-stop markup (fixed labels only)", () => {
  it("each state has its label; unknown is neutral", () => {
    for (const state of Object.keys(DEMO_VERSION_BADGE_LABEL) as (keyof typeof DEMO_VERSION_BADGE_LABEL)[]) {
      const html = renderToStaticMarkup(<DemoVersionBadge value={{ kind: "ok", state, versionNo: 3, sendStop: null }} />);
      expect(html).toContain(DEMO_VERSION_BADGE_LABEL[state]);
      expect(html).toContain(`data-demo-version="${state}"`);
    }
    expect(renderToStaticMarkup(<DemoVersionBadge value={{ kind: "unknown" }} />)).toContain(DEMO_VERSION_BADGE_UNKNOWN);
  });
  it("the send stop shows the fixed reason and that the facts are not checked here; nothing when sending is not stopped", () => {
    const html = renderToStaticMarkup(
      <DemoSendStopNotice value={{ kind: "ok", state: "approved", versionNo: 1, sendStop: { code: "demo_not_shareable", reasons: ["versioned_sharing_disabled"], factsUnknown: true } }} />,
    );
    expect(html).toContain(TODAY_SEND_STOP_TITLE);
    expect(html).toContain(SEND_BLOCK_LABEL.demo_not_shareable);
    expect(html).toContain("版での共有がまだ無効です");
    expect(html).toContain(TODAY_FACTS_NOT_CHECKED);
    expect(html).not.toMatch(/<button|<form/);
    expect(renderToStaticMarkup(<DemoSendStopNotice value={{ kind: "ok", state: "awaiting_review", versionNo: 1, sendStop: null }} />)).toBe("");
    expect(renderToStaticMarkup(<DemoSendStopNotice value={{ kind: "unknown" }} />)).toBe("");
  });
});

// --- the Today card and page --------------------------------------------------------------------------------------

const state = vi.hoisted(() => ({ items: [] as unknown[], from: [] as string[], fail: false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/admin/auth", () => ({ requireAdmin: vi.fn(async () => undefined), requireAdminPage: vi.fn(async () => undefined) }));
vi.mock("@/lib/admin/today", async (original) => ({ ...(await original<typeof import("@/lib/admin/today")>()), loadTodayQueue: vi.fn(async () => state.items) }));
vi.mock("@/lib/supabase/server", () => ({
  createAuthClient: vi.fn(async () => ({
    from(t: string) {
      state.from.push(t);
      const rows = state.fail
        ? { data: null, error: { message: "boom" } }
        : {
            data: [
              {
                id: DEMO, prospect_id: PROSPECT, approved_version_id: id(1), disabled_at: null,
                sales_demo_versions: [{ ...version(1, { status: "approved" }), sales_demo_version_files: [], sales_demo_quality_reviews: [review(1, "approved")] }],
              },
            ],
            error: null,
          };
      const b: Record<string, unknown> = {};
      for (const m of ["select", "in", "order", "limit"]) b[m] = () => b;
      b.then = (ok: (v: unknown) => unknown) => ok(rows);
      return b;
    },
  })),
}));

function todayItem(input: EvidenceInput = eligibleInstagramInput()): TodayItem {
  return {
    kind: input.kind, prospectId: PROSPECT, doNotContact: false, since: new Date("2026-10-05T00:00:00Z"), outreachId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    channel: input.channel, shopName: "テスト工房", category: "bakery", ward: "中区", subject: null, body: "テスト用の営業文です。",
    instagramUrl: input.instagramUrl, publicEmail: input.publicEmail, demoToken: input.demoAvailable ? "A".repeat(43) : null, sentAt: null,
    designStatus: input.designStatus, designErrorCode: null, designReview: null, evidence: buildTodayEvidence(input), draftVersion: 1, editedAt: null,
    instagramHandle: input.instagramHandle, approval: null,
  };
}
const MARKERS = ["demo-version-badge", "demo-versions-link", "demo-send-stop", "デモの版", "/admin/sales/demos/"];
const pageHtml = async () => {
  const { default: TodayPage } = await import("@/app/admin/sales/page");
  return renderToStaticMarkup(await TodayPage());
};

beforeEach(() => {
  state.items = [todayItem()];
  state.from = [];
  state.fail = false;
});
afterEach(() => vi.unstubAllEnvs());

describe("flag OFF: the Today card and page are exactly as before", () => {
  it("TodayCard without demoVersion: none of the new markup", () => {
    const html = renderToStaticMarkup(<TodayCard item={todayItem()} now={NOW} action={<span>action</span>} />);
    for (const m of MARKERS) expect(html, m).not.toContain(m);
  });
  it("the page reads nothing more (no sales_demos request) and renders no badge, link or warning — for every flag spelling but \"true\"", async () => {
    for (const flag of [undefined, "", "false", "TRUE", "1"]) {
      if (flag === undefined) vi.unstubAllEnvs();
      else vi.stubEnv("SALES_DEMO_VERSIONS_ENABLED", flag);
      state.from = [];
      const html = await pageHtml();
      expect(state.from, String(flag)).toEqual([]);
      for (const m of MARKERS) expect(html, `${flag} ${m}`).not.toContain(m);
      expect(html).toContain("この内容で送信を承認"); // the existing send flow is untouched
    }
  });
});

describe("flag ON: badge, link and the send-stop explanation; the send action itself unchanged", () => {
  it("one request; the badge, the link to the version page and the warning; the existing send flow stays as it is", async () => {
    vi.stubEnv("SALES_DEMO_VERSIONS_ENABLED", "true");
    const html = await pageHtml();
    expect(state.from).toEqual(["sales_demos"]);
    expect(html).toContain('data-demo-version="approved"');
    expect(html).toContain("デモの版: 品質承認済み（v1）");
    expect(html).toContain(`href="/admin/sales/demos/${PROSPECT}"`);
    expect(html).toContain('data-send-stop="demo_not_shareable"');
    expect(html).toContain("この内容で送信を承認"); // display only: the send action is not removed or changed
  });
  it("a failed read: a neutral badge, the card still renders with its send action", async () => {
    vi.stubEnv("SALES_DEMO_VERSIONS_ENABLED", "true");
    state.fail = true;
    const html = await pageHtml();
    expect(html).toContain(DEMO_VERSION_BADGE_UNKNOWN);
    expect(html).not.toContain("demo-send-stop");
    expect(html).toContain("この内容で送信を承認");
  });
  it("the card shows the badge for any item, the warning only on an initial card", () => {
    const value: TodayDemoVersion = { kind: "ok", state: "approved", versionNo: 1, sendStop: { code: "demo_not_shareable", reasons: [], factsUnknown: true } };
    const follow = renderToStaticMarkup(<TodayCard item={todayItem(eligibleInstagramInput({ kind: "follow_up", outreachStatus: "sent" }))} now={NOW} action={null} demoVersion={value} />);
    expect(follow).toContain("demo-version-badge");
    expect(follow).not.toContain("demo-send-stop");
  });
});
