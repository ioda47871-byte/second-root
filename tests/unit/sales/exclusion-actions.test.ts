import { beforeEach, describe, expect, it, vi } from "vitest";

// DEV-049: the server action refuses an over-long or malformed field instead
// of silently dropping it (which would save an entry without that key), and
// passes normalised keys to the admin RPC.

const state = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/admin/auth", () => ({ requireAdmin: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/server", () => ({ createAuthClient: vi.fn(async () => ({ rpc: state.rpc })) }));

import { addExclusion, removeExclusion } from "@/app/admin/sales/_actions/exclusions";
import { emailDigest } from "@/lib/sales/email-digest";
import nextConfig from "../../../next.config";

beforeEach(() => {
  state.rpc.mockReset();
  state.rpc.mockResolvedValue({ data: "id", error: null });
});

describe("addExclusion", () => {
  it.each([
    ["an over-long key", { label: "店", reason: "existing_customer", website: "https://shop.example.jp/", instagram: "x".repeat(1001) }],
    ["a non-string key", { label: "店", reason: "existing_customer", email: 123 }],
    ["a non-object input", "instagram=foo"],
    ["null", null],
  ])("refuses %s without calling the database", async (_label, raw) => {
    const result = await addExclusion(raw as never);
    expect(result.ok).toBe(false);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("sends the normalised keys to sales_add_exclusion", async () => {
    const result = await addExclusion({ label: " 既存のお客様 ", reason: "existing_customer", instagram: "@Mugi_No_Mi", email: "Info@Example.JP" });
    expect(result).toEqual({ ok: true });
    expect(state.rpc).toHaveBeenCalledWith("sales_add_exclusion", {
      p_label: "既存のお客様",
      p_reason: "existing_customer",
      p_note: null,
      p_instagram_handle: "mugi_no_mi",
      p_website_domain: null,
      p_email_digest: emailDigest("info@example.jp"),
      p_normalized_name: null,
      p_normalized_address: null,
    });
  });

  it("DEV-050: never passes the email itself to the database, logs or errors", async () => {
    const logs: unknown[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a) => void logs.push(a)));
    try {
      const ok = await addExclusion({ label: "店", reason: "existing_customer", email: "Owner@Customer.Example.JP" });
      expect(ok).toEqual({ ok: true });
      state.rpc.mockResolvedValue({ data: null, error: { message: "already_excluded" } });
      const dup = await addExclusion({ label: "店", reason: "existing_customer", email: "Owner@Customer.Example.JP" });
      const seen = JSON.stringify([state.rpc.mock.calls, ok, dup, logs]).toLowerCase();
      expect(seen).not.toContain("owner@customer.example.jp");
      expect(seen).not.toContain("customer.example");
      expect(state.rpc.mock.calls[0][1]).toMatchObject({ p_email_digest: emailDigest("owner@customer.example.jp") });
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });

  it("maps a duplicate to a clear message", async () => {
    state.rpc.mockResolvedValue({ data: null, error: { message: "already_excluded" } });
    const result = await addExclusion({ label: "店", reason: "other", instagram: "mugi_no_mi" });
    expect(result).toEqual({ ok: false, error: expect.stringContaining("すでに除外リスト") });
  });
});

describe("removeExclusion", () => {
  it("refuses a malformed id without calling the database", async () => {
    expect((await removeExclusion("not-a-uuid")).ok).toBe(false);
    expect(state.rpc).not.toHaveBeenCalled();
  });
});

describe("DEV-050: development logging", () => {
  it("does not log Server Function arguments (emails, DM text, reply drafts) in next dev", () => {
    expect(nextConfig.logging).toMatchObject({ serverFunctions: false });
  });
});
