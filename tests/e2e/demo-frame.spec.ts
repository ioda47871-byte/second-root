import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type APIRequestContext, type Request } from "@playwright/test";
import pg from "pg";
import { signViewToken } from "@/lib/sales/demo-version/view-token";
import { ensureUsers, removeUsers, usersFor } from "./support/admin-users";
import { DEMO_VERSIONS_BUCKET, seedDemoVersion, storageStatus, type SeededVersion } from "../support/seed-demo-version";

// DEV-196d-2 (spec §6.3・§6.4・§6.7・§6.8・T1・T3): the admin artifact route `/demo-frame/a/<token>/<path>`.
//
// The suite's own server (playwright.config.ts) runs with the flag OFF, as every deployment does today: there the
// route must be the plain 404. For the flag-ON checks this file starts a SECOND server from the same build, with
// SALES_DEMO_VERSIONS_ENABLED=true and a signing key made up inside this test process only (no value is registered
// anywhere). The framed document must be an opaque origin with no script, no cookie and no request leaving the app.
//
// The checks that read the bucket need the local storage API; CI starts Supabase with `-x storage-api`, so they skip
// there (the flag-off, scope p and 404 checks still run). Fictional shop and example.com only.

const ON_PORT = Number(process.env.E2E_PORT ?? 3100) + 11;
const ON = `http://127.0.0.1:${ON_PORT}`;
const KEY = randomBytes(32);
const SECRET_COOKIE = "sb-e2e-auth-token";
// own admin user, so this file never races admin.spec.ts for the per-project users
const USERS_KEY = "demo-frame";

let server: ChildProcess | null = null;
let db: pg.Pool;
let svc: SupabaseClient;
let storageUp = false;
let storageSkipReason = "";
let seeded: SeededVersion;

const HTML =
  '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>架空の店</title>' +
  '<link rel="stylesheet" href="style.css"><link rel="stylesheet" href="https://example.com/external.css"></head>' +
  '<body><main><h1 id="shop">架空の焼き菓子店</h1>' +
  '<img id="hero" src="photos/hero-desktop.webp" alt="店の写真">' +
  '<img id="external" src="https://example.com/external.webp" alt="">' +
  '<form action="https://example.com/post"><button id="send">送信</button></form>' +
  "<script>document.getElementById('shop').textContent='script ran';new Image().src='/leak?c='+encodeURIComponent(document.cookie);</script>" +
  '<iframe src="https://example.com/frame"></iframe></main></body></html>';
const CSS = "@import url(https://example.com/import.css);body{margin:0;background:url(https://example.com/bg.webp)}h1{color:#5a3e2b}";

const token = (scope: "a" | "p" = "a", s: SeededVersion = seeded) => signViewToken({ scope, versionId: s.versionId, demoId: s.demoId, now: new Date(), key: KEY });

async function waitForServer(url: string, ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(url);
      if (r.status > 0) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("flag-on server did not start");
}

/** The parts of a 404 that must never differ (dates and connection headers aside). */
async function notFoundShape(api: APIRequestContext, url: string, headers: Record<string, string> = {}) {
  const res = await api.get(url, { headers, maxRedirects: 0 });
  const h = res.headers();
  return {
    status: res.status(),
    body: await res.text(),
    headers: Object.fromEntries(
      ["content-type", "cache-control", "x-content-type-options", "referrer-policy", "x-robots-tag", "content-security-policy", "x-frame-options", "set-cookie"].map((k) => [k, h[k] ?? null]),
    ),
  };
}

test.describe.configure({ mode: "serial" });
// One flag-on server and one seeded version: run once (desktop project), not once per device project.
test.skip(({ isMobile }) => isMobile, "the flag-on server is started once, by the desktop project");

test.beforeAll(async () => {
  db = new pg.Pool({ connectionString: process.env.SUPABASE_DB_URL, max: 2 });
  svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  // skipped ONLY when the storage service is not running (CI: `-x storage-api`); any other answer throws here
  const storage = await storageStatus();
  storageUp = storage.available;
  storageSkipReason = storage.available ? "" : `${storage.reason} — covered without Storage by tests/unit/demo-frame (headers) and locally with Storage`;
  await ensureUsers(USERS_KEY);
  seeded = await seedDemoVersion(db, svc, { html: HTML, css: CSS });
  server = spawn("npm", ["run", "start", "--", "--port", String(ON_PORT)], {
    env: { ...process.env, SALES_DEMO_VERSIONS_ENABLED: "true", SALES_DEMO_VIEW_SIGNING_KEY: KEY.toString("base64url") },
    stdio: "ignore",
    detached: true,
  });
  await waitForServer(ON, 120_000);
});

