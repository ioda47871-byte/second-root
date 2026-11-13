import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type BrowserContext, type Page, type Request } from "@playwright/test";
import pg from "pg";
import { signViewToken } from "@/lib/sales/demo-version/view-token";
import { SENDABLE_EMAIL, SENDABLE_FACTS_PATH, SENDABLE_PAGE_DIR, SENDABLE_PROSPECT_ID } from "@/lib/demo-version-package/seed-sendable";
import { ensureUsers, removeUsers, usersFor } from "./support/admin-users";
import { startFlagOnServer, type FlagOnServer } from "./support/flag-on-server";
import { captureMailto, openedMailto } from "./support/mailto";
import { DEMO_VERSIONS_BUCKET, seedDemoVersion, storageStatus } from "../support/seed-demo-version";
import { setShareSwitch } from "../support/share-fixture";

// DEV-263e (Issue #263 completion check 4): the whole sales MVP flow on the fictional, photo-less shop 環, end to end on
// the real admin screens, against the LOCAL Supabase stack only:
//
//   candidate (import-local.ts --seed-sendable) → DEV-263f: the owner registers 環's facts pack on the admin screen (the
//   facts store) → v2 package (package-local.ts --copy) imported with the facts from the store (--facts-from-store: the
//   copy result is facts_from_facts_path) → the admin preview of the version
//   (PC 1440 / SP 390 renders) → the 7-item quality approval → the owner's copy decision 「文章を承認」 → send approval
//   on the today card (pins the version) → the message carries the share URL → before 送信済み the URL is private →
//   mail app handoff (mailto, captured; nothing leaves the machine) → 手動で送信済みにする → the share URL opened in a
//   fresh, cookie-less browser context renders exactly the approved version from the artifact origin (sandboxed frame,
//   noindex), never a newer unapproved version and never the React demo → reply → meeting.
//   And the Instagram path: 環 again from a clean slate, reached by a fictional Instagram handle, its facts registered by
//   the dev-only CLI source (--trusted-facts --admin) → the same approvals →
//   DMを送る (copies the text and opens Instagram, stubbed; no API send) → 手動で送信済みにする → the share URL.
//
// A second `next start` from the same build runs with every demo flag ON (versions, quality review, share), a signing
// key made up in this process, two origins (app http://127.0.0.1:<port>, artifact http://localhost:<port>) and
// SALES_LOCAL_E2E_TEST_RECIPIENTS="true" (a loopback Supabase only, lib/sales/test-recipient.ts). The suite's own server
// keeps every flag off. The LOCAL database's share switch is turned on for this file only (the owner's SQL step on a
// hosted project) and off again afterwards. 環 (fixed id) is removed before, between and after the tests.
// Needs the local storage API (CI's stack runs without it: the file is skipped there) and the facts pack on
// origin/develop (the local facts path refuses it otherwise). No real send, no network beyond the two local origins.

const PORT = Number(process.env.E2E_PORT ?? 3100) + 23;
const APP = `http://127.0.0.1:${PORT}`;
const ART = `http://localhost:${PORT}`;
const KEY = randomBytes(32);
const USERS_KEY = "sales-mvp";
const REPO = process.cwd();
const SHOP = "架空自転車修理 環";
const NEWER_TEXT = "あとから作った別の版";

let on: FlagOnServer | null = null;
let db: pg.Pool;
let svc: SupabaseClient;
let storageUp = false;
let skipReason = "";
let adminId = "";
let pkgDir = "";

test.describe.configure({ mode: "serial" });
test.skip(({ isMobile }) => isMobile, "one flag-on server: the desktop project runs this file and sets 1440 / 390 itself");

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function tsx(script: string, args: string[]): { status: number | null; json: Record<string, unknown> | null; out: string } {
  const r = spawnSync("npx", ["tsx", join(REPO, script), ...args], { cwd: REPO, encoding: "utf8", env: process.env, timeout: 240_000 });
  const out = r.stdout ?? "";
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(out) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: r.status, json, out: `${out.slice(0, 2000)}${(r.stderr ?? "").slice(0, 2000)}` };
}

