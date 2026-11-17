import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { factsPackSha256 } from "@/lib/demo-version-package/facts-content";
import {
  assertS0LocalApiUrl, assertS0RecordPath, assertS0WriteAllowed, parseS0SeedRecord, S0_FACTS_PATH, S0_PROSPECT_ID, S0_SEED_FLAG, S0_SEED_TABLES, S0_SHOP_ID, s0RegistryRow, s0SeedPlan,
} from "@/lib/demo-version-package/seed-s0";
import { SENDABLE_FACTS_PATH, SENDABLE_REGISTRY_ADDRESS, sendableSeedContent } from "@/lib/demo-version-package/seed-sendable";
import { loadVerifiedGenerationFacts } from "@/lib/sales/b-route/verified-generation-facts";

// DEV-139 Stage 0 (A-4): the local seed's guard and its registry row, without any database. The integration test
// (tests/integration/s0-local-seed.test.ts) runs the same seed against CI's own throwaway local Supabase.

const REPO = resolve(__dirname, "../../..");
const S0 = readFileSync(join(REPO, S0_FACTS_PATH));
const TAMAKI = readFileSync(join(REPO, SENDABLE_FACTS_PATH));
const THREE_METHODS = readFileSync(join(REPO, "design-library/research/three-methods/facts-pack.json"));
const LOCAL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const tmp = mkdtempSync(join(tmpdir(), "s0-seed-unit-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const factsOf = (b: Uint8Array) => JSON.parse(Buffer.from(b).toString("utf8")) as { shop_id: string; facts: { id: string; key: string; value: string; source_id: string }[] };
const withFact = (key: string, value: string) => {
  const p = factsOf(S0);
  p.facts.find((f) => f.key === key)!.value = value;
  return Buffer.from(`${JSON.stringify(p, null, 2)}\n`);
};

describe("the guard of seed / cleanup (before any connection)", () => {
  it("requires the explicit owner flag even for a local stack", () => {
    expect(() => assertS0WriteAllowed(["seed"], { SUPABASE_DB_URL: LOCAL })).toThrow("S0_OWNER_APPROVAL_FLAG_MISSING");
    expect(() => assertS0WriteAllowed(["seed", "--owner-approved"], { SUPABASE_DB_URL: LOCAL })).toThrow("S0_OWNER_APPROVAL_FLAG_MISSING");
    expect(assertS0WriteAllowed(["seed", S0_SEED_FLAG], { SUPABASE_DB_URL: LOCAL })).toMatchObject({ host: "127.0.0.1", port: 54322 });
    expect(assertS0WriteAllowed([S0_SEED_FLAG], { SUPABASE_DB_URL: "postgres://postgres:postgres@localhost:54322/postgres" })).toMatchObject({ host: "localhost" });
  });
  it("refuses anything but 127.0.0.1 / localhost (hosted hosts, query strings, PG* host variables, other schemes, no URL)", () => {
    const refused = (url: string | undefined, env: Record<string, string> = {}) => {
      try {
        assertS0WriteAllowed([S0_SEED_FLAG], { SUPABASE_DB_URL: url, ...env });
        return "allowed";
      } catch (e) {
        return (e as { code: string }).code;
      }
    };
    expect(refused("postgresql://postgres:pw@db.abcdefghijklmnop.supabase.co:5432/postgres")).toBe("DB_URL_NOT_LOCAL");
    expect(refused("postgresql://postgres:pw@10.0.0.5:5432/postgres")).toBe("DB_URL_NOT_LOCAL");
    expect(refused("postgresql://postgres:pw@[::1]:5432/postgres")).toBe("DB_URL_NOT_LOCAL");
    expect(refused(`${LOCAL}?host=db.example.com`)).toBe("DB_URL_NOT_LOCAL");
    expect(refused(`${LOCAL}#x`)).toBe("DB_URL_NOT_LOCAL");
    expect(refused(LOCAL, { PGHOST: "db.example.com" })).toBe("DB_URL_NOT_LOCAL");
    expect(refused("https://127.0.0.1:54321")).toBe("DB_URL_NOT_LOCAL");
    expect(refused(undefined)).toBe("DB_URL_INVALID");
  });
  it("the CLI refuses before connecting: no flag, or a hosted URL (exit 1, a code only)", () => {
    const run = (args: string[], env: Record<string, string>) => {
      const r = spawnSync("npx", ["tsx", join(REPO, "scripts/sales/demo-version/s0-local-seed.ts"), ...args], {
        cwd: REPO, encoding: "utf8", timeout: 60_000, env: { ...process.env, PGHOST: "", PGHOSTADDR: "", PGSERVICE: "", PGSERVICEFILE: "", ...env },
      });
      return { status: r.status, json: JSON.parse(r.stdout || "null") as { status: string; code: string } | null };
    };
    const rec = join(tmp, "record.json");
    // the admin id is never reached: nothing listens on these hosts, and the guard runs first
    const admin = ["--admin", "13900000-5e00-4d00-8a00-0000000000aa", "--record", rec];
    expect(run(["seed", ...admin], { SUPABASE_DB_URL: LOCAL })).toEqual({ status: 1, json: { status: "FAIL", code: "S0_OWNER_APPROVAL_FLAG_MISSING" } });
    expect(run(["seed", ...admin, S0_SEED_FLAG], { SUPABASE_DB_URL: "postgresql://postgres:pw@db.example.com:5432/postgres" })).toEqual({ status: 1, json: { status: "FAIL", code: "DB_URL_NOT_LOCAL" } });
    expect(run(["cleanup", "--record", rec], { SUPABASE_DB_URL: LOCAL })).toEqual({ status: 1, json: { status: "FAIL", code: "S0_OWNER_APPROVAL_FLAG_MISSING" } });
    expect(run(["seed", ...admin.slice(0, 2), "--record", join(REPO, "s0-record.json"), S0_SEED_FLAG], { SUPABASE_DB_URL: LOCAL })).toEqual({ status: 1, json: { status: "FAIL", code: "S0_RECORD_PATH_IN_REPO" } });
  }, 120_000);
  it("verify reads only through a local API origin (http://127.0.0.1 / localhost, no credentials)", () => {
    expect(assertS0LocalApiUrl("http://127.0.0.1:54321")).toBe("http://127.0.0.1:54321");
    expect(assertS0LocalApiUrl("http://localhost:54321/")).toBe("http://localhost:54321");
    for (const bad of ["https://abcdefghijklmnop.supabase.co", "https://127.0.0.1:54321", "http://u:p@127.0.0.1:54321", "http://127.0.0.2:54321", "http://localhost.example.com"])
      expect(() => assertS0LocalApiUrl(bad)).toThrow("SUPABASE_URL_NOT_LOCAL");
    expect(() => assertS0LocalApiUrl(undefined)).toThrow("SUPABASE_URL_INVALID");
  });
  it("the record file is outside the repository and never a link", () => {
    expect(() => assertS0RecordPath(REPO, undefined)).toThrow("S0_RECORD_PATH_MISSING");
    expect(() => assertS0RecordPath(REPO, join(REPO, "x.json"))).toThrow("S0_RECORD_PATH_IN_REPO");
    expect(() => assertS0RecordPath(REPO, "x.json", REPO)).toThrow("S0_RECORD_PATH_IN_REPO");
    expect(assertS0RecordPath(REPO, join(tmp, "ok.json"))).toBe(join(tmp, "ok.json"));
    const target = join(tmp, "target.json");
    writeFileSync(target, "{}");
    symlinkSync(target, join(tmp, "link.json"));
    expect(() => assertS0RecordPath(REPO, join(tmp, "link.json"))).toThrow("S0_RECORD_PATH_SYMLINK");
    // a directory link pointing into the repository is caught by its real path
    symlinkSync(REPO, join(tmp, "repo-link"));
    expect(() => assertS0RecordPath(REPO, join(tmp, "repo-link", "x.json"))).toThrow("S0_RECORD_PATH_IN_REPO");
    expect(() => assertS0RecordPath(REPO, join(tmp, "no-such-dir", "x.json"))).toThrow("S0_RECORD_DIR_MISSING");
  });
});

describe("the registry row is derived from the facts (the address mismatch fixed on the registry side)", () => {
  it("the S0 pack is the three-methods こむぎ灯 pack with only menu_item_N renamed service_N (same shop, same values)", () => {
    expect(S0.toString("utf8")).toBe(THREE_METHODS.toString("utf8").replaceAll('"key": "menu_item_', '"key": "service_'));
    expect(factsOf(S0).shop_id).toBe(S0_SHOP_ID);
    // the three-methods pack itself cannot enter the facts path (menu_item_ is unmapped there and in the database)
    expect(() => s0RegistryRow(THREE_METHODS)).toThrow("TRUSTED_FACTS_UNMAPPED_KEY");
  });
  it("name and address are the facts' values byte for byte, and satisfy the registry's Nagoya constraint", () => {
    const row = s0RegistryRow(S0);
    const facts = new Map(factsOf(S0).facts.map((f) => [f.key, f.value]));
    expect(row.name).toBe(facts.get("name"));
    expect(row.address).toBe(facts.get("address"));
    expect(row).toMatchObject({ id: S0_PROSPECT_ID, name: "架空パン工房 こむぎ灯", address: "名古屋市昭和区架空町二丁目8-1", normalized_address: "愛知県名古屋市昭和区架空町2-8-1", category: "bakery", ward: "昭和区" });
    // sales_prospects_nagoya: normalized_address like '愛知県名古屋市%' and address like '%名古屋市%'
    expect(row.normalized_address.startsWith("愛知県名古屋市") && row.address.includes("名古屋市")).toBe(true);
    // only reserved example.com contact data
    expect(row.public_email.endsWith("@komugi-s0.example.com") && row.website_domain === "komugi-s0.example.com").toBe(true);
  });
  it("refuses, before any write, a pack the registry could not hold exactly", () => {
    expect(() => s0RegistryRow(withFact("address", "架空市架空区架空町二丁目8-1"))).toThrow("S0_FACTS_ADDRESS_NOT_NAGOYA");
    expect(() => s0RegistryRow(withFact("category", "bicycle_repair"))).toThrow("S0_FACTS_CATEGORY_UNSUPPORTED");
    expect(() => s0RegistryRow(TAMAKI)).toThrow("S0_FACTS_NOT_S0_SHOP");
    // 環 itself: its address can never be a registry address (why its seed keeps a placeholder)
    expect(factsOf(TAMAKI).facts.find((f) => f.key === "address")!.value.includes("名古屋市")).toBe(false);
  });
  it("the plan writes one row per table, the demo content derived from the same bytes", () => {
    const plan = s0SeedPlan(S0);
    expect(plan.counts).toEqual(Object.fromEntries(S0_SEED_TABLES.map((t) => [t, 1])));
    expect(plan.demo.content.facts_pack_sha256).toBe(factsPackSha256(S0));
    expect(plan.facts_pack).toMatchObject({ shop_id: S0_SHOP_ID, facts_sha256: factsPackSha256(S0), recorded_via: "operator_cli" });
    expect(plan.outreach).toMatchObject({ kind: "initial", channel: "email", status: "drafted" });
  });
});

/** A read-only client holding exactly the planned rows (the shape PR #280 reads). */
function plannedClient(prospect: Record<string, unknown>, factsBytes: Uint8Array, content: Record<string, unknown>): SupabaseClient {
  const demoId = "13900000-5e00-4d00-8a00-0000000000d1";
  const rows: Record<string, unknown> = {
    sales_prospects: { do_not_contact: false, instagram_handle: null, sources: [{ field: "email", value: prospect.public_email }], ...prospect },
    sales_demos: { id: demoId, prospect_id: prospect.id, disabled_at: null, expires_at: null, content },
    sales_demo_facts_packs: [{ id: "13900000-5e00-4d00-8a00-0000000000f1", seq: 1, demo_id: demoId, shop_id: factsOf(factsBytes).shop_id, facts_sha256: factsPackSha256(factsBytes), facts_pack_text: Buffer.from(factsBytes).toString("utf8"), recorded_at: "2026-11-17", recorded_via: "operator_cli" }],
    sales_exclusions: [],
  };
  return {
    from(table: string) {
      const make = {
        select: () => make, eq: () => make, or: () => make, order: () => make,
        limit: () => Promise.resolve({ data: rows[table] ?? [], error: null }),
        maybeSingle: () => Promise.resolve({ data: rows[table] ?? null, error: null }),
      };
      return make;
    },
  } as unknown as SupabaseClient;
}

describe("PR #280's exact identity check, on the planned rows (the check itself unchanged)", () => {
  it("passes for the S0 seed: the registry row equals the facts", async () => {
    const plan = s0SeedPlan(S0);
    const r = await loadVerifiedGenerationFacts(plannedClient(plan.prospect, S0, plan.demo.content), S0_PROSPECT_ID);
    expect(r).toMatchObject({ prospectId: S0_PROSPECT_ID, shopId: S0_SHOP_ID, factsSha256: factsPackSha256(S0) });
    expect(Buffer.from(r.factsBytes).equals(S0)).toBe(true);
  });
  it("still HOLDs 環's seed (placeholder registry address) and a registry address one character off", async () => {
    const tamakiProspect = { id: S0_PROSPECT_ID, name: "架空自転車修理 環", address: SENDABLE_REGISTRY_ADDRESS, normalized_name: "架空自転車修理 環", normalized_address: SENDABLE_REGISTRY_ADDRESS, website_domain: "tamaki-demo.example.com", public_email: "info@tamaki-demo.example.com" };
    await expect(loadVerifiedGenerationFacts(plannedClient(tamakiProspect, TAMAKI, sendableSeedContent(TAMAKI)), S0_PROSPECT_ID)).rejects.toMatchObject({ code: "PROSPECT_FACTS_IDENTITY_HOLD" });
    const plan = s0SeedPlan(S0);
    const off = { ...plan.prospect, address: "名古屋市昭和区架空町二丁目8-2" };
    await expect(loadVerifiedGenerationFacts(plannedClient(off, S0, plan.demo.content), S0_PROSPECT_ID)).rejects.toMatchObject({ code: "PROSPECT_FACTS_IDENTITY_HOLD" });
    const normalizedOnly = { ...plan.prospect, address: plan.prospect.normalized_address };
    await expect(loadVerifiedGenerationFacts(plannedClient(normalizedOnly, S0, plan.demo.content), S0_PROSPECT_ID)).rejects.toMatchObject({ code: "PROSPECT_FACTS_IDENTITY_HOLD" });
  });
});

describe("the seed record (the cleanup's only input)", () => {
  const ok = {
    schema: "s0_local_seed_record_v1", prospect_id: S0_PROSPECT_ID, shop_id: S0_SHOP_ID, facts_sha256: factsPackSha256(S0),
    rows: {
      sales_prospects: [S0_PROSPECT_ID], sales_sources: ["13900000-5e00-4d00-8a00-0000000000a1"], sales_demos: ["13900000-5e00-4d00-8a00-0000000000a2"],
      sales_demo_facts_packs: ["13900000-5e00-4d00-8a00-0000000000a3"], sales_outreaches: ["13900000-5e00-4d00-8a00-0000000000a4"],
    },
  };
  it("accepts only the S0 prospect, one uuid per seeded table", () => {
    expect(parseS0SeedRecord(ok)).toEqual(ok);
    const bad = (over: Record<string, unknown>) => () => parseS0SeedRecord({ ...ok, ...over });
    expect(bad({ prospect_id: "5e2d0a63-7c1b-4f0e-9a6d-263a00000001" })).toThrow("S0_RECORD_INVALID");
    expect(bad({ rows: { ...ok.rows, sales_prospects: ["5e2d0a63-7c1b-4f0e-9a6d-263a00000001"] } })).toThrow("S0_RECORD_INVALID");
    expect(bad({ rows: { ...ok.rows, sales_sources: [...ok.rows.sales_sources, "13900000-5e00-4d00-8a00-0000000000a9"] } })).toThrow("S0_RECORD_INVALID");
    expect(bad({ rows: { ...ok.rows, sales_demos: ["x' or 1=1 --"] } })).toThrow("S0_RECORD_INVALID");
    expect(bad({ rows: { ...ok.rows, sales_exclusions: ["13900000-5e00-4d00-8a00-0000000000a9"] } })).toThrow("S0_RECORD_INVALID");
    expect(bad({ schema: "other" })).toThrow("S0_RECORD_INVALID");
    expect(() => parseS0SeedRecord(null)).toThrow("S0_RECORD_INVALID");
  });
});
