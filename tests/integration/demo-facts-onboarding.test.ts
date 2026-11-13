import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadNoDemoProspect } from "@/lib/admin/demo-onboarding";
import { demoContentWithFactsSha, onboardingDemoContent } from "@/lib/demo-version-package/facts-content";
import { importPackage, type PackageStore } from "@/lib/demo-version-package/import";
import { compCopyInput } from "@/lib/demo-version-package/local-inputs";
import { buildPackage } from "@/lib/demo-version-package/package";
import { SENDABLE_FACTS_PATH, SENDABLE_PAGE_DIR } from "@/lib/demo-version-package/seed-sendable";
import { toDemoView } from "@/lib/sales/demo-content";
import { createDemoFromFactsAsAdmin, FactsOnboardingError } from "@/lib/sales/facts-onboarding";
import { onboardFactsLocal } from "@/lib/sales/facts-onboarding-local";
import { loadCurrentFactsPack, registerFactsPackAsAdmin } from "@/lib/sales/facts-store";
import { BASE_FACTS, fictionalPack } from "../support/fictional-facts-pack";
import { anonClient, candidate, createUser, db, makeAdmin, resetSalesData, rpc, serviceClient, setFactsCliRegistration, signedInClient, verifiedRun } from "./helpers";

// DEV-263h (Issue #263, runbook B-2): a shop's demo content from its confirmed facts pack — sales_create_demo_from_facts
// (the admin's session) and the local owner path (onboard-local.ts), on the LOCAL stack. Fictional shops and test
// prospects only (example.com / test handles); no network, no model, no send. Nothing touches 輪 (SR-001).

const REPO = resolve(__dirname, "../..");
const TAMAKI = readFileSync(resolve(REPO, SENDABLE_FACTS_PATH), "utf8");

let admin: SupabaseClient;
let outsider: SupabaseClient;
let adminId: string;

/** A prospect through the existing ingest (every prospect rule), with its legacy React demo. */
async function shop(overrides: Record<string, unknown> = {}) {
  const runId = randomUUID();
  await verifiedRun(runId, { c01: candidate(overrides) });
  await rpc("sales_run_begin_persist", { p_run_id: runId });
  const r = await rpc<{ prospect_id: string }>("sales_persist_candidate", { p_run_id: runId, p_key: "c01" });
  await rpc("sales_run_finalize", { p_run_id: runId });
  const { rows } = await db.query("select id, content, template from public.sales_demos where prospect_id = $1", [r.prospect_id]);
  return { prospectId: r.prospect_id, demoId: rows[0].id as string, content: rows[0].content as Record<string, unknown>, template: rows[0].template as string };
}
const demoRow = async (prospectId: string) => (await db.query("select id, content, template, public_token, updated_at from public.sales_demos where prospect_id = $1", [prospectId])).rows[0];
const storeRows = async (prospectId: string) => (await db.query("select shop_id, facts_sha256, recorded_via, demo_id from public.sales_demo_facts_packs where prospect_id = $1 order by seq", [prospectId])).rows;
const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof FactsOnboardingError ? e.code : (e as Error).message.split(":")[0];
  }
  return "no-refusal";
};
const createAs = (client: SupabaseClient, prospectId: string, factsPack: string, replaceContent = true) => createDemoFromFactsAsAdmin(client, { prospectId, factsPack, replaceContent });

beforeAll(async () => {
  await resetSalesData();
  adminId = await createUser("onboard-admin@test.example.com");
  await makeAdmin(adminId);
  await createUser("onboard-outsider@test.example.com");
  admin = await signedInClient("onboard-admin@test.example.com");
  outsider = await signedInClient("onboard-outsider@test.example.com");
});
beforeEach(async () => {
  await db.query("truncate public.sales_demo_copy_owner_decisions, public.sales_demo_version_copy_links, public.sales_demo_copy_facts_checks, public.sales_demo_facts_packs, public.sales_demo_copy_reviews, public.sales_demo_quality_reviews, public.sales_demo_version_files, public.sales_demo_versions, public.sales_outreach_approvals, public.sales_exclusions, public.sales_outreaches, public.sales_demos, public.sales_sources, public.sales_prospects, public.sales_agent_runs cascade");
  await setFactsCliRegistration(false);
});
afterAll(async () => {
  await setFactsCliRegistration(false);
  await resetSalesData();
});

