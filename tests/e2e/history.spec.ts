import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { seedDraft } from "../support/seed-demo";
import { ensureUsers, removeUsers, usersFor } from "./support/admin-users";

// 履歴 + metrics, and manual DNC on / off by the human admin.

test.describe.configure({ mode: "serial" });

let db: pg.Pool;
const seeded: string[] = [];
let ADMIN: ReturnType<typeof usersFor>["admin"];

test.beforeAll(async ({}, testInfo) => {
  db = new pg.Pool({ connectionString: process.env.SUPABASE_DB_URL, max: 2 });
  ADMIN = usersFor(`history-${testInfo.project.name}`).admin;
  await ensureUsers(`history-${testInfo.project.name}`);
});
test.afterAll(async ({}, testInfo) => {
  if (seeded.length > 0) await db.query("delete from public.sales_prospects where id = any($1::uuid[])", [seeded]);
  await db.end();
  await removeUsers(`history-${testInfo.project.name}`);
});

async function login(page: Page) {
  await page.goto("/admin/login");
  await page.getByLabel("メールアドレス").fill(ADMIN.email);
  await page.getByLabel("パスワード").fill(ADMIN.password);
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(page).toHaveURL(/\/admin\/sales$/);
}

test("shows outcomes, metrics, and lets the admin set and clear DNC", async ({ page }) => {
  const shop = await seedDraft(db);
  seeded.push(shop.prospectId);
  await db.query(
    `update public.sales_outreaches set status = 'sent', sent_at = now() where id = $1;`,
    [shop.outreachId],
  );
  await login(page);
  await page.getByRole("navigation", { name: "営業管理" }).getByRole("link", { name: "履歴" }).click();
  await expect(page.getByRole("table").first()).toBeVisible();
  await expect(page.getByRole("table").filter({ hasText: "全体" })).toContainText("合計");

  const item = page.getByTestId("history-item").filter({ hasText: shop.name });
  await expect(item).toContainText("返信待ち");
  await item.getByText("詳細").click();
  await item.getByRole("button", { name: "営業不要（DNC）にする" }).click();
  await item.getByRole("button", { name: "はい、営業不要（DNC）にする" }).click();
  await expect(page.getByTestId("history-item").filter({ hasText: shop.name })).toContainText("DNC");
  const dnc = async () => (await db.query("select do_not_contact from public.sales_prospects where id = $1", [shop.prospectId])).rows[0].do_not_contact;
  expect(await dnc()).toBe(true);

  // The <details> stays open across the server re-render.
  const again = page.getByTestId("history-item").filter({ hasText: shop.name });
  await again.getByRole("button", { name: "DNC を解除" }).click();
  await again.getByRole("button", { name: "はい、DNC を解除" }).click();
  await expect.poll(dnc).toBe(false);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
