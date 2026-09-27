import { expect, test, type Page } from "@playwright/test";
import { ADMIN, OUTSIDER, ensureUsers, removeUsers } from "./support/admin-users";

// Admin login (Supabase Auth email + password) and the mobile-first shell.

test.describe.configure({ mode: "serial" });
test.beforeAll(ensureUsers);
test.afterAll(removeUsers);

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
  await expect(page.getByRole("alert")).toHaveText("メールアドレスまたはパスワードが正しくありません。");
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
