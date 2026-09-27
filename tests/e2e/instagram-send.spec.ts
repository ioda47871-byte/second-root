import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { seedDraft } from "../support/seed-demo";
import { ensureUsers, removeUsers, usersFor } from "./support/admin-users";

// DMを送る → copy + open Instagram (stubbed, never the real site) → back →
// 送信済み. Opening Instagram alone must not mark anything sent.

test.describe.configure({ mode: "serial" });

let db: pg.Pool;
const seeded: string[] = [];
let ADMIN: ReturnType<typeof usersFor>["admin"];

test.beforeAll(async ({}, testInfo) => {
  db = new pg.Pool({ connectionString: process.env.SUPABASE_DB_URL, max: 2 });
  ADMIN = usersFor(`dm-${testInfo.project.name}`).admin;
  await ensureUsers(`dm-${testInfo.project.name}`);
});
test.afterAll(async ({}, testInfo) => {
  if (seeded.length > 0) await db.query("delete from public.sales_prospects where id = any($1::uuid[])", [seeded]);
  await db.end();
  await removeUsers(`dm-${testInfo.project.name}`);
});

async function login(page: Page) {
  await page.goto("/admin/login");
  await page.getByLabel("メールアドレス").fill(ADMIN.email);
  await page.getByLabel("パスワード").fill(ADMIN.password);
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(page).toHaveURL(/\/admin\/sales$/);
}

test("copies the DM, opens Instagram, and only 送信済み records the send", async ({ page, context, baseURL }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseURL });
  // Never contact the real Instagram from tests.
  await context.route(/instagram\.com/, (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<p>stub</p>" }));
  const draft = await seedDraft(db);
  seeded.push(draft.prospectId);
  await login(page);

  const card = page.getByTestId("today-item").filter({ hasText: draft.name });
  const [popup] = await Promise.all([context.waitForEvent("page"), card.getByRole("button", { name: "DMを送る" }).click()]);
  expect(popup.url()).toMatch(/^https:\/\/www\.instagram\.com\/e2e_[a-z0-9]+\/$/);
  await popup.close();

  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain("E2E テスト用の営業文です。");
  expect(clip).toContain(`/demo/${draft.token}`);
  expect(clip).toContain("公式サイトではありません");

  // Opened but not confirmed: still unsent, demo still private.
  let { rows } = await db.query("select status from public.sales_outreaches where id = $1", [draft.outreachId]);
  expect(rows[0].status).toBe("drafted");
  expect((await page.request.get(`/demo/${draft.token}`)).status()).toBe(404);

  await card.getByRole("button", { name: "送信済み" }).click();
  await expect(page.getByTestId("today-item").filter({ hasText: draft.name })).toHaveCount(0);
  ({ rows } = await db.query("select status from public.sales_outreaches where id = $1", [draft.outreachId]));
  expect(rows[0].status).toBe("sent");
  expect((await page.request.get(`/demo/${draft.token}`)).status()).toBe(200);
});
