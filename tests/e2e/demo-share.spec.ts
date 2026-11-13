import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Request } from "@playwright/test";
import pg from "pg";
import { ensureUsers, removeUsers, usersFor } from "./support/admin-users";
import { DEMO_VERSIONS_BUCKET, seedDemoVersion, storageStatus, type SeededVersion } from "../support/seed-demo-version";
import { pinSentApproval, setShareSwitch } from "../support/share-fixture";

// DEV-196g (spec §6.1・§6.4・§6.7・§6.8, Issue #263): the shared demo URL `/demo/<publicToken>` as a recipient opens it —
// a fresh browser context with no cookie, from the app origin — and the version's page in a sandboxed frame from a
// SEPARATE artifact origin. Locally the two origins are the same `next start` reached by two host names:
// app http://127.0.0.1:<port>, artifact http://localhost:<port> (different origins to the browser; the app's cookies
// never go to the artifact origin).
//
// The suite's own server keeps every flag OFF: the share page must be exactly the React demo it was before. This file
// starts a SECOND server from the same build with SALES_DEMO_VERSIONS_ENABLED, SALES_DEMO_SHARE_ENABLED, a signing key
// made up in this process and the two origins (no value is registered anywhere), and turns the LOCAL database's share
// switch on for its own run only (off again afterwards). The share page's `frame-src` rule is a build-time header
// (next.config.ts), so this shared build does not carry it; tests/unit/sales/demo-share.test.ts pins that rule.
//
// The real send path (quality approval → copy confirmation from the facts path → send approval → 送信済み) needs the
// facts path (DEV-263a); the sent approval that pins the version is written by the fixture as the database owner.
// Fictional shops and example.com only; nothing is sent anywhere.

const PORT = Number(process.env.E2E_PORT ?? 3100) + 21;
const APP = `http://127.0.0.1:${PORT}`;
const ART = `http://localhost:${PORT}`;
const KEY = randomBytes(32);
const USERS_KEY = "demo-share";

const PINNED_HTML =
  '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>架空の店</title><link rel="stylesheet" href="style.css"></head>' +
  '<body><main><h1 id="shop">架空の焼き菓子店</h1><p id="which">送信時に承認した版</p>' +
  "<script>document.getElementById('which').textContent='script ran'</script></main></body></html>";
const NEWER_HTML = PINNED_HTML.replace("送信時に承認した版", "あとから作った別の版");
const CSS = "body{margin:0;background:#faf7f2}h1{color:rgb(90, 62, 43)}";

let server: ChildProcess | null = null;
let db: pg.Pool;
let svc: SupabaseClient;
let storageUp = false;
let userId = "";
const seeded: SeededVersion[] = [];

async function tokenOf(demoId: string) {
  return (await db.query("select public_token from public.sales_demos where id = $1", [demoId])).rows[0].public_token as string;
}

test.describe.configure({ mode: "serial" });
test.skip(({ isMobile }) => isMobile, "the share server is started once, by the desktop project");

test.beforeAll(async () => {
  db = new pg.Pool({ connectionString: process.env.SUPABASE_DB_URL, max: 2 });
  svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  storageUp = (await storageStatus()).available;
  await ensureUsers(USERS_KEY);
  userId = (await db.query("select id from auth.users where email = $1", [usersFor(USERS_KEY).admin.email])).rows[0].id as string;
  server = spawn("npm", ["run", "start", "--", "--port", String(PORT)], {
    env: {
      ...process.env,
      SALES_DEMO_VERSIONS_ENABLED: "true",
      SALES_DEMO_SHARE_ENABLED: "true",
      SALES_DEMO_VIEW_SIGNING_KEY: KEY.toString("base64url"),
      SALES_DEMO_ARTIFACT_ORIGIN: ART,
      SALES_DEMO_APP_ORIGIN: APP,
    },
    stdio: "ignore",
    detached: true,
  });
  const until = Date.now() + 120_000;
  for (;;) {
    try {
      if ((await fetch(APP)).status > 0) break;
    } catch {
      // not up yet
    }
    if (Date.now() > until) throw new Error("share server did not start");
    await new Promise((r) => setTimeout(r, 500));
  }
});

