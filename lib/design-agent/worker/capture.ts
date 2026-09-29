/**
 * Public Instagram profile capture for the design worker (DEV-028 worker).
 *
 * - One fresh, non-persistent browser context per capture. No login, no
 *   stored cookies, no user profile. The browser's temporary profile lives in
 *   the worker's temp root (TMPDIR), which is deleted after the job.
 * - Only the target page is opened. Every page navigation (including each
 *   redirect hop, followed by hand) must pass `target.allowNavigation`; the
 *   production target allows only instagram.com (source-url.ts). Leaving it
 *   ends the capture as PUBLIC_SOURCE_UNAVAILABLE.
 * - Nothing is clicked, typed or dismissed. One short scroll at most.
 * - A login wall, challenge, rate limit, private or missing account, or an
 *   empty page ends the capture as PUBLIC_SOURCE_UNAVAILABLE. It is never
 *   worked around.
 * - Before any screenshot every image and video on the page is blurred and
 *   desaturated slightly: colour, density and composition stay readable for
 *   art direction, people and small details do not. The screenshots are
 *   reference material for Codex only and never become a demo asset.
 */
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import { isInstagramUrl, type ProfileSource } from "./source-url";

export type CaptureTarget = {
  url: string;
  /** Whether the browser may navigate to this URL (every hop and the final page). */
  allowNavigation(url: string): boolean;
};

/** The only target the worker builds for a job. */
export function instagramTarget(source: ProfileSource): CaptureTarget {
  return { url: source.url, allowNavigation: isInstagramUrl };
}

export const UNAVAILABLE_REASONS = [
  "LOAD_FAILED",
  "HTTP_ERROR",
  "RATE_LIMITED",
  "OFF_SITE_REDIRECT",
  "TOO_MANY_REDIRECTS",
  "LOGIN_WALL",
  "CHALLENGE",
  "PRIVATE_OR_MISSING",
  "EMPTY_PAGE",
  "CAPTURE_ERROR",
] as const;
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];

export type CaptureResult =
  | { status: "captured"; files: string[]; posts: number }
  | { status: "PUBLIC_SOURCE_UNAVAILABLE"; reason: UnavailableReason };

export const CAPTURE_VIEWPORT = { width: 1280, height: 1000 };
/** Softens people and small detail; keeps colour and layout. */
export const MEDIA_FILTER = "blur(6px) saturate(0.9)";
const MEDIA_CSS = `img, video, picture, canvas, [style*="background-image"] { filter: ${MEDIA_FILTER} !important; }`;
const POSTS = 'a[href*="/p/"], a[href*="/reel/"]';
const LOGIN_PATH = /^\/(accounts\/(login|signup|emailsignup)|challenge|checkpoint|suspended)/;
const MAX_HOPS = 4;

class Unavailable extends Error {
  constructor(readonly reason: UnavailableReason) {
    super(reason);
  }
}

async function visibleText(page: Page, selector: string, max: number): Promise<string> {
  return (await page.locator(selector).first().innerText({ timeout: 2_000 }).catch(() => "")).slice(0, max);
}

/** Throws Unavailable when the page is a wall of some kind. */
async function assertPublicPage(page: Page, target: CaptureTarget): Promise<void> {
  const current = page.url();
  if (!target.allowNavigation(current)) throw new Unavailable("OFF_SITE_REDIRECT");
  if (LOGIN_PATH.test(new URL(current).pathname)) throw new Unavailable(/challenge|checkpoint|suspended/.test(current) ? "CHALLENGE" : "LOGIN_WALL");
  if (await page.locator('input[name="password"], input[type="password"]').first().isVisible().catch(() => false)) throw new Unavailable("LOGIN_WALL");
  if (await page.locator('iframe[src*="captcha"], iframe[title*="captcha" i], #captcha, [id*="recaptcha"]').count().catch(() => 0)) throw new Unavailable("CHALLENGE");
  const dialog = await visibleText(page, '[role="dialog"]', 600);
  if (/ログイン|Log in|Sign up|登録する|captcha|robot|ロボット/i.test(dialog)) throw new Unavailable("LOGIN_WALL");
  const body = await visibleText(page, "body", 4_000);
  if (/Please wait a few minutes|しばらくしてから|Rate limit|too many requests/i.test(body)) throw new Unavailable("RATE_LIMITED");
  if (/This account is private|このアカウントは非公開です|Sorry, this page isn't available|このページはご利用いただけません/i.test(body)) {
    throw new Unavailable("PRIVATE_OR_MISSING");
  }
}

