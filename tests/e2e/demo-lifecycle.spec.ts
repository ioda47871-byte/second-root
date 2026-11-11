import { randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { QUALITY_CHECKLIST_ITEMS } from "@/lib/sales/demo-version/quality";
import { ensureUsers, removeUsers, usersFor } from "./support/admin-users";
import { startFlagOnServer, type FlagOnServer } from "./support/flag-on-server";
import { seedDemoVersion, type SeededVersion } from "../support/seed-demo-version";

// DEV-196d-6 (spec §4.6・§6.6・§9.4・§9.5): withdrawing an approval and revoking a version (normal / urgent) on the real
// screen at PC 1440 and SP 390, against a second server with the flag ON. Approvals are set up through the real
// function as the admin, so nothing here needs Storage (runs in CI). Fictional shops and example.com only.

const ON_PORT = Number(process.env.E2E_PORT ?? 3100) + 15;
const USERS_KEY = "demo-lifecycle";
const ALL_OK = Object.fromEntries(QUALITY_CHECKLIST_ITEMS.map((k) => [k, "ok"]));

let on: FlagOnServer;
let db: pg.Pool;
let svc: SupabaseClient;
let adminRpc: SupabaseClient;
let adminId = "";
/** outreaches this file created for the open-send case: removed afterwards so the shared Today queue is untouched */
const outreaches: string[] = [];

test.describe.configure({ mode: "serial" });
test.skip(({ isMobile }) => isMobile, "one flag-on server: the desktop project runs this file and sets 1440 / 390 itself");

test.beforeAll(async () => {
  db = new pg.Pool({ connectionString: process.env.SUPABASE_DB_URL, max: 2 });
  svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  await ensureUsers(USERS_KEY);
  const { admin } = usersFor(USERS_KEY);
  adminId = (await db.query("select id from auth.users where email = $1", [admin.email])).rows[0].id as string;
  adminRpc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  expect((await adminRpc.auth.signInWithPassword(admin)).error).toBeNull();
  on = await startFlagOnServer(ON_PORT, randomBytes(32), { review: true }); // DEV-196k: writes need the review flag
});

test.afterAll(async () => {
  on?.stop();
  // the approvals go with their outreach (on delete cascade); other specs share the Today queue (max 5 items)
  if (outreaches.length) await db.query("delete from public.sales_outreaches where id = any($1::uuid[])", [outreaches]);
  await removeUsers(USERS_KEY);
  await db?.end();
});

const one = async (sql: string, args: unknown[]) => (await db.query(sql, args)).rows[0];
async function twoVersions() {
  const v1 = await seedDemoVersion(db, svc, { upload: false });
  const v2 = await seedDemoVersion(db, svc, { upload: false, into: { prospectId: v1.prospectId, demoId: v1.demoId, parentVersionId: v1.versionId } });
  return { v1, v2 };
}
/** The admin's own quality approval through sales_review_demo_version (the 196d-5 screen is tested on its own). */
async function approve(v: SeededVersion) {
  const sha = async (p: string) => (await one("select sha256 from public.sales_demo_version_files where version_id = $1 and path = $2", [v.versionId, p])).sha256 as string;
  const r = await adminRpc.rpc("sales_review_demo_version", {
    p_version_id: v.versionId, p_decision: "approved", p_checklist: ALL_OK, p_note: null,
    p_viewed_renders: { desktop_1440: await sha("renders/desktop_1440.webp"), mobile_390: await sha("renders/mobile_390.webp") },
    p_bundle_sha256: (await one("select bundle_sha256 from public.sales_demo_versions where id = $1", [v.versionId])).bundle_sha256,
  });
  expect(r.error, r.error?.message).toBeNull();
}
async function login(page: Page) {
  const { admin } = usersFor(USERS_KEY);
  await page.goto(`${on.origin}/admin/login`);
  await page.getByLabel("メールアドレス").fill(admin.email);
  await page.getByLabel("パスワード").fill(admin.password);
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(page).toHaveURL(/\/admin\/sales/);
}
const open = (page: Page, v: SeededVersion) => page.goto(`${on.origin}/admin/sales/demos/${v.prospectId}?v=${v.versionId}`);
const status = async (v: SeededVersion) => (await one("select status, revoke_code from public.sales_demo_versions where id = $1", [v.versionId])) as { status: string; revoke_code: string | null };
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

for (const vp of [
  { name: "PC 1440", width: 1440, height: 900 },
  { name: "SP 390", width: 390, height: 844 },
]) {
  test(`${vp.name}: withdraw in two steps; the version is a draft again; the other version is not approved`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    const { v1, v2 } = await twoVersions();
    await approve(v2);
    await login(page);
    await open(page, v2);
    const panel = page.locator("[data-lifecycle]");
    await expect(panel.locator("[data-withdraw]")).toContainText("この版は下書きに戻り");
    await expect(panel.locator("[data-withdraw]")).toContainText("再承認なしで再び有効");
    await expect(panel.locator("[data-withdraw]")).toContainText("「デモを共有できない」の停止は外れます");
    await panel.getByRole("button", { name: "品質承認を取り下げる…" }).click();
    await expect(panel.locator('[data-confirm-step="withdraw"]')).toBeVisible();
    await panel.getByRole("button", { name: "取り下げる", exact: true }).click();
    await expect(panel.locator('[data-lifecycle-result="done"]')).toContainText("下書きに戻りました");
    expect((await status(v2)).status).toBe("draft");
    expect((await status(v1)).status).toBe("draft");
    expect((await one("select approved_version_id from public.sales_demos where id = $1", [v2.demoId])).approved_version_id).toBeNull();
    expect((await one("select state, withdrawn_by from public.sales_demo_quality_reviews where version_id = $1", [v2.versionId]))).toEqual({ state: "withdrawn", withdrawn_by: adminId });
    await expect(page).toHaveURL(new RegExp(`v=${v2.versionId}`));
    await expect(page.locator("[data-send-stop]")).toHaveCount(0);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });

  test(`${vp.name}: revoke with a reason in two steps; the page stays on the revoked version with no render; nothing switches`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    const { v1, v2 } = await twoVersions();
    await approve(v2);
    await login(page);
    await open(page, v2);
    const normal = page.locator('[data-revoke="normal"]');
    await expect(normal.getByRole("button", { name: "版を取り消す…" })).toBeDisabled(); // no reason yet
    await normal.getByRole("combobox").selectOption("QUALITY_PROBLEM");
    await normal.getByRole("button", { name: "版を取り消す…" }).click();
    await expect(normal.locator('[data-confirm-step="revoke"]')).toContainText("404");
    await normal.getByRole("button", { name: "取り消す（元に戻せません）" }).click();
    await expect(page.locator('[data-lifecycle-result="done"]')).toContainText("切り替えていません");
    expect(await status(v2)).toEqual({ status: "revoked", revoke_code: "QUALITY_PROBLEM" });
    // stays on the revoked version: revoked message with the reason, no render, no frame, no decision form
    await expect(page).toHaveURL(new RegExp(`v=${v2.versionId}`));
    await expect(page.locator('[data-preview-unavailable="version"]')).toContainText("取り消し済みです（理由: 品質の問題）");
    await expect(page.locator("[data-render], iframe, [data-review-form], [data-lifecycle]")).toHaveCount(0);
    await expect(page.locator('[data-version="2"]')).toHaveAttribute("data-gone", "true");
    // no automatic switch: v1 is still a draft and not approved in its place
    expect((await status(v1)).status).toBe("draft");
    expect((await one("select approved_version_id from public.sales_demos where id = $1", [v1.demoId])).approved_version_id).toBeNull();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });
}

