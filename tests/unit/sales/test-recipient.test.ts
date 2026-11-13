import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composedFor } from "@/lib/admin/initial-send";
import { isLoopbackSupabaseUrl, isReservedEmailDomain, LOCAL_E2E_TEST_RECIPIENTS_ENV, normaliseEmailDomain, TEST_RECIPIENT_LABEL, testRecipientBlock } from "@/lib/sales/test-recipient";

// DEV-263a (PR #266 Fresh Review L2): a fictional shop (content.facts_pack ^fictional-) or a reserved test address is
// never approved for sending, unless the local E2E flag is exactly "true". Server gate only (no migration).

const state = vi.hoisted(() => ({ row: null as unknown, rpc: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/admin/auth", () => ({ requireAdmin: vi.fn(async () => undefined), requireAdminPage: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/server", () => ({
  createAuthClient: vi.fn(async () => {
    const chain = { select: () => chain, eq: () => chain, in: () => chain, order: () => chain, maybeSingle: async () => ({ data: state.row, error: null }) };
    return { from: () => chain, rpc: state.rpc };
  }),
}));
vi.mock("@/lib/sales/copy-review/store", async (orig) => ({ ...(await orig<typeof import("@/lib/sales/copy-review/store")>()), outreachCopyGate: vi.fn(async () => ({ legacy: true })) }));

const OUTREACH = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const LOCAL = "http://127.0.0.1:54321";
const TOKEN = "A".repeat(43);
const emailRow = (email: string, factsPack: string | null = null) => ({
  id: OUTREACH,
  kind: "initial",
  status: "drafted",
  channel: "email",
  subject: "ご案内",
  body: "テスト用の営業文です。",
  draft_version: 3,
  prospect: { name: "テスト工房", public_email: email, instagram_url: null, instagram_handle: null, demo: [{ public_token: TOKEN, disabled_at: null, facts_pack: factsPack }] },
});

describe("testRecipientBlock (pure)", () => {
  it("reserved domains and fictional facts packs are blocked; real-looking ones are not", () => {
    for (const d of ["a@example.com", "a@shop.example.com", "a@example.net", "a@example.org", "a@x.test", "a@x.invalid", "a@x.example", "a@x.localhost", "A@EXAMPLE.COM"]) expect(isReservedEmailDomain(d), d).toBe(true);
    for (const d of ["a@example.co.jp", "a@myexample.com", "a@examples.com", "a@testshop.jp", "a@shop.jp", null, "", "no-at"]) expect(isReservedEmailDomain(d), String(d)).toBe(false);
    expect(testRecipientBlock({ publicEmail: "info@tamaki-demo.example.com", channel: "email", factsPack: null }, {})).toBe("test_recipient_reserved_domain");
    expect(testRecipientBlock({ publicEmail: null, channel: "instagram", factsPack: "fictional-bicycle-repair-tamaki" }, {})).toBe("test_recipient_fictional_shop");
    expect(testRecipientBlock({ publicEmail: "info@shop.jp", channel: "email", factsPack: "real-shop" }, {})).toBeNull();
    // an Instagram send is not judged by an email it does not use
    expect(testRecipientBlock({ publicEmail: "a@example.com", channel: "instagram", factsPack: null }, {})).toBeNull();
  });
  it("only the local E2E flag, exactly \"true\", lets them through", () => {
    const i = { publicEmail: "a@example.com", channel: "email", factsPack: "fictional-x" };
    expect(testRecipientBlock(i, { [LOCAL_E2E_TEST_RECIPIENTS_ENV]: "true", NEXT_PUBLIC_SUPABASE_URL: LOCAL })).toBeNull();
    for (const v of ["1", "TRUE", "yes", ""]) expect(testRecipientBlock(i, { [LOCAL_E2E_TEST_RECIPIENTS_ENV]: v, NEXT_PUBLIC_SUPABASE_URL: LOCAL }), v).toBe("test_recipient_fictional_shop");
  });

  it("DEV-263e: the domain is NFKC + IDNA normalised and every trailing dot stripped before the reserved test", () => {
    for (const d of [
      "a@ＥＸＡＭＰＬＥ．ＣＯＭ", // full-width letters and full stop
      "a@example。com", // ideographic full stop
      "a@shop.example.com.", // one trailing dot
      "a@shop.example.com...", // several
      "a@Shop.Example.Org..",
      "a@x.ｔｅｓｔ",
      "a@x.invalid.",
      " a@ example.net ",
      "a@exa‍mple.com", // the IDNA mapping refuses it: fail closed
    ]) expect(isReservedEmailDomain(d), JSON.stringify(d)).toBe(true);
    for (const d of ["a@example.co.jp.", "a@ｓｈｏｐ．ｊｐ", "a@例え.テスト", "a@myexample.com..", "a@"]) expect(isReservedEmailDomain(d), JSON.stringify(d)).toBe(false);
    expect(normaliseEmailDomain("ＥＸＡＭＰＬＥ．ＣＯＭ..")).toBe("example.com");
    expect(normaliseEmailDomain("...")).toBeNull();
    expect(testRecipientBlock({ publicEmail: "info@tamaki-demo.example.com.", channel: "email", factsPack: null }, {})).toBe("test_recipient_reserved_domain");
  });

  it("DEV-263e: the local flag counts only when the Supabase URL is a loopback host", () => {
    const i = { publicEmail: "a@example.com", channel: "email", factsPack: "fictional-x" };
    for (const url of [LOCAL, "http://localhost:54321", "http://127.0.0.2:54321", "http://[::1]:54321"]) {
      expect(isLoopbackSupabaseUrl(url), url).toBe(true);
      expect(testRecipientBlock(i, { [LOCAL_E2E_TEST_RECIPIENTS_ENV]: "true", NEXT_PUBLIC_SUPABASE_URL: url }), url).toBeNull();
    }
    for (const url of [undefined, "", "not a url", "https://abcdefgh.supabase.co", "http://localhost.example.com", "http://127.0.0.1.nip.io", "http://10.0.0.1:54321", "http://192.168.1.2:54321"]) {
      expect(isLoopbackSupabaseUrl(url), String(url)).toBe(false);
      expect(testRecipientBlock(i, { [LOCAL_E2E_TEST_RECIPIENTS_ENV]: "true", NEXT_PUBLIC_SUPABASE_URL: url }), String(url)).toBe("test_recipient_fictional_shop");
    }
  });
});

describe("approveSend refuses a test recipient before the database (unless the local E2E flag is set)", () => {
  beforeEach(() => {
    state.rpc.mockReset();
    state.rpc.mockResolvedValue({ data: { replayed: false }, error: null });
    vi.stubEnv(LOCAL_E2E_TEST_RECIPIENTS_ENV, "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", LOCAL);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("a reserved domain and a fictional shop are refused; the approve RPC is never called", async () => {
    const { approveSend } = await import("@/app/admin/sales/_actions/send");
    for (const [r, code] of [
      [emailRow("info@tamaki-demo.example.com"), "test_recipient_reserved_domain"],
      [emailRow("info@shop.jp", "fictional-bicycle-repair-tamaki"), "test_recipient_fictional_shop"],
    ] as const) {
      state.row = r;
      const c = composedFor(r as never)!;
      expect(await approveSend(OUTREACH, 3, { subject: c.subject, body: c.body })).toEqual({ ok: false, error: TEST_RECIPIENT_LABEL[code] });
    }
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("with the local E2E flag the same recipient is approved as before; a real-looking one always is", async () => {
    const { approveSend } = await import("@/app/admin/sales/_actions/send");
    state.row = emailRow("info@shop.jp");
    let c = composedFor(state.row as never)!;
    expect(await approveSend(OUTREACH, 3, { subject: c.subject, body: c.body })).toEqual({ ok: true });
    vi.stubEnv(LOCAL_E2E_TEST_RECIPIENTS_ENV, "true");
    state.row = emailRow("info@tamaki-demo.example.com", "fictional-bicycle-repair-tamaki");
    c = composedFor(state.row as never)!;
    expect(await approveSend(OUTREACH, 3, { subject: c.subject, body: c.body })).toEqual({ ok: true });
    expect(state.rpc).toHaveBeenCalledTimes(2);
  });

  it("DEV-263e: the flag set on a server that talks to a hosted Supabase still refuses (the RPC is never called)", async () => {
    const { approveSend } = await import("@/app/admin/sales/_actions/send");
    vi.stubEnv(LOCAL_E2E_TEST_RECIPIENTS_ENV, "true");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abcdefgh.supabase.co");
    state.row = emailRow("info@tamaki-demo.example.com", "fictional-bicycle-repair-tamaki");
    const c = composedFor(state.row as never)!;
    expect(await approveSend(OUTREACH, 3, { subject: c.subject, body: c.body })).toEqual({ ok: false, error: TEST_RECIPIENT_LABEL.test_recipient_fictional_shop });
    expect(state.rpc).not.toHaveBeenCalled();
  });
});
