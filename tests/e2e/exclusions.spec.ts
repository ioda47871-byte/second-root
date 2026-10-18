import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { ensureUsers, removeUsers, usersFor } from "./support/admin-users";

// DEV-049: the admin adds and removes an exclusion (existing customer).

test.describe.configure({ mode: "serial" });

let db: pg.Pool;
let ADMIN: ReturnType<typeof usersFor>["admin"];
let handle: string;

test.beforeAll(async ({}, testInfo) => {
  db = new pg.Pool({ connectionString: process.env.SUPABASE_DB_URL, max: 2 });
  ADMIN = usersFor(`excl-${testInfo.project.name}`).admin;
  await ensureUsers(`excl-${testInfo.project.name}`);
  handle = `e2e_excl_${testInfo.project.name}_${Date.now()}`.slice(0, 30);
});
test.afterAll(async ({}, testInfo) => {
  await db.query("delete from public.sales_exclusions where instagram_handle = $1", [handle]);
  await db.end();
  await removeUsers(`excl-${testInfo.project.name}`);
});

async function login(page: Page) {
  await page.goto("/admin/login");
  await page.getByLabel("メールアドレス").fill(ADMIN.email);
  await page.getByLabel("パスワード").fill(ADMIN.password);
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(page).toHaveURL(/\/admin\/sales$/);
}

test("adds an existing customer by Instagram URL and removes it after confirmation", async ({ page }) => {
  await login(page);
  await page.goto("/admin/sales/history");
  await page.getByRole("link", { name: "除外リスト（既存のお客様など）" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "除外リスト" })).toBeVisible();

  const form = page.getByTestId("exclusion-form");
  await form.getByLabel("表示名（店名など・必須）").fill("E2E 既存のお客様");
  await form.getByLabel("Instagram（URL か @ユーザー名）").fill(`https://www.instagram.com/${handle.toUpperCase()}/`);
  await form.getByRole("button", { name: "除外リストに追加" }).click();
  await expect(form.getByRole("status")).toHaveText("追加しました。");

  const item = page.getByTestId("exclusion-item").filter({ hasText: `@${handle}` });
  await expect(item).toBeVisible();
  await expect(item.getByText("既存顧客")).toBeVisible();
  const { rows } = await db.query("select reason, created_by is not null as by_admin from public.sales_exclusions where instagram_handle = $1", [handle]);
  expect(rows).toEqual([{ reason: "existing_customer", by_admin: true }]);

  // The same account again is refused with a clear message.
  await form.getByLabel("表示名（店名など・必須）").fill("E2E 重複");
  await form.getByLabel("Instagram（URL か @ユーザー名）").fill(`@${handle}`);
  await form.getByRole("button", { name: "除外リストに追加" }).click();
  await expect(form.getByRole("alert")).toContainText("すでに除外リストにあります");

  await item.getByRole("button", { name: "除外をやめる" }).click();
  await item.getByRole("button", { name: "はい、除外をやめる" }).click();
  await expect(page.getByTestId("exclusion-item").filter({ hasText: `@${handle}` })).toHaveCount(0);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("refuses an input without any matching key", async ({ page }) => {
  await login(page);
  await page.goto("/admin/sales/exclusions");
  const form = page.getByTestId("exclusion-form");
  await form.getByLabel("表示名（店名など・必須）").fill("E2E 鍵なし");
  await form.getByRole("button", { name: "除外リストに追加" }).click();
  await expect(form.getByRole("alert")).toContainText("1つ以上");
});
