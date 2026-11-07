import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { seedEmailDraft } from "../support/seed-demo";
import { ensureUsers, removeUsers, usersFor } from "./support/admin-users";
import { captureMailto, openedMailto } from "./support/mailto";

// この内容で送信を承認 → メールを作成 (mailto with everything pre-filled; the
// human presses Send in their mail app, nothing is sent by the system; the
// database records only 「送信画面を開いた」) → 手動で送信済みにする (DEV-195).

test.describe.configure({ mode: "serial" });

let db: pg.Pool;
const seeded: string[] = [];
let ADMIN: ReturnType<typeof usersFor>["admin"];

test.beforeAll(async ({}, testInfo) => {
  db = new pg.Pool({ connectionString: process.env.SUPABASE_DB_URL, max: 2 });
  ADMIN = usersFor(`mail-${testInfo.project.name}`).admin;
  await ensureUsers(`mail-${testInfo.project.name}`);
});
test.afterAll(async ({}, testInfo) => {
  if (seeded.length > 0) await db.query("delete from public.sales_prospects where id = any($1::uuid[])", [seeded]);
  await db.end();
  await removeUsers(`mail-${testInfo.project.name}`);
});

async function login(page: Page) {
  await page.goto("/admin/login");
  await page.getByLabel("メールアドレス").fill(ADMIN.email);
  await page.getByLabel("パスワード").fill(ADMIN.password);
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(page).toHaveURL(/\/admin\/sales$/);
}

test("approve the exact text, then the mailto pre-fills everything; opening is recorded apart from 手動で送信済み", async ({ page }) => {
  const draft = await seedEmailDraft(db);
  seeded.push(draft.prospectId);
  await captureMailto(page);
  await login(page);
  const card = page.getByTestId("today-item").filter({ hasText: draft.name });

  // Step 1: the exact recipient and text are shown before anything can be opened.
  await expect(card.getByTestId("send-recipient")).toHaveText(draft.email);
  await expect(card.getByLabel("送る文面")).toHaveValue(/E2E メール本文です。/);
  await expect(card.getByRole("link", { name: "メールを作成" })).toHaveCount(0);
  await card.getByTestId("approve-send").click();

  // Step 2: approved (recorded with the snapshot), still unsent.
  const link = card.getByRole("link", { name: "メールを作成" });
  await expect(link).toBeVisible();
  let { rows } = await db.query(
    "select a.state, a.recipient, a.subject, a.body, a.mode, o.status from public.sales_outreach_approvals a join public.sales_outreaches o on o.id = a.outreach_id where a.outreach_id = $1",
    [draft.outreachId],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ state: "approved", recipient: draft.email, subject: "ホームページのご提案", mode: "manual", status: "drafted" });
  const href = (await link.getAttribute("href"))!;
  expect(href.startsWith(`mailto:${draft.email}?`)).toBe(true);
  const params = new URLSearchParams(href.slice(href.indexOf("?") + 1));
  expect([...params.keys()]).toEqual(["subject", "body"]);
  expect(params.get("subject")).toBe("ホームページのご提案");
  const body = params.get("body")!;
  expect(body.replace(/\r\n/g, "\n")).toBe(rows[0].body);
  expect(body).toContain(`${draft.name} ご担当者様`);
  expect(body).toContain("E2E メール本文です。");
  expect(body).toContain(`/demo/${draft.token}`);
  expect(body).toContain("公式サイトではありません");
  expect(body).toContain("以後ご連絡いたしません");
  expect(body).toContain("Second Root");
  await expect(card.getByRole("button", { name: "手動で送信済みにする" })).toHaveCount(0);

  // Opening the mail app records 「送信画面を開いた」 first (never a send), and
  // only then hands the approved mailto to the device (captured here).
  await link.click();
  await expect(card.getByRole("button", { name: "手動で送信済みにする" })).toBeVisible();
  expect(await openedMailto(page)).toEqual([href]);
  ({ rows } = await db.query(
    "select a.state, a.opened_via, o.status from public.sales_outreach_approvals a join public.sales_outreaches o on o.id = a.outreach_id where a.outreach_id = $1",
    [draft.outreachId],
  ));
  expect(rows).toEqual([{ state: "send_opened", opened_via: "mailto", status: "drafted" }]);
  expect((await page.request.get(`/demo/${draft.token}`)).status()).toBe(404);

  // The confirm step is still offered after the tab reloads (the state is in the database).
  await page.reload();
  await expect(card.getByRole("button", { name: "手動で送信済みにする" })).toBeVisible();

  await card.getByRole("button", { name: "手動で送信済みにする" }).click();
  await expect(page.getByTestId("today-item").filter({ hasText: draft.name })).toHaveCount(0);
  ({ rows } = await db.query(
    "select a.state, o.status from public.sales_outreach_approvals a join public.sales_outreaches o on o.id = a.outreach_id where a.outreach_id = $1",
    [draft.outreachId],
  ));
  expect(rows).toEqual([{ state: "sent", status: "sent" }]);
  expect((await page.request.get(`/demo/${draft.token}`)).status()).toBe(200);
});

