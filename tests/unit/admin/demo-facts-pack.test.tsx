import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import FactsPackRegistration from "@/components/admin/demo/FactsPackRegistration";
import { sendableSeedContent, SENDABLE_FACTS_PATH } from "@/lib/demo-version-package/seed-sendable";
import { HIDDEN_EMAIL_LABEL, QUALITY_REVIEW_DISABLED_TEXT } from "@/lib/sales/demo-version/admin-messages";
import { checkFactsPackForDemo } from "@/lib/sales/facts-store";

// DEV-263f (Issue #263): the owner's facts pack registration on the admin screen — the pure check against the demo's
// content, the core preview / submit (flag first, the same bytes as the preview, only sales_register_facts_pack under
// the admin's session), the server actions' flag / admin order, and the panel's markup. The fictional 環 only.

const REPO = resolve(__dirname, "../../..");
const PROSPECT = "00000000-0000-4000-8000-0000000000c1";
const DEMO = "00000000-0000-4000-8000-0000000000d1";
const ENV = { SALES_DEMO_VERSIONS_ENABLED: "true", SALES_DEMO_QUALITY_REVIEW_ENABLED: "true" };
const packText = readFileSync(resolve(REPO, SENDABLE_FACTS_PATH), "utf8");
const content = () => sendableSeedContent(new TextEncoder().encode(packText));

