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
type Faults = Record<string, boolean>;
function fixture(overrides: {
  prospect?: Record<string, unknown>; demo?: Record<string, unknown>;
  stored?: Record<string, unknown> | null; exclusions?: Record<string, unknown>[]; faults?: Faults;
} = {}) {
  const calls: string[] = [];
  const filters: string[] = [];
  const rows: Record<string, unknown> = {
    sales_prospects: {
      id: prospectId, name: "架空パン工房 灯", address: "架空市架空区", do_not_contact: false,
      instagram_handle: "fictional_lamp", website_domain: null, public_email: null,
      normalized_name: "架空パン工房灯", normalized_address: "架空市架空区", sources: [],
      ...overrides.prospect,
    },
    sales_demos: { id: demoId, prospect_id: prospectId, disabled_at: null, expires_at: null, content: demoContentWithFactsSha(bytes), ...overrides.demo },
    sales_demo_facts_packs: overrides.stored === null ? [] : [{
      id: "facts-1", seq: 1, demo_id: demoId, shop_id: "fictional-bakery-lamp",
      facts_sha256: hash, facts_pack_text: text, recorded_at: "2026-11-17", recorded_via: "admin_session",
      ...overrides.stored,
    }],
    sales_exclusions: overrides.exclusions ?? [],
  };
  // The column each table may be filtered by (a query on the wrong column fails the test).
  const keyColumn: Record<string, string> = { sales_prospects: "id", sales_demos: "prospect_id", sales_demo_facts_packs: "prospect_id" };
  const client = {
    from(table: string) {
      calls.push(table);
      const result = () => ({ error: overrides.faults?.[table] ? { code: "DB_ERR" } : null });
      const make = {
        select: () => make,
        eq: (col: string, value: unknown) => {
          if (col !== keyColumn[table] || value !== prospectId) throw new Error(`unexpected filter ${table}.${col}`);
          return make;
        },
        or: (expr: string) => { filters.push(expr); return make; },
        order: () => make,
        limit: () => Promise.resolve({ data: rows[table] ?? [], ...result() }),
        maybeSingle: () => Promise.resolve({ data: rows[table] ?? null, ...result() }),
      };
      return make;
    },
  } as unknown as SupabaseClient;
  return { client, calls, filters };
}

const exclusion = (over: Record<string, unknown>) => ({
  reason: "existing_customer", instagram_handle: null, website_domain: null, email_digest: null,
  normalized_name: null, normalized_address: null, ...over,
});

