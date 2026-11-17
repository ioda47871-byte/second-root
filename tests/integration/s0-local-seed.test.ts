import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { factsPackSha256 } from "@/lib/demo-version-package/facts-content";
import {
  assertS0WriteAllowed, cleanupS0Seed, S0_FACTS_PATH, S0_PROSPECT_ID, S0_SEED_FLAG, S0_SEED_TABLES, S0_SHOP_ID, S0SeedError, s0SeedPlan, seedS0Shop, type S0SeedRecord,
} from "@/lib/demo-version-package/seed-s0";
import { SENDABLE_FACTS_PATH, seedSendableShop } from "@/lib/demo-version-package/seed-sendable";
import { loadVerifiedGenerationFacts } from "@/lib/sales/b-route/verified-generation-facts";
import { createUser, db, makeAdmin, nameFactsInContent, registerFacts, resetSalesData, setFactsCliRegistration, signedInClient } from "./helpers";

// DEV-139 Stage 0 (A-4): the local seed of the fictional bakery こむぎ灯 (scripts/sales/demo-version/s0-local-seed.ts,
// docs/operations/s0-local-db-seed.md) on CI's OWN throwaway local stack — never an owner's database. Proves: the seed
// writes exactly the planned rows; PR #280's read (loadVerifiedGenerationFacts, under a signed-in admin's session,
// the identity check unchanged) succeeds for it; the HOLD cases (stale SHA, DNC, exclusion, expired, identity
// mismatch, changed facts); and the cleanup removes exactly the seeded rows. Fictional shops and example.com only; no
// network, no model, no send, no import.

const REPO = resolve(__dirname, "../..");
const S0 = new Uint8Array(readFileSync(resolve(REPO, S0_FACTS_PATH)));
const TAMAKI = new Uint8Array(readFileSync(resolve(REPO, SENDABLE_FACTS_PATH)));
const S0_SHA = factsPackSha256(S0);

let admin: SupabaseClient;
let outsider: SupabaseClient;
let adminId: string;

const withClient = async <T>(f: (c: import("pg").PoolClient) => Promise<T>): Promise<T> => {
  const c = await db.connect();
  try {
    return await f(c);
  } finally {
    c.release();
  }
};
const seed = () => withClient((c) => seedS0Shop(c, { factsPack: S0, adminId }));
const cleanup = (rec: unknown, includeImported = false) => withClient((c) => cleanupS0Seed(c, rec, { factsPack: S0, includeImported }));
const read = (client: SupabaseClient = admin) => loadVerifiedGenerationFacts(client, S0_PROSPECT_ID);
const stopCode = async (p: Promise<unknown>) => {
  try {
    await p;
    return "no-stop";
  } catch (e) {
    return (e as { code?: string }).code ?? (e as Error).message.split(":")[0];
  }
};
/** Rows per seeded table for a prospect (null: every prospect). */
async function counts(prospectId: string | null): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of S0_SEED_TABLES) {
    const col = t === "sales_prospects" ? "id" : "prospect_id";
    out[t] = (await db.query(`select count(*)::int as n from public.${t} ${prospectId ? `where ${col} = $1` : ""}`, prospectId ? [prospectId] : [])).rows[0].n;
  }
  return out;
}
const ones = Object.fromEntries(S0_SEED_TABLES.map((t) => [t, 1]));
const zeros = Object.fromEntries(S0_SEED_TABLES.map((t) => [t, 0]));

