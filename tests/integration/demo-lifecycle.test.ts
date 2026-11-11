import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { submitRevoke, submitWithdraw } from "@/lib/admin/demo-lifecycle";
import { submitDemoReview } from "@/lib/admin/demo-review";
import { loadDemoVersionsPage } from "@/lib/admin/demo-versions";
import { serveDemoFrame } from "@/lib/demo-frame/serve";
import { supabaseFrameStore } from "@/lib/demo-frame/store";
import { APPROVAL_OPEN_MESSAGE } from "@/lib/sales/demo-version/admin-messages";
import { QUALITY_CHECKLIST_ITEMS } from "@/lib/sales/demo-version/quality";
import { signViewToken } from "@/lib/sales/demo-version/view-token";
import { seedDemoVersion, type SeededVersion } from "../support/seed-demo-version";
import { createUser, db, makeAdmin, serviceClient, signedInClient } from "./helpers";

// DEV-196d-6: withdrawing a quality approval and revoking a version (normal / urgent) through the server's re-check
// and the DEV-196c functions, on the LOCAL stack, as a signed-in admin. No object is read from Storage (the artifact
// route's object read is injected in this test), so everything runs in CI. Fictional shops and example.com only.

const KEY = randomBytes(32);
const ENV = { SALES_DEMO_VERSIONS_ENABLED: "true", SALES_DEMO_VIEW_SIGNING_KEY: KEY.toString("base64url") };
const ALL_OK = Object.fromEntries(QUALITY_CHECKLIST_ITEMS.map((k) => [k, "ok"]));
let admin: SupabaseClient;
let adminId: string;
let outsider: SupabaseClient;

beforeAll(async () => {
  const n = randomBytes(4).toString("hex");
  adminId = await createUser(`demo-life-admin-${n}@test.example.com`);
  await makeAdmin(adminId);
  await createUser(`demo-life-outsider-${n}@test.example.com`);
  admin = await signedInClient(`demo-life-admin-${n}@test.example.com`);
  outsider = await signedInClient(`demo-life-outsider-${n}@test.example.com`);
});

const deps = (client: SupabaseClient = admin, env: Record<string, string | undefined> = ENV) => ({ env, now: new Date(), client: client as never });
const seed = (into?: SeededVersion) =>
  seedDemoVersion(db, serviceClient(), { upload: false, ...(into ? { into: { prospectId: into.prospectId, demoId: into.demoId, parentVersionId: into.versionId } } : {}) });
const one = async (sql: string, args: unknown[]) => (await db.query(sql, args)).rows[0];
const bundle = async (v: SeededVersion) => (await one("select bundle_sha256 from public.sales_demo_versions where id = $1", [v.versionId])).bundle_sha256 as string;
const fileSha = async (v: SeededVersion, path: string) => (await one("select sha256 from public.sales_demo_version_files where version_id = $1 and path = $2", [v.versionId, path])).sha256 as string;
const versionRow = (v: SeededVersion) => one("select status, revoked_at, revoked_by, revoke_code from public.sales_demo_versions where id = $1", [v.versionId]);
const approvedId = async (v: SeededVersion) => (await one("select approved_version_id from public.sales_demos where id = $1", [v.demoId])).approved_version_id as string | null;

async function approve(v: SeededVersion) {
  const r = await submitDemoReview(
    {
      prospectId: v.prospectId, versionId: v.versionId, decision: "approved", checklist: ALL_OK, bundleSha256: await bundle(v), impersonation: [], acknowledgedSendStop: true, note: null,
      viewedRenders: { desktop_1440: await fileSha(v, "renders/desktop_1440.webp"), mobile_390: await fileSha(v, "renders/mobile_390.webp") },
    },
    deps(),
  );
  expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
  return (await one("select id from public.sales_demo_quality_reviews where version_id = $1 and state = 'active'", [v.versionId])).id as string;
}