/** Removes the test prospects and everything under them (as the database owner, triggers off) and their stored files. */
async function purge(ids: string[]) {
  const { rows } = await db.query(
    "select v.storage_prefix from public.sales_demo_versions v join public.sales_demos d on d.id = v.demo_id where d.prospect_id = any($1::uuid[])",
    [ids],
  );
  if (storageUp) {
    for (const r of rows) {
      const prefix = r.storage_prefix as string;
      const names: string[] = [];
      for (const dir of ["page", "page/photos", "renders"]) {
        const l = await svc.storage.from(DEMO_VERSIONS_BUCKET).list(`${prefix}${dir}`, { limit: 1000 });
        for (const f of l.data ?? []) if (f.id) names.push(`${prefix}${dir}/${f.name}`);
      }
      if (names.length) await svc.storage.from(DEMO_VERSIONS_BUCKET).remove(names);
    }
  }
  const c = await db.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    const D = "(select id from public.sales_demos where prospect_id = any($1::uuid[]))";
    const V = `(select id from public.sales_demo_versions where demo_id in ${D})`;
    const O = "(select id from public.sales_outreaches where prospect_id = any($1::uuid[]))";
    for (const sql of [
      `delete from public.sales_outreach_draft_edits where outreach_id in ${O}`,
      "delete from public.sales_outreach_approvals where prospect_id = any($1::uuid[])",
      "delete from public.sales_outreaches where prospect_id = any($1::uuid[])",
      "delete from public.sales_demo_copy_facts_checks where review_id in (select id from public.sales_demo_copy_reviews where prospect_id = any($1::uuid[]))",
      "delete from public.sales_demo_facts_packs where prospect_id = any($1::uuid[])",
      `delete from public.sales_demo_copy_owner_decisions where demo_id in ${D}`,
      `delete from public.sales_demo_version_copy_links where demo_id in ${D}`,
      `delete from public.sales_demo_structure_findings where demo_id in ${D}`,
      `delete from public.sales_demo_quality_reviews where demo_id in ${D}`,
      `delete from public.sales_demo_version_files where version_id in ${V}`,
      "delete from public.sales_demo_copy_reviews where prospect_id = any($1::uuid[])",
      `delete from public.sales_demo_versions where demo_id in ${D}`,
      "delete from public.sales_demo_images where prospect_id = any($1::uuid[])",
      "delete from public.sales_demos where prospect_id = any($1::uuid[])",
      "delete from public.sales_prospect_insights where prospect_id = any($1::uuid[])",
      "delete from public.sales_sources where prospect_id = any($1::uuid[])",
      "delete from public.sales_prospects where id = any($1::uuid[])",
    ])
      await c.query(sql, [ids]);
    await c.query("commit");
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}

/** An unsent initial draft (the draft step is a worker's; here the fixture writes it), first in today's queue. */
async function draftFor(prospectId: string, channel: "email" | "instagram"): Promise<string> {
  const { rows } = await db.query(
    `insert into public.sales_outreaches (prospect_id, kind, channel, subject, body, created_at)
     values ($1, 'initial', $2, $3, 'はじめまして。ホームページのご提案用に、貴店のデモページを作りました。', now() - interval '3650 days') returning id`,
    [prospectId, channel, channel === "email" ? "ホームページのご提案" : null],
  );
  return rows[0].id as string;
}

const demoOf = async (prospectId: string) =>
  (await db.query("select id, public_token, approved_version_id from public.sales_demos where prospect_id = $1", [prospectId])).rows[0] as { id: string; public_token: string; approved_version_id: string | null };

async function login(page: Page) {
  const { admin } = usersFor(USERS_KEY);
  await page.goto(`${APP}/admin/login`);
  await page.getByLabel("メールアドレス").fill(admin.email);
  await page.getByLabel("パスワード").fill(admin.password);
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(page).toHaveURL(/\/admin\/sales$/);
}

/** Every request a context makes goes to the two local origins (or is a mailto captured in the page): nothing is sent. */
function watchOrigins(ctx: BrowserContext): Set<string> {
  const origins = new Set<string>();
  ctx.on("request", (r) => {
    const u = new URL(r.url());
    if (u.protocol === "http:" || u.protocol === "https:") origins.add(u.origin);
  });
  return origins;
}

/**
 * import-local.ts with the facts from the facts store; the copy came from that path. `fromStore`: the facts the owner
 * registered on the admin screen; otherwise the dev-only source (the committed pack registered as the admin first).
 */