beforeAll(async () => {
  await resetSalesData();
  adminId = await createUser("s0-seed-admin@test.example.com");
  await makeAdmin(adminId);
  await createUser("s0-seed-outsider@test.example.com");
  admin = await signedInClient("s0-seed-admin@test.example.com");
  outsider = await signedInClient("s0-seed-outsider@test.example.com");
});
beforeEach(async () => {
  await db.query(
    "truncate public.sales_demo_copy_owner_decisions, public.sales_demo_version_copy_links, public.sales_demo_copy_facts_checks, public.sales_demo_facts_packs, public.sales_demo_copy_reviews, public.sales_demo_quality_reviews, public.sales_demo_version_files, public.sales_demo_versions, public.sales_outreach_approvals, public.sales_outreach_draft_edits, public.sales_exclusions, public.sales_outreaches, public.sales_demos, public.sales_sources, public.sales_prospects, public.sales_agent_runs cascade",
  );
  // the owner's local switch the seed needs (the doc's step); off again after the file (setup file)
  await setFactsCliRegistration(true);
});
afterAll(async () => {
  await setFactsCliRegistration(false);
  await resetSalesData();
});

describe("seed: exactly the planned fictional rows, on a local stack only", () => {
  it("CI's own database URL passes the guard (a local stack), and only with the flag", () => {
    expect(assertS0WriteAllowed([S0_SEED_FLAG], process.env).host).toMatch(/^(127\.0\.0\.1|localhost)$/);
    expect(() => assertS0WriteAllowed([], process.env)).toThrow("S0_OWNER_APPROVAL_FLAG_MISSING");
  });

  it("writes one row per table with the planned values, records every id, and replays idempotently", async () => {
    const plan = s0SeedPlan(S0);
    const first = await seed();
    expect(first.created).toBe(true);
    expect(await counts(S0_PROSPECT_ID)).toEqual(ones);
    expect(await counts(null)).toEqual(ones);
    const rec = first.record;
    const p = (await db.query("select * from public.sales_prospects where id = $1", [S0_PROSPECT_ID])).rows[0];
    expect(p).toMatchObject({ name: plan.prospect.name, address: plan.prospect.address, normalized_name: plan.prospect.normalized_name, normalized_address: plan.prospect.normalized_address, ward: "昭和区", category: "bakery", public_email: plan.prospect.public_email, recommended_channel: "email", do_not_contact: false });
    expect((await db.query("select id, field, value, source_type from public.sales_sources where prospect_id = $1", [S0_PROSPECT_ID])).rows).toEqual([{ id: rec.rows.sales_sources[0], field: "email", value: plan.prospect.public_email, source_type: "official_contact" }]);
    const d = (await db.query("select id, content, template, expires_at, disabled_at from public.sales_demos where prospect_id = $1", [S0_PROSPECT_ID])).rows[0];
    expect(d).toMatchObject({ id: rec.rows.sales_demos[0], template: "bakery_v1", expires_at: null, disabled_at: null });
    expect(d.content).toEqual(plan.demo.content);
    const f = (await db.query("select id, demo_id, shop_id, facts_sha256, facts_pack_text, recorded_by, recorded_via from public.sales_demo_facts_packs where prospect_id = $1", [S0_PROSPECT_ID])).rows[0];
    expect(f).toMatchObject({ id: rec.rows.sales_demo_facts_packs[0], demo_id: d.id, shop_id: S0_SHOP_ID, facts_sha256: S0_SHA, recorded_by: adminId, recorded_via: "operator_cli" });
    expect(Buffer.from(f.facts_pack_text, "utf8").equals(Buffer.from(S0))).toBe(true);
    expect((await db.query("select id, kind, channel, status, sent_at from public.sales_outreaches where prospect_id = $1", [S0_PROSPECT_ID])).rows).toEqual([{ id: rec.rows.sales_outreaches[0], kind: "initial", channel: "email", status: "drafted", sent_at: null }]);
    // nothing sendable was created: no approval
    expect((await db.query("select count(*)::int as n from public.sales_outreach_approvals where prospect_id = $1", [S0_PROSPECT_ID])).rows[0].n).toBe(0);
    const again = await seed();
    expect(again).toEqual({ record: rec, created: false });
    expect(await counts(null)).toEqual(ones);
  });

  it("refuses while the owner's facts CLI switch is off, or for an unknown admin, writing nothing", async () => {
    await setFactsCliRegistration(false);
    expect(await stopCode(seed())).toBe("S0_SWITCH_FACTS_CLI_OFF");
    await setFactsCliRegistration(true);
    expect(await stopCode(withClient((c) => seedS0Shop(c, { factsPack: S0, adminId: "13900000-5e00-4d00-8a00-0000000000ee" })))).toBe("S0_ADMIN_NOT_FOUND");
    expect(await counts(null)).toEqual(zeros);
  });
});

