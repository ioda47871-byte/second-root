import { randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { QUALITY_CHECKLIST_ITEMS } from "@/lib/sales/demo-version/quality";
import { ensureUsers, removeUsers, usersFor } from "./support/admin-users";
import { startFlagOnServer, type FlagOnServer } from "./support/flag-on-server";
import { seedDraft } from "../support/seed-demo";
import { seedDemoVersion } from "../support/seed-demo-version";

// DEV-196d-7: the Today card's demo version badge, its link and the send-stop explanation, at PC 1440 and SP 390.
// The suite's server keeps the flag OFF: the Today card must be exactly as before there (no badge, link or warning).
// A second server with the flag ON shows them. Nothing needs Storage. Fictional shops and example.com only.

const ON_PORT = Number(process.env.E2E_PORT ?? 3100) + 16;
const USERS_KEY = "demo-today";
const ALL_OK = Object.fromEntries(QUALITY_CHECKLIST_ITEMS.map((k) => [k, "ok"]));

let on: FlagOnServer;
let db: pg.Pool;
let svc: SupabaseClient;
let adminRpc: SupabaseClient;
const outreaches: string[] = [];
let approvedShop: { prospectId: string; name: string };
let awaitingShop: { prospectId: string; name: string };

test.describe.configure({ mode: "serial" });
test.skip(({ isMobile }) => isMobile, "one flag-on server: the desktop project runs this file and sets 1440 / 390 itself");

const one = async (sql: string, args: unknown[]) => (await db.query(sql, args)).rows[0];
async function shop(approve: boolean) {
  const d = await seedDraft(db);
  outreaches.push(d.outreachId);
  const demoId = (await one("select id from public.sales_demos where prospect_id = $1", [d.prospectId])).id as string;
  const v = await seedDemoVersion(db, svc, { upload: false, into: { prospectId: d.prospectId, demoId } });
  if (approve) {
    const sha = async (p: string) => (await one("select sha256 from public.sales_demo_version_files where version_id = $1 and path = $2", [v.versionId, p])).sha256 as string;
    const r = await adminRpc.rpc("sales_review_demo_version", {
      p_version_id: v.versionId, p_decision: "approved", p_checklist: ALL_OK, p_note: null,
      p_viewed_renders: { desktop_1440: await sha("renders/desktop_1440.webp"), mobile_390: await sha("renders/mobile_390.webp") },
      p_bundle_sha256: (await one("select bundle_sha256 from public.sales_demo_versions where id = $1", [v.versionId])).bundle_sha256,
    });
    expect(r.error, r.error?.message).toBeNull();
  }
  return { prospectId: d.prospectId, name: d.name };
}

test.beforeAll(async () => {
  db = new pg.Pool({ connectionString: process.env.SUPABASE_DB_URL, max: 2 });
  svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  await ensureUsers(USERS_KEY);
  adminRpc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  expect((await adminRpc.auth.signInWithPassword(usersFor(USERS_KEY).admin)).error).toBeNull();
  approvedShop = await shop(true);
  awaitingShop = await shop(false);
  on = await startFlagOnServer(ON_PORT, randomBytes(32));
});

test.afterAll(async () => {
  on?.stop();
  // the shared Today queue (max 5 items): take this file's drafts off it
  if (outreaches.length) await db.query("delete from public.sales_outreaches where id = any($1::uuid[])", [outreaches]);
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
const card = (page: Page, name: string) => page.locator('[data-testid="today-item"]', { has: page.getByRole("heading", { name }) });
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test("flag off (the suite's server): the Today cards have no badge, no link and no warning — unchanged", async ({ page, baseURL }) => {
  await login(page, baseURL!);
  await page.goto(`${baseURL}/admin/sales`);
  await expect(page.locator('[data-testid="today-item"]').first()).toBeVisible();
  await expect(page.locator('[data-testid="demo-version-badge"], [data-testid="demo-versions-link"], [data-testid="demo-send-stop"]')).toHaveCount(0);
  await expect(page.getByText("デモの版")).toHaveCount(0);
  // the existing card is as it was: the approved shop's card still offers the same send approval
  await expect(card(page, approvedShop.name).getByRole("button", { name: "この内容で送信を承認" })).toBeVisible();
});

for (const vp of [
  { name: "PC 1440", width: 1440, height: 900 },
  { name: "SP 390", width: 390, height: 844 },
]) {
  test(`${vp.name} flag on: the badge, the send-stop explanation, and the link to the version page`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await login(page, on.origin);
    await page.goto(`${on.origin}/admin/sales`);
    const approved = card(page, approvedShop.name);
    await expect(approved.getByTestId("demo-version-badge")).toHaveText("デモの版: 品質承認済み（v1）");
    const stop = approved.getByTestId("demo-send-stop");
    await expect(stop).toHaveAttribute("data-send-stop", "demo_not_shareable");
    await expect(stop).toContainText("この店舗の送信承認は、デモの版のため止まっています。");
    await expect(stop).toContainText("版での共有がまだ無効です");
    // display only: the send action is the one the card always had (the database refuses it)
    await expect(approved.getByRole("button", { name: "この内容で送信を承認" })).toBeVisible();
    const awaiting = card(page, awaitingShop.name);
    await expect(awaiting.getByTestId("demo-version-badge")).toHaveText("デモの版: 品質確認待ち（v1）");
    await expect(awaiting.getByTestId("demo-send-stop")).toHaveCount(0);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await awaiting.getByTestId("demo-versions-link").click();
    await expect(page).toHaveURL(new RegExp(`/admin/sales/demos/${awaitingShop.prospectId}$`));
    await expect(page.getByRole("heading", { level: 1 })).toContainText("デモの版");
  });
}
