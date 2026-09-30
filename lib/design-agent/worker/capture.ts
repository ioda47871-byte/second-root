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
 * - Privacy of the media on the page, in two layers:
 *   1. before any screenshot every image, video and background image is
 *      blurred with CSS (CSP bypassed so the style always applies);
 *   2. after the screenshot, every media rectangle found on the page
 *      (including inside shadow roots) is pixelated and blurred in the PNG
 *      itself, so privacy does not depend on the page's DOM or CSS.
 *   Colour, density and composition stay readable for art direction; people
 *   and small details do not. Header text (the public bio, the shop name) is
 *   kept. The screenshots are reference material for Codex only and never
 *   become a demo asset.
 * - Only definite answers become PUBLIC_SOURCE_UNAVAILABLE. A network error,
 *   a 5xx or an unexpected browser error is `retry` (the job is tried again).
 */
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Browser, BrowserContext, Page, Route } from "playwright";
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

/** Definite answers: the page cannot be read without logging in (or at all). */
export const UNAVAILABLE_REASONS = [
  "RATE_LIMITED",
  "CAPTCHA",
  "OFF_SITE_REDIRECT",
  "TOO_MANY_REDIRECTS",
  "LOGIN_WALL",
  "CHALLENGE",
  "PRIVATE_OR_MISSING",
  "EMPTY_PAGE",
] as const;
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];
/** Transient: says nothing about the profile. */
export type RetryReason = "LOAD_FAILED" | "HTTP_ERROR" | "CAPTURE_ERROR";

export type CaptureResult =
  | { status: "captured"; files: string[]; posts: number; softened: number }
  | { status: "PUBLIC_SOURCE_UNAVAILABLE"; reason: UnavailableReason }
  | { status: "retry"; reason: RetryReason };

export const CAPTURE_VIEWPORT = { width: 1280, height: 1000 };
/** Softens people and small detail; keeps colour and layout. */
export const MEDIA_FILTER = "blur(6px) saturate(0.9)";
const MEDIA_CSS = `img, video, picture, canvas, svg image, [style*="background-image"] { filter: ${MEDIA_FILTER} !important; }`;
/** Media rectangles are shrunk by this factor, then scaled back with a blur. */
export const PIXELATE_FACTOR = 10;
const POSTS = 'a[href*="/p/"], a[href*="/reel/"]';
const LOGIN_PATH = /^\/(accounts\/(login|signup|emailsignup)|challenge|checkpoint|suspended)/;
const MAX_HOPS = 4;

class Unavailable extends Error {
  constructor(readonly reason: UnavailableReason) {
    super(reason);
  }
}

class Retry extends Error {
  constructor(readonly reason: RetryReason) {
    super(reason);
  }
}

type Rect = { x: number; y: number; w: number; h: number };

/** Every media element's page rectangle, shadow roots included; also blurs them in place. */
async function mediaRects(page: Page, filter: string): Promise<Rect[]> {
  // No named functions inside page callbacks: tsx (keepNames) would wrap them
  // in a __name() helper that does not exist in the page.
  return page.evaluate((f) => {
    const out: Array<{ x: number; y: number; w: number; h: number }> = [];
    const MEDIA = new Set(["img", "video", "canvas", "picture", "image", "iframe", "object", "embed"]);
    const roots: Array<Document | ShadowRoot> = [document];
    while (roots.length > 0) {
      const root = roots.pop()!;
      for (const el of Array.from(root.querySelectorAll("*"))) {
        const style = getComputedStyle(el);
        const tag = el.tagName.toLowerCase();
        if (MEDIA.has(tag) || (style.backgroundImage !== "none" && style.backgroundImage.includes("url("))) {
          (el as HTMLElement).style?.setProperty("filter", f, "important");
          const r = el.getBoundingClientRect();
          if (r.width >= 8 && r.height >= 8) out.push({ x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height });
        }
        if (el.shadowRoot) roots.push(el.shadowRoot);
      }
    }
    return out;
  }, filter);
}

