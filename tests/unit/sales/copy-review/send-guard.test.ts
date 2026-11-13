import { beforeEach, describe, expect, it, vi } from "vitest";
import { composedFor } from "@/lib/admin/initial-send";
import { COPY_SEND_CODES, COPY_SEND_LABEL } from "@/lib/sales/copy-review/labels";

// DEV-199e: the server's copy guard in 「この内容で送信を承認」 (app/admin/sales/_actions/send.ts): a quality-approved
// version whose copy gate refuses never reaches the database's approve RPC; a demo without an approved version (the
// React demo) is approved exactly as before. The gate itself: gate.test.ts; the database: the integration test.

const state = vi.hoisted(() => ({ row: null as unknown, rpc: vi.fn(), gate: { legacy: true } as unknown, gateCalls: 0, realGate: false }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/admin/auth", () => ({ requireAdmin: vi.fn(async () => undefined), requireAdminPage: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/server", () => ({
  createAuthClient: vi.fn(async () => {
    const chain = { select: () => chain, eq: () => chain, in: () => chain, order: () => chain, maybeSingle: async () => ({ data: state.row, error: null }) };
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
