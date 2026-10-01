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
import { createSocket } from "node:dgram";
import { chmod, writeFile } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
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
import { publicEgress, startEgressProxy, WEBSITE_BROWSER_ARGS, type EgressPolicy, type EgressProxy } from "./egress-proxy";

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

/** Hosting platforms whose subdomains belong to other shops: there only the site's own host (and www.) is allowed. */
const SHARED_PLATFORMS =
  /(^|\.)(wixsite\.com|wix\.com|jimdofree\.com|jimdo\.com|jimdosite\.com|base\.shop|thebase\.in|stores\.jp|square\.site|studio\.site|peraichi\.com|wordpress\.com|blogspot\.com|ameblo\.jp|fc2\.com|github\.io|netlify\.app|vercel\.app|pages\.dev|webnode\.jp|goope\.jp|crayonsite\.com|weebly\.com|squarespace\.com|shopify\.com|myshopify\.com|hotpepper\.jp|tabelog\.com|note\.com|canva\.site)$/i;

/** The site's own host, its www. twin and (not on a shared platform) its subdomains (m., shop. ...), over http or https. */
export function websiteTarget(source: WebsiteSource): CaptureTarget {
  const bare = source.host.replace(/^www\./, "");
  const subdomains = !SHARED_PLATFORMS.test(bare);
  return {
    url: source.url,
    allowNavigation(raw: string): boolean {
      try {
        const u = new URL(raw);
        const host = u.hostname.toLowerCase();
        return (u.protocol === "https:" || u.protocol === "http:") && u.username === "" && u.password === "" && u.port === "" && (host === bare || host === `www.${bare}` || (subdomains && host.endsWith(`.${bare}`)));
      } catch {
        return false;
      }
    },
  };
}

/** Loopback, private, link-local (cloud metadata), CGNAT, multicast, unspecified, and their IPv6 / mapped / NAT64 forms. */
// Two lists: Node matches an IPv4 address against IPv6 rules too (::ffff:0:0/96 would cover every IPv4 address).
const PRIVATE_V4 = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3],
] as const) PRIVATE_V4.addSubnet(net, prefix, "ipv4");
const PRIVATE_V6 = new BlockList();
for (const [net, prefix] of [
  ["::", 96], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) PRIVATE_V6.addSubnet(net, prefix, "ipv6");

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return PRIVATE_V4.check(address, "ipv4");
  if (family === 6) return PRIVATE_V6.check(address, "ipv6");
  return true; // not an address at all: never treated as public
}

/** Production egress: ports 80 / 443 of names whose every address is public (egress-proxy.ts). */
export const publicWebsiteEgress = (): EgressPolicy => publicEgress(isPrivateAddress);

/**
 * The navigation guard's view of the same policy: a document request whose
 * host the proxy would refuse is stopped before it is sent (and counted as
 * leaving the site). Non-http(s) URLs (data:, blob:) carry no host and pass.
 */
export function egressHostCheck(egress: EgressPolicy): (url: string) => Promise<boolean> {
  return async (raw: string) => {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return false;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return true;
    const port = u.port === "" ? (u.protocol === "https:" ? 443 : 80) : Number(u.port);
    const addresses = await egress(u.hostname, port).catch(() => null);
    return addresses !== null && addresses.length > 0;
  };
}

/** The production host check (public addresses, ports 80 / 443). */
export const publicHostCheck = () => egressHostCheck(publicWebsiteEgress());

/**
 * WebRTC cannot use the proxy: the browser must have it limited to proxied
 * traffic (WEBSITE_BROWSER_ARGS), and not every Chromium build honours that
 * flag (Playwright's headless shell does not). Before any shop page is
 * opened, a page of our own tries STUN to a UDP socket of ours on 127.0.0.1:
 * one packet and the capture does not happen.
 */
async function webrtcSealed(browser: Browser, proxy: { server: string; bypass: string }): Promise<boolean> {
  const udp = createSocket("udp4");
  let packets = 0;
  udp.on("message", () => {
    packets += 1;
  });
  const context = await browser.newContext({ proxy, serviceWorkers: "block" });
  try {
    await new Promise<void>((resolve, reject) => {
      udp.once("error", reject);
      udp.bind(0, "127.0.0.1", () => resolve());
    });
    const page = await context.newPage();
    await page.setContent("<p>check</p>");
    await page.evaluate(async (port) => {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: `stun:127.0.0.1:${port}` }] });
      pc.createDataChannel("x");
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise((r) => setTimeout(r, 1500));
      pc.close();
    }, udp.address().port);
    return packets === 0;
  } catch {
    return false;
  } finally {
    await context.close().catch(() => undefined);
    udp.close();
  }
}

export interface WebsiteCaptureOptions {
  target: CaptureTarget;
  /** Production: publicWebsiteEgress(). Tests only: a policy that allows the local mock. */
  egress?: EgressPolicy;
  outDir: string;
  /**
   * Must start Chromium with WEBSITE_BROWSER_ARGS (no WebRTC UDP, no QUIC: they cannot use the proxy),
   * from a build that honours them (the full Chromium, channel "chromium"; checked before every capture).
   */
  launch: (args: readonly string[]) => Promise<Browser>;
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
  let egressProxy: EgressProxy | undefined;
  const state: NavigationState = { offSite: false };
  try {
    const egress = options.egress ?? publicWebsiteEgress();
    // Every connection of the shop's page, its frames and its workers goes through the proxy.
    egressProxy = await startEgressProxy(egress);
    const proxy = egressProxy.proxy;
    browser = await options.launch(WEBSITE_BROWSER_ARGS);
    if (!(await webrtcSealed(browser, proxy))) return { status: "retry", reason: "BROWSER_WEBRTC_OPEN" };
    const b = browser;
    const context: BrowserContext = await browser.newContext({ ...CONTEXT_OPTIONS, proxy });
    const scratch: ScratchPage = async () => {
      const own = await b.newContext({ javaScriptEnabled: true, serviceWorkers: "block", proxy });
      return { page: await own.newPage(), close: () => own.close() };
    };
    const guard = await guardNavigation(context, options.target, state, { walls: false, hostCheck: egressHostCheck(egress) });
    // WebSockets never pass through request routing: a shop page needs none for a screenshot (workers' ones meet the proxy).
    await context.routeWebSocket(/.*/, (ws) => ws.close());
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
    await egressProxy?.close().catch(() => undefined);
  }
}