describe("registered candidate facts → read-only B-route generation preflight", () => {
  it("returns only the current owner's exact facts bytes and SHA, not ingest guesses", async () => {
    const f = fixture();
    const result = await loadVerifiedGenerationFacts(f.client, prospectId);
    expect(result).toMatchObject({
      prospectId, demoId, factsPackId: "facts-1", shopId: "fictional-bakery-lamp", factsSha256: hash,
    });
    expect(Buffer.from(result.factsBytes).equals(bytes)).toBe(true);
    expect(f.calls).toEqual(["sales_prospects", "sales_exclusions", "sales_demos", "sales_demo_facts_packs"]);
    expect(f.filters).toEqual(['instagram_handle.in.("fictional_lamp"),normalized_name.in.("架空パン工房灯")']);
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
    for (const [overrides, code] of [
      [{ stored: { facts_sha256: "0".repeat(64) } }, "OWNER_FACTS_LINEAGE_MISMATCH"],
      [{ stored: { demo_id: prospectId } }, "OWNER_FACTS_LINEAGE_MISMATCH"],
      [{ stored: { shop_id: "another-shop" } }, "OWNER_FACTS_INVALID"],
      [{ demo: { content: { ...demoContentWithFactsSha(bytes), hours: "unverified" } } }, "TRUSTED_FACTS_CONTENT_MISMATCH"],
    ] as const) {
      const f = fixture(overrides);
      const err = await loadVerifiedGenerationFacts(f.client, prospectId).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GenerationFactsStop);
      expect(err).toMatchObject({ code });
    }
  });
  it("holds a mismatched registry identity (name or address) even if a pack was registered", async () => {
    for (const prospect of [{ address: "別の場所" }, { name: "別の架空店" }, { name: null }]) {
      const f = fixture({ prospect });
      await expect(loadVerifiedGenerationFacts(f.client, prospectId)).rejects.toMatchObject({ code: "PROSPECT_FACTS_IDENTITY_HOLD" });
    }
  });
  it("stops a malformed id, an unknown prospect, unknown DNC and an unreadable facts store", async () => {
    await expect(loadVerifiedGenerationFacts(fixture().client, "not-a-uuid")).rejects.toMatchObject({ code: "PROSPECT_ID_INVALID" });
    const missing = fixture({ faults: { sales_prospects: true } });
    await expect(loadVerifiedGenerationFacts(missing.client, prospectId)).rejects.toMatchObject({ code: "PROSPECT_NOT_AVAILABLE" });
    const dncUnknown = fixture({ prospect: { do_not_contact: null } });
    await expect(loadVerifiedGenerationFacts(dncUnknown.client, prospectId)).rejects.toMatchObject({ code: "PROSPECT_DNC_OR_UNKNOWN" });
    const store = fixture({ faults: { sales_demo_facts_packs: true } });
    await expect(loadVerifiedGenerationFacts(store.client, prospectId)).rejects.toBeInstanceOf(GenerationFactsStop);
  });
  it("stops an excluded shop (PR #280 review M1) and an unreadable exclusion list, before the demo is read", async () => {
    for (const ex of [
      exclusion({ instagram_handle: "fictional_lamp" }),
      exclusion({ normalized_name: "架空パン工房灯", normalized_address: "架空市架空区", reason: "partner" }),
    ]) {
      const f = fixture({ exclusions: [ex] });
      await expect(loadVerifiedGenerationFacts(f.client, prospectId)).rejects.toMatchObject({ code: "PROSPECT_EXCLUDED_OR_UNKNOWN" });
      expect(f.calls).toEqual(["sales_prospects", "sales_exclusions"]);
    }
    // same name at another address is not this shop
    const other = fixture({ exclusions: [exclusion({ normalized_name: "架空パン工房灯", normalized_address: "別の架空市" })] });
    await expect(loadVerifiedGenerationFacts(other.client, prospectId)).resolves.toMatchObject({ demoId });
    const unreadable = fixture({ faults: { sales_exclusions: true } });
    await expect(loadVerifiedGenerationFacts(unreadable.client, prospectId)).rejects.toMatchObject({ code: "PROSPECT_EXCLUDED_OR_UNKNOWN" });
  });
  it("stops an expired demo (PR #280 review L4)", async () => {
    const now = new Date("2026-11-17T00:00:00Z");
    const expired = fixture({ demo: { expires_at: "2026-11-16T00:00:00Z" } });
    await expect(loadVerifiedGenerationFacts(expired.client, prospectId, now)).rejects.toMatchObject({ code: "DEMO_NOT_ELIGIBLE" });
    const live = fixture({ demo: { expires_at: "2026-12-01T00:00:00Z" } });
    await expect(loadVerifiedGenerationFacts(live.client, prospectId, now)).resolves.toMatchObject({ demoId });
  });
  it("rejects disabled demos or DB errors; never writes", async () => {
    const disabled = fixture({ demo: { disabled_at: "2026-11-17T00:00:00Z" } });
    await expect(loadVerifiedGenerationFacts(disabled.client, prospectId)).rejects.toMatchObject({ code: "DEMO_NOT_ELIGIBLE" });
    const error = fixture({ faults: { sales_demos: true } });
    await expect(loadVerifiedGenerationFacts(error.client, prospectId)).rejects.toMatchObject({ code: "DEMO_NOT_AVAILABLE" });
  });
});
