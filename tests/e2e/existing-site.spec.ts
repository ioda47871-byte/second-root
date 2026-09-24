import { expect, test } from "@playwright/test";

// Regression smoke for the pre-existing Second Root site. /api/contact is
// always intercepted so no real inquiry email is ever sent.

test("home page renders with the contact form", async ({ page }) => {
  const res = await page.goto("/");
  expect(res?.status()).toBe(200);
  await expect(page).toHaveTitle(/Second Root/);
  await expect(page.locator("#contact form")).toBeVisible();
});

test("home page has no horizontal overflow", async ({ page }) => {
  await page.goto("/");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

for (const [path, heading] of [
  ["/privacy", "プライバシーポリシー"],
  ["/terms", "サイト利用規約"],
] as const) {
  test(`${path} renders`, async ({ page }) => {
    const res = await page.goto(path);
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
  });
}

test("robots.txt and sitemap.xml are served", async ({ request }) => {
  expect((await request.get("/robots.txt")).ok()).toBe(true);
  const sitemap = await request.get("/sitemap.xml");
  expect(sitemap.ok()).toBe(true);
  expect(await sitemap.text()).toContain("https://secondroot.jp/privacy");
});

async function fillContactForm(page: import("@playwright/test").Page) {
  const form = page.locator("#contact form");
  await form.locator("#cf-name").fill("テスト 太郎");
  await form.locator("#cf-shop").fill("テスト店");
  await form.locator("#cf-email").fill("owner@example.com");
  await form.locator("#cf-category").selectOption("パン屋");
  await form.locator("#cf-message").fill("E2E テスト（送信はモック）");
  return form;
}

test("contact form submits and moves to /thanks", async ({ page }) => {
  let payload: unknown;
  await page.route("**/api/contact", async (route) => {
    payload = route.request().postDataJSON();
    await route.fulfill({ status: 200, json: { ok: true } });
  });
  await page.goto("/");
  const form = await fillContactForm(page);
  await form.locator("button[type=submit]").click();
  await expect(page).toHaveURL(/\/thanks$/);
  expect(payload).toMatchObject({ shop: "テスト店", email: "owner@example.com" });
});

test("contact form shows the server error message", async ({ page }) => {
  await page.route("**/api/contact", (route) =>
    route.fulfill({ status: 502, json: { error: "送信に失敗しました。時間をおいて再度お試しください。" } }),
  );
  await page.goto("/");
  const form = await fillContactForm(page);
  await form.locator("button[type=submit]").click();
  await expect(page.getByText("送信に失敗しました。時間をおいて再度お試しください。")).toBeVisible();
  await expect(page).not.toHaveURL(/\/thanks$/);
});
