import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DemoFromFacts from "@/components/admin/demo/DemoFromFacts";
import { onboardingDemoContent } from "@/lib/demo-version-package/facts-content";
import { HIDDEN_EMAIL_LABEL, QUALITY_REVIEW_DISABLED_TEXT } from "@/lib/sales/demo-version/admin-messages";
import { BASE_FACTS, fictionalPack } from "@/tests/support/fictional-facts-pack";

// DEV-263h (Issue #263): デモの事実を facts pack から作る on the admin screen — the core preview / submit (flag first, the same
// bytes as the preview, the owner's confirmation for a replacement, only sales_create_demo_from_facts under the admin's
// session), the server actions' flag / admin order, the refusals the screen can see and the panel's markup. Fictional only.

const PROSPECT = "00000000-0000-4000-8000-0000000000c2";
const ENV = { SALES_DEMO_VERSIONS_ENABLED: "true", SALES_DEMO_QUALITY_REVIEW_ENABLED: "true" };
const text = fictionalPack();
const LEGACY = { name: "テストベーカリー", category: "bakery" };

type Demo = { content: unknown; expires_at: string | null; disabled_at: string | null; design_status: string | null } | null;
const S = {
  admin: true,
  prospect: { id: PROSPECT, name: "架空の店 試験", address: "架空市架空区試験町1-2-3", do_not_contact: false } as unknown,
  demo: { content: LEGACY, expires_at: null, disabled_at: null, design_status: null } as Demo,
  approvals: [] as unknown[],
  otherDemos: [] as unknown[],
  otherFacts: [] as unknown[],
  readError: false,
  rpcError: null as null | { message: string },
};
const rpc = vi.fn(async () =>
  S.rpcError
    ? { data: null, error: S.rpcError }
    : { data: { prospect_id: PROSPECT, demo_id: "d", demo_created: S.demo === null, content_changed: S.demo !== null, facts_pack_id: "f", facts_sha256: "a".repeat(64), shop_id: "fictional-onboarding-h1", replayed: false }, error: null },
);
function fakeClient() {
  return {
    rpc,
    from: (table: string) => {
      let neq = false;
      const b = {
        select: () => b,
        eq: () => b,
        in: () => b,
        neq: () => {
          neq = true;
          return b;
        },
        limit: async () => ({ data: table === "sales_outreach_approvals" ? S.approvals : table === "sales_demos" && neq ? S.otherDemos : S.otherFacts, error: null }),
        maybeSingle: async () => {
          if (S.readError) return { data: null, error: { message: "boom" } };
          if (table === "sales_prospects") return { data: S.prospect, error: null };
          if (table === "sales_demos") return { data: S.demo, error: null };
          return { data: null, error: null };
        },
      };
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
const { previewDemoFromFacts, submitDemoFromFacts } = await import("@/lib/admin/demo-onboarding");
const { previewDemoFromFactsPack, createDemoFromFactsPack } = await import("@/app/admin/sales/_actions/demo-versions");

const o = (env: Record<string, string> = ENV) => ({ env, client: fakeClient() as never });

beforeEach(() => {
  rpc.mockClear();
  Object.assign(S, {
    admin: true,
    prospect: { id: PROSPECT, name: "架空の店 試験", address: "架空市架空区試験町1-2-3", do_not_contact: false },
    demo: { content: LEGACY, expires_at: null, disabled_at: null, design_status: null },
    approvals: [],
    otherDemos: [],
    otherFacts: [],
    readError: false,
    rpcError: null,
  });
});

describe("previewDemoFromFacts / submitDemoFromFacts", () => {
  it("a legacy demo: the preview says replace (needs confirmation) and writes nothing; submit without confirmation is refused; with it, only sales_create_demo_from_facts", async () => {
    const p = await previewDemoFromFacts({ prospectId: PROSPECT, factsPack: text }, o());
    expect(p).toMatchObject({ ok: true, action: "replace_legacy", needsConfirm: true, shopId: "fictional-onboarding-h1" });
    expect(rpc).not.toHaveBeenCalled();
    if (!p.ok) throw new Error("preview");
    expect(await submitDemoFromFacts({ prospectId: PROSPECT, factsPack: text, sha256: p.sha256, replaceContent: false, identityConfirmed: false }, o())).toMatchObject({ ok: false, code: "facts_onboarding_replace_unconfirmed" });
    expect(rpc).not.toHaveBeenCalled();
    expect(await submitDemoFromFacts({ prospectId: PROSPECT, factsPack: text, sha256: p.sha256, replaceContent: true, identityConfirmed: false }, o())).toMatchObject({ ok: true, contentChanged: true });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("sales_create_demo_from_facts", { p_prospect_id: PROSPECT, p_facts_pack: text, p_replace_content: true });
  });

  it("no demo: create (no confirmation); an unchanged demo registers only (replace_content false)", async () => {
    S.demo = null;
    const p = await previewDemoFromFacts({ prospectId: PROSPECT, factsPack: text }, o());
    expect(p).toMatchObject({ ok: true, action: "create", needsConfirm: false });
    if (!p.ok) throw new Error("preview");
    expect(await submitDemoFromFacts({ prospectId: PROSPECT, factsPack: text, sha256: p.sha256, replaceContent: true, identityConfirmed: false }, o())).toMatchObject({ ok: true, demoCreated: true });
    expect(rpc).toHaveBeenLastCalledWith("sales_create_demo_from_facts", { p_prospect_id: PROSPECT, p_facts_pack: text, p_replace_content: false });
    S.demo = { content: onboardingDemoContent(new TextEncoder().encode(text)), expires_at: null, disabled_at: null, design_status: null };
    expect(await previewDemoFromFacts({ prospectId: PROSPECT, factsPack: text }, o())).toMatchObject({ ok: true, action: "unchanged", needsConfirm: false });
  });

  it("the flag off refuses before reading; malformed input, an invalid pack, a stale sha256 and a missing prospect are refused without a write", async () => {
    expect(await previewDemoFromFacts({ prospectId: PROSPECT, factsPack: text }, o({ SALES_DEMO_VERSIONS_ENABLED: "true" }))).toEqual({ ok: false, error: QUALITY_REVIEW_DISABLED_TEXT });
    expect(await submitDemoFromFacts({ prospectId: PROSPECT, factsPack: text, sha256: "a".repeat(64), replaceContent: true, identityConfirmed: false }, o({}))).toEqual({ ok: false, error: QUALITY_REVIEW_DISABLED_TEXT });
    expect(await previewDemoFromFacts({ prospectId: "x", factsPack: text }, o())).toMatchObject({ ok: false });
    expect(await previewDemoFromFacts({ prospectId: PROSPECT, factsPack: fictionalPack({ facts: [...BASE_FACTS, ["price", "100円"]] }) }, o())).toMatchObject({ ok: false, code: "TRUSTED_FACTS_UNMAPPED_KEY" });
    expect(await previewDemoFromFacts({ prospectId: PROSPECT, factsPack: "{}" }, o())).toMatchObject({ ok: false, code: "TRUSTED_FACTS_INVALID" });
    expect(await submitDemoFromFacts({ prospectId: PROSPECT, factsPack: text, sha256: "b".repeat(64), replaceContent: true, identityConfirmed: false }, o())).toMatchObject({ ok: false, code: "FACTS_PACK_STALE" });
    S.prospect = null;
    expect(await previewDemoFromFacts({ prospectId: PROSPECT, factsPack: text }, o())).toMatchObject({ ok: false });
    S.prospect = { id: PROSPECT, name: "架空の店 試験", address: "架空市架空区試験町1-2-3", do_not_contact: false };
    S.readError = true;
    expect(await previewDemoFromFacts({ prospectId: PROSPECT, factsPack: text }, o())).toMatchObject({ ok: false });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("the prospect rules: DNC, a duplicate shop, a shared / approved demo — refused before the database; the database's refusal is shown in words", async () => {
    const sub = async () => {
      const p = await previewDemoFromFacts({ prospectId: PROSPECT, factsPack: text }, o());
      return p.ok ? "ok" : p.code;
    };
    S.prospect = { id: PROSPECT, name: "架空の店 試験", address: "架空市架空区試験町1-2-3", do_not_contact: true };
    expect(await sub()).toBe("facts_onboarding_do_not_contact");
    S.prospect = { id: PROSPECT, name: "架空の店 試験", address: "架空市架空区試験町1-2-3", do_not_contact: false };
    S.otherFacts = [{ id: "x" }];
    expect(await sub()).toBe("facts_onboarding_shop_other_prospect");
    S.otherFacts = [];
    S.otherDemos = [{ id: "y" }];
    expect(await sub()).toBe("facts_onboarding_shop_other_prospect");
    S.otherDemos = [];
    S.approvals = [{ id: "a" }];
    expect(await sub()).toBe("facts_onboarding_demo_in_use");
    S.approvals = [];
    S.demo = { content: LEGACY, expires_at: "2026-12-01T00:00:00Z", disabled_at: null, design_status: null };
    expect(await sub()).toBe("facts_onboarding_demo_in_use");
    S.demo = { content: LEGACY, expires_at: null, disabled_at: null, design_status: null };
    expect(rpc).not.toHaveBeenCalled();
    // the exclusion list is the database's: its refusal reaches the owner in words
    S.rpcError = { message: "facts_onboarding_excluded" };
    const p = await previewDemoFromFacts({ prospectId: PROSPECT, factsPack: text }, o());
    if (!p.ok) throw new Error("preview");
    expect(await submitDemoFromFacts({ prospectId: PROSPECT, factsPack: text, sha256: p.sha256, replaceContent: true, identityConfirmed: false }, o())).toMatchObject({ ok: false, code: "facts_onboarding_excluded", error: expect.stringContaining("除外") });
  });

  it("PR #271 L3: the prospect's name / address beside the pack's; a mismatch is refused unless the owner confirms it", async () => {
    S.prospect = { id: PROSPECT, name: "別の店", address: "愛知県名古屋市中区別町9", do_not_contact: false };
    const p = await previewDemoFromFacts({ prospectId: PROSPECT, factsPack: text }, o());
    expect(p).toMatchObject({ ok: true, identity: { mismatch: true, prospectName: "別の店", packName: "架空の店 試験" } });
    if (!p.ok) throw new Error("preview");
    expect(await submitDemoFromFacts({ prospectId: PROSPECT, factsPack: text, sha256: p.sha256, replaceContent: true, identityConfirmed: false }, o())).toMatchObject({ ok: false, code: "facts_onboarding_identity_unconfirmed" });
    expect(rpc).not.toHaveBeenCalled();
    expect(await submitDemoFromFacts({ prospectId: PROSPECT, factsPack: text, sha256: p.sha256, replaceContent: true, identityConfirmed: true }, o())).toMatchObject({ ok: true });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("PR #271 L4: an unexpected database error is shown as one generic message (no raw text, code unexpected)", async () => {
    S.rpcError = { message: "duplicate key value violates unique constraint sales_demos_public_token_key" };
    const p = await previewDemoFromFacts({ prospectId: PROSPECT, factsPack: text }, o());
    if (!p.ok) throw new Error("preview");
    const r = await submitDemoFromFacts({ prospectId: PROSPECT, factsPack: text, sha256: p.sha256, replaceContent: true, identityConfirmed: false }, o());
    expect(r).toMatchObject({ ok: false, code: "unexpected" });
    expect(JSON.stringify(r)).not.toContain("sales_demos");
    expect(JSON.stringify(r)).not.toContain("duplicate key");
  });

  it("a value holding an email address is never shown", async () => {
    const withEmail = fictionalPack({ facts: BASE_FACTS.map(([k, v]) => [k, k === "description" ? "連絡は info@shop.example.com へ" : v]) });
    const p = await previewDemoFromFacts({ prospectId: PROSPECT, factsPack: withEmail }, o());
    expect(JSON.stringify(p)).not.toContain("info@shop.example.com");
    expect(JSON.stringify(p)).toContain(HIDDEN_EMAIL_LABEL);
  });
});

describe("server actions: flag first, then the admin", () => {
  it("flag off → refused without the admin check; a non-admin is refused; an admin reaches the core", async () => {
    const saved = { ...process.env };
    try {
      delete process.env.SALES_DEMO_QUALITY_REVIEW_ENABLED;
      S.admin = false;
      expect(await previewDemoFromFactsPack({ prospectId: PROSPECT, factsPack: text })).toEqual({ ok: false, error: QUALITY_REVIEW_DISABLED_TEXT });
      expect(await createDemoFromFactsPack({ prospectId: PROSPECT, factsPack: text, sha256: "a".repeat(64), replaceContent: true, identityConfirmed: false })).toEqual({ ok: false, error: QUALITY_REVIEW_DISABLED_TEXT });
      Object.assign(process.env, ENV);
      await expect(previewDemoFromFactsPack({ prospectId: PROSPECT, factsPack: text })).rejects.toThrow("forbidden");
      await expect(createDemoFromFactsPack({ prospectId: PROSPECT, factsPack: text, sha256: "a".repeat(64), replaceContent: true, identityConfirmed: false })).rejects.toThrow("forbidden");
      expect(rpc).not.toHaveBeenCalled();
      S.admin = true;
      expect(await previewDemoFromFactsPack({ prospectId: PROSPECT, factsPack: text })).toMatchObject({ ok: true, action: "replace_legacy" });
    } finally {
      process.env = saved;
    }
  });
});

describe("DemoFromFacts panel", () => {
  it("shows the form only when enabled, with the target's explanation", () => {
    const on = renderToStaticMarkup(<DemoFromFacts prospectId={PROSPECT} target="no_demo" enabled />);
    expect(on).toContain('data-demo-from-facts="no_demo"');
    expect(on).toContain("data-demo-from-facts-input");
    expect(on).toContain("この事実からデモの事実を作る");
    const legacy = renderToStaticMarkup(<DemoFromFacts prospectId={PROSPECT} target="legacy" enabled={false} />);
    expect(legacy).toContain("React のデモ");
    expect(legacy).not.toContain("data-demo-from-facts-input");
  });
});
