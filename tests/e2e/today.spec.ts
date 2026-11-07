import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { seedDraft } from "../support/seed-demo";
import { ensureUsers, removeUsers, usersFor } from "./support/admin-users";

// 今日やること: the admin sees today's drafts with one action and folded details.

test.describe.configure({ mode: "serial" });

let db: pg.Pool;
const seeded: string[] = [];
let ADMIN: ReturnType<typeof usersFor>["admin"];

test.beforeAll(async ({}, testInfo) => {
  db = new pg.Pool({ connectionString: process.env.SUPABASE_DB_URL, max: 2 });
  ADMIN = usersFor(`today-${testInfo.project.name}`).admin;
  await ensureUsers(`today-${testInfo.project.name}`);
});
test.afterAll(async ({}, testInfo) => {
  if (seeded.length > 0) await db.query("delete from public.sales_prospects where id = any($1::uuid[])", [seeded]);
  await db.end();
  await removeUsers(`today-${testInfo.project.name}`);
});

async function login(page: Page) {
  await page.goto("/admin/login");
  await page.getByLabel("メールアドレス").fill(ADMIN.email);
  await page.getByLabel("パスワード").fill(ADMIN.password);
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(page).toHaveURL(/\/admin\/sales$/);
}

test("shows an unsent draft with channel, state and folded details", async ({ page }) => {
  const draft = await seedDraft(db);
  seeded.push(draft.prospectId);
  await login(page);
  const card = page.getByTestId("today-item").filter({ hasText: draft.name });
  await expect(card).toBeVisible();
  // DEV-194: the folded evidence repeats words like "Instagram" and 未送信, so the badges are addressed directly.
  await expect(card.getByTestId("channel-badge")).toBeVisible();
  await expect(card.getByTestId("channel-badge")).toHaveText("Instagram");
  await expect(card.getByTestId("state-badge")).toBeVisible();
  await expect(card.getByTestId("state-badge")).toHaveText("未送信");
  // DEV-195: the text to be approved is shown with the send action; the stored draft stays folded in 詳細.
  await expect(card.getByTestId("send-preview")).toBeVisible();
  const folded = card.locator("details p", { hasText: "E2E テスト用の営業文です。" });
  await expect(folded).toBeHidden();
  await card.getByText("詳細").click();
  await expect(folded).toBeVisible();
  await expect(card.getByRole("link", { name: "デモを確認" })).toHaveAttribute("href", `/admin/preview/${draft.prospectId}`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("does not show a DNC shop", async ({ page }) => {
  const draft = await seedDraft(db);
  seeded.push(draft.prospectId);
  await db.query("update public.sales_prospects set do_not_contact = true, dnc_reason = 'explicit_refusal', dnc_set_at = now() where id = $1", [draft.prospectId]);
  await login(page);
  await expect(page.getByRole("heading", { level: 1, name: "今日やること" })).toBeVisible();
  await expect(page.locator("main").getByRole("alert")).toHaveCount(0);
  await expect(page.getByTestId("today-item").filter({ hasText: draft.name })).toHaveCount(0);
});

test("DEV-048: skips an unsent draft from today's list (drafted → lost, shown as 見送り)", async ({ page }) => {
  const draft = await seedDraft(db);
  seeded.push(draft.prospectId);
  await login(page);
  const card = page.getByTestId("today-item").filter({ hasText: draft.name });
  await card.getByText("詳細").click();
  await card.getByTestId("skip-draft").click();
  await card.getByLabel("見送る理由（任意）").fill("E2E: 写真が少ない");
  await card.getByRole("button", { name: "はい、見送る" }).click();
  await expect(page.getByTestId("today-item").filter({ hasText: draft.name })).toHaveCount(0);
  const { rows } = await db.query(
    "select status, sent_at, lost_reason from public.sales_outreaches where prospect_id = $1 and kind = 'initial'",
    [draft.prospectId],
  );
  expect(rows).toEqual([{ status: "lost", sent_at: null, lost_reason: "E2E: 写真が少ない" }]);
  await page.goto("/admin/sales/history");
  await expect(page.getByTestId("history-item").filter({ hasText: draft.name }).getByText("見送り")).toBeVisible();
});

test("DEV-048: marks a shop DNC from today's list", async ({ page }) => {
  const draft = await seedDraft(db);
  seeded.push(draft.prospectId);
  await login(page);
  const card = page.getByTestId("today-item").filter({ hasText: draft.name });
  await card.getByText("詳細").click();
  await card.getByRole("button", { name: "営業不要（DNC）にする" }).click();
  await card.getByRole("button", { name: "はい、営業不要（DNC）にする" }).click();
  await expect(page.getByTestId("today-item").filter({ hasText: draft.name })).toHaveCount(0);
  const { rows } = await db.query("select do_not_contact, dnc_reason from public.sales_prospects where id = $1", [draft.prospectId]);
  expect(rows).toEqual([{ do_not_contact: true, dnc_reason: "admin_manual" }]);
});

test("DEV-048: refuses to skip a draft that was sent in the meantime (stale page)", async ({ page }) => {
  const draft = await seedDraft(db);
  seeded.push(draft.prospectId);
  await login(page);
  const card = page.getByTestId("today-item").filter({ hasText: draft.name });
  await card.getByText("詳細").click();
  await card.getByTestId("skip-draft").click();
  // Sent from another tab after this page was rendered.
  await db.query(
    "update public.sales_outreaches set status = 'sent', sent_at = now() where prospect_id = $1 and kind = 'initial'",
    [draft.prospectId],
  );
  await card.getByRole("button", { name: "はい、見送る" }).click();
  await expect(card.getByRole("alert")).toContainText("すでに送信済みか見送り済み");
  const { rows } = await db.query("select status from public.sales_outreaches where prospect_id = $1 and kind = 'initial'", [draft.prospectId]);
  expect(rows).toEqual([{ status: "sent" }]);
});

test("DEV-195: edits the draft before approving; the edit is kept with its history and the text to approve follows it", async ({ page }) => {
  const draft = await seedDraft(db);
  seeded.push(draft.prospectId);
  await login(page);
  const card = page.getByTestId("today-item").filter({ hasText: draft.name });
  await card.getByText("詳細", { exact: true }).click();
  await card.getByTestId("edit-draft").click();
  await card.getByLabel(/^本文/).fill("オーナーが書き直した E2E の本文です。");
  await card.getByTestId("save-draft").click();
  await expect(card.getByTestId("draft-edited")).toBeVisible();
  await expect(card.getByLabel("送る文面")).toHaveValue(/オーナーが書き直した E2E の本文です。/);
  const { rows } = await db.query(
    "select o.draft_version, o.body, e.previous_body from public.sales_outreaches o join public.sales_outreach_draft_edits e on e.outreach_id = o.id where o.id = $1",
    [draft.outreachId],
  );
  expect(rows).toEqual([{ draft_version: 2, body: "オーナーが書き直した E2E の本文です。", previous_body: "はじめまして。E2E テスト用の営業文です。" }]);
  // A link is refused (the demo URL is added automatically).
  await card.getByTestId("edit-draft").click();
  await card.getByLabel(/^本文/).fill("詳しくは https://example.com を見てください。");
  await card.getByTestId("save-draft").click();
  await expect(card.getByTestId("draft-editor").getByRole("alert")).toContainText("URL");
});

test("DEV-195: the owner records an improvement hypothesis; it shows who wrote it, and nothing stored reads 未確認", async ({ page }) => {
  const draft = await seedDraft(db);
  seeded.push(draft.prospectId);
  await login(page);
  const card = page.getByTestId("today-item").filter({ hasText: draft.name });
  await card.getByText("選んだ理由・出典・連絡の可否").click();
  await expect(card.getByTestId("evidence-hypothesis")).toContainText("未確認");
  await card.getByTestId("edit-insight-improvement_hypothesis").click();
  await card.getByLabel(/^改善の仮説/).fill("メニューと地図を1ページにまとめる");
  await card.getByTestId("save-insight-improvement_hypothesis").click();
  await expect(card.getByTestId("evidence-hypothesis")).toContainText("メニューと地図を1ページにまとめる");
  await expect(card.getByTestId("evidence-hypothesis")).toContainText("記入: オーナー");
  await expect(card.getByTestId("evidence-rationale")).toContainText("未確認");
  const { rows } = await db.query("select kind, body, source from public.sales_prospect_insights where prospect_id = $1", [draft.prospectId]);
  expect(rows).toEqual([{ kind: "improvement_hypothesis", body: "メニューと地図を1ページにまとめる", source: "owner" }]);
});
