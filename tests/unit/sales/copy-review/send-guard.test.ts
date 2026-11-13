import { beforeEach, describe, expect, it, vi } from "vitest";
import { composedFor } from "@/lib/admin/initial-send";
import { COPY_SEND_CODES, COPY_SEND_LABEL } from "@/lib/sales/copy-review/labels";

// DEV-199e: the server's copy guard in 「この内容で送信を承認」 (app/admin/sales/_actions/send.ts): a quality-approved
// version whose copy gate refuses never reaches the database's approve RPC; a demo without an approved version (the
// React demo) is approved exactly as before. The gate itself: gate.test.ts; the database: the integration test.

const state = vi.hoisted(() => ({ row: null as unknown, rowError: null as unknown, rpc: vi.fn(), gate: { legacy: true } as unknown, gateCalls: 0, realGate: false }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/admin/auth", () => ({ requireAdmin: vi.fn(async () => undefined), requireAdminPage: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/server", () => ({
  createAuthClient: vi.fn(async () => {
    const chain = { select: () => chain, eq: () => chain, in: () => chain, order: () => chain, maybeSingle: async () => ({ data: state.rowError ? null : state.row, error: state.rowError }) };
    return { from: () => chain, rpc: state.rpc };
  }),
}));
vi.mock("@/lib/sales/copy-review/store", async (orig) => {
  const real = await orig<typeof import("@/lib/sales/copy-review/store")>();
  return {
    ...real,
    outreachCopyGate: vi.fn(async (...a: Parameters<typeof real.outreachCopyGate>) => {
      state.gateCalls += 1;
      return state.realGate ? real.outreachCopyGate(...a) : state.gate;
    }),
  };
});

const OUTREACH = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const TOKEN = "A".repeat(43);
const row = (demo: Record<string, unknown>) => ({
  id: OUTREACH,
  kind: "initial",
  status: "drafted",
  channel: "instagram",
  subject: null,
  body: "テスト用の営業文です。",
  draft_version: 3,
  prospect: { name: "テスト工房", public_email: null, instagram_url: "https://www.instagram.com/test_shop/", instagram_handle: "test_shop", demo: [{ public_token: TOKEN, disabled_at: null, ...demo }] },
});

beforeEach(() => {
  state.rpc.mockReset();
  state.rpc.mockResolvedValue({ data: { replayed: false }, error: null });
  state.row = row({});
  state.gate = { legacy: true };
  state.gateCalls = 0;
  state.realGate = false;
  state.rowError = null;
  // DEV-196g: a versioned send needs the share flag on (the flag-off refusal has its own describe below)
  vi.unstubAllEnvs();
  vi.stubEnv("SALES_DEMO_VERSIONS_ENABLED", "true");
  vi.stubEnv("SALES_DEMO_SHARE_ENABLED", "true");
});

describe("DEV-196g (PR #267 M1): with the share flag off, a versioned send is refused; the React demo is unchanged", () => {
  it.each([undefined, "false", "TRUE"])("SALES_DEMO_SHARE_ENABLED=%s: approve and open refuse a versioned send before the database", async (flag) => {
    const { VERSIONED_SEND_SHARE_OFF } = await import("@/lib/sales/demo-version/admin-messages");
    const { approveSend, markSendOpened } = await import("@/app/admin/sales/_actions/send");
    if (flag === undefined) vi.stubEnv("SALES_DEMO_SHARE_ENABLED", undefined as never);
    else vi.stubEnv("SALES_DEMO_SHARE_ENABLED", flag);
    state.gate = { legacy: false, ok: true };
    const body = composedFor(state.row as never)!.body;
    expect(await approveSend(OUTREACH, 3, { subject: null, body })).toEqual({ ok: false, error: VERSIONED_SEND_SHARE_OFF });
    state.row = { demo_version_id: "cccccccc-0000-4000-8000-000000000001" };
    expect(await markSendOpened("dddddddd-0000-4000-8000-000000000001", "copy")).toEqual({ ok: false, error: VERSIONED_SEND_SHARE_OFF });
    expect(state.rpc).not.toHaveBeenCalled();
  });
  it("flag off: the React demo (legacy) is approved and opened as before", async () => {
    const { approveSend, markSendOpened } = await import("@/app/admin/sales/_actions/send");
    vi.stubEnv("SALES_DEMO_SHARE_ENABLED", "false");
    const body = composedFor(state.row as never)!.body;
    expect(await approveSend(OUTREACH, 3, { subject: null, body })).toEqual({ ok: true });
    state.row = { demo_version_id: null };
    expect(await markSendOpened("dddddddd-0000-4000-8000-000000000001", "copy")).toEqual({ ok: true });
  });
  it("DEV-263e (PR #267 delta Low): flag off — an unread copy gate and an unreadable pin are refused (fail closed)", async () => {
    const { VERSIONED_SEND_SHARE_OFF } = await import("@/lib/sales/demo-version/admin-messages");
    const { approveSend, markSendOpened } = await import("@/app/admin/sales/_actions/send");
    vi.stubEnv("SALES_DEMO_SHARE_ENABLED", "false");
    state.gate = { legacy: true, unread: true };
    const body = composedFor(state.row as never)!.body;
    expect(await approveSend(OUTREACH, 3, { subject: null, body })).toEqual({ ok: false, error: VERSIONED_SEND_SHARE_OFF });
    state.rowError = { message: "boom" };
    const opened = await markSendOpened("dddddddd-0000-4000-8000-000000000001", "copy");
    expect(opened.ok).toBe(false);
    expect(state.rpc).not.toHaveBeenCalled();
  });
  it("DEV-263e: flag on — an unread copy gate is left to the database's guards as before", async () => {
    const { approveSend } = await import("@/app/admin/sales/_actions/send");
    state.gate = { legacy: true, unread: true };
    const body = composedFor(state.row as never)!.body;
    expect(await approveSend(OUTREACH, 3, { subject: null, body })).toEqual({ ok: true });
    expect(state.rpc).toHaveBeenCalledTimes(1);
  });
});

describe("approveSend: the copy guard of a quality-approved version", () => {
  it("the React demo (no approved version): the gate is consulted, says legacy, and the approval goes to the database as before", async () => {
    const { approveSend } = await import("@/app/admin/sales/_actions/send");
    const body = composedFor(state.row as never)!.body;
    expect(await approveSend(OUTREACH, 3, { subject: null, body })).toEqual({ ok: true });
    expect(state.gateCalls).toBe(1);
    expect(state.rpc).toHaveBeenCalledWith("sales_approve_outreach", expect.anything());
  });

  it.each(COPY_SEND_CODES)("refuses %s before the database with the owner's words", async (code) => {
    const { approveSend } = await import("@/app/admin/sales/_actions/send");
    state.gate = { legacy: false, ok: false, code, details: [] };
    const body = composedFor(state.row as never)!.body;
    expect(await approveSend(OUTREACH, 3, { subject: null, body })).toEqual({ ok: false, error: COPY_SEND_LABEL[code] });
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("the copy gate passing does not skip the database (it decides again)", async () => {
    const { approveSend } = await import("@/app/admin/sales/_actions/send");
    state.gate = { legacy: false, ok: true };
    const body = composedFor(state.row as never)!.body;
    expect(await approveSend(OUTREACH, 3, { subject: null, body })).toEqual({ ok: true });
    expect(state.rpc).toHaveBeenCalledWith("sales_approve_outreach", expect.anything());
  });

  it("the real loader: an approved version whose store cannot be read is refused (fail closed); no approved version is legacy", async () => {
    const { approveSend } = await import("@/app/admin/sales/_actions/send");
    state.realGate = true;
    state.row = row({ approved_version_id: "cccccccc-0000-4000-8000-000000000001" });
    const body = composedFor(state.row as never)!.body;
    expect(await approveSend(OUTREACH, 3, { subject: null, body })).toEqual({ ok: false, error: COPY_SEND_LABEL.demo_copy_review_unverifiable });
    expect(state.rpc).not.toHaveBeenCalled();
    state.row = row({ approved_version_id: null });
    expect(await approveSend(OUTREACH, 3, { subject: null, body })).toEqual({ ok: true });
  });
});

describe("PR #262 L1 / L2 / L4", () => {
  it("L1: when the demo cannot be read, the path is unknown: no server refusal (the database's guard decides)", async () => {
    const { outreachCopyGate } = await vi.importActual<typeof import("@/lib/sales/copy-review/store")>("@/lib/sales/copy-review/store");
    const chainOf = (result: unknown) => {
      const c = { select: () => c, eq: () => c, in: () => c, order: () => c, maybeSingle: async () => result };
      return { from: () => c };
    };
    expect(await outreachCopyGate(chainOf({ data: null, error: { message: "boom" } }) as never, OUTREACH)).toEqual({ legacy: true, unread: true });
    // a demo known to be on the versioned path whose version cannot be loaded still fails closed
    expect(await outreachCopyGate(chainOf({ data: { prospect: { demo: { approved_version_id: "not-a-uuid" } } }, error: null }) as never, OUTREACH)).toMatchObject({ legacy: false, ok: false, code: "demo_copy_review_unverifiable" });
  });

  it("L1: approveSend lets an unread (legacy-or-unknown) path through to the database", async () => {
    const { approveSend } = await import("@/app/admin/sales/_actions/send");
    state.gate = { legacy: true, unread: true };
    const body = composedFor(state.row as never)!.body;
    expect(await approveSend(OUTREACH, 3, { subject: null, body })).toEqual({ ok: true });
    expect(state.rpc).toHaveBeenCalledWith("sales_approve_outreach", expect.anything());
  });

  it("L2: the admin screen's send stop mirrors the database: demo_not_shareable first, then the copy guard", async () => {
    const { lastSendStops } = await import("@/lib/sales/demo-version/view-model");
    const { SEND_BLOCK_LABEL } = await import("@/lib/sales/demo-version/admin-messages");
    expect(lastSendStops(["versioned_sharing_disabled"], "demo_copy_review_missing")).toEqual({ code: "demo_not_shareable", reasons: ["versioned_sharing_disabled"] });
    expect(lastSendStops([], undefined)).toEqual({ code: "demo_copy_review_unverifiable", reasons: [] });
    expect(lastSendStops([], null)).toBeNull();
    for (const code of COPY_SEND_CODES) {
      expect(lastSendStops([], code)).toEqual({ code, reasons: [] });
      expect(SEND_BLOCK_LABEL[code]).toBe(COPY_SEND_LABEL[code]);
    }
  });

  it("L4: approveSend is the only server entry point that calls the approve RPC", async () => {
    const { readdirSync, readFileSync } = await vi.importActual<typeof import("node:fs")>("node:fs");
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "node_modules" ? [] : walk(`${d}/${e.name}`)) : /\.(ts|tsx|mts|mjs|js)$/.test(e.name) ? [`${d}/${e.name}`] : []));
    const callers = [...["app", "components", "lib", "scripts"].flatMap(walk), "proxy.ts"].filter((f) => readFileSync(f, "utf8").includes("sales_approve_outreach"));
    expect(callers).toEqual(["app/admin/sales/_actions/send.ts"]);
    const send = readFileSync("app/admin/sales/_actions/send.ts", "utf8");
    expect(send.match(/sales_approve_outreach/g)).toHaveLength(1);
    expect(send.slice(send.indexOf("export async function approveSend"), send.indexOf('rpc("sales_approve_outreach"'))).toContain("outreachCopyGate(");
  });
});