describe("the database derivation (sales_derive_facts_demo_content)", () => {
  const derive = async (text: string) => (await db.query("select public.sales_derive_facts_demo_content($1) as c", [text])).rows[0].c as Record<string, unknown>;

  it("is exactly the server's derivation (demoContentWithFactsSha) for the fictional packs", async () => {
    for (const text of [fictionalPack(), TAMAKI, fictionalPack({ facts: BASE_FACTS.filter(([k]) => !k.startsWith("service_") && !k.startsWith("statement_")) })])
      expect(await derive(text)).toEqual(demoContentWithFactsSha(new TextEncoder().encode(text)));
    expect((await derive(fictionalPack())).menu_items).toEqual(["一番目の品", "二番目の品", "十番目の品"]);
  });

  it("refuses what the server refuses (unmapped, twice, missing, extra field, malformed, untrimmed)", async () => {
    const code = (text: string) => refusal(derive(text));
    expect(await code(fictionalPack({ facts: [...BASE_FACTS, ["price", "100円"]] }))).toBe("facts_pack_unmapped_key");
    expect(await code(fictionalPack({ facts: [...BASE_FACTS, ["hours", "9:00"]] }))).toBe("facts_pack_duplicate_key");
    expect(await code(fictionalPack({ facts: BASE_FACTS.filter(([k]) => k !== "workshop") }))).toBe("facts_pack_incomplete");
    expect(await code(fictionalPack({ extra: { note: "x" } }))).toBe("invalid_facts_pack");
    expect(await code("{")).toBe("invalid_facts_pack");
    for (const v of [" 空白", "空白　", " 空白", "空白\n"]) expect(await code(fictionalPack({ facts: BASE_FACTS.map(([k, x]) => [k, k === "hours" ? v : x]) }))).toBe("facts_pack_value_untrimmed");
  });

  it("no API role can call the internal functions; only the admin function is open to the signed-in role", async () => {
    for (const client of [anonClient(), serviceClient(), admin]) {
      expect((await client.rpc("sales_derive_facts_demo_content", { p_facts_pack: fictionalPack() })).error).not.toBeNull();
      expect((await client.rpc("sales_onboard_facts_demo", { p_prospect_id: randomUUID(), p_facts_pack: fictionalPack(), p_replace_content: true, p_admin_id: adminId, p_via: "operator_cli" })).error).not.toBeNull();
    }
    for (const client of [anonClient(), serviceClient()]) expect((await client.rpc("sales_create_demo_from_facts", { p_prospect_id: randomUUID(), p_facts_pack: fictionalPack(), p_replace_content: true })).error).not.toBeNull();
    const definer = (await db.query("select proname, prosecdef from pg_proc where proname in ('sales_create_demo_from_facts', 'sales_onboard_facts_demo', 'sales_derive_facts_demo_content') order by proname")).rows;
    expect(definer).toEqual([
      { proname: "sales_create_demo_from_facts", prosecdef: true },
      { proname: "sales_derive_facts_demo_content", prosecdef: false },
      { proname: "sales_onboard_facts_demo", prosecdef: false },
    ]);
  });
});