/** A blank page to process images in, and how to close it. */
export type ScratchPage = () => Promise<{ page: Page; close: () => Promise<void> }>;

/** Pixelates and blurs the given rectangles of a PNG, on a blank page. */
async function soften(scratch: ScratchPage, png: Buffer, rects: Rect[]): Promise<Buffer> {
  const { page, close } = await scratch();
  try {
    const out = await page.evaluate(
      async ({ src, rects, factor }) => {
        const img = new Image();
        img.src = src;
        await img.decode();
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(img, 0, 0);
        for (const r of rects) {
          const x = Math.max(0, Math.floor(r.x));
          const y = Math.max(0, Math.floor(r.y));
          const w = Math.min(canvas.width - x, Math.ceil(r.w + (r.x - x)));
          const h = Math.min(canvas.height - y, Math.ceil(r.h + (r.y - y)));
          if (w <= 0 || h <= 0) continue;
          const small = document.createElement("canvas");
          small.width = Math.max(1, Math.round(w / factor));
          small.height = Math.max(1, Math.round(h / factor));
          small.getContext("2d")!.drawImage(canvas, x, y, w, h, 0, 0, small.width, small.height);
          ctx.save();
          ctx.beginPath();
          ctx.rect(x, y, w, h);
          ctx.clip();
          ctx.filter = "blur(4px)";
          ctx.drawImage(small, 0, 0, small.width, small.height, x, y, w, h);
          ctx.restore();
        }
        return canvas.toDataURL("image/png");
      },
      { src: `data:image/png;base64,${png.toString("base64")}`, rects, factor: PIXELATE_FACTOR },
    );
    return Buffer.from(out.slice(out.indexOf(",") + 1), "base64");
  } finally {
    await close().catch(() => undefined);
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
  if (await page.locator('iframe[src*="captcha"], iframe[title*="captcha" i], #captcha, [id*="recaptcha"], [id*="hcaptcha"]').count().catch(() => 0)) throw new Unavailable("CAPTCHA");
  const dialog = await visibleText(page, '[role="dialog"]', 600);
  if (/captcha|robot|ロボット/i.test(dialog)) throw new Unavailable("CAPTCHA");
  if (/ログイン|Log in|Sign up|登録する/i.test(dialog)) throw new Unavailable("LOGIN_WALL");
  const body = await visibleText(page, "body", 4_000);
  if (/Please wait a few minutes|しばらくしてから|Rate limit|too many requests/i.test(body)) throw new Unavailable("RATE_LIMITED");
  if (/This account is private|このアカウントは非公開です|Sorry, this page isn't available|このページはご利用いただけません/i.test(body)) {
    throw new Unavailable("PRIVATE_OR_MISSING");
  }
}

async function guardNavigation(context: BrowserContext, target: CaptureTarget, state: { offSite: boolean; redirect?: string }): Promise<void> {
  await context.route("**/*", (route) =>
    handle(route).catch(() => route.abort("failed").catch(() => undefined)),
  );
  async function handle(route: Route): Promise<void> {
    const request = route.request();
    if (!request.isNavigationRequest()) return route.continue().catch(() => undefined);
    // Frames inside the page (Instagram embeds other hosts) and popups are
    // blocked quietly; only where the page itself goes decides the capture.
    let mainFrame: boolean;
    try {
      mainFrame = request.frame().parentFrame() === null;
    } catch {
      return route.abort("blockedbyclient").catch(() => undefined); // a popup (no frame yet)
    }
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
      // One more try: a kept-alive connection the server has just closed fails at once.
      await new Promise((r) => setTimeout(r, 500));
      try {
        response = await route.fetch({ maxRedirects: 0, timeout: 30_000 });
      } catch {
        return route.abort("failed");
      }
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
  }
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
    if (failed || status === undefined) throw new Retry("LOAD_FAILED");
    if (status === 429) throw new Unavailable("RATE_LIMITED");
    if (status === 404 || status === 410) throw new Unavailable("PRIVATE_OR_MISSING");
    if (status >= 400) throw new Retry("HTTP_ERROR");
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

export const CONTEXT_OPTIONS = {
  viewport: CAPTURE_VIEWPORT,
  deviceScaleFactor: 1,
  locale: "ja-JP",
  serviceWorkers: "block",
  acceptDownloads: false,
  bypassCSP: true,
} as const;

/** Signs of a signed-in Instagram page (navigation links only; nothing is opened or read). */
const SIGNED_IN = 'a[href^="/direct/inbox"], a[href="/explore/"], svg[aria-label="Home"], svg[aria-label="ホーム"], svg[aria-label="New post"], svg[aria-label="新規投稿"]';

/**
 * Hides everything of the signed-in account on the page before screenshots:
 * the navigation (own avatar, notifications, messages), any fixed or sticky
 * element outside the main content (the messages dock, banners), dialogs,
 * "followed by" lines and suggested-account sections (other people's names
 * and faces). Only styles are changed; nothing is clicked.
 * No named functions inside: tsx (keepNames) would add a helper the page lacks.
 */
export async function hideAccountChrome(page: Page): Promise<number> {
  return page.evaluate(() => {
    const targets: Element[] = [];
    const main = document.querySelector("main");
    for (const el of Array.from(document.querySelectorAll('a[href*="mutualOnly"], a[href*="/followers/mutual"]'))) targets.push(el);
    for (const el of Array.from(document.querySelectorAll('nav, [role="navigation"], [role="dialog"], [role="banner"]:not(header), aside'))) {
      if (!main || !main.contains(el) || el.getAttribute("role") === "dialog") targets.push(el);
    }
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      const position = getComputedStyle(el).position;
      if ((position === "fixed" || position === "sticky") && !(main && main.contains(el))) targets.push(el);
    }
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      if (el.children.length > 0) continue;
      const text = el.textContent ?? "";
      if (/Followed by|がフォローしています|フォロワー:/.test(text)) {
        // The line itself, and its parent when that holds little else (the
        // names are often sibling links); never the header or main.
        targets.push(el);
        const parent = el.parentElement;
        if (parent && !["HEADER", "MAIN", "SECTION", "BODY"].includes(parent.tagName) && (parent.textContent ?? "").length <= text.length + 120) targets.push(parent);
      } else if (/Suggested for you|おすすめ|Similar accounts|似ているアカウント/.test(text)) {
        let box: Element = el;
        for (let i = 0; i < 6 && box.parentElement && box.parentElement.tagName !== "MAIN" && box.parentElement.tagName !== "HEADER"; i += 1) box = box.parentElement;
        targets.push(box);
      }
    }
    let hidden = 0;
    for (const el of targets) {
      if (!(el instanceof HTMLElement) || el.tagName === "MAIN" || el.tagName === "BODY" || el.tagName === "HTML") continue;
      el.style.setProperty("visibility", "hidden", "important");
      hidden += 1;
    }
    return hidden;
  });
}

