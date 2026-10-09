import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TodayItem } from "@/lib/admin/today";
import type { DesignStatus } from "@/lib/sales/design";

// DEV-030: with the AI design step on, a first message whose demo is still
// waiting for (pending) or getting (processing) its design is neither offered
// on the today screen nor accepted by 送信済み. With the step off, both are
// exactly as before. Also the bridge route's size / JSON / echo handling.

const state = vi.hoisted(() => ({
  designStatus: null as unknown,
  rpc: vi.fn(),
  items: [] as unknown[],
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/admin/auth", () => ({ requireAdmin: vi.fn(async () => undefined), requireAdminPage: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/server", () => ({
  createAuthClient: vi.fn(async () => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => ({ data: { prospect: { demo: [{ design_status: state.designStatus }] } }, error: null }),
    };
    return { from: () => chain, rpc: state.rpc };
  }),
}));
vi.mock("@/lib/admin/today", async (original) => ({
  ...(await original<typeof import("@/lib/admin/today")>()),
  loadTodayQueue: vi.fn(async () => state.items),
}));

const OUTREACH = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

beforeEach(() => {
  state.rpc.mockReset();
  state.rpc.mockResolvedValue({ data: null, error: null });
});
afterEach(() => vi.unstubAllEnvs());

describe("markSent", () => {
  it.each(["pending", "processing"] as const)("refuses %s with the step on, without calling the database function", async (status) => {
    vi.stubEnv("SALES_AI_DESIGN_ENABLED", "true");
    state.designStatus = status;
    const { markSent } = await import("@/app/admin/sales/_actions/send");
    expect(await markSent(OUTREACH)).toEqual({ ok: false, error: "AIデザインの完成前のため送信済みにできません。" });
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it.each([null, "ready", "blocked", "failed"] as const)("allows %s with the step on", async (status) => {
    vi.stubEnv("SALES_AI_DESIGN_ENABLED", "true");
    state.designStatus = status;
    const { markSent } = await import("@/app/admin/sales/_actions/send");
    expect(await markSent(OUTREACH)).toEqual({ ok: true });
    expect(state.rpc).toHaveBeenCalledWith("sales_mark_sent", { p_outreach_id: OUTREACH });
  });

  it("with the step off, does not look at the design at all (legacy)", async () => {
    state.designStatus = "pending";
    const { markSent } = await import("@/app/admin/sales/_actions/send");
    expect(await markSent(OUTREACH)).toEqual({ ok: true });
    expect(state.rpc).toHaveBeenCalledTimes(1);
  });
});

function item(designStatus: DesignStatus | null): TodayItem {
  return {
    kind: "initial",
    prospectId: "11111111-2222-4333-8444-555555555555",
    doNotContact: false,
    since: new Date(),
    outreachId: OUTREACH,
    channel: "instagram",
    shopName: "テスト工房",
    category: "bakery",
    ward: "中区",
    subject: null,
    body: "テスト用の営業文です。",
    instagramUrl: "https://www.instagram.com/test_shop/",
    publicEmail: null,
    demoToken: "A".repeat(43),
    sentAt: null,
    designStatus,
  };
}

async function todayHtml(status: DesignStatus | null): Promise<string> {
  state.items = [item(status)];
  const { default: TodayPage } = await import("@/app/admin/sales/page");
  return renderToStaticMarkup(await TodayPage());
}

describe("today screen action", () => {
  it.each(["pending", "processing"] as const)("%s with the step on: no DM action, a waiting note", async (status) => {
    vi.stubEnv("SALES_AI_DESIGN_ENABLED", "true");
    const html = await todayHtml(status);
    expect(html).toContain('data-testid="design-wait"');
    expect(html).not.toContain("DMを送る");
  });

  it.each([null, "ready", "blocked", "failed"] as const)("%s with the step on: the DM action as before", async (status) => {
    vi.stubEnv("SALES_AI_DESIGN_ENABLED", "true");
    const html = await todayHtml(status);
    expect(html).not.toContain('data-testid="design-wait"');
    expect(html).toContain("DMを送る");
  });

  it("with the step off, the DM action whatever the stored state", async () => {
    const html = await todayHtml("pending");
    expect(html).not.toContain('data-testid="design-wait"');
    expect(html).toContain("DMを送る");
  });
});

describe("bridge route input handling", () => {
  const TOKEN = "bridge-token-0123456789abcdef-0123456789";
  const call = async (body: string, headers: Record<string, string> = {}) => {
    const { POST } = await import("@/app/api/internal/sales-design/jobs/route");
    return POST(new NextRequest("http://localhost/api/internal/sales-design/jobs", { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...headers }, body }));
  };
  beforeEach(() => {
    vi.stubEnv("SALES_AI_DESIGN_ENABLED", "true");
    vi.stubEnv("SALES_DESIGN_BRIDGE_TOKEN_SHA256", createHash("sha256").update(TOKEN).digest("hex"));
  });

  it("refuses bodies over 32 KB, invalid JSON and invalid requests without echoing values", async () => {
    expect((await call(JSON.stringify({ action: "claim", pad: "x".repeat(40_000) }))).status).toBe(413);
    expect((await call("{not json")).status).toBe(400);
    const res = await call(JSON.stringify({ action: "submit", jobId: "secret-looking-value", screenshot: "iVBORw0KGgo=" }));
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toMatch(/secret-looking-value|iVBORw0KGgo|screenshot/);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
