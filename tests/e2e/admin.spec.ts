import { expect, test, type Page } from "@playwright/test";
import { ensureUsers, removeUsers, usersFor } from "./support/admin-users";

// Admin login (Supabase Auth email + password) and the mobile-first shell.

test.describe.configure({ mode: "serial" });
let ADMIN: ReturnType<typeof usersFor>["admin"];
let OUTSIDER: ReturnType<typeof usersFor>["outsider"];
test.beforeAll(async ({}, testInfo) => {
  ({ admin: ADMIN, outsider: OUTSIDER } = usersFor(testInfo.project.name));
  await ensureUsers(testInfo.project.name);
});
test.afterAll(async ({}, testInfo) => removeUsers(testInfo.project.name));

async function login(page: Page, email: string, password: string) {
  await page.goto("/admin/login");
  await page.getByLabel("メールアドレス").fill(email);
  await page.getByLabel("パスワード").fill(password);
  await page.getByRole("button", { name: "ログイン" }).click();
}

test("redirects to login when signed out, with noindex headers", async ({ page }) => {
  const res = await page.goto("/admin/sales");
  await expect(page).toHaveURL(/\/admin\/login$/);
  expect(res?.headers()["x-robots-tag"]).toBe("noindex, nofollow");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
});

test("rejects a wrong password without saying which part was wrong", async ({ page }) => {
  await login(page, ADMIN.email, "wrong-password-000000");
  await expect(page.locator("form").getByRole("alert")).toHaveText("メールアドレスまたはパスワードが正しくありません。");
  await expect(page).toHaveURL(/\/admin\/login$/);
});

test("a signed-in user who is not on the allowlist is refused", async ({ page }) => {
  await login(page, OUTSIDER.email, OUTSIDER.password);
  await expect(page.getByRole("heading", { name: "権限がありません" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "営業管理" })).toHaveCount(0);
});

test("the admin signs in, uses the 4-tab navigation and signs out", async ({ page }) => {
  await login(page, ADMIN.email, ADMIN.password);
  await expect(page).toHaveURL(/\/admin\/sales$/);
  const nav = page.getByRole("navigation", { name: "営業管理" });
  for (const label of ["今日", "返信", "商談", "履歴"]) await expect(nav.getByRole("link", { name: label })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "今日やること" })).toBeVisible();
  await nav.getByRole("link", { name: "返信" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "返信" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "返信" })).toHaveAttribute("aria-current", "page");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.getByRole("button", { name: "ログアウト" }).click();
  await expect(page).toHaveURL(/\/admin\/login$/);
  await page.goto("/admin/sales");
  await expect(page).toHaveURL(/\/admin\/login$/);
});

test("the admin can preview an unsent demo that the public URL does not show", async ({ page }) => {
  const { seedDemo } = await import("../support/seed-demo");
  const pg = (await import("pg")).default;
  const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL });
  await db.connect();
  try {
    const demo = await seedDemo(db, { expiresAt: null });
    expect((await page.goto(`/demo/${demo.token}`))?.status()).toBe(404);
    await login(page, ADMIN.email, ADMIN.password);
    await expect(page).toHaveURL(/\/admin\/sales$/);
    await page.goto(`/admin/preview/${demo.prospectId}`);
    await expect(page.getByRole("status")).toContainText("未送信");
    await expect(page.getByRole("heading", { level: 1, name: demo.name })).toBeVisible();
    await db.query("delete from public.sales_prospects where id = $1", [demo.prospectId]);
  } finally {
    await db.end();
  }
});

test("a non-admin cannot open a demo preview", async ({ page }) => {
  await login(page, OUTSIDER.email, OUTSIDER.password);
  await expect(page.getByRole("heading", { name: "権限がありません" })).toBeVisible();
  const res = await page.goto("/admin/preview/00000000-0000-0000-0000-000000000000");
  expect(res?.status()).toBe(404);
});
