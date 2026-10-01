/**
 * Public Instagram profile capture for the design worker (DEV-028 worker).
 *
 * - One fresh, non-persistent browser context per capture. No login, no
 *   stored cookies, no user profile. The browser's temporary profile lives in
 *   the worker's temp root (TMPDIR), which is deleted after the job.
 * - Only the target page is opened. Every page navigation (including each
 *   redirect hop, checked in Chromium before it is sent) must pass `target.allowNavigation`; the
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
  | { status: "PUBLIC_SOURCE_UNAVAILABLE"; reason: UnavailableReason; detail?: UnavailableDetail }
  | { status: "retry"; reason: RetryReason };

export const CAPTURE_VIEWPORT = { width: 1280, height: 1000 };
/** Softens people and small detail; keeps colour and layout. */
export const MEDIA_FILTER = "blur(6px) saturate(0.9)";
export const MEDIA_CSS = `img, video, picture, canvas, svg image, [style*="background-image"] { filter: ${MEDIA_FILTER} !important; }`;
/** Media rectangles are shrunk by this factor, then scaled back with a blur. */
export const PIXELATE_FACTOR = 10;
export const POSTS = 'a[href*="/p/"], a[href*="/reel/"]';
export const LOGIN_PATH = /^\/(accounts\/(login|signup|emailsignup)|challenge|checkpoint|suspended)/;
const MAX_HOPS = 4;

/** Which signal made PRIVATE_OR_MISSING (diagnosis only; the reason stays the same). */
export type UnavailableDetail = "HTTP_404" | "HTTP_410" | "BODY_PRIVATE" | "BODY_PAGE_UNAVAILABLE";

export class Unavailable extends Error {
  constructor(
    readonly reason: UnavailableReason,
    readonly detail?: UnavailableDetail,
  ) {
    super(reason);
  }
}

/** Page texts shared by the capture and the diagnosis (matched, never printed). */
export const PRIVATE_MARKER = /This account is private|このアカウントは非公開です/i;
export const PAGE_UNAVAILABLE_MARKER = /Sorry, this page isn't available|このページはご利用いただけません/i;
export const RATE_LIMIT_MARKER = /Please wait a few minutes|しばらくしてから|Rate limit|too many requests/i;
export const CAPTCHA_SELECTOR = 'iframe[src*="captcha"], iframe[title*="captcha" i], #captcha, [id*="recaptcha"], [id*="hcaptcha"]';
export const LOGIN_FORM_SELECTOR = 'input[name="password"], input[type="password"]';

export class Retry extends Error {
  constructor(readonly reason: RetryReason) {
    super(reason);
  }
}

type Rect = { x: number; y: number; w: number; h: number };

