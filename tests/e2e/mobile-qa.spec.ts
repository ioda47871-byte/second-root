import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { seedDraft, seedEmailDraft } from "../support/seed-demo";
import { ensureUsers, removeUsers, usersFor } from "./support/admin-users";

// Mobile QA across every admin page (DEV-018): at the narrowest supported
// width (320px, iPhone SE 1st gen) and a common one (375px), with long
// unbroken shop names, every card state present and the interactive states
// opened (email fallback, reply form, 失注 confirmation), no page scrolls
// sideways, every page has one h1 and the current nav item, tap targets are
// big enough, and nothing logs a console error.

let db: pg.Pool;
const seeded: string[] = [];
let ADMIN: ReturnType<typeof usersFor>["admin"];

const LONG = "とても長い店名の小さなベーカリー".repeat(3) + "x".repeat(40);

test.beforeAll(async ({}, testInfo) => {
  db = new pg.Pool({ connectionString: process.env.SUPABASE_DB_URL, max: 2 });
  ADMIN = usersFor(`qa-${testInfo.project.name}`).admin;
  await ensureUsers(`qa-${testInfo.project.name}`);

  // Track each shop as soon as it exists, so a failure below never leaks rows.
  const track = async <T extends { prospectId: string }>(seed: Promise<T>): Promise<T> => {
    const s = await seed;
    seeded.push(s.prospectId);
    await db.query("update public.sales_prospects set name = name || $2 where id = $1", [s.prospectId, LONG]);
    await db.query("update public.sales_demos set content = jsonb_set(content, '{name}', to_jsonb(content->>'name' || $2)) where prospect_id = $1", [s.prospectId, LONG]);
    return s;
  };
  const markSent = async (s: { outreachId: string; prospectId: string }, sentAt = "now()") => {
    await db.query(`update public.sales_outreaches set status = 'sent', sent_at = ${sentAt} where id = $1`, [s.outreachId]);
    await db.query("update public.sales_demos set expires_at = now() + interval '24 days' where prospect_id = $1", [s.prospectId]);
  };

  // Today: an Instagram draft, an email draft and a due email follow-up.
  await track(seedDraft(db, "長い営業文。".repeat(40)));
  await track(seedEmailDraft(db));
  await markSent(await track(seedEmailDraft(db)), "now() - interval '6 days'");
  // Replies (sent) and meetings (replied, meeting).
  await markSent(await track(seedDraft(db)));
  const replied = await track(seedDraft(db));
  await markSent(replied);
  await db.query("update public.sales_outreaches set status = 'replied', reply_type = 'interested', replied_at = now() where id = $1", [replied.outreachId]);
  const meeting = await track(seedDraft(db));
  await markSent(meeting);
  await db.query("update public.sales_outreaches set status = 'replied', reply_type = 'meeting_request', replied_at = now() where id = $1", [meeting.outreachId]);
  await db.query("update public.sales_outreaches set status = 'meeting', meeting_at = now() where id = $1", [meeting.outreachId]);
});
test.afterAll(async ({}, testInfo) => {
  try {
    if (seeded.length > 0) await db.query("delete from public.sales_prospects where id = any($1::uuid[])", [seeded]);
  } finally {
    await db.end();
    await removeUsers(`qa-${testInfo.project.name}`);
  }
});

async function login(page: Page) {
  await page.goto("/admin/login");
  await page.getByLabel("メールアドレス").fill(ADMIN.email);
  await page.getByLabel("パスワード").fill(ADMIN.password);
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(page).toHaveURL(/\/admin\/sales$/);
}

/** Opens the interactive states of one card of each kind, without leaving the page. */
async function openStates(page: Page, path: string) {
  if (path === "/admin/sales") {
    const mail = page.getByTestId("today-item").filter({ has: page.getByRole("link", { name: "メールを作成" }) }).first();
    await mail.getByRole("link", { name: "メールを作成" }).evaluate((a) => {
      a.addEventListener("click", (e) => e.preventDefault(), { once: true });
      a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await expect(mail.getByRole("button", { name: "送信済み" })).toBeVisible();
  }
  if (path === "/admin/sales/replies") {
    const card = page.getByTestId("reply-item").filter({ hasText: LONG }).first();
    await card.getByRole("button", { name: "返信あり" }).click();
    await card.getByLabel("断り").check();
  }
  if (path === "/admin/sales/meetings") {
    const card = page.getByTestId("meeting-item").filter({ hasText: LONG }).first();
    await card.getByRole("button", { name: "失注", exact: true }).click();
    await expect(card.getByRole("button", { name: "やめる" })).toBeVisible();
  }
  await page.evaluate(() => document.querySelectorAll("details").forEach((d) => (d.open = true)));
}

const PAGES = [
  ["/admin/sales", "今日やること", "today-item", 3],
  ["/admin/sales/replies", "返信", "reply-item", 1],
  ["/admin/sales/meetings", "商談", "meeting-item", 2],
  ["/admin/sales/history", "履歴", "history-item", 6],
] as const;

for (const width of [320, 375]) {
  test(`every admin page fits ${width}px with long names, all card states and opened actions`, async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setViewportSize({ width, height: 800 });
    await login(page);

    for (const [path, title, testId, minItems] of PAGES) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await expect(page.getByRole("navigation", { name: "営業管理" }).locator('[aria-current="page"]')).toHaveCount(1);
      // This spec's long-named cards are really on screen (not pushed out).
      expect(await page.getByTestId(testId).filter({ hasText: LONG }).count(), `${path} long cards`).toBeGreaterThanOrEqual(minItems);

      await openStates(page, path);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${path} at ${width}px`).toBeLessThanOrEqual(0);

      // Every visible control is at least 24px (WCAG 2.5.8); primary and
      // secondary actions at least 44px.
      for (const control of await page.locator("main button, main a, main summary, main input[type=radio], main input[type=checkbox]").all()) {
        if (!(await control.isVisible())) continue;
        const box = (await control.boundingBox())!;
        const label = `${path}: ${(await control.textContent())?.trim() || (await control.getAttribute("aria-label")) || "control"}`;
        expect(Math.max(box.height, box.width), label).toBeGreaterThanOrEqual(24);
        const cls = (await control.getAttribute("class")) ?? "";
        if (/(^|_)(primary|primaryLink|secondary)__/.test(cls)) expect(box.height, label).toBeGreaterThanOrEqual(44);
      }
      const primaries = await page.locator("main [class*='primary']").count();
      if (path === "/admin/sales") expect(primaries, "primary actions found").toBeGreaterThan(0);
    }

    // The demo preview of a long-named shop fits too.
    await page.goto(`/admin/preview/${seeded[0]}`);
    await expect(page.getByText(LONG).first()).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
  });
}

test("the login form works with the keyboard only", async ({ page }) => {
  await page.goto("/admin/login");
  const email = page.getByLabel("メールアドレス");
  for (let i = 0; i < 10 && !(await email.evaluate((el) => el === document.activeElement)); i += 1) await page.keyboard.press("Tab");
  await expect(email).toBeFocused();
  await page.keyboard.type(ADMIN.email);
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("パスワード")).toBeFocused();
  await page.keyboard.type(ADMIN.password);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/admin\/sales$/);
});
