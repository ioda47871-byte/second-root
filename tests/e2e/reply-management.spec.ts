import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { seedDraft, seedEmailDraft } from "../support/seed-demo";
import { ensureUsers, removeUsers, usersFor } from "./support/admin-users";

// DEV-056: 返信待ち oldest sent first with the days since sending and the
// follow-up state; 商談 with the days since the reply / meeting start.
// Display only: nothing is sent and no state changes here.

test.describe.configure({ mode: "serial" });

let db: pg.Pool;
const seeded: string[] = [];
let ADMIN: ReturnType<typeof usersFor>["admin"];

test.beforeAll(async ({}, testInfo) => {
  db = new pg.Pool({ connectionString: process.env.SUPABASE_DB_URL, max: 2 });
  ADMIN = usersFor(`replymgmt-${testInfo.project.name}`).admin;
  await ensureUsers(`replymgmt-${testInfo.project.name}`);
});
test.afterAll(async ({}, testInfo) => {
  if (seeded.length > 0) await db.query("delete from public.sales_prospects where id = any($1::uuid[])", [seeded]);
  await db.end();
  await removeUsers(`replymgmt-${testInfo.project.name}`);
});

async function login(page: Page) {
  await page.goto("/admin/login");
  await page.getByLabel("メールアドレス").fill(ADMIN.email);
  await page.getByLabel("パスワード").fill(ADMIN.password);
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(page).toHaveURL(/\/admin\/sales$/);
}

/** Marks the initial as sent `days` ago with its demo public for 30 days from then. */
async function sentDaysAgo(shop: { outreachId: string; prospectId: string }, days: number) {
  await db.query("update public.sales_outreaches set status = 'sent', sent_at = now() - make_interval(days => $2) where id = $1", [shop.outreachId, days]);
  await db.query("update public.sales_demos set expires_at = now() - make_interval(days => $2) + interval '30 days' where prospect_id = $1", [shop.prospectId, days]);
}

/** Moves the reply / meeting timestamps back (test-only: the identity trigger normally forbids this). */
async function backdate(outreachId: string, column: "replied_at" | "meeting_at", days: number) {
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    await client.query(`update public.sales_outreaches set ${column} = now() - make_interval(days => $2) where id = $1`, [outreachId, days]);
    await client.query("commit");
  } finally {
    client.release();
  }
}

test("返信待ち shows days since sending and the follow-up state, oldest first", async ({ page }) => {
  const instagram = await seedDraft(db);
  const due = await seedEmailDraft(db);
  const waiting = await seedEmailDraft(db);
  const today = await seedEmailDraft(db);
  seeded.push(instagram.prospectId, due.prospectId, waiting.prospectId, today.prospectId);
  await sentDaysAgo(instagram, 9);
  await sentDaysAgo(due, 6);
  await sentDaysAgo(waiting, 2);
  await sentDaysAgo(today, 0);

  await login(page);
  await page.getByRole("navigation", { name: "営業管理" }).getByRole("link", { name: "返信" }).click();
  await expect(page.getByTestId("reply-summary")).toContainText(/返信待ち \d+ 件・うちフォロー可能 \d+ 件/);

  const card = (name: string) => page.getByTestId("reply-item").filter({ hasText: name });
  await expect(card(instagram.name).getByTestId("reply-elapsed")).toHaveText("送信から 9 日");
  await expect(card(instagram.name).getByTestId("reply-followup")).toHaveText("Instagram はフォローなし");
  await expect(card(due.name).getByTestId("reply-elapsed")).toHaveText("送信から 6 日");
  await expect(card(due.name).getByTestId("reply-followup")).toHaveAttribute("data-follow-up", "due");
  await expect(card(due.name).getByTestId("reply-followup")).toContainText("フォロー可能");
  await expect(card(waiting.name).getByTestId("reply-followup")).toHaveText("フォロー期限まで 3 日");
  await expect(card(today.name).getByTestId("reply-elapsed")).toHaveText("本日送信");
  await expect(card(today.name).getByTestId("reply-followup")).toHaveText("フォロー期限まで 5 日");

  // Oldest sent first.
  const titles = await page.getByTestId("reply-item").locator("h2").allTextContents();
  const order = [instagram, due, waiting, today].map((s) => titles.indexOf(s.name));
  expect(order.every((i) => i >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);

  // Viewing records nothing: no follow-up row, states unchanged.
  const { rows } = await db.query("select count(*)::int as n from public.sales_outreaches where prospect_id = any($1::uuid[]) and (kind = 'follow_up' or status <> 'sent')", [seeded]);
  expect(rows[0].n).toBe(0);

  // The follow-up itself is still offered only on 今日 (§4.3).
  await page.getByRole("navigation", { name: "営業管理" }).getByRole("link", { name: "今日" }).click();
  await expect(page.getByTestId("today-item").filter({ hasText: due.name })).toContainText("フォロー（初回から6日）");
});

test("商談 shows days since the reply and since the meeting started", async ({ page }) => {
  const replied = await seedDraft(db);
  const meeting = await seedDraft(db);
  seeded.push(replied.prospectId, meeting.prospectId);
  await sentDaysAgo(replied, 5);
  await sentDaysAgo(meeting, 5);
  await db.query("update public.sales_outreaches set status = 'replied', reply_type = 'question', replied_at = now() where id = any($1::uuid[])", [
    [replied.outreachId, meeting.outreachId],
  ]);
  await backdate(replied.outreachId, "replied_at", 3);
  await db.query("update public.sales_outreaches set status = 'meeting', meeting_at = now() where id = $1", [meeting.outreachId]);

  await login(page);
  await page.getByRole("navigation", { name: "営業管理" }).getByRole("link", { name: "商談" }).click();
  const card = (name: string) => page.getByTestId("meeting-item").filter({ hasText: name });
  await expect(card(replied.name)).toContainText("質問");
  await expect(card(replied.name).getByTestId("meeting-elapsed")).toHaveText("返信から 3 日");
  await expect(card(meeting.name).getByTestId("meeting-elapsed")).toHaveText("本日商談開始");
});
