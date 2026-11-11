import { randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { ensureUsers, removeUsers, usersFor } from "./support/admin-users";
import { startFlagOnServer, type FlagOnServer } from "./support/flag-on-server";
import { DEFAULT_CSS, DEMO_VERSIONS_BUCKET, seedDemoVersion, storageStatus, type SeededVersion } from "../support/seed-demo-version";

// DEV-196d-4 (spec §4.1・§7.2): the admin compare page for two versions of one fictional shop's demo, at PC 1440 and
// SP 390. The suite's server keeps the flag OFF (404); a second server from the same build has it ON. Checks that
// read the bucket (the page text and the renders) skip only when the storage service is not running (CI).

const ON_PORT = Number(process.env.E2E_PORT ?? 3100) + 13;
const USERS_KEY = "demo-compare";
const page1 =
  '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>架空の店</title><link rel="stylesheet" href="style.css"></head>' +
  '<body><h1>架空の焼き菓子店</h1><p>朝の光と焼き色</p><img src="photos/hero-desktop.webp" alt="店の写真"></body></html>';
/** v2 also shows the shop's stored name as its own line: a fact line */
const page2 = (shopName: string) =>
  '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>架空の店</title><link rel="stylesheet" href="style.css"></head>' +
  `<body><h1>架空の焼き菓子店</h1><p>静かな午後の一皿</p><p>${shopName}</p><img src="photos/hero-desktop.webp" alt="店の写真"></body></html>`;
let shopName = "";

let on: FlagOnServer;
let db: pg.Pool;
let svc: SupabaseClient;
let storageUp = false;
let skipReason = "";
let v1: SeededVersion;
let v2: SeededVersion;

test.describe.configure({ mode: "serial" });
test.skip(({ isMobile }) => isMobile, "one flag-on server: the desktop project runs this file and sets 1440 / 390 itself");

test.beforeAll(async () => {
  db = new pg.Pool({ connectionString: process.env.SUPABASE_DB_URL, max: 2 });
  svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const storage = await storageStatus();
  storageUp = storage.available;
  skipReason = storage.available ? "" : `${storage.reason} — the text diff and renders run locally with Storage`;
  await ensureUsers(USERS_KEY);
  v1 = await seedDemoVersion(db, svc, { html: page1, css: DEFAULT_CSS, renderHeights: { desktop: 3000, mobile: 3200 } });
  shopName = (await db.query("select name from public.sales_prospects where id = $1", [v1.prospectId])).rows[0].name as string;
  v2 = await seedDemoVersion(db, svc, { html: page2(shopName), css: DEFAULT_CSS, renderHeights: { desktop: 3600, mobile: 3800 }, into: { prospectId: v1.prospectId, demoId: v1.demoId, parentVersionId: v1.versionId } });
  on = await startFlagOnServer(ON_PORT, randomBytes(32));
});

test.afterAll(async () => {
  on?.stop();
  if (storageUp) for (const s of [v1, v2]) if (s) await svc.storage.from(DEMO_VERSIONS_BUCKET).remove(Object.keys(s.objects).map((n) => `${s.prefix}${n}`));
  await removeUsers(USERS_KEY);
  await db?.end();
});

async function login(page: Page, origin: string) {
  const { admin } = usersFor(USERS_KEY);
  await page.goto(`${origin}/admin/login`);
  await page.getByLabel("メールアドレス").fill(admin.email);
  await page.getByLabel("パスワード").fill(admin.password);
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(page).toHaveURL(/\/admin\/sales/);
}
const url = (origin: string, q = "") => `${origin}/admin/sales/demos/${v1.prospectId}/compare${q}`;
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test("flag off (the suite's server): the compare page is 404 for the signed-in admin", async ({ page, baseURL }) => {
  await login(page, baseURL!);
  expect((await page.goto(url(baseURL!)))?.status()).toBe(404);
});

test("flag on: default pair is the parent v1 against the candidate v2; meta, structure and files are shown; headers", async ({ page }) => {
  await login(page, on.origin);
  const res = await page.goto(url(on.origin));
  expect(res?.status()).toBe(200);
  expect(res?.headers()["content-security-policy"]).toBe("frame-ancestors 'none'; frame-src 'self'");
  expect(res?.headers()["x-frame-options"]).toBe("DENY");
  await expect(page.locator("[data-compare-pair]")).toHaveAttribute("data-compare-pair", "1-2");
  await expect(page.locator('[data-compare="meta"]')).toContainText("同じ事実から作られています");
  await expect(page.locator('[data-file="page/index.html"]')).toHaveAttribute("data-change", "changed");
  await expect(page.locator('[data-file="page/style.css"]')).toHaveAttribute("data-change", "same");
  await expect(page.locator('[data-compare="structure"]')).toContainText("計測なし");
  // read only: the only forms are the GET picker and the shell's logout
  await expect(page.locator('form[method="get"]')).toHaveCount(1);
  expect((await page.goto(`${on.origin}/admin/sales/demos/00000000-0000-4000-8000-000000000000/compare`))?.status()).toBe(404);
});

test("the picker swaps the pair (GET, no write); the version page links to the compare page", async ({ page }) => {
  await login(page, on.origin);
  await page.goto(`${on.origin}/admin/sales/demos/${v1.prospectId}`);
  await page.getByRole("link", { name: "版を比べる" }).click();
  await expect(page).toHaveURL(/\/compare\?b=/);
  await page.getByLabel("比べる元（左）").selectOption(v2.versionId);
  await page.getByLabel("比べる版（右）").selectOption(v1.versionId);
  await page.getByRole("button", { name: "比較する" }).click();
  await expect(page).toHaveURL(new RegExp(`a=${v2.versionId}&b=${v1.versionId}`));
  await expect(page.locator("[data-compare-pair]")).toHaveAttribute("data-compare-pair", "2-1");
});

test("the page text line by line: the changed sentence is removed / added, the shop's name is a fact line", async ({ page }) => {
  test.skip(!storageUp, skipReason);
  await login(page, on.origin);
  await page.goto(url(on.origin));
  const list = page.locator('[data-copy="ok"]');
  await expect(list.locator('[data-op="del"]', { hasText: "朝の光と焼き色" })).toHaveCount(1);
  await expect(list.locator('[data-op="add"]', { hasText: "静かな午後の一皿" })).toHaveCount(1);
  // the shop's stored name is a fact line; the made-up heading is not called a fact (nor creative)
  await expect(list.locator('[data-op="add"][data-kind="fact"]', { hasText: shopName })).toHaveCount(1);
  await expect(list.locator('[data-op="same"][data-kind="unknown"]', { hasText: "架空の焼き菓子店" })).toHaveCount(1);
  await expect(page.locator("[data-copy-counts]")).toHaveAttribute("data-copy-counts", "2/1");
});

for (const vp of [
  { name: "PC 1440", width: 1440, height: 900 },
  { name: "SP 390", width: 390, height: 844 },
]) {
  test(`${vp.name}: renders side by side with synced scrolling, then overlaid with an opacity slider; no page overflow`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await login(page, on.origin);
    await page.goto(url(on.origin));
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    test.skip(!storageUp, skipReason);
    const a = page.locator('[data-compare-scroll="a"]');
    const b = page.locator('[data-compare-scroll="b"]');
    for (const box of [a, b]) await expect.poll(() => box.locator("img").evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBe(1440);
    // both boxes really scroll (the whole render is reachable), and scrolling one moves the other
    for (const box of [a, b]) await expect.poll(() => box.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(50);
    await a.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await expect.poll(() => b.evaluate((el) => Math.round((el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight)) * 100))).toBeGreaterThanOrEqual(98);
    await page.getByRole("button", { name: "SP 390" }).click();
    await expect.poll(() => a.locator("img").evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBe(390);
    await page.getByRole("button", { name: "重ねる" }).click();
    const slider = page.getByRole("slider");
    await slider.fill("80");
    await expect(page.locator("[data-overlay-opacity]")).toHaveAttribute("data-overlay-opacity", "80");
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });
}
