import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { loadFunnelSection } from "@/lib/admin/history";

// DEV-057: the 履歴 funnel section loads its two views independently. A view
// that cannot be read (e.g. before migration 20261020110000) hides only its
// own part, and with the AI design step off sales_design_daily is not read.

const now = new Date("2026-10-19T03:00:00Z"); // 直近 30 日 starts 2026-09-20 (JST)

const funnelRow = {
  prepared_on: "2026-10-01",
  prepared: 3,
  skipped: 1,
  unsent: 0,
  sent: 2,
  replied: 1,
  meetings: 0,
  won: 0,
  won_amount_jpy: 0,
  reply_interested: 1,
  reply_question: 0,
  reply_meeting_request: 0,
  reply_decline: 0,
  reply_other: 0,
  dnc: 0,
};
const designRow = { prepared_on: "2026-10-01", design_status: "blocked", design_error_code: "QUALITY_NOT_ACCEPTED", demos: 2 };

function fakeClient(failing: string[] = []) {
  const calls: Array<{ view: string; since?: unknown }> = [];
  const client = {
    from(view: string) {
      const call: { view: string; since?: unknown } = { view };
      calls.push(call);
      const builder = {
        select: () => builder,
        gte: (_col: string, value: unknown) => {
          call.since = value;
          return builder;
        },
        order: async () =>
          failing.includes(view)
            ? { data: null, error: { code: "42P01", message: `relation "public.${view}" does not exist` } }
            : { data: view === "sales_funnel_daily" ? [funnelRow] : [designRow], error: null },
      };
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

describe("loadFunnelSection", () => {
  it("with the AI design step off, reads only the funnel view", async () => {
    const { client, calls } = fakeClient();
    const section = await loadFunnelSection(client, "30d", now, false);
    expect(calls).toEqual([{ view: "sales_funnel_daily", since: "2026-09-20" }]);
    expect(section.design).toBeNull();
    expect(section.funnel).toMatchObject({ prepared: 3, skipped: 1, sent: 2, replied: 1 });
  });

  it("with the step on, reads both views for the same period", async () => {
    const { client, calls } = fakeClient();
    const section = await loadFunnelSection(client, "all", now, true);
    expect(calls.map((c) => c.view).sort()).toEqual(["sales_design_daily", "sales_funnel_daily"]);
    expect(calls.every((c) => c.since === undefined)).toBe(true);
    expect(section.design).toMatchObject({ total: 2, topErrors: [{ code: "QUALITY_NOT_ACCEPTED", count: 2 }] });
  });

  it("a missing funnel view hides only the funnel; the design results still load", async () => {
    const { client } = fakeClient(["sales_funnel_daily"]);
    const section = await loadFunnelSection(client, "30d", now, true);
    expect(section.funnel).toBeNull();
    expect(section.design).toMatchObject({ total: 2 });
  });

  it("a missing design view hides only the design results", async () => {
    const { client } = fakeClient(["sales_design_daily"]);
    const section = await loadFunnelSection(client, "30d", now, true);
    expect(section.design).toBe("unavailable");
    expect(section.funnel).toMatchObject({ prepared: 3 });
  });
});
