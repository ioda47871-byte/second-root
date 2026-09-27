import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { seedDraft } from "../support/seed-demo";
import { ensureUsers, removeUsers, usersFor } from "./support/admin-users";

// 返信あり → 分類 → 商談 → 成約（金額必須）, and 断り with / without DNC.

test.describe.configure({ mode: "serial" });

let db: pg.Pool;
const seeded: string[] = [];
let ADMIN: ReturnType<typeof usersFor>["admin"];

test.beforeAll(async ({}, testInfo) => {
  db = new pg.Pool({ connectionString: process.env.SUPABASE_DB_URL, max: 2 });
  ADMIN = usersFor(`outcome-${testInfo.project.name}`).admin;
  await ensureUsers(`outcome-${testInfo.project.name}`);
});
test.afterAll(async ({}, testInfo) => {
  if (seeded.length > 0) await db.query("delete from public.sales_prospects where id = any($1::uuid[])", [seeded]);
  await db.end();
  await removeUsers(`outcome-${testInfo.project.name}`);
});

async function login(page: Page) {
  await page.goto("/admin/login");
  await page.getByLabel("メールアドレス").fill(ADMIN.email);
  await page.getByLabel("パスワード").fill(ADMIN.password);
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(page).toHaveURL(/\/admin\/sales$/);
}

async function sentShop() {
  const draft = await seedDraft(db);
  seeded.push(draft.prospectId);
  await db.query("update public.sales_outreaches set status = 'sent', sent_at = now() where id = $1", [draft.outreachId]);
  await db.query("update public.sales_demos set expires_at = now() + interval '30 days' where prospect_id = $1", [draft.prospectId]);
  return draft;
}

const statusOf = async (id: string) => (await db.query("select status, won_amount_jpy from public.sales_outreaches where id = $1", [id])).rows[0];

test("reply → meeting → won with a required amount", async ({ page }) => {
  const shop = await sentShop();
  await login(page);
  await page.getByRole("navigation", { name: "営業管理" }).getByRole("link", { name: "返信" }).click();
  const card = page.getByTestId("reply-item").filter({ hasText: shop.name });
  await card.getByRole("button", { name: "返信あり" }).click();
  await card.getByLabel("興味あり").check();
  await expect(card.getByLabel(/今後の連絡を拒否/)).toHaveCount(0);
  await card.getByRole("button", { name: "記録する" }).click();
  await expect(page.getByTestId("reply-item").filter({ hasText: shop.name })).toHaveCount(0);

  await page.getByRole("navigation", { name: "営業管理" }).getByRole("link", { name: "商談" }).click();
  let meeting = page.getByTestId("meeting-item").filter({ hasText: shop.name });
  await expect(meeting).toContainText("興味あり");
  await meeting.getByRole("button", { name: "商談へ" }).click();
  meeting = page.getByTestId("meeting-item").filter({ hasText: shop.name });
  await expect(meeting).toContainText("商談中");
  await expect(meeting.getByRole("button", { name: "成約" })).toBeDisabled();
  await meeting.getByLabel("成約金額（円・税込）").fill("198000");
  await meeting.getByRole("button", { name: "成約" }).click();
  await expect(page.getByTestId("meeting-item").filter({ hasText: shop.name })).toHaveCount(0);
  expect(await statusOf(shop.outreachId)).toEqual({ status: "won", won_amount_jpy: 198000 });
});

test("a plain decline is not DNC; an explicit refusal is DNC and hides the demo", async ({ page }) => {
  const plain = await sentShop();
  const refused = await sentShop();
  await login(page);
  await page.goto("/admin/sales/replies");

  let card = page.getByTestId("reply-item").filter({ hasText: plain.name });
  await card.getByRole("button", { name: "返信あり" }).click();
  await card.getByLabel("断り").check();
  await card.getByRole("button", { name: "記録する" }).click();
  await expect(page.getByTestId("reply-item").filter({ hasText: plain.name })).toHaveCount(0);

  card = page.getByTestId("reply-item").filter({ hasText: refused.name });
  await card.getByRole("button", { name: "返信あり" }).click();
  await card.getByLabel("断り").check();
  await card.getByLabel(/今後の連絡を拒否された/).check();
  await card.getByRole("button", { name: "記録する" }).click();
  await expect(page.getByTestId("reply-item").filter({ hasText: refused.name })).toHaveCount(0);

  const dnc = async (id: string) => (await db.query("select do_not_contact from public.sales_prospects where id = $1", [id])).rows[0].do_not_contact;
  expect(await dnc(plain.prospectId)).toBe(false);
  expect(await dnc(refused.prospectId)).toBe(true);
  expect((await page.request.get(`/demo/${plain.token}`)).status()).toBe(200);
  expect((await page.request.get(`/demo/${refused.token}`)).status()).toBe(404);
});