test("SP 390: the urgent revoke is distinct, lists only urgent reasons, and says what it stops", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { v1 } = await twoVersions();
  await login(page);
  await open(page, v1);
  const urgent = page.locator('[data-revoke="urgent"]');
  await expect(urgent).toContainText("急ぎの取り消し");
  const options = await urgent.locator("option").allTextContents();
  expect(options).toEqual(["（選んでください）", "事実の誤り", "権利の苦情・誤り", "安全上の懸念"]);
  await urgent.getByRole("combobox").selectOption("SAFETY_CONCERN");
  await urgent.getByRole("button", { name: "急ぎで取り消す…" }).click();
  await expect(urgent.locator('[data-confirm-step="urgent"]')).toContainText("表示されなくなります（404）");
  await urgent.getByRole("button", { name: "急ぎで取り消す（元に戻せません）" }).click();
  await expect(page.locator('[data-preview-unavailable="version"]')).toContainText("安全上の懸念");
  expect(await status(v1)).toEqual({ status: "revoked", revoke_code: "SAFETY_CONCERN" });
});

test("an open send: withdraw / revoke cannot be pressed; the fixed message and the Today link are shown; nothing is settled", async ({ page }) => {
  const { v2 } = await twoVersions();
  await approve(v2);
  const o = await one("insert into public.sales_outreaches (prospect_id, kind, channel, body) values ($1, 'initial', 'instagram', 'はじめまして。') returning id", [v2.prospectId]);
  outreaches.push(o.id as string);
  const a = await one(
    `insert into public.sales_outreach_approvals (outreach_id, prospect_id, channel, recipient, body, draft_version, demo_token, demo_version, snapshot_sha256, approved_by)
     select o.id, o.prospect_id, o.channel, p.instagram_handle, o.body || ' /demo/' || d.public_token, o.draft_version, d.public_token,
            public.sales_demo_version(d), encode(sha256(convert_to(o.id::text, 'UTF8')), 'hex'), $2
       from public.sales_outreaches o join public.sales_prospects p on p.id = o.prospect_id join public.sales_demos d on d.prospect_id = p.id
      where o.id = $1 returning id`,
    [o.id, adminId],
  );
  await db.query("update public.sales_outreach_approvals set state = 'send_opened', opened_at = now(), last_opened_at = now(), opened_via = 'instagram_profile', open_count = 1 where id = $1", [a.id]);
  await login(page);
  await open(page, v2);
  const panel = page.locator("[data-lifecycle]");
  await expect(panel.locator('[data-lifecycle-blocked="approval_open"]')).toContainText("送信画面を開いた");
  await expect(panel.getByRole("link", { name: /今日の画面へ/ })).toHaveAttribute("href", "/admin/sales");
  await expect(panel.getByRole("button", { name: "品質承認を取り下げる…" })).toBeDisabled();
  await expect(panel.locator('[data-revoke="normal"] select')).toBeDisabled();
  expect((await one("select state from public.sales_outreach_approvals where id = $1", [a.id])).state).toBe("send_opened");
  expect((await status(v2)).status).toBe("approved");
});
