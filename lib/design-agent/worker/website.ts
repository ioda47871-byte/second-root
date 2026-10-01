/**
 * The shop's verified official website as a visual source (DEV-028 Phase 3,
 * the first source in the order: website → signed-in Instagram (capture
 * helper) → public Instagram → PUBLIC_SOURCE_UNAVAILABLE).
 *
 * - A fresh, non-persistent browser context: never the Instagram profile,
 *   no cookies kept, the browser's temporary profile in the run's temp root.
 * - The same navigation guard as the Instagram capture (capture.ts): every
 *   document request, each redirect hop and every frame, is checked in
 *   Chromium before it is sent; the main page may only stay on the site's
 *   own host (and its www. twin). Popups never navigate.
 * - Only the home page and at most two more pages of the same site whose
 *   link looks like about / concept / menu / products / access, opened by
 *   their URL (nothing is clicked or typed, no form is sent).
 * - Each page: one screen (the top), media blurred in the page and then
 *   pixelated in the PNG, exactly like the Instagram screenshots. The PNGs
 *   are art-direction references for Codex only: no image, logo or text of
 *   the site is ever copied into the demo (the demo shows verified facts).
 */
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import {
  assertNavigation,
  CAPTURE_VIEWPORT,
  CONTEXT_OPTIONS,
  guardNavigation,
  MEDIA_CSS,
  MEDIA_FILTER,
  mediaRects,
  open,
  Retry,
  soften,
  Unavailable,
  type CaptureResult,
  type CaptureTarget,
  type NavigationState,
  type ScratchPage,
} from "./capture";

export type WebsiteSource = { url: string; host: string };

const BLOCKED_HOSTS = /(^|\.)(instagram\.com|facebook\.com|fb\.com|threads\.net|x\.com|twitter\.com|tiktok\.com|line\.me|localhost)$/i;
const SECTION_HINT = /about|concept|story|philosophy|menu|product|item|goods|shop|store|access|map|location|info|コンセプト|について|私たち|こだわり|メニュー|商品|お品書き|アクセス|店舗|お店/i;
export const MAX_WEBSITE_PAGES = 3;

/** An http(s) URL of a real host: no credentials, no port, no IP literal, no local or social-media host. */
export function parseWebsiteUrl(raw: unknown): WebsiteSource | null {
  if (typeof raw !== "string" || raw.length > 300 || /\s/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username !== "" || url.password !== "" || url.port !== "") return null;
  const host = url.hostname.toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || /^\d+(\.\d+)+$/.test(host) || BLOCKED_HOSTS.test(host)) return null;
  if (/\.(local|internal|lan|home|test|invalid|example|localhost)$/.test(host)) return null;
  url.hash = "";
  return { url: url.toString(), host };
}

/** The site's own host and its www. twin, over http or https. */
export function websiteTarget(source: WebsiteSource): CaptureTarget {
  const bare = source.host.replace(/^www\./, "");
  const hosts = new Set([bare, `www.${bare}`]);
  return {
    url: source.url,
    allowNavigation(raw: string): boolean {
      try {
        const u = new URL(raw);
        return (u.protocol === "https:" || u.protocol === "http:") && u.username === "" && u.password === "" && u.port === "" && hosts.has(u.hostname.toLowerCase());
      } catch {
        return false;
      }
    },
  };
}

export interface WebsiteCaptureOptions {
  target: CaptureTarget;
  outDir: string;
  launch: () => Promise<Browser>;
  settleMs?: number;
}

/** Up to two same-site links that look like about / menu / access pages (by href or link text). */
async function sectionLinks(page: Page, target: CaptureTarget): Promise<string[]> {
  const links = await page
    .evaluate(() => Array.from(document.querySelectorAll("a[href]")).map((a) => ({ href: (a as HTMLAnchorElement).href, text: (a.textContent ?? "").trim().slice(0, 60) })))
    .catch(() => [] as Array<{ href: string; text: string }>);
  const home = new URL(target.url);
  const seen = new Set([home.pathname.replace(/\/$/, "") || "/"]);
  const picked: string[] = [];
  for (const link of links) {
    if (picked.length >= MAX_WEBSITE_PAGES - 1) break;
    let u: URL;
    try {
      u = new URL(link.href);
    } catch {
      continue;
    }
    if (!target.allowNavigation(u.toString()) || /\.(pdf|jpe?g|png|gif|webp|zip|mp4)$/i.test(u.pathname)) continue;
    const key = u.pathname.replace(/\/$/, "") || "/";
    if (seen.has(key) || !(SECTION_HINT.test(decodeURIComponent(u.pathname)) || SECTION_HINT.test(link.text))) continue;
    seen.add(key);
    u.hash = "";
    picked.push(u.toString());
  }
  return picked;
}

async function shoot(page: Page, scratch: ScratchPage, file: string): Promise<number> {
  await page.addStyleTag({ content: MEDIA_CSS }).catch(() => undefined);
  const rects = (await mediaRects(page, MEDIA_FILTER)).filter((r) => r.y < CAPTURE_VIEWPORT.height && r.y + r.h > 0);
  const raw = await page.screenshot({ clip: { x: 0, y: 0, width: CAPTURE_VIEWPORT.width, height: CAPTURE_VIEWPORT.height }, animations: "disabled" });
  await writeFile(file, await soften(scratch, raw, rects), { mode: 0o600 });
  await chmod(file, 0o600);
  return rects.length;
}

export async function captureWebsite(options: WebsiteCaptureOptions): Promise<CaptureResult> {
  const settleMs = options.settleMs ?? 4_000;
  let browser: Browser | undefined;
  const state: NavigationState = { offSite: false };
  try {
    browser = await options.launch();
    const b = browser;
    const context: BrowserContext = await browser.newContext(CONTEXT_OPTIONS);
    const scratch: ScratchPage = async () => {
      const own = await b.newContext({ javaScriptEnabled: true, serviceWorkers: "block" });
      return { page: await own.newPage(), close: () => own.close() };
    };
    const guard = await guardNavigation(context, options.target, state);
    const home = await open(guard, options.target, state);
    await home.waitForTimeout(settleMs);
    assertNavigation(state);
    const files: string[] = [];
    let softened = 0;
    const first = join(options.outDir, "site-1.png");
    softened += await shoot(home, scratch, first);
    files.push(first);
    for (const url of await sectionLinks(home, options.target)) {
      const page = await guard.newPage();
      page.on("dialog", (dialog) => void dialog.dismiss().catch(() => undefined));
      const status = await page
        .goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 })
        .then((r) => r?.status())
        .catch(() => undefined);
      if (state.offSite) break; // the site tried to leave: what we have is enough, the rest is not opened
      if (status === undefined || status >= 400) continue;
      await page.waitForTimeout(Math.min(settleMs, 3_000));
      if (state.offSite) break;
      const file = join(options.outDir, `site-${files.length + 1}.png`);
      softened += await shoot(page, scratch, file);
      files.push(file);
      await page.close().catch(() => undefined);
    }
    return { status: "captured", files, posts: 0, softened };
  } catch (error) {
    if (state.offSite) return { status: "PUBLIC_SOURCE_UNAVAILABLE", reason: "OFF_SITE_REDIRECT" };
    if (error instanceof Unavailable) return { status: "PUBLIC_SOURCE_UNAVAILABLE", reason: error.reason, ...(error.detail ? { detail: error.detail } : {}) };
    return { status: "retry", reason: error instanceof Retry ? error.reason : "CAPTURE_ERROR" };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
