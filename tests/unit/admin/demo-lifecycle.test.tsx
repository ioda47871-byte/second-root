import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import VersionLifecycle from "@/components/admin/demo/VersionLifecycle";
import {
  APPROVAL_OPEN_MESSAGE,
  LIFECYCLE_REFUSAL_LABEL,
  REVOKE_EFFECTS,
  REVOKE_REASON_LABEL,
  URGENT_REVOKE_TEXT,
  WITHDRAW_CONFIRM_TEXT,
  WITHDRAW_SEND_EFFECT_TEXT,
} from "@/lib/sales/demo-version/admin-messages";
import { checkRevoke, checkWithdraw, RevokeInput, URGENT_REVOKE_REASONS, WithdrawInput } from "@/lib/sales/demo-version/lifecycle-input";
import { buildDemoVersionsView, type QualityReviewDb, type VersionFileDb, type VersionRowDb } from "@/lib/sales/demo-version/view-model";

// DEV-196d-6: withdraw / revoke — the input's shape (explicit confirmation, fixed codes), the server's re-check, the
// core (only the DEV-196c functions), the actions' flag / admin order, and the panel's markup.

const NOW = new Date("2026-11-11T03:00:00Z");
const DEMO = "00000000-0000-4000-8000-0000000000d1";
const PROSPECT = "00000000-0000-4000-8000-0000000000c1";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const h = (c: string) => c.repeat(64);
const REVIEW = id(700);

const version = (over: Partial<VersionRowDb> = {}): VersionRowDb => ({
  id: id(1), demo_id: DEMO, version_no: 1, parent_version_id: null, origin: "manual_import", worker_commit: "abcdef1", facts_sha256: h("f"),
  bundle_sha256: h("1"), status: "approved", validator_result: { ok: true, codes: [] }, structure_descriptor: null, rights_summary: null,
  expires_at: "2027-01-01T00:00:00Z", revoked_at: null, revoke_code: null, created_at: "2026-11-10T00:00:00Z", ...over,
});
const files: VersionFileDb[] = [{ version_id: id(1), path: "page/index.html", role: "html", sha256: h("2"), bytes: 10, content_type: "text/html", width: null, height: null, image_id: null }];
const approval: QualityReviewDb = {
  id: REVIEW, version_id: id(1), decision: "approved", state: "active", checklist: {}, viewed_renders_sha256: {}, reviewed_at: "2026-11-10T00:00:00Z",
  withdrawn_at: null, invalidated_at: null, invalidated_reason: null, bundle_sha256: h("1"), facts_sha256: h("f"),
};
const view = (o: { v?: Partial<VersionRowDb>; reviews?: QualityReviewDb[]; openSend?: boolean } = {}) =>
  buildDemoVersionsView({
    versions: [version(o.v)],
    files,
    images: [],
    reviews: o.reviews ?? [approval],
    approvals: o.openSend ? [{ id: id(800), outreach_id: id(801), state: "send_opened", demo_version_id: null }] : [],
    approvedVersionId: id(1),
    demoDisabled: false,
    currentFactsSha256: h("f"),
    now: NOW,
  });
const withdraw = (over: Partial<WithdrawInput> = {}) => ({ prospectId: PROSPECT, versionId: id(1), reviewId: REVIEW, bundleSha256: h("1"), confirmed: true as const, ...over });
const revoke = (over: Partial<RevokeInput> = {}) => ({ prospectId: PROSPECT, versionId: id(1), bundleSha256: h("1"), code: "QUALITY_PROBLEM" as const, urgent: false, confirmed: true as const, ...over });

describe("inputs: explicit confirmation and fixed reason codes only", () => {
  it("refuses a missing / false confirmation, an unknown code, stray keys and malformed ids", () => {
    expect(WithdrawInput.safeParse(withdraw()).success).toBe(true);
    expect(RevokeInput.safeParse(revoke()).success).toBe(true);
    for (const bad of [{ confirmed: false }, { confirmed: undefined }, { reviewId: "x" }, { extra: 1 }]) expect(WithdrawInput.safeParse({ ...withdraw(), ...bad }).success, JSON.stringify(bad)).toBe(false);
    for (const bad of [{ confirmed: false }, { code: "free text" }, { code: "SOMETHING_ELSE" }, { urgent: "yes" }]) expect(RevokeInput.safeParse({ ...revoke(), ...bad }).success, JSON.stringify(bad)).toBe(false);
    expect([...URGENT_REVOKE_REASONS]).toEqual(["FACT_ERROR", "RIGHTS_COMPLAINT", "SAFETY_CONCERN"]);
  });
});

