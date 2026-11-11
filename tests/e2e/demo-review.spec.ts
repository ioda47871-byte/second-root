import { randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { ensureUsers, removeUsers, usersFor } from "./support/admin-users";
import { startFlagOnServer, type FlagOnServer } from "./support/flag-on-server";
import { DEMO_VERSIONS_BUCKET, seedDemoVersion, storageStatus, type SeededVersion } from "../support/seed-demo-version";

// DEV-196d-5 (spec §7.2・§8.3・§9): the admin's quality decision on the real screen, at PC 1440 and SP 390, against a
// second server with the flag ON (the suite's server keeps it off). The change request runs without Storage; the
// approvals need the renders scrolled to their end, so they run only where the storage service is running.
// Fictional shops and example.com only.

const ON_PORT = Number(process.env.E2E_PORT ?? 3100) + 14;
const USERS_KEY = "demo-review";
const HTML =
  '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>架空の店</title><link rel="stylesheet" href="style.css"></head>' +
  '<body><h1>架空の焼き菓子店</h1><p>朝の光と焼き色</p><img src="photos/hero-desktop.webp" alt="店の写真"></body></html>';

let on: FlagOnServer;
let db: pg.Pool;
let svc: SupabaseClient;
let storageUp = false;
let skipReason = "";
let adminId = "";
const seeded: SeededVersion[] = [];

test.describe.configure({ mode: "serial" });
test.skip(({ isMobile }) => isMobile, "one flag-on server: the desktop project runs this file and sets 1440 / 390 itself");

test.beforeAll(async () => {
  db = new pg.Pool({ connectionString: process.env.SUPABASE_DB_URL, max: 2 });
  svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const storage = await storageStatus();
  storageUp = storage.available;
  skipReason = storage.available ? "" : `${storage.reason} — approving needs the renders scrolled to their end; runs locally with Storage`;
  await ensureUsers(USERS_KEY);
  adminId = (await db.query("select id from auth.users where email = $1", [usersFor(USERS_KEY).admin.email])).rows[0].id as string;
  on = await startFlagOnServer(ON_PORT, randomBytes(32), { review: true }); // DEV-196k: writes need the review flag
});

test.afterAll(async () => {
  on?.stop();
  if (storageUp) for (const s of seeded) await svc.storage.from(DEMO_VERSIONS_BUCKET).remove(Object.keys(s.objects).map((n) => `${s.prefix}${n}`));
  await removeUsers(USERS_KEY);
  await db?.end();
});

async function seed(o: { ai?: boolean } = {}) {
  const s = await seedDemoVersion(db, svc, { html: HTML, shopName: `架空の焼き菓子店${randomBytes(3).toString("hex")}`, renderHeights: { desktop: 2400, mobile: 2600 }, ...(o.ai ? { aiConceptConfirmedBy: adminId } : {}) });
  seeded.push(s);
  return s;
}
async function login(page: Page) {
  const { admin } = usersFor(USERS_KEY);
  await page.goto(`${on.origin}/admin/login`);
  await page.getByLabel("メールアドレス").fill(admin.email);
  await page.getByLabel("パスワード").fill(admin.password);
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(page).toHaveURL(/\/admin\/sales/);
}
const open = (page: Page, s: SeededVersion) => page.goto(`${on.origin}/admin/sales/demos/${s.prospectId}`);
const answerAll = async (page: Page, answer: "問題なし" | "問題あり" = "問題なし") => {
  for (const item of await page.locator("[data-item]").all()) await item.getByLabel(answer).check();
};
const scrollRenders = async (page: Page) => {
  for (const v of ["desktop_1440", "mobile_390"]) {
    const figure = page.locator(`[data-render="${v}"]`);
    await expect(figure).toHaveAttribute("data-image", "ok");
    await page.locator(`[data-scroll="${v}"]`).evaluate((b) => b.scrollTo(0, b.scrollHeight));
    await expect(figure).toHaveAttribute("data-viewed", "true");
  }
};
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const reviewRows = async (s: SeededVersion) => (await db.query("select decision, state, reviewed_by from public.sales_demo_quality_reviews where version_id = $1", [s.versionId])).rows;

for (const vp of [
  { name: "PC 1440", width: 1440, height: 900 },
  { name: "SP 390", width: 390, height: 844 },
]) {
  test(`${vp.name}: nothing starts checked; 修正を依頼 needs an ng and is recorded as this admin (runs without Storage)`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    const s = await seed();
    await login(page);
    await open(page, s);
    const form = page.locator("[data-review-form]");
    await expect(form).toBeVisible();
    await expect(form.locator('input[type="radio"]:checked')).toHaveCount(0);
    await expect(form.locator('input[type="checkbox"]:checked')).toHaveCount(0);
    for (const b of ["品質承認", "修正を依頼", "却下"]) await expect(form.getByRole("button", { name: b, exact: true })).toBeDisabled();
    await answerAll(page);
    // all ok: no send-back; and no approval without the renders viewed and the acknowledgement
    await expect(form.getByRole("button", { name: "修正を依頼" })).toBeDisabled();
    await expect(form.getByRole("button", { name: "品質承認" })).toBeDisabled();
    await form.locator('[data-item="shop_specific_structure"]').getByLabel("問題あり").check();
    await expect(form.getByRole("button", { name: "品質承認" })).toBeDisabled();
    await form.getByRole("button", { name: "修正を依頼" }).click();
    await expect(form.locator('[data-review-result="done"]')).toContainText("「修正を依頼」を記録しました");
    expect(await reviewRows(s)).toEqual([{ decision: "changes_requested", state: "active", reviewed_by: adminId }]);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });
}

