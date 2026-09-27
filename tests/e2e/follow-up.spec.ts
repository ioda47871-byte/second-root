import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { seedEmailDraft } from "../support/seed-demo";
import { ensureUsers, removeUsers, usersFor } from "./support/admin-users";

// 5-day email follow-up: shown first in 今日やること, mailto pre-filled
// (nothing is sent by the system), 送信済み records it once.

test.describe.configure({ mode: "serial" });

let db: pg.Pool;
const seeded: string[] = [];
let ADMIN: ReturnType<typeof usersFor>["admin"];

test.beforeAll(async ({}, testInfo) => {
  db = new pg.Pool({ connectionString: process.env.SUPABASE_DB_URL, max: 2 });
  ADMIN = usersFor(`follow-${testInfo.project.name}`).admin;
  await ensureUsers(`follow-${testInfo.project.name}`);
});
test.afterAll(async ({}, testInfo) => {
  if (seeded.length > 0) await db.query("delete from public.sales_prospects where id = any($1::uuid[])", [seeded]);
  await db.end();
  await removeUsers(`follow-${testInfo.project.name}`);
});

async function login(page: Page) {
  await page.goto("/admin/login");
  await page.getByLabel("メールアドレス").fill(ADMIN.email);
  await page.getByLabel("パスワード").fill(ADMIN.password);
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(page).toHaveURL(/\/admin\/sales$/);
}

test("offers one follow-up mailto 5 days after the email and records it on 送信済み", async ({ page }) => {
  const draft = await seedEmailDraft(db);
  seeded.push(draft.prospectId);
  await db.query("update public.sales_outreaches set status = 'sent', sent_at = now() - interval '6 days' where id = $1", [draft.outreachId]);
  await db.query("update public.sales_demos set expires_at = now() + interval '24 days' where prospect_id = $1", [draft.prospectId]);

  await login(page);
  const card = page.getByTestId("today-item").filter({ hasText: draft.name });
  await expect(card).toContainText("フォロー（初回から6日）");
  const link = card.getByRole("link", { name: "フォローメールを作成" });
  const href = (await link.getAttribute("href"))!;
  expect(href.startsWith(`mailto:${draft.email}?`)).toBe(true);
  const params = new URLSearchParams(href.slice(href.indexOf("?") + 1));
  expect(params.get("subject")).toBe("Re: ホームページのご提案");
  const body = params.get("body")!;
  expect(body).toContain(`${draft.name} ご担当者様`);
  expect(body).toContain(`/demo/${draft.token}`);
  expect(body).toContain("この1回限り");
  expect(body).toContain("以後ご連絡いたしません");

  // Opening the mail app records nothing.
  await link.evaluate((a) => {
    a.addEventListener("click", (e) => e.preventDefault(), { once: true });
    a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  const followUps = async () =>
    (await db.query("select status from public.sales_outreaches where prospect_id = $1 and kind = 'follow_up'", [draft.prospectId])).rows;
  expect(await followUps()).toEqual([]);

  await card.getByRole("button", { name: "送信済み" }).click();
  await expect(page.getByTestId("today-item").filter({ hasText: draft.name })).toHaveCount(0);
  expect(await followUps()).toEqual([{ status: "sent" }]);

  // Only once: it does not come back.
  await page.reload();
  await expect(page.getByTestId("today-item").filter({ hasText: draft.name })).toHaveCount(0);
});