export interface ContextCaptureOptions {
  target: CaptureTarget;
  outDir: string;
  settleMs?: number;
  /** "signed-in": require a signed-in page (else LOGIN_WALL) and hide the account's own parts. */
  session: "signed-out" | "signed-in";
  scratch: ScratchPage;
}

/**
 * The capture itself on a prepared context: guarded navigation, wall checks,
 * blur, screenshots of the main content, PNG-level pixelation. Shared by the
 * signed-out worker capture and the signed-in dedicated-profile capture.
 */
export async function captureInContext(context: BrowserContext, options: ContextCaptureOptions): Promise<CaptureResult> {
  const settleMs = options.settleMs ?? 5_000;
  const files: string[] = [];
  try {
    const state: { offSite: boolean; redirect?: string } = { offSite: false };
    await guardNavigation(context, options.target, state);
    const page = await open(context, options.target, state);
    await page.waitForTimeout(settleMs);
    if (state.offSite) throw new Unavailable("OFF_SITE_REDIRECT");
    await assertPublicPage(page, options.target);
    if (options.session === "signed-in") {
      if ((await page.locator(SIGNED_IN).count().catch(() => 0)) === 0) throw new Unavailable("LOGIN_WALL");
      await hideAccountChrome(page);
    }
    await page.addStyleTag({ content: MEDIA_CSS });

    const header = (await page.locator("header").count()) > 0 ? await page.locator("header").first().boundingBox({ timeout: 2_000 }).catch(() => null) : null;
    const posts = page.locator(POSTS);
    const postCount = await posts.count();
    if ((!header || header.height < 60) && postCount === 0) throw new Unavailable("EMPTY_PAGE");
    // Screenshots cover the main content only (never the side navigation).
    const main = options.session === "signed-in" ? await page.locator("main").first().boundingBox({ timeout: 2_000 }).catch(() => null) : null;
    const clipX = main ? Math.max(0, Math.floor(main.x)) : 0;
    const clipW = main ? Math.min(CAPTURE_VIEWPORT.width - clipX, Math.ceil(main.width)) : CAPTURE_VIEWPORT.width;

    let softened = 0;
    const shot = async (name: string, y: number, height: number) => {
      const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
      const top = Math.max(0, Math.min(y, pageHeight - 1));
      const h = Math.min(height, pageHeight - top);
      if (h < 60 || clipW < 200) return;
      const rects = (await mediaRects(page, MEDIA_FILTER))
        .map((r) => ({ ...r, x: r.x - clipX, y: r.y - top }))
        .filter((r) => r.y + r.h > 0 && r.y < h && r.x + r.w > 0 && r.x < clipW);
      const raw = await page.screenshot({ clip: { x: clipX, y: top, width: clipW, height: h }, fullPage: true, animations: "disabled" });
      const file = join(options.outDir, name);
      await writeFile(file, await soften(options.scratch, raw, rects), { mode: 0o600 });
      await chmod(file, 0o600);
      softened += rects.length;
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
        if (options.session === "signed-in") await hideAccountChrome(page).catch(() => 0);
        await page.addStyleTag({ content: MEDIA_CSS }).catch(() => undefined);
        // The first two images are enough; a failure here does not lose them.
        await shot("grid-lower.png", first.y - 10 + 900, 900).catch(() => undefined);
      }
    }
    if (files.length === 0) throw new Unavailable("EMPTY_PAGE");
    return { status: "captured", files, posts: postCount, softened };
  } catch (error) {
    if (error instanceof Unavailable) return { status: "PUBLIC_SOURCE_UNAVAILABLE", reason: error.reason };
    return { status: "retry", reason: error instanceof Retry ? error.reason : "CAPTURE_ERROR" };
  }
}

/**
 * profile.png (header), grid-top.png (first rows) and, when the grid goes on
 * and no wall appears after one scroll, grid-lower.png. At least one image or
 * PUBLIC_SOURCE_UNAVAILABLE.
 */
export async function capturePublicProfile(options: CaptureOptions): Promise<CaptureResult> {
  let browser: Browser | undefined;
  try {
    browser = await options.launch();
    const b = browser;
    const context = await browser.newContext(CONTEXT_OPTIONS);
    return await captureInContext(context, {
      target: options.target,
      outDir: options.outDir,
      settleMs: options.settleMs,
      session: "signed-out",
      scratch: async () => {
        const scratch = await b.newContext({ javaScriptEnabled: true, serviceWorkers: "block" });
        return { page: await scratch.newPage(), close: () => scratch.close() };
      },
    });
  } catch {
    return { status: "retry", reason: "CAPTURE_ERROR" };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