/** A send screen opened (send_opened), written as the database owner (the functions cannot reach this state today). */
async function openSend(v: SeededVersion) {
  const o = await one("insert into public.sales_outreaches (prospect_id, kind, channel, body) values ($1, 'initial', 'instagram', 'はじめまして。テスト用の営業文です。') returning id", [v.prospectId]);
  const { rows } = await db.query(
    `insert into public.sales_outreach_approvals (outreach_id, prospect_id, channel, recipient, body, draft_version, demo_token, demo_version,
       snapshot_sha256, approved_by, demo_version_id, demo_bundle_sha256, demo_quality_review_id, demo_share_eligible)
     select o.id, o.prospect_id, o.channel, p.instagram_handle, o.body || ' /demo/' || d.public_token, o.draft_version, d.public_token,
            public.sales_demo_version(d), encode(sha256(convert_to(o.id::text, 'UTF8')), 'hex'), $2, null, null, null, null
       from public.sales_outreaches o join public.sales_prospects p on p.id = o.prospect_id join public.sales_demos d on d.prospect_id = p.id
      where o.id = $1
     returning id`,
    [o.id, adminId],
  );
  await db.query("update public.sales_outreach_approvals set state = 'send_opened', opened_at = now(), last_opened_at = now(), opened_via = 'instagram_profile', open_count = 1 where id = $1", [rows[0].id]);
  return rows[0].id as string;
}

describe("withdraw a quality approval", () => {
  it("happy path: the approval is withdrawn by this admin, the version is a draft again, the send stop is lifted, nothing else is approved", async () => {
    const v1 = await seed();
    const v2 = await seed(v1);
    const reviewId = await approve(v1);
    const r = await submitWithdraw({ prospectId: v1.prospectId, versionId: v1.versionId, reviewId, bundleSha256: await bundle(v1), confirmed: true }, deps());
    expect(r).toEqual({ ok: true, replayed: false });
    expect(await one("select state, withdrawn_by from public.sales_demo_quality_reviews where id = $1", [reviewId])).toEqual({ state: "withdrawn", withdrawn_by: adminId });
    expect((await versionRow(v1)).status).toBe("draft");
    expect(await approvedId(v1)).toBeNull();
    // no automatic switch: the other version stays a draft, and the shop has no approved version (sending as before)
    expect((await versionRow(v2)).status).toBe("draft");
    const page = await loadDemoVersionsPage(v1.prospectId, { env: ENV, now: new Date(), client: admin as never });
    expect(page.kind === "ok" && page.view.sendStop).toBeNull();
  });

  it("flag off, a non-admin, a stale bundle, a review that is not the active approval, no confirmation: refused, nothing changes", async () => {
    const v = await seed();
    const reviewId = await approve(v);
    const ok = { prospectId: v.prospectId, versionId: v.versionId, reviewId, bundleSha256: await bundle(v), confirmed: true };
    const cases: Array<[string, unknown, ReturnType<typeof deps>]> = [
      ["flag off", ok, deps(admin, { ...ENV, SALES_DEMO_VERSIONS_ENABLED: undefined })],
      ["outsider", ok, deps(outsider)],
      ["stale", { ...ok, bundleSha256: "0".repeat(64) }, deps()],
      ["other review", { ...ok, reviewId: "00000000-0000-4000-8000-000000000999" }, deps()],
      ["no confirmation", { ...ok, confirmed: false }, deps()],
    ];
    for (const [label, input, d] of cases) expect((await submitWithdraw(input, d)).ok, label).toBe(false);
    expect((await one("select state from public.sales_demo_quality_reviews where id = $1", [reviewId])).state).toBe("active");
    expect((await versionRow(v)).status).toBe("approved");
  });
});