test("Low (a): a note like style.css shows the clear message and blocks the decision", async ({ page }) => {
  const s = await seed();
  await login(page);
  await open(page, s);
  const form = page.locator("[data-review-form]");
  await answerAll(page, "問題あり");
  await form.locator("textarea").fill("style.css の余白");
  await expect(form.getByRole("alert")).toContainText("「style.css」「example.com」");
  await expect(form.getByRole("button", { name: "修正を依頼" })).toBeDisabled();
  await form.locator("textarea").fill("スタイルシートの余白");
  await expect(form.getByRole("button", { name: "修正を依頼" })).toBeEnabled();
});

for (const vp of [
  { name: "PC 1440", width: 1440, height: 900 },
  { name: "SP 390", width: 390, height: 844 },
]) {
  test(`${vp.name}: 品質承認 only after 7 ok + both renders to the end + the acknowledgement; warned before and after`, async ({ page }) => {
    test.skip(!storageUp, skipReason);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    const s = await seed();
    await login(page);
    await open(page, s);
    const form = page.locator("[data-review-form]");
    const approve = form.getByRole("button", { name: "品質承認" });
    await answerAll(page);
    await expect(approve).toBeDisabled();
    await scrollRenders(page);
    await expect(form.locator("[data-review-summary]")).toContainText("7項目 7/7・PC✓・SP✓");
    await expect(approve).toBeDisabled(); // the acknowledgement is still missing
    await expect(form.locator('[data-approval-warning="form"]')).toContainText("送信承認は止まります");
    await form.locator("[data-ack]").check();
    await expect(approve).toBeEnabled();
    await approve.click();
    await expect(form.locator('[data-review-result="done"]')).toContainText("今は送信承認ができません");
    expect(await reviewRows(s)).toEqual([{ decision: "approved", state: "active", reviewed_by: adminId }]);
    // after the refresh: the version is approved and the page says sending is stopped and why
    await expect(page.locator('[data-version="1"]')).toContainText("品質承認済み");
    await expect(page.locator("[data-send-stop]")).toHaveAttribute("data-send-stop", "demo_not_shareable");
    await expect(page.locator("[data-review-form]")).toHaveCount(0);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });
}

test("AI concept image: approval waits for its own 「事実の偽装なし」 confirmation", async ({ page }) => {
  test.skip(!storageUp, skipReason);
  const s = await seed({ ai: true });
  await login(page);
  await open(page, s);
  const form = page.locator("[data-review-form]");
  const approve = form.getByRole("button", { name: "品質承認" });
  await answerAll(page);
  await scrollRenders(page);
  await form.locator("[data-ack]").check();
  await expect(form.locator("[data-review-summary]")).toContainText("画像 0/1");
  await expect(approve).toBeDisabled();
  await form.locator(`[data-confirm-image="${s.imageId}"] input[type="checkbox"]`).check();
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect(form.locator('[data-review-result="done"]')).toBeVisible();
  expect(await reviewRows(s)).toEqual([{ decision: "approved", state: "active", reviewed_by: adminId }]);
});