test.afterAll(async () => {
  if (server?.pid) {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  if (seeded && storageUp) await svc.storage.from(DEMO_VERSIONS_BUCKET).remove(Object.keys(seeded.objects).map((n) => `${seeded.prefix}${n}`));
  await removeUsers(USERS_KEY);
  await db?.end();
});

test("flag off (the suite's server): a valid admin token is the plain 404, identical to the flag-on refusals", async ({ request }) => {
  const tok = token();
  const off = await notFoundShape(request, `/demo-frame/a/${tok}/index.html`, { "Sec-Fetch-Dest": "iframe" });
  expect(off.status).toBe(404);
  expect(off.body).toBe("Not Found");
  expect(off.headers["cache-control"]).toBe("private, no-store");
  expect(off.headers["set-cookie"]).toBeNull();
  expect(off.headers["x-frame-options"]).toBeNull();
  // flag on, refused for different reasons: the same response
  const refusals = [
    `${ON}/demo-frame/a/${token("a", { ...seeded, versionId: "00000000-0000-4000-8000-000000000000" })}/index.html`,
    `${ON}/demo-frame/a/${tok}/page/index.html`,
    `${ON}/demo-frame/a/${tok}/index.html?x=1`,
    `${ON}/demo-frame/a/not-a-token/index.html`,
    `${ON}/demo-frame/p/${token("p")}/index.html`,
    `${ON}/demo-frame/a/${tok}`,
    `${ON}/demo-frame`,
    `${ON}/demo-frame/x/y`,
  ];
  for (const url of refusals) expect(await notFoundShape(request, url, { "Sec-Fetch-Dest": "iframe" }), url).toEqual(off);
  for (const url of [`/demo-frame/p/${token("p")}/index.html`, "/demo-frame", `/demo-frame/a/${tok}`]) expect(await notFoundShape(request, url), url).toEqual(off);
});

test("share scope p without SALES_DEMO_SHARE_ENABLED (DEV-196g) is never served: p tokens, a tokens under /p, every file, preview flag on → 404", async ({ request }) => {
  for (const tok of [token("p"), token("a")]) {
    for (const [p, dest] of [["index.html", "iframe"], ["style.css", "style"], ["photos/hero-desktop.webp", "image"], ["renders/desktop_1440.webp", "image"]]) {
      const res = await request.get(`${ON}/demo-frame/p/${tok}/${p}`, { headers: { "Sec-Fetch-Dest": dest! } });
      expect(res.status(), p).toBe(404);
    }
  }
  // an a token is not a p token, and the reverse
  expect((await request.get(`${ON}/demo-frame/a/${token("p")}/index.html`, { headers: { "Sec-Fetch-Dest": "iframe" } })).status()).toBe(404);
});

test("opened directly (not in a frame) or fetched for the wrong purpose → 404", async ({ page, request }) => {
  const tok = token();
  expect((await page.goto(`${ON}/demo-frame/a/${tok}/index.html`))?.status()).toBe(404); // Sec-Fetch-Dest: document
  expect((await page.goto(`${ON}/demo-frame/a/${tok}/style.css`))?.status()).toBe(404);
  expect((await page.goto(`${ON}/demo-frame/a/${tok}/photos/hero-desktop.webp`))?.status()).toBe(404);
  expect((await request.get(`${ON}/demo-frame/a/${tok}/style.css`)).status()).toBe(404); // no Sec-Fetch-Dest
  expect((await request.post(`${ON}/demo-frame/a/${tok}/index.html`, { headers: { "Sec-Fetch-Dest": "iframe" } })).status()).toBe(404);
});

test("framed in an admin page: opaque origin, no script, no cookie, images shown, zero requests leave the app", async ({ page, context }) => {
  test.skip(!storageUp, storageSkipReason);
  const tok = token();
  const base = `${ON}/demo-frame/a/${tok}/`;
  // The admin session cookie the artifact must never reach (SameSite=Lax, readable by script, like @supabase/ssr's).
  await context.addCookies([{ name: SECRET_COOKIE, value: "secret-session-value", url: ON, sameSite: "Lax" }]);

  const requests: Request[] = [];
  context.on("request", (r) => requests.push(r));
  // Backstop: nothing may leave the flag-on server; anything else is recorded and aborted.
  const external: string[] = [];
  await context.route(/.*/, (route) => {
    const u = route.request().url();
    if (u.startsWith(`${ON}/`)) return route.continue();
    external.push(u);
    return route.abort();
  });
  // A stand-in for the admin outer page (DEV-196d-3 builds the real one), served from the app origin.
  await page.route(`${ON}/__outer`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html><body><iframe id="frame" title="demo" sandbox="" referrerpolicy="no-referrer" src="${base}index.html" style="width:1000px;height:800px"></iframe></body></html>`,
    }),
  );

  const htmlResponse = page.waitForResponse((r) => r.url() === `${base}index.html`);
  await page.goto(`${ON}/__outer`);
  const res = await htmlResponse;
  expect(res.status()).toBe(200);
  const headers = res.headers();
  expect(headers["content-security-policy"]).toMatch(/; sandbox$/);
  expect(headers["content-security-policy"]).toContain(`frame-ancestors ${ON}`);
  expect(headers["x-frame-options"]).toBeUndefined();
  expect(headers["set-cookie"]).toBeUndefined();

  const frame = page.frameLocator("#frame");
  await expect(frame.locator("#shop")).toHaveText("架空の焼き菓子店"); // the inline script never ran
  await expect.poll(() => frame.locator("#hero").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  expect(await frame.locator("#external").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(0);

  // opaque origin: the app page cannot reach into the frame, and the frame has no origin of its own
  expect(await page.evaluate(() => (document.getElementById("frame") as HTMLIFrameElement).contentDocument === null)).toBe(true);
  const f = page.frames().find((x) => x.url() === `${base}index.html`)!;
  expect(f).toBeTruthy();
  // window.origin is the document's security origin (location.origin only echoes the URL)
  expect(await f.evaluate(() => window.origin)).toBe("null");
  const cookie = await f.evaluate(() => {
    try {
      return document.cookie;
    } catch (e) {
      return `blocked:${(e as Error).name}`;
    }
  });
  expect(cookie).not.toContain("secret-session-value");

  // the form cannot be submitted out of the sandbox
  await frame.locator("#send").click();
  await page.waitForTimeout(500);

  const urls = requests.map((r) => r.url());
  expect(external, "requests that tried to leave the app").toEqual([]);
  // the artifact's external references are refused by the browser before any network access (CSP)
  const leaving = requests.filter((r) => !r.url().startsWith(`${ON}/`));
  for (const r of leaving) expect(r.failure()?.errorText, r.url()).toMatch(/^csp$|BLOCKED_BY_CSP/);
  expect(leaving.map((r) => r.url()).every((u) => u.startsWith("https://example.com/"))).toBe(true);
  expect(urls.some((u) => u.includes("/leak"))).toBe(false);
  expect(new Set(urls.filter((u) => u.startsWith(`${ON}/`)))).toEqual(new Set([`${ON}/__outer`, `${base}index.html`, `${base}style.css`, `${base}photos/hero-desktop.webp`]));
  // the framed document's own requests are cross-site (opaque origin): the session cookie is not sent with them
  for (const r of requests.filter((x) => x.url() === `${base}style.css` || x.url() === `${base}photos/hero-desktop.webp`)) {
    expect((await r.allHeaders())["cookie"] ?? "", r.url()).not.toContain(SECRET_COOKIE);
  }
});

test("revoking the version makes the frame 404 on the next load (no fallback to another demo)", async ({ request }) => {
  test.skip(!storageUp, storageSkipReason);
  const tok = token();
  expect((await request.get(`${ON}/demo-frame/a/${tok}/style.css`, { headers: { "Sec-Fetch-Dest": "style" } })).status()).toBe(200);
  // the admin's own action, through the database function (as the screen in DEV-196d-6 will call it)
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  const { admin: ADMIN } = usersFor(USERS_KEY);
  expect((await admin.auth.signInWithPassword(ADMIN)).error).toBeNull();
  const revoked = await admin.rpc("sales_revoke_demo_version", { p_version_id: seeded.versionId, p_code: "QUALITY_PROBLEM" });
  expect(revoked.error, revoked.error?.message).toBeNull();
  for (const [p, dest] of [["index.html", "iframe"], ["style.css", "style"], ["photos/hero-desktop.webp", "image"], ["renders/desktop_1440.webp", "image"]]) {
    const res = await request.get(`${ON}/demo-frame/a/${tok}/${p}`, { headers: { "Sec-Fetch-Dest": dest! } });
    expect(res.status(), p).toBe(404);
    expect(await res.text()).toBe("Not Found");
  }
});
