import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { demoContentWithFactsSha, factsPackSha256 } from "@/lib/demo-version-package/facts-content";
import { GenerationFactsStop, loadVerifiedGenerationFacts } from "@/lib/sales/b-route/verified-generation-facts";

const prospectId = "cb773e36-3e9a-433d-9b4e-f73ab2c5cb01";
const demoId = "cb773e36-3e9a-433d-9b4e-f73ab2c5cb02";
const facts = [
  { id: "F1", key: "name", value: "架空パン工房 灯", source_id: "S1" },
  { id: "F2", key: "category", value: "bakery", source_id: "S1" },
  { id: "F3", key: "address", value: "架空市架空区", source_id: "S1" },
  { id: "F4", key: "description", value: "架空の確認用パン工房です。", source_id: "S1" },
];
const bytes = Buffer.from(JSON.stringify({ schema: "shop_facts_pack_v1", shop_id: "fictional-bakery-lamp", facts }));
const text = bytes.toString("utf8");
const hash = factsPackSha256(bytes);
function fixture(overrides: {
  prospect?: Record<string, unknown>; demo?: Record<string, unknown>;
  stored?: Record<string, unknown> | null; faults?: Record<string, boolean>;
} = {}) {
  const calls: string[] = [];
  const rows: Record<string, unknown> = {
    sales_prospects: { id: prospectId, name: "架空パン工房 灯", address: "架空市架空区", do_not_contact: false, ...overrides.prospect },
    sales_demos: { id: demoId, prospect_id: prospectId, disabled_at: null, content: demoContentWithFactsSha(bytes), ...overrides.demo },
    sales_demo_facts_packs: overrides.stored === null ? [] : [{
      id: "facts-1", seq: 1, demo_id: demoId, shop_id: "fictional-bakery-lamp",
      facts_sha256: hash, facts_pack_text: text, recorded_at: "2026-11-17", recorded_via: "owner",
      ...overrides.stored,
    }],
  };
  const client = {
    from(table: string) {
      calls.push(table);
      const make = {
        select: (_cols: string) => make,
        eq: (_col: string, _value: unknown) => make,
        order: (_col: string, _opts: unknown) => make,
        limit: (_count: number) => Promise.resolve({
          data: rows[table] ?? [], error: overrides.faults?.[table] ? { code: "DB_ERR" } : null,
        }),
        maybeSingle: () => Promise.resolve({
          data: rows[table] ?? null, error: overrides.faults?.[table] ? { code: "DB_ERR" } : null,
        }),
      };
      return make;
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

describe("registered candidate facts → read-only B-route generation preflight", () => {
  it("returns only the current owner's exact facts bytes and SHA, not ingest guesses", async () => {
    const f = fixture();
    const result = await loadVerifiedGenerationFacts(f.client, prospectId);
    expect(result).toMatchObject({
      prospectId, demoId, factsPackId: "facts-1", shopId: "fictional-bakery-lamp", factsSha256: hash,
    });
    expect(Buffer.from(result.factsBytes).equals(bytes)).toBe(true);
    expect(f.calls).toEqual(["sales_prospects", "sales_demos", "sales_demo_facts_packs"]);
  });
  it("stops DNC before querying demo or facts", async () => {
    const f = fixture({ prospect: { do_not_contact: true } });
    await expect(loadVerifiedGenerationFacts(f.client, prospectId)).rejects.toMatchObject({ code: "PROSPECT_DNC_OR_UNKNOWN" });
    expect(f.calls).toEqual(["sales_prospects"]);
  });
  it("HOLDs when the owner has not registered facts", async () => {
    const f = fixture({ stored: null });
    await expect(loadVerifiedGenerationFacts(f.client, prospectId)).rejects.toMatchObject({ code: "OWNER_FACTS_MISSING" });
  });
  it("rejects changed facts bytes, stale demo content and wrong demo lineage", async () => {
    for (const overrides of [
      { stored: { facts_sha256: "0".repeat(64) } },
      { stored: { demo_id: prospectId } },
      { demo: { content: { ...demoContentWithFactsSha(bytes), hours: "unverified" } } },
    ]) {
      const f = fixture(overrides);
      await expect(loadVerifiedGenerationFacts(f.client, prospectId)).rejects.toBeInstanceOf(GenerationFactsStop);
    }
  });
  it("holds a mismatched registry identity even if a pack was registered", async () => {
    const f = fixture({ prospect: { address: "別の場所" } });
    await expect(loadVerifiedGenerationFacts(f.client, prospectId)).rejects.toMatchObject({ code: "PROSPECT_FACTS_IDENTITY_HOLD" });
  });
  it("rejects disabled demos or DB errors; never writes", async () => {
    const disabled = fixture({ demo: { disabled_at: "2026-11-17T00:00:00Z" } });
    await expect(loadVerifiedGenerationFacts(disabled.client, prospectId)).rejects.toMatchObject({ code: "DEMO_NOT_ELIGIBLE" });
    const error = fixture({ faults: { sales_demos: true } });
    await expect(loadVerifiedGenerationFacts(error.client, prospectId)).rejects.toMatchObject({ code: "DEMO_NOT_AVAILABLE" });
  });
});
