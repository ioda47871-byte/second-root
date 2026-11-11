import { randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { ensureUsers, removeUsers, usersFor } from "./support/admin-users";
import { startFlagOnServer, type FlagOnServer } from "./support/flag-on-server";
import { DEMO_VERSIONS_BUCKET, seedDemoVersion, storageStatus, type SeededVersion } from "../support/seed-demo-version";
import { solidWebp } from "../support/solid-webp";

// DEV-196d-3 (spec §6.1・§6.7・§6.8・§7.2): the read-only admin demo version page at PC 1440 and SP 390.
//
// The suite's server keeps the flag OFF: the page must be 404 there. A second server from the same build runs with
// the flag ON (startFlagOnServer). Checks that show the renders and the live page need the storage API, which CI does
// not start (`-x storage-api`): they skip there with the reason, ONLY when the storage service is not running.
// Fictional shop and example.com only.

const ON_PORT = Number(process.env.E2E_PORT ?? 3100) + 12;
const KEY = randomBytes(32);
const USERS_KEY = "demo-versions-page";
// tall full pages (each side ≤ 4096 px, spec §5.2)
const DESKTOP = { desktop: 4000, mobile: 4090 };

let on: FlagOnServer;
let db: pg.Pool;
let svc: SupabaseClient;
let storageUp = false;
let skipReason = "";
let seeded: SeededVersion;

test.describe.configure({ mode: "serial" });
test.skip(({ isMobile }) => isMobile, "one flag-on server: the desktop project runs this file and sets 1440 / 390 itself");

test.beforeAll(async () => {
  db = new pg.Pool({ connectionString: process.env.SUPABASE_DB_URL, max: 2 });
  svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const storage = await storageStatus();
  storageUp = storage.available;
  skipReason = storage.available ? "" : `${storage.reason} — render / frame display runs locally with Storage; headers and structure still run here`;
  await ensureUsers(USERS_KEY);
  seeded = await seedDemoVersion(db, svc, { renderHeights: DESKTOP });
  on = await startFlagOnServer(ON_PORT, KEY);
});

test.afterAll(async () => {
  on?.stop();
  if (seeded && storageUp) await svc.storage.from(DEMO_VERSIONS_BUCKET).remove(Object.keys(seeded.objects).map((n) => `${seeded.prefix}${n}`));
  await removeUsers(USERS_KEY);
  await db?.end();
});

async function login(page: Page, origin: string) {
  const { admin } = usersFor(USERS_KEY);
  await page.goto(`${origin}/admin/login`);
  await page.getByLabel("メールアドレス").fill(admin.email);
  await page.getByLabel("パスワード").fill(admin.password);
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(page).toHaveURL(/\/admin\/sales/);
}

const pageUrl = (origin: string) => `${origin}/admin/sales/demos/${seeded.prospectId}`;
const noPageOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test("flag off (the suite's server): the page is 404 for the signed-in admin; /admin headers unchanged", async ({ page, baseURL }) => {
  await login(page, baseURL!);
  const res = await page.goto(pageUrl(baseURL!));
  expect(res?.status()).toBe(404);
  const admin = await page.goto(`${baseURL}/admin/sales`);
  expect(admin?.headers()["x-frame-options"]).toBe("DENY");
  expect(admin?.headers()["content-security-policy"]).toBe("frame-ancestors 'none'");
});

test("flag on: the page's own headers — framed by nobody, may frame only 'self'; other admin pages unchanged", async ({ page }) => {
  await login(page, on.origin);
  const res = await page.goto(pageUrl(on.origin));
  expect(res?.status()).toBe(200);
  expect(res?.headers()["content-security-policy"]).toBe("frame-ancestors 'none'; frame-src 'self'");
  expect(res?.headers()["x-frame-options"]).toBe("DENY");
  expect(res?.headers()["cache-control"]).toBe("private, no-store");
  for (const p of ["/admin/sales", `/admin/preview/${seeded.prospectId}`]) {
    const r = await page.goto(`${on.origin}${p}`);
    expect(r?.headers()["content-security-policy"], p).toBe("frame-ancestors 'none'");
    expect(r?.headers()["x-frame-options"], p).toBe("DENY");
  }
  // an unknown prospect is 404, not an empty page
  expect((await page.goto(`${on.origin}/admin/sales/demos/00000000-0000-4000-8000-000000000000`))?.status()).toBe(404);
});

test("flag on: version list, facts (missing → 未確認), rights, the approval warning; no revoke yet, decisions start disabled", async ({ page }) => {
  await login(page, on.origin);
  await page.goto(pageUrl(on.origin));
  await expect(page.getByRole("heading", { level: 1 })).toContainText("デモの版");
  await expect(page.locator('[data-version="1"]')).toContainText("下書き");
  await expect(page.locator("[data-facts]")).toHaveAttribute("data-facts", "same");
  await expect(page.getByText("未確認").first()).toBeVisible();
  await expect(page.locator('[data-image="page/photos/hero-desktop.webp"]')).toHaveAttribute("data-rights", "owner_provided_internal");
  await expect(page.locator('[data-approval-warning="before"]')).toContainText("送信承認は止まります");
  // DEV-196d-5 added the quality decision: nothing is written until the admin's own explicit action, so every
  // decision button starts disabled; there is still no revoke (DEV-196d-6) and no <form> besides the shell's logout
  await expect(page.locator("form")).toHaveCount(1);
  await expect(page.getByRole("button", { name: /取り消/ })).toHaveCount(0);
  for (const b of ["品質承認", "修正を依頼", "却下"]) await expect(page.getByRole("button", { name: b, exact: true })).toBeDisabled();
});

test("the live frame is sandbox=\"\" exactly (no allow-same-origin, no allow, no srcdoc)", async ({ page }) => {
  await login(page, on.origin);
  await page.goto(pageUrl(on.origin));
  await expect(page.locator("iframe")).toHaveCount(0); // not mounted until chosen
  await page.getByRole("tab", { name: "生の頁" }).click();
  const frame = page.locator("iframe");
  await expect(frame).toHaveCount(1);
  expect(await frame.getAttribute("sandbox")).toBe("");
  expect(await frame.getAttribute("allow")).toBeNull();
  expect(await frame.getAttribute("srcdoc")).toBeNull();
  expect(await frame.getAttribute("referrerpolicy")).toBe("no-referrer");
  expect(await frame.getAttribute("src")).toMatch(/^\/demo-frame\/a\/[A-Za-z0-9_.-]+\/index\.html$/);
  if (storageUp) {
    await expect(page.frameLocator("iframe").locator("#shop")).toHaveText("架空の焼き菓子店");
    const f = page.frames().find((x) => x.url().endsWith("/index.html"))!;
    expect(await f.evaluate(() => window.origin)).toBe("null");
  }
});

for (const vp of [
  { name: "PC 1440", width: 1440, height: 900 },
  { name: "SP 390", width: 390, height: 844 },
]) {
  test(`${vp.name}: both full-page renders scroll to their very end, nothing cut off, no page overflow`, async ({ page }) => {
    test.skip(!storageUp, skipReason);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await login(page, on.origin);
    await page.goto(pageUrl(on.origin));
    expect(await noPageOverflow(page)).toBeLessThanOrEqual(0);
    for (const [viewport, natural] of [["desktop_1440", { w: 1440, h: DESKTOP.desktop }], ["mobile_390", { w: 390, h: DESKTOP.mobile }]] as const) {
      const box = page.locator(`[data-scroll="${viewport}"]`);
      const img = box.locator("img");
      await img.scrollIntoViewIfNeeded();
      await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBe(natural.w);
      const m = await box.evaluate((b) => {
        const i = b.querySelector("img")!;
        return { boxW: b.clientWidth, imgW: i.clientWidth, imgH: i.clientHeight, natW: i.naturalWidth, natH: i.naturalHeight, scrollH: b.scrollHeight };
      });
      // the whole image is laid out at its own aspect ratio (no crop) and the box can scroll over all of it
      expect(m.natH).toBe(natural.h);
      expect(Math.abs(m.imgH - Math.round((m.imgW * m.natH) / m.natW))).toBeLessThanOrEqual(1);
      expect(m.scrollH).toBeGreaterThanOrEqual(m.imgH);
      if (viewport === "mobile_390") expect(m.imgW).toBe(390); // SP 1:1
      else expect(m.imgW).toBe(m.boxW); // PC fitted to the box
      // not viewed until the sentinel under the image has been scrolled into view
      const figure = page.locator(`[data-render="${viewport}"]`);
      await expect(figure).toHaveAttribute("data-viewed", "false");
      await box.evaluate((b) => b.scrollTo(0, b.scrollHeight));
      await expect(figure).toHaveAttribute("data-viewed", "true");
      await expect(figure.getByRole("status")).toHaveText("最後まで表示しました");
      const bottom = await box.evaluate((b) => Math.round(b.scrollTop + b.clientHeight - b.scrollHeight));
      expect(Math.abs(bottom)).toBeLessThanOrEqual(1);
    }
    // PC at actual size: 1440 CSS px, scrolled inside its box, never the page
    await page.locator('[data-render="desktop_1440"]').getByRole("button", { name: "実寸で見る" }).click();
    expect(await page.locator('[data-scroll="desktop_1440"] img').evaluate((i: HTMLImageElement) => i.clientWidth)).toBe(1440);
    expect(await noPageOverflow(page)).toBeLessThanOrEqual(0);
  });
}

test("review round 1 L1: a render that 404s (expired token, no object) or has the wrong size never counts as viewed — runs without Storage", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, on.origin);
  // the PC render answers 404 (what CI and an expired token give); the SP render answers a real image of the wrong size
  await page.route(/\/renders\/desktop_1440\.webp$/, (route) => route.fulfill({ status: 404, contentType: "text/plain", body: "Not Found" }));
  await page.route(/\/renders\/mobile_390\.webp$/, (route) => route.fulfill({ status: 200, contentType: "image/webp", body: Buffer.from(solidWebp(390, 120)) }));
  await page.goto(pageUrl(on.origin));
  for (const viewport of ["desktop_1440", "mobile_390"]) {
    const figure = page.locator(`[data-render="${viewport}"]`);
    await expect(figure).toHaveAttribute("data-image", "broken");
    const box = page.locator(`[data-scroll="${viewport}"]`);
    await box.evaluate((b) => b.scrollTo(0, b.scrollHeight));
    // the collapsed image puts the sentinel in view at once: it must still not count
    expect(await page.locator(`[data-sentinel="${viewport}"]`).evaluate((el) => {
      const r = el.getBoundingClientRect();
      const b = el.parentElement!.getBoundingClientRect();
      return r.top >= b.top && r.bottom <= b.bottom + 1;
    })).toBe(true);
    await page.waitForTimeout(300);
    await expect(figure).toHaveAttribute("data-viewed", "false");
    await expect(figure.getByRole("status")).toContainText("描画画像を表示できませんでした");
  }
});

test("SP 390: the page structure fits without horizontal page scroll even without Storage", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, on.origin);
  await page.goto(pageUrl(on.origin));
  await expect(page.locator('[data-version="1"]')).toBeVisible();
  expect(await noPageOverflow(page)).toBeLessThanOrEqual(0);
});