describe("PR #280's read (loadVerifiedGenerationFacts) on the seeded rows", () => {
  it("succeeds for the fictional shop under the admin's session, with the committed bytes", async () => {
    const { record } = await seed();
    const r = await read();
    expect(r).toMatchObject({ prospectId: S0_PROSPECT_ID, demoId: record.rows.sales_demos[0], factsPackId: record.rows.sales_demo_facts_packs[0], shopId: S0_SHOP_ID, factsSha256: S0_SHA });
    expect(Buffer.from(r.factsBytes).equals(Buffer.from(S0))).toBe(true);
    // RLS intact: a signed-in non-admin sees no prospect
    expect(await stopCode(read(outsider))).toBe("PROSPECT_NOT_AVAILABLE");
  });

  it("HOLD: DNC", async () => {
    await seed();
    await db.query("update public.sales_prospects set do_not_contact = true, dnc_reason = 'admin_manual', dnc_set_at = now() where id = $1", [S0_PROSPECT_ID]);
    expect(await stopCode(read())).toBe("PROSPECT_DNC_OR_UNKNOWN");
  });

  it("HOLD: the exclusion list (name + address, and the site's domain)", async () => {
    const plan = s0SeedPlan(S0);
    await seed();
    const ex = await db.query(
      "insert into public.sales_exclusions (label, reason, normalized_name, normalized_address) values ('架空の除外（S0 確認）', 'other', $1, $2) returning id",
      [plan.prospect.normalized_name, plan.prospect.normalized_address],
    );
    expect(await stopCode(read())).toBe("PROSPECT_EXCLUDED_OR_UNKNOWN");
    await db.query("delete from public.sales_exclusions where id = $1", [ex.rows[0].id]);
    expect((await read()).factsSha256).toBe(S0_SHA);
    await db.query("insert into public.sales_exclusions (label, reason, website_domain) values ('架空の除外（S0 確認）', 'existing_customer', $1)", [plan.prospect.website_domain]);
    expect(await stopCode(read())).toBe("PROSPECT_EXCLUDED_OR_UNKNOWN");
  });

  it("HOLD: an expired or disabled demo", async () => {
    await seed();
    await db.query("update public.sales_demos set expires_at = now() - interval '1 hour' where prospect_id = $1", [S0_PROSPECT_ID]);
    expect(await stopCode(read())).toBe("DEMO_NOT_ELIGIBLE");
    await db.query("update public.sales_demos set expires_at = null, disabled_at = now() where prospect_id = $1", [S0_PROSPECT_ID]);
    expect(await stopCode(read())).toBe("DEMO_NOT_ELIGIBLE");
  });

  it("HOLD: identity mismatch — a registry address one character off, and 環's placeholder registry address", async () => {
    await seed();
    await db.query("update public.sales_prospects set address = '名古屋市昭和区架空町二丁目8-2' where id = $1", [S0_PROSPECT_ID]);
    expect(await stopCode(read())).toBe("PROSPECT_FACTS_IDENTITY_HOLD");
    // 環 (the existing sendable seed) with its facts registered: its address cannot be a registry address, so it HOLDs
    const tamaki = await withClient((c) => seedSendableShop(c, TAMAKI));
    await registerFacts(tamaki.demoId, TAMAKI, adminId);
    expect(await stopCode(loadVerifiedGenerationFacts(admin, tamaki.prospectId))).toBe("PROSPECT_FACTS_IDENTITY_HOLD");
  });

  it("HOLD / stale SHA: a newer stored pack moves the read off the committed SHA; a demo still naming the old SHA stops", async () => {
    const { record } = await seed();
    const demoId = record.rows.sales_demos[0];
    // the same facts, other bytes: a newer registration (the demo's content made to name it, as the owner would)
    const newer = `${JSON.stringify(JSON.parse(Buffer.from(S0).toString("utf8")))}\n`;
    await nameFactsInContent(demoId, newer);
    await registerFacts(demoId, newer, adminId);
    const r = await read();
    expect(r.factsSha256).not.toBe(S0_SHA); // anything pinned to the committed SHA (prompt, copy, package) is now stale
    // the demo content still naming the older SHA while the store holds the newer pack
    await db.query("update public.sales_demos set content = content || jsonb_build_object('facts_pack_sha256', $2::text) where id = $1", [demoId, S0_SHA]);
    expect(await stopCode(read())).toBe("TRUSTED_FACTS_SHA_MISMATCH");
  });

  it("HOLD: demo facts changed after registration (wrong facts)", async () => {
    await seed();
    await db.query("update public.sales_demos set content = content || '{\"hours\": \"6:00〜12:00\"}'::jsonb where prospect_id = $1", [S0_PROSPECT_ID]);
    expect(await stopCode(read())).toBe("TRUSTED_FACTS_CONTENT_MISMATCH");
  });
});

