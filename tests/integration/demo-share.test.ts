import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { serveDemoFrame, type FrameRequest } from "@/lib/demo-frame/serve";
import { supabaseFrameStore } from "@/lib/demo-frame/store";
import { resolveLegacyOnly, resolveShareOuter } from "@/lib/sales/demo-share";
import { signViewToken } from "@/lib/sales/demo-version/view-token";
import { seedDemoVersion, storageStatus } from "../support/seed-demo-version";
import { pinSentApproval, setShareSwitch } from "../support/share-fixture";
import { anonClient, createUser, db, resetSalesData, serviceClient, signedInClient, makeAdmin } from "./helpers";

// DEV-196g on the LOCAL stack: the database switch (owner-only, default off), sales_resolve_demo_share with it on and
// off, and the share route's decision with the real store (the resolver asked per file). Fictional shops only.

const KEY = randomBytes(32);
const APP = "http://127.0.0.1:3100";
const ART = "http://localhost:3100";
const ENV = { SALES_DEMO_VERSIONS_ENABLED: "true", SALES_DEMO_SHARE_ENABLED: "true", SALES_DEMO_VIEW_SIGNING_KEY: KEY.toString("base64url"), SALES_DEMO_ARTIFACT_ORIGIN: ART, SALES_DEMO_APP_ORIGIN: APP };
let adminId: string;
let storageUp = false;

const resolve = async (token: string) => (await db.query("select public.sales_resolve_demo_share($1) as r", [token])).rows[0].r as { mode: string; version_id?: string };
const tokenOf = async (demoId: string) => (await db.query("select public_token from public.sales_demos where id = $1", [demoId])).rows[0].public_token as string;
const frame = (versionId: string, demoId: string, path = "index.html", dest = "iframe"): FrameRequest => ({
  method: "GET",
  pathname: `/demo-frame/p/${signViewToken({ scope: "p", versionId, demoId, now: new Date(), key: KEY })}/${path}`,
  search: "",
  origin: ART,
  secFetchDest: dest,
});
const serve = (r: FrameRequest, env: Record<string, string | undefined> = ENV) => serveDemoFrame(r, { env, now: new Date(), store: () => supabaseFrameStore(serviceClient()) }, "p");

beforeAll(async () => {
  adminId = await createUser(`dev196g-admin-${randomBytes(4).toString("hex")}@example.com`);
  storageUp = (await storageStatus()).available;
});
beforeEach(async () => {
  await resetSalesData();
  await makeAdmin(adminId);
  await setShareSwitch(db, false);
});
afterAll(async () => {
  await setShareSwitch(db, false);
  await resetSalesData();
});

describe("the database switch (sales_demo_share_settings)", () => {
  it("starts off; no API role can read or change it; the owner can", async () => {
    expect((await db.query("select versioned_sharing_enabled from public.sales_demo_share_settings")).rows).toEqual([{ versioned_sharing_enabled: false }]);
    expect((await db.query("select public.sales_demo_versioned_sharing_enabled() as on")).rows[0].on).toBe(false);
    const svc = await serviceClient().from("sales_demo_share_settings").update({ versioned_sharing_enabled: true }).eq("id", true).select();
    expect(svc.error?.message ?? "").toMatch(/share_switch_owner_only/);
    const admin = await signedInClient((await db.query("select email from auth.users where id = $1", [adminId])).rows[0].email);
    expect((await admin.from("sales_demo_share_settings").select("*")).data ?? []).toEqual([]);
    expect((await anonClient().from("sales_demo_share_settings").select("*")).error).not.toBeNull();
    expect((await serviceClient().rpc("sales_demo_versioned_sharing_enabled")).data).toBe(false);
    expect((await admin.rpc("sales_demo_versioned_sharing_enabled")).error).not.toBeNull();
    await expect(db.query("insert into public.sales_demo_share_settings (id) values (true)")).rejects.toThrow();
    await expect(db.query("delete from public.sales_demo_share_settings")).rejects.toThrow(/share_switch_single_row/);
    await setShareSwitch(db, true);
    expect((await db.query("select public.sales_demo_versioned_sharing_enabled() as on")).rows[0].on).toBe(true);
  });
});