test("says why when the email cannot be composed, and offers nothing to send", async ({ page }) => {
  const draft = await seedEmailDraft(db);
  seeded.push(draft.prospectId);
  // Longer than a mailto: link can safely carry once encoded.
  await db.query("update public.sales_outreaches set body = $2 where id = $1", [draft.outreachId, "長".repeat(1500)]);
  await login(page);
  const card = page.getByTestId("today-item").filter({ hasText: draft.name });
  await expect(card.getByRole("alert")).toContainText("メールを作成できません");
  await expect(card.getByRole("link", { name: "メールを作成" })).toHaveCount(0);
  await expect(card.getByTestId("approve-send")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "送信済み" })).toHaveCount(0);
});

test("PR #239 M1: an exclusion added after approval stops the mail app from opening", async ({ page }) => {
  const draft = await seedEmailDraft(db);
  seeded.push(draft.prospectId);
  await captureMailto(page);
  await login(page);
  const card = page.getByTestId("today-item").filter({ hasText: draft.name });
  await card.getByTestId("approve-send").click();
  const link = card.getByRole("link", { name: "メールを作成" });
  await expect(link).toBeVisible();
  // Excluded from another tab after the card rendered.
  await db.query("insert into public.sales_exclusions (label, reason, website_domain) values ('E2E 除外', 'existing_customer', $1)", [draft.email.split("@")[1]]);
  try {
    await link.click();
    await expect(card.getByRole("alert")).toContainText("除外リスト");
    expect(await openedMailto(page)).toEqual([]);
    const { rows } = await db.query("select state, opened_at from public.sales_outreach_approvals where outreach_id = $1", [draft.outreachId]);
    expect(rows).toEqual([{ state: "approved", opened_at: null }]);
  } finally {
    await db.query("delete from public.sales_exclusions where label = 'E2E 除外'");
  }
});

test("PR #239 M2: opened, then the shop became DNC: the card keeps the confirm step with a warning and records the flag", async ({ page }) => {
  const draft = await seedEmailDraft(db);
  seeded.push(draft.prospectId);
  await captureMailto(page);
  await login(page);
  const card = page.getByTestId("today-item").filter({ hasText: draft.name });
  await card.getByTestId("approve-send").click();
  await card.getByRole("link", { name: "メールを作成" }).click();
  await expect(card.getByRole("button", { name: "手動で送信済みにする" })).toBeVisible();
  // The owner sent it; meanwhile the shop is marked DNC (which also disables the demo).
  await db.query("update public.sales_prospects set do_not_contact = true, dnc_reason = 'admin_manual', dnc_set_at = now() where id = $1", [draft.prospectId]);
  await db.query("update public.sales_demos set disabled_at = now() where prospect_id = $1", [draft.prospectId]);
  await page.reload();
  await expect(card.getByTestId("approval-blocked")).toBeVisible();
  await expect(card.getByRole("link", { name: "メールを作成" })).toHaveCount(0);
  await expect(card.getByTestId("withdraw-approval")).toBeVisible();
  await card.getByRole("button", { name: "手動で送信済みにする" }).click();
  await expect(page.getByTestId("today-item").filter({ hasText: draft.name })).toHaveCount(0);
  const { rows } = await db.query("select status, blocked_after_open from public.sales_outreaches where id = $1", [draft.outreachId]);
  expect(rows).toEqual([{ status: "sent", blocked_after_open: "do_not_contact" }]);
});