function importTrusted(target: string[], fromStore = false): { versionId: string; bundleSha256: string } {
  const facts = fromStore ? ["--facts-from-store"] : ["--trusted-facts", SENDABLE_FACTS_PATH, "--admin", adminId];
  const r = tsx("scripts/sales/demo-version/import-local.ts", ["--package", pkgDir, ...target, ...facts]);
  expect(r.status, r.out).toBe(0);
  expect(r.json?.status).toBe("OK");
  const copy = r.json!.copy as Record<string, unknown>;
  expect(copy.facts_from_facts_path).toBe(true);
  return { versionId: r.json!.versionId as string, bundleSha256: r.json!.bundleSha256 as string };
}

/** DEV-263f: 店舗の事実の登録 on the admin version page — paste the committed pack, 内容を確認, この事実を登録する. */
async function registerFactsOnAdmin(page: Page, prospectId: string) {
  await page.goto(`${APP}/admin/sales/demos/${prospectId}`);
  const panel = page.locator("[data-facts-registration]");
  await expect(panel.locator("[data-facts-current]")).toHaveAttribute("data-facts-current", "none");
  // a pack the demo was not derived from is refused (nothing registered)
  await panel.locator("[data-facts-input]").fill(`${readFileSync(resolve(REPO, SENDABLE_FACTS_PATH), "utf8")} `);
  await panel.getByRole("button", { name: "内容を確認" }).click();
  await expect(panel.locator("[data-facts-preview]")).toHaveAttribute("data-facts-preview", "refused");
  await expect(panel.getByRole("button", { name: "この事実を登録する" })).toBeDisabled();
  await panel.locator("[data-facts-input]").fill(readFileSync(resolve(REPO, SENDABLE_FACTS_PATH), "utf8"));
  await panel.getByRole("button", { name: "内容を確認" }).click();
  await expect(panel.locator("[data-facts-preview]")).toHaveAttribute("data-facts-preview", "ok");
  await expect(panel.locator("[data-facts-preview]")).toContainText("fictional-bicycle-repair-tamaki");
  await panel.getByRole("button", { name: "この事実を登録する" }).click();
  await expect(panel.locator("[data-facts-result]")).toHaveAttribute("data-facts-result", "done");
  await expect(panel.locator("[data-facts-current]")).toHaveAttribute("data-facts-current", "ok");
  const rows = (await db.query("select recorded_by, recorded_via from public.sales_demo_facts_packs where prospect_id = $1", [prospectId])).rows;
  expect(rows).toEqual([{ recorded_by: adminId, recorded_via: "admin_session" }]);
}

/** The admin version page: preview PC 1440 / SP 390, then the 7-item quality approval and the owner's copy approval. */
async function approveOnAdmin(page: Page, prospectId: string, versionId: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${APP}/admin/sales/demos/${prospectId}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(SHOP.slice(0, 6));
  await expect(page.locator("[data-selected-version]")).toHaveAttribute("data-selected-version", "1");

  // the stored copy review: from the facts path, the audit passed, waiting only for the owner
  const copyPanel = page.locator('[data-copy-review="present"]');
  await expect(copyPanel.locator("[data-facts-from-facts-path]")).toHaveAttribute("data-facts-from-facts-path", "true");
  await expect(copyPanel.locator("[data-copy-verdict]")).toHaveAttribute("data-copy-verdict", "approve_candidate");
  await expect(copyPanel.locator("[data-copy-owner-decision]")).toHaveAttribute("data-copy-owner-decision", "none");

  await qualityApprove(page, prospectId, versionId, 1);

  // the owner's copy decision (decideCopyReview)
  const decision = page.locator("[data-copy-decision-form]");
  await decision.locator('[data-copy-decision="approve"] input[type="radio"]').check();
  await decision.getByRole("button", { name: "「文章を承認」を記録する" }).click();
  await expect(page.locator("[data-copy-owner-decision]")).toHaveAttribute("data-copy-owner-decision", "approve");
  await expect(page.locator("[data-copy-send-block]")).toHaveCount(0);
  await expect(page.locator("[data-send-stop]")).toHaveCount(0);
}

