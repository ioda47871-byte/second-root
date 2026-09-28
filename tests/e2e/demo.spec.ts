import { expect, test } from "@playwright/test";
import pg from "pg";
import { seedDemo } from "../support/seed-demo";

// Public demo page against the local Supabase stack (seeded fictional shop).

const day = 86_400_000;
let db: pg.Pool;
const seeded: string[] = [];

// One pool per worker for this file; tests in the file run serially so the
// pool is never used after afterAll closes it.
test.describe.configure({ mode: "serial" });
test.beforeAll(() => {
  db = new pg.Pool({ connectionString: process.env.SUPABASE_DB_URL, max: 2 });
});
test.afterAll(async () => {
  // Only this worker's rows: the other project may still be using its own.
  if (seeded.length > 0) await db.query("delete from public.sales_prospects where id = any($1::uuid[])", [seeded]);
  await db.end();
});

async function seed(opts: Parameters<typeof seedDemo>[1]) {
  const demo = await seedDemo(db, opts);
  seeded.push(demo.prospectId);
  return demo;
}

test("shows a sent demo with the proposal notice and noindex", async ({ page }) => {
  const { token, name } = await seed({ expiresAt: new Date(Date.now() + 10 * day) });
  const res = await page.goto(`/demo/${token}`);
  expect(res?.status()).toBe(200);
  expect(res?.headers()["x-robots-tag"]).toBe("noindex, nofollow");
  expect(res?.headers()["referrer-policy"]).toBe("no-referrer");
  expect(res?.headers()["x-frame-options"]).toBe("DENY");
  expect(res?.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(res?.headers()["x-content-type-options"]).toBe("nosniff");
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  await expect(page.getByRole("note")).toContainText("ご提案用のデモページ");
  await expect(page.getByRole("note")).toContainText("公式サイトではありません");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  await expect(page.getByText("8:00〜17:00")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

for (const [template, category] of [["bakery_v1", "bakery"], ["baked_goods_v1", "baked_goods"], ["cafe_v1", "cafe"]] as const) {
  test(`${template} fits the screen with long unbroken text and repeated menu items`, async ({ page }) => {
    const { token, name } = await seed({
      expiresAt: new Date(Date.now() + 10 * day),
      template,
      category,
      description: "a".repeat(300),
      menuItems: ["ブレンド", "ブレンド", "b".repeat(120)],
    });
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    expect((await page.goto(`/demo/${token}`))?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
    await expect(page.getByText("ブレンド")).toHaveCount(2);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    expect(errors.filter((e) => e.includes("same key"))).toEqual([]);
  });
}

test("returns 404 for unsent, expired, disabled and unknown demos", async ({ page }) => {
  const unsent = await seed({ expiresAt: null });
  const expired = await seed({ expiresAt: new Date(Date.now() - day) });
  const disabled = await seed({ expiresAt: new Date(Date.now() + day), disabledAt: new Date() });
  for (const token of [unsent.token, expired.token, disabled.token, "x".repeat(43)]) {
    const res = await page.goto(`/demo/${token}`);
    expect(res?.status(), token).toBe(404);
    expect(res?.headers()["x-robots-tag"]).toBe("noindex, nofollow");
  }
});