/** Every media element's page rectangle, shadow roots included; also blurs them in place. */
export async function mediaRects(page: Page, filter: string): Promise<Rect[]> {
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
export async function soften(scratch: ScratchPage, png: Buffer, rects: Rect[]): Promise<Buffer> {
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
  if (await page.locator(LOGIN_FORM_SELECTOR).first().isVisible().catch(() => false)) throw new Unavailable("LOGIN_WALL");
  if (await page.locator(CAPTCHA_SELECTOR).count().catch(() => 0)) throw new Unavailable("CAPTCHA");
  const dialog = await visibleText(page, '[role="dialog"]', 600);
  if (/captcha|robot|ロボット/i.test(dialog)) throw new Unavailable("CAPTCHA");
  if (/ログイン|Log in|Sign up|登録する/i.test(dialog)) throw new Unavailable("LOGIN_WALL");
  const body = await visibleText(page, "body", 4_000);
  if (RATE_LIMIT_MARKER.test(body)) throw new Unavailable("RATE_LIMITED");
  if (PRIVATE_MARKER.test(body)) throw new Unavailable("PRIVATE_OR_MISSING", "BODY_PRIVATE");
  if (PAGE_UNAVAILABLE_MARKER.test(body)) throw new Unavailable("PRIVATE_OR_MISSING", "BODY_PAGE_UNAVAILABLE");
}

/** What the navigation guard saw on the capture page's own navigations. */
export type NavigationState = {
  /** The page tried to go off the allowed site (the request was never sent). */
  offSite: boolean;
  /** The page was sent to a sign-in / challenge path (the request was never sent). */
  wall?: string;
  /** More than MAX_HOPS redirects in one navigation. */
  tooManyRedirects?: boolean;
};

export interface NavigationGuard {
  /** A new tab whose every document request (main frame and frames, each redirect hop) is checked before it goes out. */
  newPage(): Promise<Page>;
}

/**
 * Guards where the browser may go, without touching the requests it sends.
 *
 * - The capture's own tabs (guard.newPage()): every document request, each
 *   redirect hop included, is paused in Chromium (CDP Fetch, request stage)
 *   and checked before it is sent. Allowed: continued unchanged, so the
 *   browser's own headers (sec-fetch-*, accept-language, cookies, user agent)
 *   go out as in a normal visit. Off the site: failed, and in the main frame
 *   the capture ends. A sign-in / challenge path in the main frame is failed
 *   too (the wall is recorded, never loaded).
 *   Frames Chromium runs in another process (out-of-process iframes, e.g.
 *   sandboxed ones) are attached and held at start until the same check is on.
 *   Prerendering is switched off, and a main frame that still ends up off the
 *   site ends the capture.
 * - Any other tab (a popup the page opens): no navigation at all.
 * - Not navigations and not guarded here, as before: subresources (images,
 *   scripts, XHR) and the browser's own preloading requests (speculation-rules
 *   prefetch, link prefetch). Chromium sends those outside any page's request
 *   interception; they never become the page that is captured.
 * - Playwright's fetch-and-fulfill routing is not used: it re-sends the page
 *   request from outside the browser without the browser's own headers, and
 *   Instagram answers that with "this page isn't available". Playwright's
 *   continue alone cannot guard: route handlers never see redirect hops.
 */
export async function guardNavigation(context: BrowserContext, target: CaptureTarget, state: NavigationState): Promise<NavigationGuard> {
  const guarded = new WeakSet<Page>();
  await context.route("**/*", (route) => handle(route).catch(() => route.abort("failed").catch(() => undefined)));
  async function handle(route: Route): Promise<void> {
    const request = route.request();
    if (!request.isNavigationRequest()) return route.continue().catch(() => undefined);
    let page: Page;
    try {
      page = request.frame().page();
    } catch {
      return route.abort("blockedbyclient").catch(() => undefined); // a popup (no frame yet)
    }
    // A guarded tab's document requests are checked in Chromium (every hop); this is a second check of the first one.
    if (guarded.has(page) && target.allowNavigation(request.url())) return route.continue().catch(() => undefined);
    return route.abort("blockedbyclient").catch(() => undefined);
  }
  return {
    async newPage() {
      const page = await context.newPage();
      guarded.add(page);
      const cdp = await context.newCDPSession(page);
      const { frameTree } = (await cdp.send("Page.getFrameTree")) as { frameTree: { frame: { id: string } } };
      const mainFrame = frameTree.frame.id;
      const hops = new Map<string, number>();
      type Send = (method: string, params: Record<string, unknown>) => Promise<unknown>;
      type Paused = { requestId: string; frameId: string; networkId?: string; redirectedRequestId?: string; request: { url: string } };
      const DOCUMENTS = { patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }] };
      let nextId = 1;
      /** Replies of frame targets, by message id (ids are unique across all levels). */
      const replies = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();

      /** Decides one paused document request; only the page's own session can see its main frame. */
      const decide = async (send: Send, event: Paused, top: boolean): Promise<void> => {
        const main = top && event.frameId === mainFrame;
        const fail = () => send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" });
        const url = event.request.url;
        if (!target.allowNavigation(url)) {
          if (main) state.offSite = true;
          return void (await fail());
        }
        if (main) {
          const key = event.networkId ?? event.requestId;
          const hop = event.redirectedRequestId ? (hops.get(key) ?? 0) + 1 : 0;
          hops.set(key, hop);
          if (hop > MAX_HOPS) {
            state.tooManyRedirects = true;
            return void (await fail());
          }
          if (LOGIN_PATH.test(new URL(url).pathname)) {
            state.wall = url;
            return void (await fail());
          }
        }
        await send("Fetch.continueRequest", { requestId: event.requestId });
      };

      /**
       * One CDP session level: the page itself, or a frame Chromium runs in
       * another process (an out-of-process iframe, e.g. a sandboxed one) and
       * frames nested in it. Each such frame target is held at start
       * (waitForDebuggerOnStart) until the target has confirmed that its
       * document requests are paused here too; if it refuses, the frame stays
       * held, so nothing it would load goes out.
       */
      const level = (send: Send, top: boolean) => {
        const children = new Map<string, (method: string, params: Record<string, unknown>) => void>();
        const on = (method: string, params: Record<string, unknown>): void => {
          if (method === "Fetch.requestPaused") return void decide(send, params as unknown as Paused, top).catch(() => undefined);
          if (method === "Target.attachedToTarget") {
            const sessionId = String(params.sessionId);
            // Resolves when the target has answered (not merely when the message was handed over).
            const childSend: Send = (m, p) => {
              const id = nextId++;
              const answered = new Promise<void>((resolve, reject) => replies.set(id, { resolve, reject }));
              return send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id, method: m, params: p }) }).then(() => answered);
            };
            children.set(sessionId, level(childSend, false));
            const isFrame = (params.targetInfo as { type?: string } | undefined)?.type === "iframe";
            void (async () => {
              if (isFrame) {
                // A frame starts only once its document requests are guarded; if that fails it stays held.
                await childSend("Fetch.enable", DOCUMENTS);
                await childSend("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: false });
              }
              // Anything else held at start (a dedicated worker) loads no document: let it run.
              await childSend("Runtime.runIfWaitingForDebugger", {});
            })().catch(() => undefined);
            return;
          }
          if (method === "Target.receivedMessageFromTarget") {
            let message: { id?: number; method?: string; params?: Record<string, unknown>; error?: { message?: string } };
            try {
              message = JSON.parse(String(params.message)) as typeof message;
            } catch {
              return;
            }
            if (message.method) return void children.get(String(params.sessionId))?.(message.method, message.params ?? {});
            const reply = message.id !== undefined ? replies.get(message.id) : undefined;
            if (reply) {
              replies.delete(message.id!);
              if (message.error) reply.reject(new Error("frame target refused"));
              else reply.resolve();
            }
          }
        };
        return on;
      };
      const topLevel = level((m, p) => cdp.send(m as "Fetch.continueRequest", p as never), true);
      for (const method of ["Fetch.requestPaused", "Target.attachedToTarget", "Target.receivedMessageFromTarget"] as const) {
        cdp.on(method, (params) => topLevel(method, params as unknown as Record<string, unknown>));
      }
      await cdp.send("Fetch.enable", DOCUMENTS as never);
      await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: false });
      // A prerendered page would become the main page without a request to check; do not prerender.
      await cdp.send("Page.setPrerenderingAllowed" as never, { isAllowed: false } as never).catch(() => undefined);
      // Last line: whatever the way, a main frame that ends up off the site ends the capture.
      page.on("framenavigated", (frame) => {
        const url = frame.url();
        if (frame !== page.mainFrame() || url.startsWith("about:") || url.startsWith("chrome-error:")) return;
        if (!target.allowNavigation(url)) {
          state.offSite = true;
          void page.close().catch(() => undefined);
        }
      });
      return page;
    },
  };
}

