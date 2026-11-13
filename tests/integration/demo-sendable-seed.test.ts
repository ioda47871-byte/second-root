import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { importPackage, type PackageStore } from "@/lib/demo-version-package/import";
import { assertDemoContentFromFacts, compCopyInput, LocalInputError, readCommittedFacts } from "@/lib/demo-version-package/local-inputs";
import { buildPackage } from "@/lib/demo-version-package/package";
import type { FactsPack } from "@/lib/demo-version-package/seed-rin";
import { SENDABLE_EMAIL, SENDABLE_FACTS_PATH, SENDABLE_PAGE_DIR, SENDABLE_PROSPECT_ID, seedSendableShop } from "@/lib/demo-version-package/seed-sendable";
import { db, resetSalesData, serviceClient } from "./helpers";

// DEV-263a (Issue #263): the fictional sendable shop 環 on the LOCAL stack — the seed, the local facts path
// (import-local.ts --trusted-facts) and the copy send block afterwards. Fictional shop, example.com only; nothing is
// sent (no outreach is created), no network, no model.

const REPO = resolve(__dirname, "../..");
const pack = () => JSON.parse(readFileSync(join(REPO, SENDABLE_FACTS_PATH), "utf8")) as FactsPack;
const png = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: { r: Math.floor(Math.random() * 255), g: 90, b: 140 } } }).png().toBuffer();
const memoryStore = (): PackageStore => {
  const objects = new Map<string, Uint8Array>();
  return { download: async (k) => objects.get(k) ?? null, upload: async (k, b) => void objects.set(k, b) };
};
const seed = async () => {
  const c = await db.connect();
  try {
    return await seedSendableShop(c, pack());
  } finally {
    c.release();
  }
};
const fixturePackage = async () => {
  const c = compCopyInput(join(REPO, SENDABLE_PAGE_DIR), join(REPO, SENDABLE_FACTS_PATH));
  return buildPackage({ html: c.html, css: c.css, renders: { desktop_1440: new Uint8Array(await png(1440, 900)), mobile_390: new Uint8Array(await png(390, 900)) }, source: "test", copy: c.copy });
};
const demoContent = async (demoId: string) => (await db.query("select content from public.sales_demos where id = $1", [demoId])).rows[0].content as unknown;

beforeEach(resetSalesData);
afterAll(resetSalesData);

describe("the fictional sendable shop 環", () => {
  it("seeds once (idempotent): an example.com email prospect with its first-party source, a demo, no outreach", async () => {
    const a = await seed();
    expect(a).toMatchObject({ prospectId: SENDABLE_PROSPECT_ID, created: true });
    expect(await seed()).toEqual({ ...a, created: false });
    const p = (await db.query("select category, website_status, public_email, recommended_channel, instagram_handle, do_not_contact from public.sales_prospects where id = $1", [SENDABLE_PROSPECT_ID])).rows[0];
    expect(p).toEqual({ category: "bakery", website_status: "present", public_email: SENDABLE_EMAIL, recommended_channel: "email", instagram_handle: null, do_not_contact: false });
    expect(SENDABLE_EMAIL.endsWith("@tamaki-demo.example.com")).toBe(true);
    expect((await db.query("select count(*)::int as n from public.sales_outreaches where prospect_id = $1", [SENDABLE_PROSPECT_ID])).rows[0].n).toBe(0);
  });

  it("imported with the facts from the facts path: stored as such, and the copy send block waits only on the owner", async () => {
    const s = await seed();
    const trusted = readCommittedFacts(REPO, SENDABLE_FACTS_PATH);
    assertDemoContentFromFacts(await demoContent(s.demoId), trusted);
    const res = await importPackage(await fixturePackage(), { client: serviceClient(), store: memoryStore(), demoId: s.demoId, trustedFactsPack: trusted });
    expect(res.copy).toMatchObject({ status: "checked", facts_from_facts_path: true, copy_verdict: "approve_candidate", send_blockers: ["OWNER_APPROVAL_MISSING"] });
    expect(res.storedCopy).toMatchObject({ round: 0, copy_verdict: "approve_candidate", next_step: "owner_review", facts_from_facts_path: true, linked_version_id: res.versionId });
    const q = (await db.query("select gate_blockers, lane from public.sales_demo_copy_reviews where id = $1", [res.storedCopy!.review_id])).rows[0];
    expect(q).toEqual({ gate_blockers: ["OWNER_APPROVAL_MISSING"], lane: "real_shop_proposal" });
    expect((await db.query("select public.sales_copy_send_block($1) as c", [res.versionId])).rows[0].c).toBe("demo_copy_owner_confirmation_missing");
  });

  it("a demo whose content is not derived from the same facts pack is refused before the import", async () => {
    const s = await seed();
    await db.query("update public.sales_demos set content = jsonb_set(content, '{hours}', '\"9:00〜18:00\"') where id = $1", [s.demoId]);
    expect(() => assertDemoContentFromFacts(null, readCommittedFacts(REPO, SENDABLE_FACTS_PATH))).toThrow(LocalInputError);
    let code = "";
    try {
      assertDemoContentFromFacts(await demoContent(s.demoId), readCommittedFacts(REPO, SENDABLE_FACTS_PATH));
    } catch (e) {
      code = (e as LocalInputError).code;
    }
    expect(code).toBe("TRUSTED_FACTS_CONTENT_MISMATCH");
    await expect(seed()).rejects.toThrow("SENDABLE_SEED_CONTENT_STALE");
  });
});
