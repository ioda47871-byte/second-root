import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { loadTodayDemoVersions } from "@/lib/admin/demo-version-badges";
import { submitDemoReview } from "@/lib/admin/demo-review";
import { QUALITY_CHECKLIST_ITEMS } from "@/lib/sales/demo-version/quality";
import { seedDemo } from "../support/seed-demo";
import { seedDemoVersion, type SeededVersion } from "../support/seed-demo-version";
import { createUser, db, makeAdmin, serviceClient, signedInClient } from "./helpers";

// DEV-196d-7: the Today screen's demo version badges — one request for every shop on the page, through the admin's
// own session (RLS), no service role. Runs in CI (no object is read). Fictional shops and example.com only.

const ENV = { SALES_DEMO_VERSIONS_ENABLED: "true", SALES_DEMO_VIEW_SIGNING_KEY: randomBytes(32).toString("base64url") };
const ALL_OK = Object.fromEntries(QUALITY_CHECKLIST_ITEMS.map((k) => [k, "ok"]));
let admin: SupabaseClient;
let outsider: SupabaseClient;

beforeAll(async () => {
  const n = randomBytes(4).toString("hex");
  const a = await createUser(`demo-badge-admin-${n}@test.example.com`);
  await makeAdmin(a);
  await createUser(`demo-badge-outsider-${n}@test.example.com`);
  admin = await signedInClient(`demo-badge-admin-${n}@test.example.com`);
  outsider = await signedInClient(`demo-badge-outsider-${n}@test.example.com`);
});

/** Counts the requests a client makes (the badges must be ONE request). */
function counting(client: SupabaseClient) {
  const calls: string[] = [];
  const proxy = new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "from") return (t: string) => (calls.push(t), target.from(t));
      if (prop === "rpc") return (...a: Parameters<SupabaseClient["rpc"]>) => (calls.push(`rpc:${String(a[0])}`), target.rpc(...a));
      return Reflect.get(target, prop, receiver);
    },
  });
  return { client: proxy as SupabaseClient, calls };
}
const one = async (sql: string, args: unknown[]) => (await db.query(sql, args)).rows[0];
async function decide(v: SeededVersion, decision: "approved" | "changes_requested") {
  const sha = async (p: string) => (await one("select sha256 from public.sales_demo_version_files where version_id = $1 and path = $2", [v.versionId, p])).sha256 as string;
  const r = await submitDemoReview(
    {
      prospectId: v.prospectId, versionId: v.versionId, decision, impersonation: [], note: null,
      checklist: decision === "approved" ? ALL_OK : { ...ALL_OK, shop_specific_structure: "ng" },
      viewedRenders: { desktop_1440: await sha("renders/desktop_1440.webp"), mobile_390: await sha("renders/mobile_390.webp") },
      bundleSha256: (await one("select bundle_sha256 from public.sales_demo_versions where id = $1", [v.versionId])).bundle_sha256,
      acknowledgedSendStop: decision === "approved",
    },
    { env: ENV, now: new Date(), client: admin as never },
  );
  expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
}

describe("loadTodayDemoVersions (local stack)", () => {
  it("one request through the admin's session: none / awaiting / changes requested / approved (with the send stop) / revoked", async () => {
    const none = await seedDemo(db, { expiresAt: null });
    const awaiting = await seedDemoVersion(db, serviceClient(), { upload: false });
    const changes = await seedDemoVersion(db, serviceClient(), { upload: false });
    await decide(changes, "changes_requested");
    const approved = await seedDemoVersion(db, serviceClient(), { upload: false });
    await decide(approved, "approved");
    const revoked = await seedDemoVersion(db, serviceClient(), { upload: false });
    expect((await admin.rpc("sales_revoke_demo_version", { p_version_id: revoked.versionId, p_code: "QUALITY_PROBLEM" })).error).toBeNull();
    const noDemo = "00000000-0000-4000-8000-00000000abcd";

    const { client, calls } = counting(admin);
    const ids = [none.prospectId, awaiting.prospectId, changes.prospectId, approved.prospectId, revoked.prospectId, noDemo];
    const r = await loadTodayDemoVersions(client, ids, { env: ENV, now: new Date() });
    expect(calls).toEqual(["sales_demos"]); // ONE request, no service role, no per-shop query
    expect(r!.get(none.prospectId)).toEqual({ kind: "ok", state: "none", versionNo: null, sendStop: null });
    expect(r!.get(noDemo)).toEqual({ kind: "ok", state: "none", versionNo: null, sendStop: null });
    expect(r!.get(awaiting.prospectId)).toMatchObject({ kind: "ok", state: "awaiting_review", versionNo: 1, sendStop: null });
    expect(r!.get(changes.prospectId)).toMatchObject({ kind: "ok", state: "changes_requested", sendStop: null });
    // the database would refuse this shop's send approval (demo_not_shareable); the facts are not read here
    expect(r!.get(approved.prospectId)).toEqual({
      kind: "ok", state: "approved", versionNo: 1,
      sendStop: { code: "demo_not_shareable", reasons: ["versioned_sharing_disabled", "photos_not_shareable"], factsUnknown: true },
    });
    expect(r!.get(revoked.prospectId)).toMatchObject({ kind: "ok", state: "revoked", sendStop: null });
  });

  it("a signed-in non-admin reads no version rows (RLS): no state is revealed", async () => {
    const v = await seedDemoVersion(db, serviceClient(), { upload: false });
    const r = await loadTodayDemoVersions(outsider, [v.prospectId], { env: ENV, now: new Date() });
    expect(r!.get(v.prospectId)).toEqual({ kind: "ok", state: "none", versionNo: null, sendStop: null });
  });

  it("flag off: null and NO request at all", async () => {
    const v = await seedDemoVersion(db, serviceClient(), { upload: false });
    const { client, calls } = counting(admin);
    for (const flag of [undefined, "false", "TRUE"]) expect(await loadTodayDemoVersions(client, [v.prospectId], { env: { ...ENV, SALES_DEMO_VERSIONS_ENABLED: flag }, now: new Date() })).toBeNull();
    expect(calls).toEqual([]);
  });
});