/** Ends the capture when the guard stopped the page's own navigation. */
export function assertNavigation(state: NavigationState): void {
  if (state.offSite) throw new Unavailable("OFF_SITE_REDIRECT");
  if (state.tooManyRedirects) throw new Unavailable("TOO_MANY_REDIRECTS");
  if (state.wall !== undefined) throw new Unavailable(/challenge|checkpoint|suspended/.test(state.wall) ? "CHALLENGE" : "LOGIN_WALL");
}

/** Opens the target in a guarded tab; the browser follows allowed redirects itself. */
export async function open(guard: NavigationGuard, target: CaptureTarget, state: NavigationState): Promise<Page> {
  const page = await guard.newPage();
  page.on("dialog", (dialog) => void dialog.dismiss().catch(() => undefined));
  let status: number | undefined;
  let failed = false;
  try {
    status = (await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 45_000 }))?.status();
  } catch {
    failed = true;
  }
  assertNavigation(state);
  if (failed || status === undefined) throw new Retry("LOAD_FAILED");
  if (status === 429) throw new Unavailable("RATE_LIMITED");
  if (status === 404 || status === 410) throw new Unavailable("PRIVATE_OR_MISSING", status === 404 ? "HTTP_404" : "HTTP_410");
  if (status >= 400) throw new Retry("HTTP_ERROR");
  return page;
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
/** Only a signed-in account has these: its inbox link and the create / notifications buttons. */
export const SIGNED_IN = 'a[href^="/direct/inbox"], svg[aria-label="New post"], svg[aria-label="新規投稿"], svg[aria-label="Notifications"], svg[aria-label="お知らせ"]';

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
      if ((position === "fixed" || position === "sticky") && !(main && (main.contains(el) || el.contains(main)))) targets.push(el);
    }
    // Never hide anything that holds the profile header or a post.
    const header = main ? main.querySelector("header") : document.querySelector("header");
    const firstPost = document.querySelector('a[href*="/p/"], a[href*="/reel/"]');
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      if (el.children.length > 0) continue;
      const text = (el.textContent ?? "").trim();
      if (/Followed by|がフォローしています|フォロワー:/.test(text)) {
        // The line itself, and its parent when that holds little else (the
        // names are often sibling links); never the header or main.
        targets.push(el);
        const parent = el.parentElement;
        if (parent && !["HEADER", "MAIN", "SECTION", "BODY"].includes(parent.tagName) && !(header && parent.contains(header)) && (parent.textContent ?? "").length <= text.length + 120) targets.push(parent);
      } else if (/^(Suggested for you|Similar accounts|おすすめ(のアカウント)?|似ているアカウント)$/.test(text)) {
        // Only the exact section titles (a bio or caption that merely mentions
        // "おすすめ" never matches), never inside the profile header. Climb to
        // the section, but never to a box that holds the header or a post.
        if (header && header.contains(el)) continue;
        let box: Element = el;
        for (let i = 0; i < 6; i += 1) {
          const up: Element | null = box.parentElement;
          if (!up || up.tagName === "MAIN" || up.tagName === "HEADER" || up.tagName === "BODY" || (header && up.contains(header)) || (firstPost && up.contains(firstPost))) break;
          box = up;
        }
        if (!(header && box.contains(header)) && !(firstPost && box.contains(firstPost))) targets.push(box);
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
  const state: NavigationState = { offSite: false };
  try {
    const guard = await guardNavigation(context, options.target, state);
    const page = await open(guard, options.target, state);
    await page.waitForTimeout(settleMs);
    assertNavigation(state);
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
    // Signed in, the screenshots must be cropped to the main content; without it, stop.
    if (options.session === "signed-in" && (!main || main.width < 200)) throw new Unavailable("EMPTY_PAGE");
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
      assertNavigation(state);
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
    // The page tried to leave the site (stopped before any request went out). That decides, whatever
    // the page shows afterwards: the blocked navigation can leave an error page behind that looks
    // like a signed-out or empty page.
    if (state.offSite) return { status: "PUBLIC_SOURCE_UNAVAILABLE", reason: "OFF_SITE_REDIRECT" };
    if (error instanceof Unavailable) return { status: "PUBLIC_SOURCE_UNAVAILABLE", reason: error.reason, ...(error.detail ? { detail: error.detail } : {}) };
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
