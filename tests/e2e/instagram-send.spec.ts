import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { seedDraft } from "../support/seed-demo";
import { ensureUsers, removeUsers, usersFor } from "./support/admin-users";

// この内容で送信を承認 → DMを送る (copy + open Instagram, stubbed, never the
// real site) → back → 手動で送信済みにする (DEV-195). Opening Instagram is
// recorded as 「送信画面を開いた」 and never marks anything sent.

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

test("approves the DM, copies it and opens Instagram, and only 手動で送信済み records the send", async ({ page, context, baseURL }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseURL });
  // Never contact the real Instagram from tests.
  await context.route(/instagram\.com/, (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<p>stub</p>" }));
  const draft = await seedDraft(db);
  seeded.push(draft.prospectId);
  await login(page);

  const card = page.getByTestId("today-item").filter({ hasText: draft.name });
  await expect(card.getByRole("button", { name: "DMを送る" })).toHaveCount(0);
  await card.getByTestId("approve-send").click();
  const [popup] = await Promise.all([context.waitForEvent("page"), card.getByRole("button", { name: "DMを送る" }).click()]);
  expect(popup.url()).toMatch(/^https:\/\/www\.instagram\.com\/e2e_[a-z0-9]+\/$/);
  await popup.close();

  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain("E2E テスト用の営業文です。");
  expect(clip).toContain(`/demo/${draft.token}`);
  expect(clip).toContain("公式サイトではありません");

  // Opened but not confirmed: recorded as opened, still unsent, demo still private.
  await expect(card.getByRole("button", { name: "手動で送信済みにする" })).toBeVisible();
  let { rows } = await db.query(
    "select a.state, a.opened_via, a.body, o.status from public.sales_outreach_approvals a join public.sales_outreaches o on o.id = a.outreach_id where a.outreach_id = $1",
    [draft.outreachId],
  );
  expect(rows).toEqual([{ state: "send_opened", opened_via: "instagram_profile", body: clip, status: "drafted" }]);
  expect((await page.request.get(`/demo/${draft.token}`)).status()).toBe(404);

  await card.getByRole("button", { name: "手動で送信済みにする" }).click();
  await expect(page.getByTestId("today-item").filter({ hasText: draft.name })).toHaveCount(0);
  ({ rows } = await db.query("select status from public.sales_outreaches where id = $1", [draft.outreachId]));
  expect(rows[0].status).toBe("sent");
  expect((await page.request.get(`/demo/${draft.token}`)).status()).toBe(200);
});

test("送らなかった: a withdrawn approval records no send and the draft can be approved again", async ({ page, context, baseURL }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseURL });
  await context.route(/instagram\.com/, (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<p>stub</p>" }));
  const draft = await seedDraft(db);
  seeded.push(draft.prospectId);
  await login(page);
  const card = page.getByTestId("today-item").filter({ hasText: draft.name });
  await card.getByTestId("approve-send").click();
  const [popup] = await Promise.all([context.waitForEvent("page"), card.getByRole("button", { name: "DMを送る" }).click()]);
  await popup.close();
  await expect(card.getByRole("button", { name: "手動で送信済みにする" })).toBeVisible();
  await card.getByTestId("withdraw-approval").click();
  await expect(card.getByTestId("approve-send")).toBeVisible();
  const { rows } = await db.query(
    "select a.state, a.superseded_reason, o.status from public.sales_outreach_approvals a join public.sales_outreaches o on o.id = a.outreach_id where a.outreach_id = $1",
    [draft.outreachId],
  );
  expect(rows).toEqual([{ state: "superseded", superseded_reason: "withdrawn", status: "drafted" }]);
});
