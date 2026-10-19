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
  // Clearing DNC never brings the demo back.
  const demo = await db.query("select disabled_at from public.sales_demos where prospect_id = $1", [shop.prospectId]);
  expect(demo.rows[0].disabled_at).not.toBeNull();
  expect((await page.request.get(`/demo/${shop.token}`)).status()).toBe(404);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

// DEV-057: the funnel, its period switch (直近 30 日 / 全期間) and the reply types.
test("shows the sales funnel and switches between 直近 30 日 and 全期間", async ({ page }) => {
  const recent = await seedDraft(db);
  const old = await seedDraft(db);
  seeded.push(recent.prospectId, old.prospectId);
  await db.query("update public.sales_outreaches set status = 'sent', sent_at = now() where id = $1", [recent.outreachId]);
  // Prepared 40 days ago: only in 全期間 (created_at is immutable for the API roles).
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    await client.query("update public.sales_outreaches set created_at = now() - interval '40 days' where id = $1", [old.outreachId]);
    await client.query("commit");
  } finally {
    client.release();
  }

  await login(page);
  await page.getByRole("navigation", { name: "営業管理" }).getByRole("link", { name: "履歴" }).click();
  const funnel = page.getByTestId("funnel");
  await expect(funnel).toHaveAttribute("data-period", "30d");
  const periods = page.getByRole("navigation", { name: "集計期間" });
  await expect(periods.getByRole("link", { name: "直近 30 日" })).toHaveAttribute("aria-current", "page");
  const table = page.getByRole("region", { name: "ファネル: 直近 30 日" });
  for (const stage of ["準備", "見送り", "送信", "返信", "商談", "成約", "成約金額"]) {
    await expect(table.getByRole("rowheader", { name: stage, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("region", { name: "返信の種類: 直近 30 日" })).toContainText("商談希望");
  const prepared = async (period: string) =>
    Number(await page.getByRole("region", { name: `ファネル: ${period}` }).locator('tr[data-stage="prepared"] td').first().textContent());
  const recentPrepared = await prepared("直近 30 日");
  expect(recentPrepared).toBeGreaterThanOrEqual(1);
  await expect(table.locator('tr[data-stage="sent"] td').first()).not.toHaveText("0");

  await periods.getByRole("link", { name: "全期間" }).click();
  await expect(page).toHaveURL(/\/admin\/sales\/history\?period=all$/);
  await expect(funnel).toHaveAttribute("data-period", "all");
  await expect(periods.getByRole("link", { name: "全期間" })).toHaveAttribute("aria-current", "page");
  expect(await prepared("全期間")).toBeGreaterThanOrEqual(recentPrepared + 1);
  // The per-condition table is still there.
  await expect(page.getByRole("table").filter({ hasText: "全体" })).toContainText("合計");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  // An unknown period falls back to 直近 30 日.
  await page.goto("/admin/sales/history?period=bogus");
  await expect(page.getByTestId("funnel")).toHaveAttribute("data-period", "30d");
});