describe("the server's re-check against the version as the database shows it now", () => {
  it("withdraw: passes for the active approval; refuses unknown version, stale bundle, another review, an open send", () => {
    const v = view();
    expect(checkWithdraw(withdraw(), v, v.versions[0])).toEqual([]);
    expect(checkWithdraw(withdraw(), v, undefined)).toEqual(["VERSION_NOT_FOUND"]);
    expect(checkWithdraw(withdraw({ bundleSha256: h("9") }), v, v.versions[0])).toContain("STALE");
    expect(checkWithdraw(withdraw({ reviewId: id(701) }), v, v.versions[0])).toContain("NOT_AN_ACTIVE_APPROVAL");
    const withdrawn = view({ reviews: [{ ...approval, state: "withdrawn" }] });
    expect(checkWithdraw(withdraw(), withdrawn, withdrawn.versions[0])).toContain("NOT_AN_ACTIVE_APPROVAL");
    const open = view({ openSend: true });
    expect(checkWithdraw(withdraw(), open, open.versions[0])).toContain("APPROVAL_OPEN");
  });
  it("revoke: passes for draft / approved / superseded; refuses stale, not revocable, an open send, an urgent revoke with a normal reason", () => {
    for (const status of ["draft", "approved", "superseded"]) {
      const v = view({ v: { status } });
      expect(checkRevoke(revoke(), v, v.versions[0]), status).toEqual([]);
    }
    const v = view();
    expect(checkRevoke(revoke({ bundleSha256: h("9") }), v, v.versions[0])).toContain("STALE");
    for (const over of [{ status: "revoked", revoked_at: "2026-11-10T00:00:00Z" }, { status: "uploading" }, { status: "rejected" }, { status: "expired" }]) {
      const x = view({ v: over });
      expect(checkRevoke(revoke(), x, x.versions[0]), over.status).toContain("NOT_REVOCABLE");
    }
    const open = view({ openSend: true });
    expect(checkRevoke(revoke(), open, open.versions[0])).toContain("APPROVAL_OPEN");
    expect(checkRevoke(revoke({ urgent: true, code: "OWNER_DECISION" }), v, v.versions[0])).toContain("URGENT_CODE");
    expect(checkRevoke(revoke({ urgent: true, code: "SAFETY_CONCERN" }), v, v.versions[0])).toEqual([]);
    expect(LIFECYCLE_REFUSAL_LABEL.APPROVAL_OPEN).toBe(APPROVAL_OPEN_MESSAGE);
  });
  it("the view model keeps only a known revoke code", () => {
    expect(view({ v: { status: "revoked", revoked_at: "2026-11-10T00:00:00Z", revoke_code: "FACT_ERROR" } }).versions[0]!.revokeCode).toBe("FACT_ERROR");
    expect(view({ v: { status: "revoked", revoked_at: "2026-11-10T00:00:00Z", revoke_code: "TEST_REVOKE" } }).versions[0]!.revokeCode).toBeNull();
  });
});

// --- the core and the actions -----------------------------------------------------------------------------------------

type RpcResult = { data: unknown; error: { message: string } | null };
const rpc = vi.fn<(fn: string, args: Record<string, unknown>) => Promise<RpcResult>>(async () => ({ data: { replayed: false }, error: null }));
const queries: string[] = [];
function fakeClient(openSend = false) {
  const tables: Record<string, unknown> = {
    sales_prospects: { id: PROSPECT, name: "架空の店" },
    sales_demos: { id: DEMO, template: "bakery_v1", content: {}, disabled_at: null, approved_version_id: id(1) },
    sales_demo_versions: [version()],
    sales_demo_version_files: files,
    sales_demo_images: [],
    sales_demo_quality_reviews: [approval],
    sales_outreach_approvals: openSend ? [{ id: id(800), outreach_id: id(801), state: "send_opened", demo_version_id: null }] : [],
  };
  return {
    rpc,
    from(t: string) {
      queries.push(t);
      const data = tables[t] ?? [];
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "order", "limit"]) b[m] = () => b;
      b.maybeSingle = async () => ({ data, error: null });
      b.then = (ok: (v: unknown) => unknown) => ok({ data, error: null });
      return b;
    },
  };
}
const auth = vi.hoisted(() => ({ admin: true }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", async (original) => ({ ...(await original<typeof import("next/navigation")>()), useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/lib/admin/auth", () => ({
  requireAdmin: vi.fn(async () => {
    if (!auth.admin) throw new Error("forbidden");
    return { userId: "u", email: null };
  }),
}));
vi.mock("@/lib/supabase/server", () => ({ createAuthClient: vi.fn(async () => fakeClient()) }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: vi.fn(() => fakeClient()) }));
const { submitRevoke, submitWithdraw } = await import("@/lib/admin/demo-lifecycle");
const { revokeDemoVersion, withdrawDemoApproval } = await import("@/app/admin/sales/_actions/demo-versions");

const KEY = Buffer.alloc(32, 7).toString("base64");
const ENV = { SALES_DEMO_VERSIONS_ENABLED: "true", SALES_DEMO_VIEW_SIGNING_KEY: KEY };
const deps = (o: { env?: Record<string, string | undefined>; openSend?: boolean } = {}) => ({ env: o.env ?? ENV, now: NOW, client: fakeClient(o.openSend) as never, factsSha256: async () => h("f") });

beforeEach(() => {
  rpc.mockClear();
  queries.length = 0;
  auth.admin = true;
  vi.unstubAllEnvs();
});