async function guardNavigation(context: BrowserContext, target: CaptureTarget, state: { offSite: boolean; redirect?: string }): Promise<void> {
  await context.route("**/*", async (route) => {
    const request = route.request();
    if (!request.isNavigationRequest()) return route.continue();
    // Frames inside the page (Instagram embeds other hosts) are blocked
    // quietly; only where the page itself goes decides the capture.
    const mainFrame = request.frame().parentFrame() === null;
    if (!target.allowNavigation(request.url())) {
      if (mainFrame) state.offSite = true;
      return route.abort("blockedbyclient");
    }
    // Redirects are not seen by route handlers once the browser follows them,
    // so each hop is fetched here without following and checked first.
    let response;
    try {
      response = await route.fetch({ maxRedirects: 0, timeout: 30_000 });
    } catch {
      return route.abort("failed");
    }
    const location = response.headers()["location"];
    if (response.status() >= 300 && response.status() < 400 && location) {
      let next: string;
      try {
        next = new URL(location, request.url()).toString();
      } catch {
        if (mainFrame) state.offSite = true;
        return route.abort("blockedbyclient");
      }
      if (!mainFrame) return route.abort("blockedbyclient");
      if (!target.allowNavigation(next)) state.offSite = true;
      else state.redirect = next;
      return route.abort("blockedbyclient");
    }
    return route.fulfill({ response });
  });
}

/** Opens the target, following allowed redirects by hand (a fresh tab per hop). */
async function open(context: BrowserContext, target: CaptureTarget, state: { offSite: boolean; redirect?: string }): Promise<Page> {
  let url = target.url;
  let page: Page | undefined;
  for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
    await page?.close().catch(() => undefined);
    page = await context.newPage();
    page.on("dialog", (dialog) => void dialog.dismiss().catch(() => undefined));
    state.redirect = undefined;
    let status: number | undefined;
    let failed = false;
    try {
      status = (await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }))?.status();
    } catch {
      failed = true;
    }
    if (state.offSite) throw new Unavailable("OFF_SITE_REDIRECT");
    if (state.redirect !== undefined) {
      if (LOGIN_PATH.test(new URL(state.redirect).pathname)) throw new Unavailable(/challenge|checkpoint|suspended/.test(state.redirect) ? "CHALLENGE" : "LOGIN_WALL");
      url = state.redirect;
      continue;
    }
    if (failed || status === undefined) throw new Unavailable("LOAD_FAILED");
    if (status === 429) throw new Unavailable("RATE_LIMITED");
    if (status >= 400) throw new Unavailable(status === 404 ? "PRIVATE_OR_MISSING" : "HTTP_ERROR");
    return page;
  }
  throw new Unavailable("TOO_MANY_REDIRECTS");
}

export interface CaptureOptions {
  target: CaptureTarget;
  /** Directory for the screenshots (0700, inside the worker's temp root). */
  outDir: string;
  launch: () => Promise<Browser>;
  /** Wait after load for client rendering. */
  settleMs?: number;
}

/**
 * profile.png (header), grid-top.png (first rows) and, when the grid goes on
 * and no wall appears after one scroll, grid-lower.png. At least one image or
 * PUBLIC_SOURCE_UNAVAILABLE.
 */
export async function capturePublicProfile(options: CaptureOptions): Promise<CaptureResult> {
  const settleMs = options.settleMs ?? 5_000;
  const files: string[] = [];
  let browser: Browser | undefined;
  try {
    browser = await options.launch();
    const context = await browser.newContext({ viewport: CAPTURE_VIEWPORT, deviceScaleFactor: 1, locale: "ja-JP", serviceWorkers: "block", acceptDownloads: false });
    const state: { offSite: boolean; redirect?: string } = { offSite: false };
    await guardNavigation(context, options.target, state);
    const page = await open(context, options.target, state);
    await page.waitForTimeout(settleMs);
    if (state.offSite) throw new Unavailable("OFF_SITE_REDIRECT");
    await assertPublicPage(page, options.target);
    await page.addStyleTag({ content: MEDIA_CSS });

    const header = (await page.locator("header").count()) > 0 ? await page.locator("header").first().boundingBox({ timeout: 2_000 }).catch(() => null) : null;
    const posts = page.locator(POSTS);
    const postCount = await posts.count();
    if ((!header || header.height < 60) && postCount === 0) throw new Unavailable("EMPTY_PAGE");

    const shot = async (name: string, y: number, height: number) => {
      const file = join(options.outDir, name);
      await page.screenshot({ path: file, clip: { x: 0, y: Math.max(0, y), width: CAPTURE_VIEWPORT.width, height }, fullPage: true, animations: "disabled" });
      await chmod(file, 0o600);
      files.push(file);
    };
    if (header && header.height >= 60) await shot("profile.png", header.y - 20, Math.min(900, header.height + 260));
    const first = postCount > 0 ? await posts.first().boundingBox() : null;
    if (first) await shot("grid-top.png", first.y - 10, 900);
    if (first && postCount > 9) {
      await page.mouse.wheel(0, 900);
      await page.waitForTimeout(Math.min(settleMs, 3_000));
      // A wall after scrolling ends the capture here; what we have is enough.
      const wall = await assertPublicPage(page, options.target).then(
        () => false,
        () => true,
      );
      if (state.offSite) throw new Unavailable("OFF_SITE_REDIRECT");
      if (!wall) {
        await page.addStyleTag({ content: MEDIA_CSS });
        await shot("grid-lower.png", first.y - 10 + 900, 900);
      }
    }
    if (files.length === 0) throw new Unavailable("EMPTY_PAGE");
    return { status: "captured", files, posts: postCount };
  } catch (error) {
    return { status: "PUBLIC_SOURCE_UNAVAILABLE", reason: error instanceof Unavailable ? error.reason : "CAPTURE_ERROR" };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