describe("revoke a version", () => {
  it("happy path (normal): revoked by this admin with the code; its approval invalidated; nothing else approved or switched", async () => {
    const v1 = await seed();
    const v2 = await seed(v1);
    const reviewId = await approve(v2);
    const r = await submitRevoke({ prospectId: v2.prospectId, versionId: v2.versionId, bundleSha256: await bundle(v2), code: "QUALITY_PROBLEM", urgent: false, confirmed: true }, deps());
    expect(r).toEqual({ ok: true, replayed: false });
    expect(await versionRow(v2)).toMatchObject({ status: "revoked", revoked_by: adminId, revoke_code: "QUALITY_PROBLEM" });
    expect(await one("select state, invalidated_reason from public.sales_demo_quality_reviews where id = $1", [reviewId])).toEqual({ state: "invalidated", invalidated_reason: "version_revoked" });
    expect(await approvedId(v2)).toBeNull();
    expect((await versionRow(v1)).status).toBe("draft"); // the parent is not approved in its place
    const page = await loadDemoVersionsPage(v1.prospectId, { env: ENV, now: new Date(), client: admin as never });
    if (page.kind !== "ok") throw new Error(page.kind);
    const revoked = page.view.versions.find((x) => x.id === v2.versionId)!;
    expect(revoked).toMatchObject({ revoked: true, revokeCode: "QUALITY_PROBLEM", previewable: false });
    expect(page.tokens[v2.versionId]).toBeUndefined();
  });

  it("after the revoke, the artifact route answers 404 for a token signed before it (the object read injected here)", async () => {
    const v = await seed();
    const token = signViewToken({ scope: "a", versionId: v.versionId, demoId: v.demoId, now: new Date(), key: KEY });
    const serve = () =>
      serveDemoFrame(
        { method: "GET", pathname: `/demo-frame/a/${token}/index.html`, search: "", origin: "http://127.0.0.1:3100", secFetchDest: "iframe" },
        { env: ENV, now: new Date(), store: () => ({ ...supabaseFrameStore(serviceClient()), object: async (key: string) => (key.startsWith(v.prefix) ? v.objects[key.slice(v.prefix.length)] ?? null : null) }) },
      );
    expect((await serve()).status).toBe(200);
    expect((await submitRevoke({ prospectId: v.prospectId, versionId: v.versionId, bundleSha256: await bundle(v), code: "SAFETY_CONCERN", urgent: true, confirmed: true }, deps())).ok).toBe(true);
    const res = await serve();
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");
  });

  it("urgent: only the urgent reasons; flag off, non-admin, stale, already revoked, no confirmation: refused", async () => {
    const v = await seed();
    const ok = { prospectId: v.prospectId, versionId: v.versionId, bundleSha256: await bundle(v), code: "FACT_ERROR", urgent: true, confirmed: true };
    const urgentWrong = await submitRevoke({ ...ok, code: "OWNER_DECISION" }, deps());
    expect(urgentWrong.ok === false && urgentWrong.refusals).toContain("URGENT_CODE");
    for (const [label, input, d] of [
      ["flag off", ok, deps(admin, { ...ENV, SALES_DEMO_VERSIONS_ENABLED: "false" })],
      ["outsider", ok, deps(outsider)],
      ["stale", { ...ok, bundleSha256: "1".repeat(64) }, deps()],
      ["unknown code", { ...ok, code: "SOMETHING" }, deps()],
      ["no confirmation", { ...ok, confirmed: false }, deps()],
    ] as Array<[string, unknown, ReturnType<typeof deps>]>) expect((await submitRevoke(input, d)).ok, label).toBe(false);
    expect((await versionRow(v)).status).toBe("draft");
    expect((await submitRevoke(ok, deps())).ok).toBe(true);
    const again = await submitRevoke(ok, deps());
    expect(again.ok === false && again.refusals).toContain("NOT_REVOCABLE");
  });
});

describe("an open send (send_opened)", () => {
  it("withdraw and revoke are refused with the fixed message; the send is not settled or cancelled; the database refuses too", async () => {
    const v = await seed();
    const reviewId = await approve(v);
    const approvalId = await openSend(v);
    const w = await submitWithdraw({ prospectId: v.prospectId, versionId: v.versionId, reviewId, bundleSha256: await bundle(v), confirmed: true }, deps());
    expect(w).toMatchObject({ ok: false, error: APPROVAL_OPEN_MESSAGE, refusals: ["APPROVAL_OPEN"] });
    const rv = await submitRevoke({ prospectId: v.prospectId, versionId: v.versionId, bundleSha256: await bundle(v), code: "FACT_ERROR", urgent: true, confirmed: true }, deps());
    expect(rv.ok === false && rv.refusals).toContain("APPROVAL_OPEN");
    expect((await one("select state from public.sales_outreach_approvals where id = $1", [approvalId])).state).toBe("send_opened");
    expect((await versionRow(v)).status).toBe("approved");
    // the DEV-196c functions refuse it on their own as well
    expect((await admin.rpc("sales_revoke_demo_version", { p_version_id: v.versionId, p_code: "FACT_ERROR" })).error?.message).toContain("approval_open");
  });
});