describe("sales_create_demo_from_facts (the admin's session)", () => {
  it("a legacy React demo: refused without confirmation; with it, the content is derived in the database, the bytes registered, a replay changes nothing, other demos are untouched", async () => {
    const s = await shop();
    const other = await shop();
    const before = await demoRow(s.prospectId);
    expect(await refusal(createAs(admin, s.prospectId, fictionalPack(), false))).toBe("facts_onboarding_replace_unconfirmed");
    expect((await demoRow(s.prospectId)).content).toEqual(before.content);
    expect(await storeRows(s.prospectId)).toEqual([]);

    const r = await createAs(admin, s.prospectId, fictionalPack());
    expect(r).toMatchObject({ prospect_id: s.prospectId, demo_id: s.demoId, demo_created: false, content_changed: true, shop_id: "fictional-onboarding-h1", replayed: false });
    const after = await demoRow(s.prospectId);
    expect(after.content).toEqual(onboardingDemoContent(new TextEncoder().encode(fictionalPack())));
    expect({ template: after.template, token: after.public_token }).toEqual({ template: before.template, token: before.public_token });
    expect(await storeRows(s.prospectId)).toEqual([{ shop_id: "fictional-onboarding-h1", facts_sha256: r.facts_sha256, recorded_via: "admin_session", demo_id: s.demoId }]);
    expect((await loadCurrentFactsPack(admin, s.prospectId))?.facts_pack_text).toBe(fictionalPack());

    // the same bytes again: a replay (no content change, no new row); the facts registration panel accepts them as current
    expect(await createAs(admin, s.prospectId, fictionalPack(), false)).toMatchObject({ content_changed: false, replayed: true });
    expect(await registerFactsPackAsAdmin(admin, { demoId: s.demoId, factsPack: fictionalPack() })).toMatchObject({ replayed: true });
    expect(await storeRows(s.prospectId)).toHaveLength(1);

    // the other prospect's legacy React demo is untouched and still renders
    const o = await demoRow(other.prospectId);
    expect(o.content).toEqual(other.content);
    expect(toDemoView(o.template, o.content)).toMatchObject({ category: "bakery" });
  });

  it("no demo yet: creates the demo (template from the prospect's category, a new token) and the store row", async () => {
    const s = await shop();
    await db.query("delete from public.sales_outreaches where prospect_id = $1", [s.prospectId]);
    await db.query("delete from public.sales_demos where prospect_id = $1", [s.prospectId]);
    expect(await loadNoDemoProspect(admin as never, s.prospectId)).toMatchObject({ prospectId: s.prospectId });
    expect(await loadNoDemoProspect(outsider as never, s.prospectId)).toBeNull();
    const r = await createAs(admin, s.prospectId, fictionalPack(), false);
    expect(r).toMatchObject({ demo_created: true, content_changed: false, replayed: false });
    const d = await demoRow(s.prospectId);
    expect(d.template).toBe("bakery_v1");
    expect(d.public_token).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(d.content.facts_pack_sha256).toBe(r.facts_sha256);
    expect(await loadNoDemoProspect(admin as never, s.prospectId)).toBeNull();
  });

  it("newer facts of the same shop replace the content (confirmation) and become the current row; another shop's pack is refused", async () => {
    const s = await shop();
    await createAs(admin, s.prospectId, fictionalPack());
    const newer = fictionalPack({ facts: BASE_FACTS.map(([k, v]) => [k, k === "hours" ? "9:00〜17:00" : v]) });
    expect(await refusal(createAs(admin, s.prospectId, newer, false))).toBe("facts_onboarding_replace_unconfirmed");
    expect(await createAs(admin, s.prospectId, newer)).toMatchObject({ content_changed: true, replayed: false });
    expect((await demoRow(s.prospectId)).content.hours).toBe("9:00〜17:00");
    expect((await storeRows(s.prospectId)).map((x) => x.facts_sha256)).toHaveLength(2);
    expect(await refusal(createAs(admin, s.prospectId, fictionalPack({ shopId: "fictional-onboarding-other" })))).toBe("facts_onboarding_shop_changed");
  });

  it("the prospect rules and the demo's state: non-admin, DNC, the exclusion list, a duplicate shop, 輪, a disabled / shared / approved demo, an invalid pack", async () => {
    const s = await shop();
    expect(await refusal(createAs(outsider, s.prospectId, fictionalPack()))).toBe("forbidden");
    expect(await refusal(createAs(admin, randomUUID(), fictionalPack()))).toBe("not_found");
    expect(await refusal(createAs(admin, s.prospectId, fictionalPack({ facts: [...BASE_FACTS, ["price", "1"]] })))).toBe("facts_pack_unmapped_key");
    expect(await refusal(createAs(admin, s.prospectId, fictionalPack({ shopId: "fictional-bicycle-repair-wa" })))).toBe("facts_onboarding_rin");

    await db.query("update public.sales_prospects set do_not_contact = true, dnc_reason = 'admin_manual', dnc_set_at = now() where id = $1", [s.prospectId]);
    expect(await refusal(createAs(admin, s.prospectId, fictionalPack()))).toBe("facts_onboarding_do_not_contact");
    await db.query("update public.sales_prospects set do_not_contact = false, dnc_reason = null, dnc_set_at = null where id = $1", [s.prospectId]);

    const p = (await db.query("select instagram_handle from public.sales_prospects where id = $1", [s.prospectId])).rows[0];
    await db.query("insert into public.sales_exclusions (label, reason, instagram_handle) values ('既存の顧客（テスト）', 'existing_customer', $1)", [p.instagram_handle]);
    expect(await refusal(createAs(admin, s.prospectId, fictionalPack()))).toBe("facts_onboarding_excluded");
    await db.query("truncate public.sales_exclusions");

    const t = await shop();
    await createAs(admin, t.prospectId, fictionalPack());
    expect(await refusal(createAs(admin, s.prospectId, fictionalPack()))).toBe("facts_onboarding_shop_other_prospect");

    const u = await shop();
    await db.query("update public.sales_demos set expires_at = now() + interval '30 days' where prospect_id = $1", [u.prospectId]);
    expect(await refusal(createAs(admin, u.prospectId, fictionalPack({ shopId: "fictional-onboarding-u" })))).toBe("facts_onboarding_demo_in_use");
    await db.query("update public.sales_demos set expires_at = null, disabled_at = now() where prospect_id = $1", [u.prospectId]);
    expect(await refusal(createAs(admin, u.prospectId, fictionalPack({ shopId: "fictional-onboarding-u" })))).toBe("demo_unavailable");
    expect((await demoRow(u.prospectId)).content).toEqual(u.content);
    expect(await storeRows(u.prospectId)).toEqual([]);
  });
});