/** On the version's admin page: both renders viewed to the end, 7 items ok, the acknowledgement, 品質承認. */
async function qualityApprove(page: Page, prospectId: string, versionId: string, versionNo: number) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${APP}/admin/sales/demos/${prospectId}?v=${versionId}`);
  await expect(page.locator("[data-selected-version]")).toHaveAttribute("data-selected-version", String(versionNo));

  // preview: both full-page renders load and are scrolled to their end (the basis of the quality judgement)
  for (const v of ["desktop_1440", "mobile_390"]) {
    const figure = page.locator(`[data-render="${v}"]`);
    await expect(figure).toHaveAttribute("data-image", "ok");
    await page.locator(`[data-scroll="${v}"]`).evaluate((b) => b.scrollTo(0, b.scrollHeight));
    await expect(figure).toHaveAttribute("data-viewed", "true");
  }

  // 7-item quality approval
  const form = page.locator("[data-review-form]");
  for (const item of await form.locator("[data-item]").all()) await item.getByLabel("問題なし").check();
  await expect(form.locator("[data-review-summary]")).toContainText("7項目 7/7・PC✓・SP✓");
  await form.locator("[data-ack]").check();
  await form.getByRole("button", { name: "品質承認" }).click();
  await expect(form.locator('[data-review-result="done"]')).toBeVisible();
  await expect(page.locator(`[data-version="${versionNo}"]`)).toContainText("品質承認済み");
  expect((await demoOf(prospectId)).approved_version_id).toBe(versionId);
  expect((await db.query("select decision, state, reviewed_by from public.sales_demo_quality_reviews where version_id = $1", [versionId])).rows).toEqual([
    { decision: "approved", state: "active", reviewed_by: adminId },
  ]);
}

/** Before 送信済み: the share URL and the artifact URL (a validly signed scope-p token for the version) are 404. */
async function expectPrivate(browser: import("@playwright/test").Browser, token: string, versionId: string, demoId: string) {
  const ctx = await browser.newContext({ baseURL: APP });
  expect((await ctx.request.get(`/demo/${token}`)).status()).toBe(404);
  const viewToken = signViewToken({ scope: "p", versionId, demoId, now: new Date(), key: KEY });
  expect((await ctx.request.get(`${ART}/demo-frame/p/${viewToken}/index.html`, { headers: { "Sec-Fetch-Dest": "iframe" } })).status()).toBe(404);
  await ctx.close();
}

/** A recipient: a fresh browser context with no cookie opens the share URL and sees exactly `versionId`. */
async function openAsRecipient(browser: import("@playwright/test").Browser, token: string, versionId: string) {
  const ctx = await browser.newContext({ baseURL: APP });
  expect(await ctx.cookies()).toEqual([]);
  const origins = watchOrigins(ctx);
  const page = await ctx.newPage();
  const requests: Request[] = [];
  page.on("request", (r) => requests.push(r));
  const res = await page.goto(`/demo/${token}`);
  expect(res?.status()).toBe(200);
  expect(res!.headers()["x-robots-tag"]).toContain("noindex");
  await expect(page.getByRole("note")).toContainText("ご提案用のデモページ");
  // the version's page in a sandboxed frame from the artifact origin — not the React demo
  const iframe = page.locator("iframe");
  await expect(iframe).toHaveCount(1);
  expect(await iframe.getAttribute("sandbox")).toBe("");
  expect(await iframe.getAttribute("referrerpolicy")).toBe("no-referrer");
  const src = (await iframe.getAttribute("src"))!;
  expect(src.startsWith(`${ART}/demo-frame/p/`)).toBe(true);
  const frame = page.frameLocator("iframe");
  await expect(frame.locator("h1")).toContainText("環");
  await expect(frame.locator("h2", { hasText: "修理のご案内" })).toBeVisible();
  await expect(frame.getByText(NEWER_TEXT)).toHaveCount(0);
  await expect(page.getByText(NEWER_TEXT)).toHaveCount(0);
  const frameOrigins = new Set(requests.filter((r) => r.frame() !== page.mainFrame()).map((r) => new URL(r.url()).origin));
  expect(frameOrigins).toEqual(new Set([ART]));
  // exactly the approved version's stored bytes, with the artifact headers (sandbox, noindex, no-store, no cookie)
  const html = await ctx.request.get(src, { headers: { "Sec-Fetch-Dest": "iframe" } });
  expect(html.status()).toBe(200);
  const stored = (await db.query("select sha256 from public.sales_demo_version_files where version_id = $1 and path = 'page/index.html'", [versionId])).rows[0].sha256 as string;
  expect(sha256(await html.body())).toBe(stored);
  const csp = html.headers()["content-security-policy"]!;
  expect(csp).toContain(`frame-ancestors ${APP}`);
  expect(csp).toContain("sandbox");
  expect(html.headers()["x-robots-tag"]).toBe("noindex, nofollow, noarchive");
  expect(html.headers()["set-cookie"]).toBeUndefined();
  expect(await ctx.cookies()).toEqual([]);
  expect([...origins].every((o) => o === APP || o === ART)).toBe(true);
  await ctx.close();
}

test.beforeAll(async () => {
  test.setTimeout(600_000);
  db = new pg.Pool({ connectionString: process.env.SUPABASE_DB_URL, max: 3 });
  svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const storage = await storageStatus();
  storageUp = storage.available;
  skipReason = storage.available ? "" : `${storage.reason} — the import uploads the version to the private bucket; runs locally with Storage`;
  if (!storageUp) return;
  await purge([SENDABLE_PROSPECT_ID]);
  await ensureUsers(USERS_KEY);
  adminId = (await db.query("select id from auth.users where email = $1", [usersFor(USERS_KEY).admin.email])).rows[0].id as string;
  // the v2 package of 環's committed, photo-less comp with its copy (written outside the repository)
  pkgDir = join(mkdtempSync(join(tmpdir(), "sr-263e-")), "pkg");
  const p = tsx("scripts/sales/demo-version/package-local.ts", ["--out", pkgDir, "--copy", SENDABLE_PAGE_DIR, "--facts", SENDABLE_FACTS_PATH]);
  expect(p.status, p.out).toBe(0);
  on = await startFlagOnServer(PORT, KEY, {
    review: true,
    env: { SALES_DEMO_SHARE_ENABLED: "true", SALES_DEMO_ARTIFACT_ORIGIN: ART, SALES_DEMO_APP_ORIGIN: APP, SALES_DEMO_BASE_URL: APP, SALES_LOCAL_E2E_TEST_RECIPIENTS: "true" },
  });
  await setShareSwitch(db, true);
});

test.afterAll(async () => {
  on?.stop();
  if (db) {
    if (storageUp) {
      await setShareSwitch(db, false);
      await purge([SENDABLE_PROSPECT_ID]);
    }
  }
  if (pkgDir) rmSync(join(pkgDir, ".."), { recursive: true, force: true });
  if (storageUp) await removeUsers(USERS_KEY);
  await db?.end();
});

test("email: candidate → trusted import → preview → quality + copy approval → send approval pins the version → mailto → 送信済み → the recipient sees exactly it → reply → meeting", async ({ page, browser, context }) => {
  test.skip(!storageUp, skipReason);
  test.setTimeout(300_000);
  const admin = watchOrigins(context);
  await captureMailto(page);

  // 1. the candidate: 環 seeded from its committed facts pack (no outreach yet)
  const seed = tsx("scripts/sales/demo-version/import-local.ts", ["--seed-sendable", "--seed-only"]);
  expect(seed.status, seed.out).toBe(0);
  expect(seed.json).toMatchObject({ status: "OK", prospect_id: SENDABLE_PROSPECT_ID });
  expect((await db.query("select count(*)::int as n from public.sales_outreaches where prospect_id = $1", [SENDABLE_PROSPECT_ID])).rows[0].n).toBe(0);

  // 2. DEV-263f: the owner registers 環's facts pack on the admin screen (the facts store): check, then register
  await login(page);
  await registerFactsOnAdmin(page, SENDABLE_PROSPECT_ID);
  // the v2 package imported with the facts from the store (copy: facts_from_facts_path)
  const v = importTrusted(["--seed-sendable"], true);
  const demo = await demoOf(SENDABLE_PROSPECT_ID);
  expect(demo.approved_version_id).toBeNull();

  // 3-5. admin preview PC / SP, 7-item quality approval, the owner's copy approval
  await approveOnAdmin(page, SENDABLE_PROSPECT_ID, v.versionId);

  // 6. the today card: the exact recipient and text, with the share URL; send approval pins the approved version
  const outreachId = await draftFor(SENDABLE_PROSPECT_ID, "email");
  await page.goto(`${APP}/admin/sales`);
  const card = page.getByTestId("today-item").filter({ hasText: SHOP });
  await expect(card.getByTestId("send-recipient")).toHaveText(SENDABLE_EMAIL);
  const shareUrl = `${APP}/demo/${demo.public_token}`;
  await expect(card.getByLabel("送る文面")).toHaveValue(new RegExp(shareUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  await card.getByTestId("approve-send").click();
  await expect(card.getByTestId("open-mail")).toBeVisible();
  let a = (await db.query("select state, demo_version_id, demo_bundle_sha256, demo_share_eligible, demo_quality_review_id is not null as reviewed from public.sales_outreach_approvals where outreach_id = $1", [outreachId])).rows;
  expect(a).toEqual([{ state: "approved", demo_version_id: v.versionId, demo_bundle_sha256: v.bundleSha256, demo_share_eligible: true, reviewed: true }]);

  // a newer version arrives after the approval (not quality-approved): it must never be what the recipient sees
  const newer = await seedDemoVersion(db, svc, {
    noPhoto: true,
    html: `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>架空の店</title></head><body><h1>${NEWER_TEXT}</h1></body></html>`,
    into: { prospectId: SENDABLE_PROSPECT_ID, demoId: demo.id, parentVersionId: v.versionId },
  });

  // 7. before 送信済み the share URL and the artifact URL (a validly signed scope-p token) are private (404 for anyone)
  await expectPrivate(browser, demo.public_token, v.versionId, demo.id);

  // 8. the mail app handoff: records 「送信画面を開いた」 then hands the approved mailto to the device (captured)
  await card.getByTestId("open-mail").click();
  await expect(card.getByTestId("confirm-sent")).toBeVisible();
  // PR #268 L2: opened (send_opened) is still not sent — both URLs stay private
  expect((await db.query("select state from public.sales_outreach_approvals where outreach_id = $1", [outreachId])).rows).toEqual([{ state: "send_opened" }]);
  await expectPrivate(browser, demo.public_token, v.versionId, demo.id);
  const opened = await openedMailto(page);
  expect(opened).toHaveLength(1);
  expect(opened[0]!.startsWith(`mailto:${SENDABLE_EMAIL}?`)).toBe(true);
  const body = new URLSearchParams(opened[0]!.slice(opened[0]!.indexOf("?") + 1)).get("body")!;
  expect(body).toContain(shareUrl);

  // 9. 手動で送信済みにする: the owner sent it from their own mail app
  await card.getByTestId("confirm-sent").click();
  await expect(page.getByTestId("send-recorded")).toHaveAttribute("data-recorded", "sent");
  a = (await db.query("select a.state, a.demo_version_id, o.status from public.sales_outreach_approvals a join public.sales_outreaches o on o.id = a.outreach_id where a.outreach_id = $1", [outreachId])).rows;
  expect(a).toEqual([{ state: "sent", demo_version_id: v.versionId, status: "sent" }]);

  // 10. the recipient: a fresh, cookie-less context sees exactly the approved version from the artifact origin
  await openAsRecipient(browser, demo.public_token, v.versionId);

  // PR #268 M1: the share shows the version PINNED at send approval, not whichever is approved now — the owner
  // quality-approves the newer version on the admin screen (approved_version_id moves to it), and the recipient
  // still sees exactly v1's stored page
  await qualityApprove(page, SENDABLE_PROSPECT_ID, newer.versionId, 2);
  expect((await demoOf(SENDABLE_PROSPECT_ID)).approved_version_id).toBe(newer.versionId);
  await openAsRecipient(browser, demo.public_token, v.versionId);

  // 11. reply → meeting
  await page.goto(`${APP}/admin/sales/replies`);
  const reply = page.getByTestId("reply-item").filter({ hasText: SHOP });
  await reply.getByRole("button", { name: "返信あり" }).click();
  await reply.getByLabel("興味あり").check();
  await reply.getByRole("button", { name: "記録する" }).click();
  await expect(page.getByTestId("reply-item").filter({ hasText: SHOP })).toHaveCount(0);
  await page.goto(`${APP}/admin/sales/meetings`);
  const meeting = page.getByTestId("meeting-item").filter({ hasText: SHOP });
  await meeting.getByRole("button", { name: "商談へ" }).click();
  await expect(page.getByTestId("meeting-item").filter({ hasText: SHOP })).toContainText("商談中");
  expect((await db.query("select status, reply_type from public.sales_outreaches where id = $1", [outreachId])).rows[0]).toEqual({ status: "meeting", reply_type: "interested" });

  // nothing was sent by the system: the admin browser only ever talked to the local app
  expect([...admin].every((o) => o === APP || o === ART)).toBe(true);
});

test("Instagram: the same approvals, then DMを送る copies the text and opens Instagram (stubbed, no API send) → 送信済み → the share URL", async ({ page, browser, context }) => {
  test.skip(!storageUp, skipReason);
  test.setTimeout(300_000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: APP });
  // Never contact the real Instagram (or its API) from tests: the profile is stubbed, and any API host would be counted.
  const api: string[] = [];
  await context.route(/instagram\.com|facebook\.com/, (route) => {
    const u = new URL(route.request().url());
    if (u.hostname !== "www.instagram.com") api.push(u.hostname);
    return route.fulfill({ status: 200, contentType: "text/html", body: "<p>stub</p>" });
  });
  const igSends = async () => (await db.query("select count(*)::int as n from public.sales_ig_sends")).rows[0].n as number;
  const igSendsBefore = await igSends();
  const handle = `tamaki_e2e_${randomBytes(3).toString("hex")}`;
  // 環 again from a clean slate (a package's job id is bound to one demo, so the same package cannot go to a second
  // shop), this time reached by a fictional Instagram handle (the demo content stays the facts path's)
  await purge([SENDABLE_PROSPECT_ID]);
  const seed = tsx("scripts/sales/demo-version/import-local.ts", ["--seed-sendable", "--seed-only"]);
  expect(seed.status, seed.out).toBe(0);
  // an Instagram-only shop (the schema: no website, no email)
  await db.query("update public.sales_prospects set instagram_url = $2, instagram_handle = $3, recommended_channel = 'instagram', website_status = 'not_found', website_url = null, website_domain = null, public_email = null where id = $1", [
    SENDABLE_PROSPECT_ID,
    `https://www.instagram.com/${handle}/`,
    handle,
  ]);
  const v = importTrusted(["--prospect", SENDABLE_PROSPECT_ID]);
  const demo = await demoOf(SENDABLE_PROSPECT_ID);

  await login(page);
  await approveOnAdmin(page, SENDABLE_PROSPECT_ID, v.versionId);

  const outreachId = await draftFor(SENDABLE_PROSPECT_ID, "instagram");
  await page.goto(`${APP}/admin/sales`);
  const card = page.getByTestId("today-item").filter({ hasText: SHOP });
  await expect(card.getByTestId("send-recipient")).toHaveText(`@${handle}`);
  await card.getByTestId("approve-send").click();
  const [popup] = await Promise.all([context.waitForEvent("page"), card.getByRole("button", { name: "DMを送る" }).click()]);
  await popup.waitForURL(`https://www.instagram.com/${handle}/`);
  await popup.close();
  await expect(card.getByTestId("confirm-sent")).toBeVisible();
  await expectPrivate(browser, demo.public_token, v.versionId, demo.id); // opened is not sent (PR #268 L2)
  const clip =await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain(`${APP}/demo/${demo.public_token}`);
  let a = (await db.query("select state, opened_via, demo_version_id, body from public.sales_outreach_approvals where outreach_id = $1", [outreachId])).rows;
  expect(a).toEqual([{ state: "send_opened", opened_via: "instagram_profile", demo_version_id: v.versionId, body: clip }]);
  // no Instagram send API exists for the first DM: nothing went to an API host, and nothing was recorded as an IG send
  expect(api).toEqual([]);
  expect(await igSends()).toBe(igSendsBefore);

  await card.getByTestId("confirm-sent").click();
  await expect(page.getByTestId("send-recorded")).toHaveAttribute("data-recorded", "sent");
  a = (await db.query("select a.state, o.status from public.sales_outreach_approvals a join public.sales_outreaches o on o.id = a.outreach_id where a.outreach_id = $1", [outreachId])).rows;
  expect(a).toEqual([{ state: "sent", status: "sent" }]);
  await openAsRecipient(browser, demo.public_token, v.versionId);
});
