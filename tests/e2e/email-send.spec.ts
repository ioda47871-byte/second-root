import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { seedEmailDraft } from "../support/seed-demo";
import { ensureUsers, removeUsers, usersFor } from "./support/admin-users";

// メールを作成 → mailto with everything pre-filled (the human presses Send in
// their mail app; nothing is sent by the system) → 送信済み.

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

test("pre-fills recipient, subject, demo URL, signature and opt-out; only 送信済み records the send", async ({ page }) => {
  const draft = await seedEmailDraft(db);
  seeded.push(draft.prospectId);
  await login(page);
  const card = page.getByTestId("today-item").filter({ hasText: draft.name });
  const link = card.getByRole("link", { name: "メールを作成" });
  const href = (await link.getAttribute("href"))!;
  expect(href.startsWith(`mailto:${draft.email}?`)).toBe(true);
  const params = new URLSearchParams(href.slice(href.indexOf("?") + 1));
  expect([...params.keys()]).toEqual(["subject", "body"]);
  expect(params.get("subject")).toBe("ホームページのご提案");
  const body = params.get("body")!;
  expect(body).toContain(`${draft.name} ご担当者様`);
  expect(body).toContain("E2E メール本文です。");
  expect(body).toContain(`/demo/${draft.token}`);
  expect(body).toContain("公式サイトではありません");
  expect(body).toContain("以後ご連絡いたしません");
  expect(body).toContain("Second Root");

  // Opening the mail app records nothing.
  // Click without letting the browser hand mailto: to an external app.
  await link.evaluate((a) => {
    a.addEventListener("click", (e) => e.preventDefault(), { once: true });
    a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  let { rows } = await db.query("select status from public.sales_outreaches where id = $1", [draft.outreachId]);
  expect(rows[0].status).toBe("drafted");

  // Fallback when no mail app opens: the same text, copyable.
  await card.getByText("メールアプリが開かない場合").click();
  await expect(card.getByLabel("宛先")).toHaveValue(draft.email);
  await expect(card.getByLabel("件名")).toHaveValue("ホームページのご提案");
  await expect(card.getByLabel("本文")).toHaveValue(/E2E メール本文です。/);

  // 送信済み is still offered after the tab reloads.
  await page.reload();
  await expect(card.getByRole("button", { name: "送信済み" })).toBeVisible();

  await card.getByRole("button", { name: "送信済み" }).click();
  await expect(page.getByTestId("today-item").filter({ hasText: draft.name })).toHaveCount(0);
  ({ rows } = await db.query("select status from public.sales_outreaches where id = $1", [draft.outreachId]));
  expect(rows[0].status).toBe("sent");
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
  await expect(card.getByRole("button", { name: "送信済み" })).toHaveCount(0);
});