describe("the local owner path (onboard-local.ts)", () => {
  it("needs the owner's CLI switch and an admin identity; records operator_cli", async () => {
    const s = await shop();
    const c = await db.connect();
    try {
      const run = (o: Partial<{ adminId: string; replaceContent: boolean }> = {}) => onboardFactsLocal(c, { prospectId: s.prospectId, factsPack: fictionalPack(), adminId, replaceContent: true, ...o });
      expect(await refusal(run())).toBe("facts_cli_registration_disabled");
      await setFactsCliRegistration(true);
      expect(await refusal(run({ adminId: randomUUID() }))).toBe("forbidden");
      expect(await refusal(run({ replaceContent: false }))).toBe("facts_onboarding_replace_unconfirmed");
      expect(await run()).toMatchObject({ action: "replace_legacy", content_changed: true, replayed: false });
      expect((await storeRows(s.prospectId))[0]).toMatchObject({ recorded_via: "operator_cli" });
    } finally {
      c.release();
    }
  });
});

describe("the whole onboarding flow (fictional 環 facts on an ingested test prospect)", () => {
  const png = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: { r: Math.floor(Math.random() * 255), g: 40, b: 120 } } }).png().toBuffer();
  const memoryStore = (): PackageStore => {
    const objects = new Map<string, Uint8Array>();
    return { download: async (k) => objects.get(k) ?? null, upload: async (k, b) => void objects.set(k, b) };
  };

  it("onboard → import the package with the facts from the store → the copy evidence is from the facts path; the send block waits only on the owner", async () => {
    const s = await shop();
    await createAs(admin, s.prospectId, TAMAKI);
    const c = compCopyInput(join(REPO, SENDABLE_PAGE_DIR), join(REPO, SENDABLE_FACTS_PATH));
    const pkg = await buildPackage({ html: c.html, css: c.css, renders: { desktop_1440: new Uint8Array(await png(1440, 900)), mobile_390: new Uint8Array(await png(390, 900)) }, source: "test", copy: c.copy });
    const res = await importPackage(pkg, { client: serviceClient(), store: memoryStore(), demoId: s.demoId, factsFromStore: true });
    expect(res.copy).toMatchObject({ status: "checked", facts_from_facts_path: true, copy_verdict: "approve_candidate" });
    expect((await db.query("select public.sales_copy_send_block($1) as c", [res.versionId])).rows[0].c).toBe("demo_copy_owner_confirmation_missing");
    // the shop's facts change after the import: the version's send is refused (demo facts changed) until re-imported
    await createAs(admin, s.prospectId, `${JSON.stringify(JSON.parse(TAMAKI))}\n`);
    const block = await db.query("select public.sales_copy_send_block($1) as c", [res.versionId]);
    expect(block.rows[0].c).not.toBeNull();
  });
});
