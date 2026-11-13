import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUALITY_REVIEW_DISABLED_TEXT } from "@/lib/sales/demo-version/admin-messages";
import { demoQualityReviewEnabled, demoVersionsEnabled, QUALITY_REVIEW_ENABLED_ENV } from "@/lib/sales/demo-version/flags";

// DEV-196k (owner decision 2026-11-11, item 5): SALES_DEMO_VERSIONS_ENABLED is preview only; every quality-review
// write (approve / send back / reject, withdraw, revoke, urgent revoke) needs SALES_DEMO_QUALITY_REVIEW_ENABLED too.
// Both strict "true", default off, checked on the server: off → refused before anything is read or written.

const SPELLINGS = [undefined, "", "false", "TRUE", "1", " true", "true"] as const;

describe("the two flags", () => {
  it("every combination: preview needs exactly \"true\"; review needs exactly \"true\" AND preview", () => {
    expect(QUALITY_REVIEW_ENABLED_ENV).toBe("SALES_DEMO_QUALITY_REVIEW_ENABLED");
    for (const preview of SPELLINGS) {
      for (const review of SPELLINGS) {
        const env = { SALES_DEMO_VERSIONS_ENABLED: preview, SALES_DEMO_QUALITY_REVIEW_ENABLED: review };
        expect(demoVersionsEnabled(env), `${preview}/${review}`).toBe(preview === "true");
        expect(demoQualityReviewEnabled(env), `${preview}/${review}`).toBe(preview === "true" && review === "true");
      }
    }
  });
});

const rpc = vi.fn(async () => ({ data: { replayed: false }, error: null }));
const from = vi.fn();
const auth = vi.hoisted(() => ({ calls: 0 }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/admin/auth", () => ({ requireAdmin: vi.fn(async () => (auth.calls++, { userId: "u", email: null })) }));
vi.mock("@/lib/supabase/server", () => ({ createAuthClient: vi.fn(async () => ({ rpc, from })) }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: vi.fn(() => ({ rpc, from })) }));
const actions = await import("@/app/admin/sales/_actions/demo-versions");
const { submitDemoReview } = await import("@/lib/admin/demo-review");
const { submitRevoke, submitWithdraw } = await import("@/lib/admin/demo-lifecycle");

const ID = "00000000-0000-4000-8000-000000000001";
const INPUTS = {
  reviewDemoVersion: { prospectId: ID, versionId: ID, decision: "rejected", checklist: {}, viewedRenders: {}, bundleSha256: "a".repeat(64), impersonation: [], acknowledgedSendStop: false, note: null },
  withdrawDemoApproval: { prospectId: ID, versionId: ID, reviewId: ID, bundleSha256: "a".repeat(64), confirmed: true },
  revokeDemoVersion: { prospectId: ID, versionId: ID, bundleSha256: "a".repeat(64), code: "FACT_ERROR", urgent: true, confirmed: true },
  // DEV-199b: the owner's copy decision is a quality-review write too
  decideCopyReview: { prospectId: ID, versionId: ID, reviewId: ID, decision: "reject", reviewSha256: "a".repeat(64), factsSha256: "a".repeat(64), copySha256: "a".repeat(64), pageHtmlSha256: "a".repeat(64), pageCssSha256: "a".repeat(64), note: null },
} as const;

beforeEach(() => {
  rpc.mockClear();
  from.mockClear();
  auth.calls = 0;
});
afterEach(() => vi.unstubAllEnvs());

describe("server actions: refused with nothing read or written unless BOTH flags are on", () => {
  for (const [preview, review] of [
    [undefined, undefined],
    ["true", undefined], // preview on, review off: pages work, every write refused
    ["true", "false"],
    ["true", "TRUE"],
    [undefined, "true"], // review without preview: still off
    ["false", "true"],
  ] as const) {
    it(`preview=${preview} review=${review}`, async () => {
      if (preview !== undefined) vi.stubEnv("SALES_DEMO_VERSIONS_ENABLED", preview);
      if (review !== undefined) vi.stubEnv("SALES_DEMO_QUALITY_REVIEW_ENABLED", review);
      for (const [name, input] of Object.entries(INPUTS)) {
        const r = await (actions as unknown as Record<string, (i: unknown) => Promise<{ ok: boolean; error?: string }>>)[name]!(input);
        expect(r, name).toEqual({ ok: false, error: QUALITY_REVIEW_DISABLED_TEXT });
      }
      expect(auth.calls).toBe(0); // refused before even the admin check
      expect(from).not.toHaveBeenCalled();
      expect(rpc).not.toHaveBeenCalled();
    });
  }

  it("the cores refuse on their own too (no read, no write) with the preview flag only", async () => {
    const env = { SALES_DEMO_VERSIONS_ENABLED: "true" };
    const deps = { env, now: new Date(), client: { rpc, from } as never };
    expect(await submitDemoReview(INPUTS.reviewDemoVersion, deps)).toEqual({ ok: false, error: QUALITY_REVIEW_DISABLED_TEXT });
    expect(await submitWithdraw(INPUTS.withdrawDemoApproval, deps)).toEqual({ ok: false, error: QUALITY_REVIEW_DISABLED_TEXT });
    expect(await submitRevoke(INPUTS.revokeDemoVersion, deps)).toEqual({ ok: false, error: QUALITY_REVIEW_DISABLED_TEXT });
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("both on: the action gets past the flags to the admin check", async () => {
    vi.stubEnv("SALES_DEMO_VERSIONS_ENABLED", "true");
    vi.stubEnv("SALES_DEMO_QUALITY_REVIEW_ENABLED", "true");
    from.mockImplementation(() => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "order", "limit"]) b[m] = () => b;
      b.maybeSingle = async () => ({ data: null, error: null });
      b.then = (ok: (v: unknown) => unknown) => ok({ data: [], error: null });
      return b;
    });
    await actions.withdrawDemoApproval(INPUTS.withdrawDemoApproval);
    expect(auth.calls).toBe(1);
  });
});
