import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { ensureUsers, removeUsers, usersFor } from "./support/admin-users";

// DEV-049: the admin adds and removes an exclusion (existing customer).

test.describe.configure({ mode: "serial" });

let db: pg.Pool;
let ADMIN: ReturnType<typeof usersFor>["admin"];
let handle: string;
let email: string;
let emailLabel: string;

test.beforeAll(async ({}, testInfo) => {
  db = new pg.Pool({ connectionString: process.env.SUPABASE_DB_URL, max: 2 });
  ADMIN = usersFor(`excl-${testInfo.project.name}`).admin;
  await ensureUsers(`excl-${testInfo.project.name}`);
  handle = `e2e_excl_${testInfo.project.name}_${Date.now()}`.slice(0, 30);
  email = `owner.${testInfo.project.name}.${Date.now()}@customer.example.com`;
  emailLabel = `E2E メール ${testInfo.project.name} ${Date.now()}`;
});
test.afterAll(async ({}, testInfo) => {
  await db.query("delete from public.sales_exclusions where instagram_handle = $1 or label = $2", [handle, emailLabel]);
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

test("DEV-050: an email-only entry stores and shows no address", async ({ page }) => {
  await login(page);
  await page.goto("/admin/sales/exclusions");
  const form = page.getByTestId("exclusion-form");
  const label = emailLabel;
  await form.getByLabel("表示名（店名など・必須）").fill(label);
  await form.getByLabel(/メールアドレス/).fill(email.toUpperCase());
  await form.getByRole("button", { name: "除外リストに追加" }).click();
  await expect(form.getByRole("status")).toHaveText("追加しました。");
  const item = page.getByTestId("exclusion-item").filter({ hasText: label });
  await expect(item.getByText("メール: 登録済み（アドレスは保存していません）")).toBeVisible();
  const { rows } = await db.query(
    "select email_digest, row_to_json(e)::jsonb - 'label' as rest from public.sales_exclusions e where label = $1",
    [label],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].email_digest).toMatch(/^[0-9a-f]{64}$/);
  expect(JSON.stringify(rows[0].rest)).not.toContain("@");
  // The form is cleared after saving, so the address is not left on the page either.
  await expect(form.getByLabel(/メールアドレス/)).toHaveValue("");
  await item.getByRole("button", { name: "除外をやめる" }).click();
  await item.getByRole("button", { name: "はい、除外をやめる" }).click();
  await expect(page.getByTestId("exclusion-item").filter({ hasText: label })).toHaveCount(0);
  expect((await page.content()).toLowerCase()).not.toContain(email.toLowerCase());
});

test("DEV-050: refuses an email address written in the label or the note", async ({ page }) => {
  await login(page);
  await page.goto("/admin/sales/exclusions");
  const form = page.getByTestId("exclusion-form");
  await form.getByLabel("表示名（店名など・必須）").fill(`連絡先 ${email}`);
  await form.getByLabel("Instagram（URL か @ユーザー名）").fill(`@${handle}`);
  await form.getByRole("button", { name: "除外リストに追加" }).click();
  await expect(form.getByRole("alert")).toContainText("メールアドレスを書かないで");
  const { rows } = await db.query("select count(*)::int as n from public.sales_exclusions where instagram_handle = $1", [handle]);
  expect(rows[0].n).toBe(0);
});

test("refuses an input without any matching key", async ({ page }) => {
  await login(page);
  await page.goto("/admin/sales/exclusions");
  const form = page.getByTestId("exclusion-form");
  await form.getByLabel("表示名（店名など・必須）").fill("E2E 鍵なし");
  await form.getByRole("button", { name: "除外リストに追加" }).click();
  await expect(form.getByRole("alert")).toContainText("1つ以上");
});