const S = { admin: true, content: content() as unknown, demoError: false, current: [] as unknown[], rpcError: null as null | { message: string }, replayed: false };
const rpc = vi.fn(async () => (S.rpcError ? { data: null, error: S.rpcError } : { data: { facts_pack_id: "row-1", facts_sha256: "a".repeat(64), shop_id: "fictional-bicycle-repair-tamaki", replayed: S.replayed }, error: null }));
function fakeClient() {
  return {
    rpc,
    from: (table: string) => {
      const b = {
        select: () => b,
        eq: () => b,
        order: () => b,
        limit: async () => ({ data: S.current, error: null }),
        maybeSingle: async () => (table === "sales_demos" ? (S.demoError ? { data: null, error: { message: "boom" } } : { data: { id: DEMO, content: S.content }, error: null }) : { data: null, error: null }),
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
const { previewFactsPack, submitFactsPack } = await import("@/lib/admin/demo-facts-pack");
const { previewDemoFactsPack, registerDemoFactsPack } = await import("@/app/admin/sales/_actions/demo-versions");

beforeEach(() => {
  rpc.mockClear();
  Object.assign(S, { admin: true, content: content(), demoError: false, current: [], rpcError: null, replayed: false });
});

describe("checkFactsPackForDemo (pure)", () => {
  it("a pack the demo was derived from passes; another pack, other content, a 輪 demo or malformed JSON are refused with a code", () => {
    const ok = checkFactsPackForDemo(packText, content());
    expect(ok).toMatchObject({ ok: true, shopId: "fictional-bicycle-repair-tamaki" });
    expect(ok.facts.length).toBeGreaterThan(5);
    expect(checkFactsPackForDemo(`${packText} `, content())).toMatchObject({ ok: false, code: "TRUSTED_FACTS_SHA_MISMATCH" });
    expect(checkFactsPackForDemo(packText, { ...content(), hours: "9:00〜18:00" })).toMatchObject({ ok: false, code: "TRUSTED_FACTS_CONTENT_MISMATCH" });
    expect(checkFactsPackForDemo(packText, { ...content(), facts_pack: "bicycle-repair-rin" })).toMatchObject({ ok: false });
    expect(checkFactsPackForDemo("{", content())).toMatchObject({ ok: false, code: "TRUSTED_FACTS_INVALID", sha256: null });
    expect(checkFactsPackForDemo(JSON.stringify({ schema: "shop_facts_pack_v1", shop_id: "x1", facts: [], extra: 1 }), content())).toMatchObject({ ok: false, code: "TRUSTED_FACTS_INVALID" });
  });
});

describe("previewFactsPack / submitFactsPack", () => {
  it("preview shows the facts and writes nothing; submit registers exactly those bytes through sales_register_facts_pack only", async () => {
    const p = await previewFactsPack({ prospectId: PROSPECT, factsPack: packText }, { env: ENV, client: fakeClient() as never });
    expect(p).toMatchObject({ ok: true, shopId: "fictional-bicycle-repair-tamaki", alreadyCurrent: false });
    expect(rpc).not.toHaveBeenCalled();
    if (!p.ok) throw new Error("preview");
    expect(await submitFactsPack({ prospectId: PROSPECT, factsPack: packText, sha256: p.sha256 }, { env: ENV, client: fakeClient() as never })).toEqual({ ok: true, replayed: false, sha256: "a".repeat(64) });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("sales_register_facts_pack", { p_demo_id: DEMO, p_facts_pack: packText });
  });

  it("the current registration is shown as such; an email in a value is hidden", async () => {
    S.current = [{ facts_sha256: checkFactsPackForDemo(packText, content()).sha256, demo_id: DEMO }];
    expect(await previewFactsPack({ prospectId: PROSPECT, factsPack: packText }, { env: ENV, client: fakeClient() as never })).toMatchObject({ ok: true, alreadyCurrent: true });
    const withEmail = JSON.stringify({ ...JSON.parse(packText), facts: [...JSON.parse(packText).facts.slice(0, 1).map((f: Record<string, string>) => ({ ...f, value: "info@shop.example.com" }))] });
    const r = await previewFactsPack({ prospectId: PROSPECT, factsPack: withEmail }, { env: ENV, client: fakeClient() as never });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("info@shop.example.com");
    expect(JSON.stringify(r)).toContain(HIDDEN_EMAIL_LABEL);
  });

  it("refused before the database: flag off, bad input, other bytes than the preview, a demo not derived from the pack, an unreadable demo", async () => {
    const sha = checkFactsPackForDemo(packText, content()).sha256!;
    expect(await submitFactsPack({ prospectId: PROSPECT, factsPack: packText, sha256: sha }, { env: {}, client: fakeClient() as never })).toEqual({ ok: false, error: QUALITY_REVIEW_DISABLED_TEXT });
    expect(await previewFactsPack({ prospectId: PROSPECT, factsPack: packText }, { env: {}, client: fakeClient() as never })).toEqual({ ok: false, error: QUALITY_REVIEW_DISABLED_TEXT });
    expect((await submitFactsPack({ prospectId: "x", factsPack: packText, sha256: sha }, { env: ENV, client: fakeClient() as never })).ok).toBe(false);
    expect(await submitFactsPack({ prospectId: PROSPECT, factsPack: packText, sha256: "b".repeat(64) }, { env: ENV, client: fakeClient() as never })).toMatchObject({ ok: false, code: "FACTS_PACK_STALE" });
    S.content = { ...content(), hours: "9:00〜18:00" };
    expect(await submitFactsPack({ prospectId: PROSPECT, factsPack: packText, sha256: sha }, { env: ENV, client: fakeClient() as never })).toMatchObject({ ok: false, code: "TRUSTED_FACTS_CONTENT_MISMATCH" });
    S.demoError = true;
    expect((await submitFactsPack({ prospectId: PROSPECT, factsPack: packText, sha256: sha }, { env: ENV, client: fakeClient() as never })).ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("the database's refusal is shown in the owner's words", async () => {
    S.rpcError = { message: "facts_pack_not_demo_content" };
    const sha = checkFactsPackForDemo(packText, content()).sha256!;
    expect(await submitFactsPack({ prospectId: PROSPECT, factsPack: packText, sha256: sha }, { env: ENV, client: fakeClient() as never })).toMatchObject({ ok: false, code: "facts_pack_not_demo_content", error: expect.stringContaining("作られていません") });
  });
});

describe("the server actions: flag first, then the admin", () => {
  it("flag off: refused before the admin check; not an admin: throws; on: preview and register", async () => {
    vi.stubEnv("SALES_DEMO_VERSIONS_ENABLED", "true");
    vi.stubEnv("SALES_DEMO_QUALITY_REVIEW_ENABLED", "false");
    S.admin = false;
    expect(await previewDemoFactsPack({ prospectId: PROSPECT, factsPack: packText })).toEqual({ ok: false, error: QUALITY_REVIEW_DISABLED_TEXT });
    expect(await registerDemoFactsPack({ prospectId: PROSPECT, factsPack: packText, sha256: "a".repeat(64) })).toEqual({ ok: false, error: QUALITY_REVIEW_DISABLED_TEXT });
    vi.stubEnv("SALES_DEMO_QUALITY_REVIEW_ENABLED", "true");
    await expect(previewDemoFactsPack({ prospectId: PROSPECT, factsPack: packText })).rejects.toThrow("forbidden");
    await expect(registerDemoFactsPack({ prospectId: PROSPECT, factsPack: packText, sha256: "a".repeat(64) })).rejects.toThrow("forbidden");
    S.admin = true;
    const p = await previewDemoFactsPack({ prospectId: PROSPECT, factsPack: packText });
    expect(p.ok).toBe(true);
    if (!p.ok) throw new Error("preview");
    expect(await registerDemoFactsPack({ prospectId: PROSPECT, factsPack: packText, sha256: p.sha256 })).toMatchObject({ ok: true });
    expect(rpc).toHaveBeenCalledTimes(1);
    vi.unstubAllEnvs();
  });
});

describe("FactsPackRegistration (markup)", () => {
  it("shows the current registration, and the form only when writes are enabled", () => {
    const on = renderToStaticMarkup(<FactsPackRegistration prospectId={PROSPECT} current={{ kind: "ok", sha256: "c".repeat(64), recordedAt: "2026-11-13T00:00:00Z", via: "admin_session" }} enabled />);
    expect(on).toContain('data-facts-current="ok"');
    expect(on).toContain("cccccccccccc");
    expect(on).toContain("data-facts-input");
    expect(on).toContain("内容を確認");
    const off = renderToStaticMarkup(<FactsPackRegistration prospectId={PROSPECT} current={{ kind: "none" }} enabled={false} />);
    expect(off).toContain('data-facts-current="none"');
    expect(off).not.toContain("data-facts-input");
  });
});
