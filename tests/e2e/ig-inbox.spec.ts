import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { seedDraft } from "../support/seed-demo";
import { ensureUsers, removeUsers, usersFor } from "./support/admin-users";

// 返信 → Instagram の返信 (DEV-022 / DEV-023): the message, AI classification
// and draft; edit, 後で対応, matching an unmatched conversation. The e2e
// server has no Meta credentials, so 「この内容で返信」 must say so and
// never record anything as sent.

test.describe.configure({ mode: "serial" });

let db: pg.Pool;
const seededProspects: string[] = [];
const seededThreads: string[] = [];
let ADMIN: ReturnType<typeof usersFor>["admin"];

test.beforeAll(async ({}, testInfo) => {
  db = new pg.Pool({ connectionString: process.env.SUPABASE_DB_URL, max: 2 });
  ADMIN = usersFor(`iginbox-${testInfo.project.name}`).admin;
  await ensureUsers(`iginbox-${testInfo.project.name}`);
});
test.afterAll(async ({}, testInfo) => {
  if (seededThreads.length > 0) await db.query("delete from public.sales_ig_threads where id = any($1::uuid[])", [seededThreads]);
  if (seededProspects.length > 0) await db.query("delete from public.sales_prospects where id = any($1::uuid[])", [seededProspects]);
  await db.end();
  await removeUsers(`iginbox-${testInfo.project.name}`);
});

async function login(page: Page) {
  await page.goto("/admin/login");
  await page.getByLabel("メールアドレス").fill(ADMIN.email);
  await page.getByLabel("パスワード").fill(ADMIN.password);
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(page).toHaveURL(/\/admin\/sales$/);
}

async function contactedShop() {
  const shop = await seedDraft(db);
  seededProspects.push(shop.prospectId);
  await db.query("update public.sales_outreaches set status = 'sent', sent_at = now() where id = $1", [shop.outreachId]);
  return shop;
}

/** A conversation with one inbound message and an AI draft. */
async function conversation(text: string, draft: string, prospectId: string | null, reviewReasons: string[] = []) {
  const igsid = `9${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 17);
  const { rows: [t] } = await db.query(
    "insert into public.sales_ig_threads (ig_account_id, igsid, username, prospect_id, match_status, last_inbound_at) values ('17841400000000001', $1, $2, $3, $4, now()) returning id",
    [igsid, `user_${igsid.slice(-6)}`, prospectId, prospectId ? "matched" : "unmatched"],
  );
  seededThreads.push(t.id);
  const { rows: [m] } = await db.query(
    "insert into public.sales_ig_messages (thread_id, mid, direction, text, sent_at) values ($1, $2, 'inbound', $3, now()) returning id",
    [t.id, `mid-${randomUUID()}`, text],
  );
  const { rows: [d] } = await db.query(
    "insert into public.sales_ig_drafts (thread_id, message_id, reply_type, body, needs_human_review, review_reasons) values ($1, $2, 'question', $3, $4, $5) returning id",
    [t.id, m.id, draft, reviewReasons.length > 0, reviewReasons],
  );
  return { threadId: t.id as string, draftId: d.id as string };
}

test("shows the message, AI classification and draft as plain text, and never fakes a send", async ({ page }) => {
  const shop = await contactedShop();
  const c = await conversation("<b>料金</b>を教えてください <script>alert(1)</script>", "お問い合わせありがとうございます。", shop.prospectId, ["price"]);
  await login(page);
  await page.getByRole("navigation", { name: "営業管理" }).getByRole("link", { name: "返信" }).click();
  const card = page.getByTestId("ig-reply-item").filter({ hasText: shop.name });
  await expect(card).toContainText("<b>料金</b>を教えてください <script>alert(1)</script>");
  await expect(card).toContainText("AI 分類: 質問");
  await expect(card).toContainText("送る前に確認: 金額の表現");
  await expect(card.getByTestId("ig-draft")).toHaveText("お問い合わせありがとうございます。");

  await card.getByRole("button", { name: "この内容で返信" }).click();
  await expect(card.getByRole("status")).toContainText("Instagram との連携がまだ設定されていません（送信していません）");
  const { rows } = await db.query("select status from public.sales_ig_sends where draft_id = $1", [c.draftId]);
  expect(rows.every((r) => r.status !== "sent")).toBe(true);
  const { rows: [d] } = await db.query("select status from public.sales_ig_drafts where id = $1", [c.draftId]);
  expect(d.status).not.toBe("sent");
});

test("edits the draft (checked again on the server) and snoozes it", async ({ page }) => {
  const shop = await contactedShop();
  const c = await conversation("営業時間を知りたいです", "10時から営業しています。", shop.prospectId);
  await login(page);
  await page.goto("/admin/sales/replies");
  let card = page.getByTestId("ig-reply-item").filter({ hasText: shop.name });

  await card.getByRole("button", { name: "返信文を編集" }).click();
  await card.getByLabel("返信文").fill("詳しくは evil.com へ");
  await card.getByRole("button", { name: "保存する" }).click();
  await expect(card.getByRole("status")).toContainText("デモ以外の URL は入れられません");

  await card.getByLabel("返信文").fill("ご質問ありがとうございます。確認してご連絡します。");
  await card.getByRole("button", { name: "保存する" }).click();
  await expect(card.getByTestId("ig-draft")).toHaveText("ご質問ありがとうございます。確認してご連絡します。");
  const { rows: [d] } = await db.query("select body from public.sales_ig_drafts where id = $1", [c.draftId]);
  expect(d.body).toBe("ご質問ありがとうございます。確認してご連絡します。");

  await card.getByRole("button", { name: "後で対応" }).click();
  await page.getByText(/後で対応（\d+件）/).click();
  card = page.getByTestId("ig-reply-item").filter({ hasText: shop.name });
  await expect(card).toContainText("後で対応");
  await card.getByRole("button", { name: "今すぐ対応に戻す" }).click();
  await expect(card.getByRole("button", { name: "後で対応" })).toBeVisible();
});

test("an unmatched conversation is linked only by the human", async ({ page }) => {
  const shop = await contactedShop();
  const c = await conversation("はじめまして", "ご連絡ありがとうございます。", null);
  await login(page);
  await page.goto("/admin/sales/replies");
  const username = (await db.query("select username from public.sales_ig_threads where id = $1", [c.threadId])).rows[0].username;
  let card = page.getByTestId("ig-reply-item").filter({ hasText: `未照合: @${username}` });
  await expect(card.getByRole("button", { name: "この内容で返信" })).toBeDisabled();
  await card.getByLabel("店舗").selectOption(shop.prospectId);
  await card.getByRole("button", { name: "この店舗の返信にする" }).click();
  card = page.getByTestId("ig-reply-item").filter({ hasText: shop.name });
  await expect(card.getByRole("button", { name: "この内容で返信" })).toBeEnabled();
  const { rows: [t] } = await db.query("select prospect_id, match_status from public.sales_ig_threads where id = $1", [c.threadId]);
  expect(t).toEqual({ prospect_id: shop.prospectId, match_status: "matched" });
});

test("fits a phone screen", async ({ page }) => {
  const shop = await contactedShop();
  await conversation("とても長いメッセージ".repeat(20), "ありがとうございます。".repeat(10), shop.prospectId);
  for (const width of [320, 375]) {
    await page.setViewportSize({ width, height: 740 });
    await login(page);
    await page.goto("/admin/sales/replies");
    const card = page.getByTestId("ig-reply-item").filter({ hasText: shop.name });
    await expect(card.getByRole("button", { name: "この内容で返信" })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.context().clearCookies();
  }
});
