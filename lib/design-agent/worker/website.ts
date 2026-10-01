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
import { lookup } from "node:dns/promises";
import { chmod, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
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

// Social media and link-in-bio pages are not a shop's own site; local names never are.
const BLOCKED_HOSTS =
  /(^|\.)(instagram\.com|facebook\.com|fb\.com|threads\.net|x\.com|twitter\.com|tiktok\.com|line\.me|lin\.ee|linktr\.ee|lit\.link|linkin\.bio|bio\.link|potofu\.me|instabio\.cc|campsite\.bio|localhost|nip\.io|sslip\.io|xip\.io|localtest\.me|lvh\.me)$/i;
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

/** The site's own host, its www. twin and its subdomains (m., shop. ...), over http or https. */
export function websiteTarget(source: WebsiteSource): CaptureTarget {
  const bare = source.host.replace(/^www\./, "");
  return {
    url: source.url,
    allowNavigation(raw: string): boolean {
      try {
        const u = new URL(raw);
        const host = u.hostname.toLowerCase();
        return (u.protocol === "https:" || u.protocol === "http:") && u.username === "" && u.password === "" && u.port === "" && (host === bare || host.endsWith(`.${bare}`));
      } catch {
        return false;
      }
    },
  };
}

/** Loopback, private, link-local (cloud metadata), CGNAT, multicast, unspecified: never a shop's public site. */
export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = address.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
  return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith("ff");
}

/**
 * The host of every request must resolve to public addresses only (cached per
 * host for one capture). A page cannot make the browser read 127.0.0.1, the
 * LAN, the WSL host or a cloud metadata service. Non-http(s) URLs (data:,
 * blob:) carry no host and pass.
 */
export function publicHostCheck(): (url: string) => Promise<boolean> {
  const cache = new Map<string, Promise<boolean>>();
  return (raw: string) => {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return Promise.resolve(false);
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return Promise.resolve(true);
    const host = u.hostname.replace(/^\[|\]$/g, "");
    let hit = cache.get(host);
    if (!hit) {
      hit = isIP(host)
        ? Promise.resolve(!isPrivateAddress(host))
        : lookup(host, { all: true }).then(
            (list) => list.length > 0 && list.every((a) => !isPrivateAddress(a.address)),
            () => false,
          );
      cache.set(host, hit);
    }
    return hit;
  };
}

export interface WebsiteCaptureOptions {
  target: CaptureTarget;
  /** Production: publicHostCheck(). Tests only: a check that allows the local mock. */
  hostCheck?: (url: string) => Promise<boolean>;
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
    let path = u.pathname;
    try {
      path = decodeURIComponent(u.pathname);
    } catch {
      /* a malformed %-sequence: match on the raw path */
    }
    if (seen.has(key) || !(SECTION_HINT.test(path) || SECTION_HINT.test(link.text))) continue;
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
    const guard = await guardNavigation(context, options.target, state, { walls: false, hostCheck: options.hostCheck ?? publicHostCheck() });
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
      if (status === undefined || status >= 400) {
        await page.close().catch(() => undefined);
        continue;
      }
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