describe("sales_resolve_demo_share with the switch", () => {
  it("off: a pinned version is 'none' exactly as before; legacy stays legacy", async () => {
    const v = await seedDemoVersion(db, serviceClient(), { noPhoto: true, upload: false });
    await pinSentApproval(db, { prospectId: v.prospectId, versionId: v.versionId, userId: adminId });
    expect(await resolve(await tokenOf(v.demoId))).toEqual({ mode: "none" });
    const legacy = await seedDemoVersion(db, serviceClient(), { noPhoto: true, upload: false });
    await pinSentApproval(db, { prospectId: legacy.prospectId, versionId: null, userId: adminId });
    expect(await resolve(await tokenOf(legacy.demoId))).toEqual({ mode: "legacy" });
  });

  it("on: exactly the pinned photo-less version; never another, never with a photo, revoked or after expiry/disable", async () => {
    await setShareSwitch(db, true);
    const v = await seedDemoVersion(db, serviceClient(), { noPhoto: true, upload: false });
    const newer = await seedDemoVersion(db, serviceClient(), { noPhoto: true, upload: false, into: { prospectId: v.prospectId, demoId: v.demoId, parentVersionId: v.versionId } });
    await pinSentApproval(db, { prospectId: v.prospectId, versionId: v.versionId, userId: adminId });
    const token = await tokenOf(v.demoId);
    expect(await resolve(token)).toEqual({ mode: "version", version_id: v.versionId });
    expect((await resolve(token)).version_id).not.toBe(newer.versionId);

    // a version with a photo (owner_provided_internal: not shareable; photos are not shared yet)
    const withPhoto = await seedDemoVersion(db, serviceClient(), { upload: false });
    await pinSentApproval(db, { prospectId: withPhoto.prospectId, versionId: withPhoto.versionId, userId: adminId });
    expect(await resolve(await tokenOf(withPhoto.demoId))).toEqual({ mode: "none" });

    // revoked → none (no fallback to the newer version or the React demo)
    await db.query("alter table public.sales_demo_versions disable trigger user");
    try {
      await db.query("update public.sales_demo_versions set status = 'revoked', revoked_at = now(), revoked_by = $2, revoke_code = 'ADMIN_REVOKED' where id = $1", [v.versionId, adminId]);
    } finally {
      await db.query("alter table public.sales_demo_versions enable trigger user");
    }
    expect(await resolve(token)).toEqual({ mode: "none" });
  });

  it("on: an expired or disabled demo is none", async () => {
    await setShareSwitch(db, true);
    const v = await seedDemoVersion(db, serviceClient(), { noPhoto: true, upload: false });
    await pinSentApproval(db, { prospectId: v.prospectId, versionId: v.versionId, userId: adminId });
    const token = await tokenOf(v.demoId);
    await db.query("update public.sales_demos set expires_at = now() - interval '1 minute' where id = $1", [v.demoId]);
    expect(await resolve(token)).toEqual({ mode: "none" });
    await db.query("update public.sales_demos set expires_at = now() + interval '1 day', disabled_at = now() where id = $1", [v.demoId]);
    expect(await resolve(token)).toEqual({ mode: "none" });
  });
});

describe("the share page decision and the share route with the real store", () => {
  it("PR #267 M1: share flag off — the React demo only for legacy; a pinned demo is 404 whatever the database switch", async () => {
    const legacy = await seedDemoVersion(db, serviceClient(), { noPhoto: true, upload: false });
    await pinSentApproval(db, { prospectId: legacy.prospectId, versionId: null, userId: adminId });
    expect(await resolveLegacyOnly(serviceClient(), await tokenOf(legacy.demoId))).toBe(true);
    const v = await seedDemoVersion(db, serviceClient(), { noPhoto: true, upload: false });
    await pinSentApproval(db, { prospectId: v.prospectId, versionId: v.versionId, userId: adminId });
    for (const on of [false, true]) {
      await setShareSwitch(db, on);
      expect(await resolveLegacyOnly(serviceClient(), await tokenOf(v.demoId)), `switch ${on}`).toBe(false);
    }
    // unsent (not public) is not React either
    const unsent = await seedDemoVersion(db, serviceClient(), { noPhoto: true, upload: false });
    expect(await resolveLegacyOnly(serviceClient(), await tokenOf(unsent.demoId))).toBe(false);
  });

  it("resolveShareOuter: version → the frame URL on the artifact origin; switch off → not found (never the React demo)", async () => {
    const v = await seedDemoVersion(db, serviceClient(), { noPhoto: true, upload: false });
    await pinSentApproval(db, { prospectId: v.prospectId, versionId: v.versionId, userId: adminId });
    const token = await tokenOf(v.demoId);
    expect(await resolveShareOuter(serviceClient(), token, { env: ENV, now: new Date() })).toEqual({ kind: "not_found" });
    await setShareSwitch(db, true);
    const r = await resolveShareOuter(serviceClient(), token, { env: ENV, now: new Date() });
    expect(r.kind).toBe("version");
    if (r.kind === "version") expect(r.frameSrc.startsWith(`${ART}/demo-frame/p/`)).toBe(true);
  });

  it.skipIf(!process.env.NEXT_PUBLIC_SUPABASE_URL)("serves the pinned version's files only while everything holds", async () => {
    if (!storageUp) return; // CI runs without the storage API: the decision tests above still run
    await setShareSwitch(db, true);
    const v = await seedDemoVersion(db, serviceClient(), { noPhoto: true });
    const other = await seedDemoVersion(db, serviceClient(), { noPhoto: true, into: { prospectId: v.prospectId, demoId: v.demoId } });
    await pinSentApproval(db, { prospectId: v.prospectId, versionId: v.versionId, userId: adminId });
    const ok = await serve(frame(v.versionId, v.demoId));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-security-policy")).toContain(`frame-ancestors ${APP}`);
    expect(Buffer.from(await ok.arrayBuffer()).equals(Buffer.from(v.objects["page/index.html"]!))).toBe(true);
    expect((await serve(frame(v.versionId, v.demoId, "style.css", "style"))).status).toBe(200);
    // another version of the same demo, a render, the share flag off, the switch off: 404
    expect((await serve(frame(other.versionId, other.demoId))).status).toBe(404);
    expect((await serve(frame(v.versionId, v.demoId, "renders/desktop_1440.webp", "image"))).status).toBe(404);
    expect((await serve(frame(v.versionId, v.demoId), { ...ENV, SALES_DEMO_SHARE_ENABLED: "false" })).status).toBe(404);
    await setShareSwitch(db, false);
    expect((await serve(frame(v.versionId, v.demoId))).status).toBe(404);
  });
});