test.afterAll(async () => {
  if (server?.pid) {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  if (db) {
    await setShareSwitch(db, false);
    for (const s of seeded) {
      if (storageUp) await svc.storage.from(DEMO_VERSIONS_BUCKET).remove(Object.keys(s.objects).map((n) => `${s.prefix}${n}`));
    }
    // the fixture's sent approvals reference the e2e admin: remove them (as the owner, triggers off) before the user
    const c = await db.connect();
    try {
      await c.query("begin");
      await c.query("set local session_replication_role = replica");
      await c.query("delete from public.sales_outreach_approvals where approved_by = $1", [userId]);
      await c.query("delete from public.sales_demo_quality_reviews where reviewed_by = $1", [userId]);
      await c.query("commit");
    } finally {
      c.release();
    }
  }
  await removeUsers(USERS_KEY);
  await db?.end();
});

test("flags off (the suite's server): the share URL is the React demo, exactly as before, and /demo-frame/p is 404", async ({ browser, request }) => {
  test.skip(!storageUp, "needs the local storage API");
  const v = await seedDemoVersion(db, svc, { noPhoto: true, html: PINNED_HTML, css: CSS });
  seeded.push(v);
  await pinSentApproval(db, { prospectId: v.prospectId, versionId: v.versionId, userId });
  await setShareSwitch(db, true);
  const token = await tokenOf(v.demoId);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const res = await page.goto(`/demo/${token}`);
  expect(res?.status()).toBe(200);
  await expect(page.getByRole("note")).toContainText("ご提案用のデモページ");
  await expect(page.locator("iframe")).toHaveCount(0);
  expect(res?.headers()["content-security-policy"]).toBe("frame-ancestors 'none'");
  await ctx.close();
  expect((await request.get(`/demo-frame/p/x/index.html`, { headers: { "Sec-Fetch-Dest": "iframe" } })).status()).toBe(404);
});

test("sharing on: a recipient (no cookie) sees exactly the pinned version in a sandboxed frame from the artifact origin", async ({ browser, request }) => {
  test.skip(!storageUp, "needs the local storage API");
  await setShareSwitch(db, true);
  const v = await seedDemoVersion(db, svc, { noPhoto: true, html: PINNED_HTML, css: CSS });
  seeded.push(v);
  const newer = await seedDemoVersion(db, svc, { noPhoto: true, html: NEWER_HTML, css: CSS, into: { prospectId: v.prospectId, demoId: v.demoId, parentVersionId: v.versionId } });
  seeded.push(newer);
  await pinSentApproval(db, { prospectId: v.prospectId, versionId: v.versionId, userId });
  const token = await tokenOf(v.demoId);

  const ctx = await browser.newContext({ baseURL: APP });
  expect(await ctx.cookies()).toEqual([]);
  const page = await ctx.newPage();
  const requests: Request[] = [];
  page.on("request", (r) => requests.push(r));
  const res = await page.goto(`/demo/${token}`);
  expect(res?.status()).toBe(200);
  const h = res!.headers();
  expect(h["x-robots-tag"]).toContain("noindex");
  expect(h["x-frame-options"]).toBe("DENY");
  await expect(page.getByRole("note")).toContainText("ご提案用のデモページ");
  await expect(page).toHaveTitle(/（ご提案用デモ）/);

  const iframe = page.locator("iframe");
  await expect(iframe).toHaveCount(1);
  expect(await iframe.getAttribute("sandbox")).toBe("");
  expect(await iframe.getAttribute("referrerpolicy")).toBe("no-referrer");
  expect(await iframe.getAttribute("allow")).toBeNull();
  const src = (await iframe.getAttribute("src"))!;
  expect(src.startsWith(`${ART}/demo-frame/p/`)).toBe(true);

  const frame = page.frameLocator("iframe");
  await expect(frame.locator("#shop")).toHaveText("架空の焼き菓子店");
  // exactly the version pinned at send approval (not the newer one), with no script run
  await expect(frame.locator("#which")).toHaveText("送信時に承認した版");
  await expect(frame.locator("h1")).toHaveCSS("color", "rgb(90, 62, 43)");
  // the frame's requests go only to the artifact origin, never to the app origin
  const frameRequests = requests.filter((r) => r.frame() !== page.mainFrame()).map((r) => new URL(r.url()).origin);
  expect(frameRequests.length).toBeGreaterThan(0);
  expect(new Set(frameRequests)).toEqual(new Set([ART]));

  // the artifact response: frame-ancestors names the app, sandbox, noindex, no-store, no cookie
  const html = await request.get(src, { headers: { "Sec-Fetch-Dest": "iframe" } });
  expect(html.status()).toBe(200);
  const csp = html.headers()["content-security-policy"]!;
  expect(csp).toContain(`frame-ancestors ${APP}`);
  expect(csp).toContain("sandbox");
  expect(csp).toContain("script-src 'none'");
  expect(html.headers()["x-robots-tag"]).toBe("noindex, nofollow, noarchive");
  expect(html.headers()["cache-control"]).toBe("private, no-store");
  expect(html.headers()["set-cookie"]).toBeUndefined();
  // opened directly (no outer notice), from the app origin, or for a render: 404
  expect((await request.get(src, { headers: { "Sec-Fetch-Dest": "document" } })).status()).toBe(404);
  expect((await request.get(src.replace(ART, APP), { headers: { "Sec-Fetch-Dest": "iframe" } })).status()).toBe(404);
  expect((await request.get(src.replace("index.html", "renders/desktop_1440.webp"), { headers: { "Sec-Fetch-Dest": "image" } })).status()).toBe(404);
  await ctx.close();
});

test("sharing on: a legacy demo stays the React demo; a revoked pinned version is 404 — never another version or React", async ({ browser }) => {
  test.skip(!storageUp, "needs the local storage API");
  await setShareSwitch(db, true);
  const legacy = await seedDemoVersion(db, svc, { noPhoto: true, upload: false });
  await pinSentApproval(db, { prospectId: legacy.prospectId, versionId: null, userId });
  const ctx = await browser.newContext({ baseURL: APP });
  const page = await ctx.newPage();
  expect((await page.goto(`/demo/${await tokenOf(legacy.demoId)}`))?.status()).toBe(200);
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect(page.getByRole("note")).toContainText("ご提案用のデモページ");

  const v = await seedDemoVersion(db, svc, { noPhoto: true, html: PINNED_HTML, css: CSS });
  seeded.push(v);
  seeded.push(await seedDemoVersion(db, svc, { noPhoto: true, html: NEWER_HTML, css: CSS, into: { prospectId: v.prospectId, demoId: v.demoId } }));
  await pinSentApproval(db, { prospectId: v.prospectId, versionId: v.versionId, userId });
  const token = await tokenOf(v.demoId);
  expect((await page.goto(`/demo/${token}`))?.status()).toBe(200);
  await db.query("alter table public.sales_demo_versions disable trigger user");
  try {
    await db.query("update public.sales_demo_versions set status = 'revoked', revoked_at = now(), revoked_by = $2, revoke_code = 'ADMIN_REVOKED' where id = $1", [v.versionId, userId]);
  } finally {
    await db.query("alter table public.sales_demo_versions enable trigger user");
  }
  expect((await page.goto(`/demo/${token}`))?.status()).toBe(404);
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect(page.getByText("あとから作った別の版")).toHaveCount(0);

  // the database switch off again: the pinned version is no longer served (404, not React)
  const w = await seedDemoVersion(db, svc, { noPhoto: true, html: PINNED_HTML, css: CSS });
  seeded.push(w);
  await pinSentApproval(db, { prospectId: w.prospectId, versionId: w.versionId, userId });
  await setShareSwitch(db, false);
  expect((await page.goto(`/demo/${await tokenOf(w.demoId)}`))?.status()).toBe(404);
  await ctx.close();
});
