import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { seedDraft, seedEmailDraft } from "../support/seed-demo";
import { ensureUsers, removeUsers, usersFor } from "./support/admin-users";

// Mobile QA across every admin page (DEV-018): at the narrowest supported
// width (320px, iPhone SE 1st gen) and a common one (375px), with long
// unbroken shop names and every card state present, no page scrolls
// sideways, every page has one h1 and the current nav item, primary
// actions are big enough to tap, and nothing logs a console error.

test.describe.configure({ mode: "serial" });

let db: pg.Pool;
const seeded: string[] = [];
let ADMIN: ReturnType<typeof usersFor>["admin"];

const LONG = "とても長い店名の小さなベーカリー".repeat(3) + "x".repeat(40);

test.beforeAll(async ({}, testInfo) => {
  db = new pg.Pool({ connectionString: process.env.SUPABASE_DB_URL, max: 2 });
  ADMIN = usersFor(`qa-${testInfo.project.name}`).admin;
  await ensureUsers(`qa-${testInfo.project.name}`);

  const rename = async (prospectId: string) => {
    await db.query("update public.sales_prospects set name = name || $2 where id = $1", [prospectId, LONG]);
  };
  // Today: an Instagram draft, an email draft and a due email follow-up.
  const ig = await seedDraft(db, "長い営業文。".repeat(40));
  const mail = await seedEmailDraft(db);
  const follow = await seedEmailDraft(db);
  await db.query("update public.sales_outreaches set status = 'sent', sent_at = now() - interval '6 days' where id = $1", [follow.outreachId]);
  await db.query("update public.sales_demos set expires_at = now() + interval '24 days' where prospect_id = $1", [follow.prospectId]);
  // Replies (sent) and meetings (replied, meeting).
  const sent = await seedDraft(db);
  await db.query("update public.sales_outreaches set status = 'sent', sent_at = now() where id = $1", [sent.outreachId]);
  const replied = await seedDraft(db);
  await db.query("update public.sales_outreaches set status = 'sent', sent_at = now() where id = $1", [replied.outreachId]);
  await db.query("update public.sales_outreaches set status = 'replied', reply_type = 'interested', replied_at = now() where id = $1", [replied.outreachId]);
  const meeting = await seedDraft(db);
  await db.query("update public.sales_outreaches set status = 'sent', sent_at = now() where id = $1", [meeting.outreachId]);
  await db.query("update public.sales_outreaches set status = 'replied', reply_type = 'meeting_request', replied_at = now() where id = $1", [meeting.outreachId]);
  await db.query("update public.sales_outreaches set status = 'meeting', meeting_at = now() where id = $1", [meeting.outreachId]);
  for (const s of [ig, mail, follow, sent, replied, meeting]) {
    seeded.push(s.prospectId);
    await rename(s.prospectId);
  }
});
test.afterAll(async ({}, testInfo) => {
  if (seeded.length > 0) await db.query("delete from public.sales_prospects where id = any($1::uuid[])", [seeded]);
  await db.end();
  await removeUsers(`qa-${testInfo.project.name}`);
});

async function login(page: Page) {
  await page.goto("/admin/login");
  await page.getByLabel("メールアドレス").fill(ADMIN.email);
  await page.getByLabel("パスワード").fill(ADMIN.password);
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(page).toHaveURL(/\/admin\/sales$/);
}

const PAGES = [
  ["/admin/sales", "今日やること"],
  ["/admin/sales/replies", "返信"],
  ["/admin/sales/meetings", "商談"],
  ["/admin/sales/history", "履歴"],
] as const;

for (const width of [320, 375]) {
  test(`every admin page fits ${width}px with long names and all card states`, async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setViewportSize({ width, height: 800 });
    await login(page);

    for (const [path, title] of PAGES) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await expect(page.getByRole("navigation", { name: "営業管理" }).locator('[aria-current="page"]')).toHaveCount(1);
      // Open every folded section so hidden content is measured too.
      await page.evaluate(() => document.querySelectorAll("details").forEach((d) => (d.open = true)));
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${path} at ${width}px`).toBeLessThanOrEqual(0);

      // Primary actions are at least 44px tall (tap target).
      for (const button of await page.locator("main button, main a[class*='primary']").all()) {
        if (!(await button.isVisible())) continue;
        const box = await button.boundingBox();
        expect(box!.height, `${path}: ${await button.textContent()}`).toBeGreaterThanOrEqual(32);
      }
      const primaries = await page.locator("main [class*='primary']").all();
      // Today has the send actions, so the selector must match something there.
      if (path === "/admin/sales") expect(primaries.length, "primary actions found").toBeGreaterThan(0);
      for (const primary of primaries) {
        if (!(await primary.isVisible())) continue;
        expect((await primary.boundingBox())!.height, `${path}: primary`).toBeGreaterThanOrEqual(44);
      }
    }

    // The demo preview of a long-named shop fits too.
    await page.goto(`/admin/preview/${seeded[0]}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
  });
}

test("the login form works with the keyboard only", async ({ page }) => {
  await page.goto("/admin/login");
  await page.getByLabel("メールアドレス").focus();
  await page.keyboard.type(ADMIN.email);
  await page.keyboard.press("Tab");
  await page.keyboard.type(ADMIN.password);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/admin\/sales$/);
});