describe("submitWithdraw / submitRevoke", () => {
  it("write only through the DEV-196c functions, with exactly the re-checked values", async () => {
    expect(await submitWithdraw(withdraw(), deps())).toEqual({ ok: true, replayed: false });
    expect(rpc).toHaveBeenLastCalledWith("sales_withdraw_demo_quality_review", { p_review_id: REVIEW });
    expect(await submitRevoke(revoke({ urgent: true, code: "RIGHTS_COMPLAINT" }), deps())).toEqual({ ok: true, replayed: false });
    expect(rpc).toHaveBeenLastCalledWith("sales_revoke_demo_version", { p_version_id: id(1), p_code: "RIGHTS_COMPLAINT" });
    expect(rpc).toHaveBeenCalledTimes(2);
  });
  it("flag off: nothing read, nothing written; refusals never reach the database; database refusals in fixed words", async () => {
    for (const f of [submitWithdraw, submitRevoke] as const) {
      expect((await f(f === submitWithdraw ? withdraw() : revoke(), deps({ env: { ...ENV, SALES_DEMO_VERSIONS_ENABLED: undefined } }))).ok).toBe(false);
    }
    expect(queries).toEqual([]);
    expect((await submitWithdraw(withdraw({ bundleSha256: h("9") }), deps())).ok).toBe(false);
    expect(await submitRevoke(revoke(), deps({ openSend: true }))).toMatchObject({ ok: false, error: APPROVAL_OPEN_MESSAGE });
    expect(rpc).not.toHaveBeenCalled();
    rpc.mockResolvedValueOnce({ data: null, error: { message: "approval_open" } });
    expect(await submitRevoke(revoke(), deps())).toEqual({ ok: false, error: APPROVAL_OPEN_MESSAGE });
    rpc.mockResolvedValueOnce({ data: null, error: { message: "internal: detail" } });
    expect((await submitWithdraw(withdraw(), deps())).ok === false).toBe(true);
  });
});

describe("withdrawDemoApproval / revokeDemoVersion (server actions)", () => {
  it("flag off: refused before the admin check, nothing written", async () => {
    vi.stubEnv("SALES_DEMO_VERSIONS_ENABLED", "false");
    auth.admin = false;
    expect((await withdrawDemoApproval(withdraw())).ok).toBe(false);
    expect((await revokeDemoVersion(revoke())).ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("a non-admin is refused (requireAdmin throws), nothing written", async () => {
    vi.stubEnv("SALES_DEMO_VERSIONS_ENABLED", "true");
    vi.stubEnv("SALES_DEMO_VIEW_SIGNING_KEY", KEY);
    auth.admin = false;
    await expect(withdrawDemoApproval(withdraw())).rejects.toThrow("forbidden");
    await expect(revokeDemoVersion(revoke())).rejects.toThrow("forbidden");
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("VersionLifecycle (markup)", () => {
  const panel = (o: { approval?: boolean; revocable?: boolean; openSends?: number } = {}) =>
    renderToStaticMarkup(
      <VersionLifecycle
        prospectId={PROSPECT}
        version={{ id: id(1), versionNo: 1, bundleSha256: h("1"), revocable: o.revocable ?? true, activeApprovalId: o.approval === false ? null : REVIEW }}
        openSends={o.openSends ?? 0}
      />,
    );
  it("each action starts as a first step only; revoking needs a reason chosen (no default); the urgent revoke is distinct", () => {
    const html = panel();
    expect(html).toContain(WITHDRAW_CONFIRM_TEXT);
    expect(html).toContain(WITHDRAW_SEND_EFFECT_TEXT);
    expect(html).toContain("品質承認を取り下げる…");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>版を取り消す…<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>急ぎで取り消す…<\/button>/);
    expect(html).not.toContain("data-confirm-step");
    expect(html).toMatch(/<option value="" selected="">（選んでください）<\/option>/);
    expect(html).toMatch(/data-revoke="urgent"/);
    expect(html).toMatch(/class="[^"]*urgent[^"]*" data-revoke="urgent"/);
    expect(html).toContain(URGENT_REVOKE_TEXT);
    // the urgent list holds only the urgent reasons
    const urgent = html.split('data-revoke="urgent"')[1]!;
    for (const r of URGENT_REVOKE_REASONS) expect(urgent).toContain(REVOKE_REASON_LABEL[r]);
    expect(urgent).not.toContain(REVOKE_REASON_LABEL.OWNER_DECISION);
    expect(REVOKE_EFFECTS.join("")).toContain("404");
    expect(REVOKE_EFFECTS.join("")).toContain("自動で品質承認することはありません");
  });
  it("an open send: every action is disabled, the fixed message and the way to the Today screen are shown", () => {
    const html = panel({ openSends: 1 });
    expect(html).toContain(APPROVAL_OPEN_MESSAGE);
    expect(html).toContain('href="/admin/sales"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>品質承認を取り下げる…<\/button>/);
  });
  it("no active approval: no withdraw; not revocable: no revoke", () => {
    expect(panel({ approval: false })).not.toContain("品質承認を取り下げる");
    expect(panel({ revocable: false })).not.toContain("版を取り消す");
  });
});