describe("cleanup: exactly the recorded rows", () => {
  it("removes the seeded rows and nothing else (another fictional shop is untouched), then the seed can run again", async () => {
    const { record } = await seed();
    const tamaki = await withClient((c) => seedSendableShop(c, TAMAKI));
    const tamakiBefore = await counts(tamaki.prospectId);
    const totalBefore = await counts(null);
    const r = await cleanup(record);
    expect(r).toEqual({ deleted: ones, storagePrefixesLeft: [] });
    expect(await counts(S0_PROSPECT_ID)).toEqual(zeros);
    expect(await counts(tamaki.prospectId)).toEqual(tamakiBefore);
    const totalAfter = await counts(null);
    for (const t of S0_SEED_TABLES) expect(totalBefore[t]! - totalAfter[t]!).toBe(1);
    // the facts store's append-only trigger is on again afterwards
    const tamakiFacts = await registerFacts(tamaki.demoId, TAMAKI, adminId);
    await expect(db.query("delete from public.sales_demo_facts_packs where id = $1", [tamakiFacts.facts_pack_id])).rejects.toThrow("facts_pack_immutable");
    expect((await seed()).created).toBe(true);
  });

  it("refuses, deleting nothing, when rows not in the record exist under the prospect", async () => {
    const { record } = await seed();
    const newer = `${JSON.stringify(JSON.parse(Buffer.from(S0).toString("utf8")))}\n`;
    await nameFactsInContent(record.rows.sales_demos[0], newer);
    await registerFacts(record.rows.sales_demos[0], newer, adminId);
    const before = await counts(null);
    try {
      await cleanup(record);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(S0SeedError);
      expect(e).toMatchObject({ code: "S0_CLEANUP_UNRECORDED_ROWS", detail: { sales_demo_facts_packs: 1 } });
    }
    expect(await counts(null)).toEqual(before);
  });

  it("refuses a tampered record or a prospect that is no longer the seed, rolling back every delete", async () => {
    const { record } = await seed();
    const tampered: S0SeedRecord = { ...record, rows: { ...record.rows, sales_outreaches: ["13900000-5e00-4d00-8a00-0000000000ee"] } };
    expect(await stopCode(cleanup(tampered))).toBe("S0_CLEANUP_UNRECORDED_ROWS");
    expect(await stopCode(cleanup({ ...record, prospect_id: "5e2d0a63-7c1b-4f0e-9a6d-263a00000001" }))).toBe("S0_RECORD_INVALID");
    await db.query("update public.sales_prospects set address = '名古屋市昭和区架空町二丁目8-2' where id = $1", [S0_PROSPECT_ID]);
    expect(await stopCode(cleanup(record))).toBe("S0_CLEANUP_PROSPECT_NOT_SEED");
    expect(await counts(S0_PROSPECT_ID)).toEqual(ones);
  });
});
