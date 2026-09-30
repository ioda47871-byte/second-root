/**
 * Why does the signed-in capture see "unavailable" where a person sees the
 * profile? (DEV-028 PoC, diagnosis only; not used by capture or the worker.)
 *
 * Opens the one target page with the dedicated profile in up to three ways,
 * one browser at a time, and reports what the page shows over time:
 *
 *   A  headless, with the capture's navigation guard (as capture does)
 *   C  headless, WITHOUT route interception (diagnosis only: the browser
 *      fetches the page itself; an off-site main frame stops the run)
 *   B  headed, with the navigation guard (needs a display)
 *
 * After the target, the Instagram home is opened in a new tab to see whether
 * the session is still signed in. Nothing is clicked, typed or scrolled; no
 * screenshot is taken; no cookie or storage is read.
 *
 * Output is fixed codes only (see DIAGNOSE_CODES): never a username, bio,
 * caption, cookie, token, page text, URL or query.
 */
import { lstat } from "node:fs/promises";
import type { BrowserContext, Page } from "playwright";
import { childEnvironment } from "../worker/env";
import { acquireLock } from "../worker/state";
import {
  CAPTCHA_SELECTOR,
  CONTEXT_OPTIONS,
  guardNavigation,
  LOGIN_FORM_SELECTOR,
  LOGIN_PATH,
  PAGE_UNAVAILABLE_MARKER,
  POSTS,
  PRIVATE_MARKER,
  SIGNED_IN,
  type CaptureTarget,
} from "../worker/capture";
import { checkProfileLocation, checkProfileTree, PERSISTENT_ARGS, prepareProfileDir, type ProfileEnv } from "./profile";
import { displayEnvironment, INSTAGRAM_HOME, type LaunchPersistent } from "./session";

/** The only page facts the diagnosis prints. */
export const DIAGNOSE_CODES = [
  "SESSION_OK",
  "SESSION_MISSING",
  "HTTP_200",
  "HTTP_404",
  "HTTP_OTHER",
  "MAIN_PRESENT",
  "MAIN_MISSING",
  "HEADER_PRESENT",
  "HEADER_MISSING",
  "POSTS_PRESENT",
  "POSTS_MISSING",
  "BODY_PRIVATE_MARKER",
  "BODY_UNAVAILABLE_MARKER",
  "SIGNED_IN_NAV_PRESENT",
  "CHALLENGE_PRESENT",
  "CAPTCHA_PRESENT",
] as const;
export type DiagnoseCode = (typeof DIAGNOSE_CODES)[number];

export type DiagnoseMode = "A" | "B" | "C";
export const MODES: Record<DiagnoseMode, { label: string; headless: boolean; guard: boolean }> = {
  A: { label: "headless+guard", headless: true, guard: true },
  C: { label: "headless+no-interception", headless: true, guard: false },
  B: { label: "headed+guard", headless: false, guard: true },
};

/** When the target page is looked at, after it has loaded (hydration shows over time). */
export const SAMPLE_AT_MS = [1_000, 3_000, 5_000, 8_000, 15_000]; // 5 s: when capture judges the page

/** How long the home page is watched for the signed-in navigation. */
export const SESSION_WAIT_MS = 15_000;

export interface DiagnoseOptions {
  profileDir: string;
  stateDir: string;
  env: ProfileEnv;
  target: CaptureTarget;
  launchPersistent: LaunchPersistent;
  modes?: DiagnoseMode[];
  sampleAtMs?: number[];
  /** Pause between two runs, so the pages are not opened back to back. */
  pauseMs?: number;
  sessionWaitMs?: number;
  /** Tests only: the signed-in check page (production: INSTAGRAM_HOME). */
  homeUrl?: string;
  /** Whether a display exists for B (production: DISPLAY / WAYLAND_DISPLAY). */
  hasDisplay?: boolean;
  say: (line: string) => void;
}

/** FAILED: no run got as far as the page (every run was a browser error). */
export type DiagnoseOutcome = "DIAGNOSED" | "FAILED" | "SESSION_MISSING" | "BROWSER_BUSY";

const CHALLENGE_PATH = /^\/(challenge|checkpoint|suspended)/;

function path(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

/** What the page shows right now, as codes. Page text is matched here and never leaves this function. */
export async function pageCodes(page: Page): Promise<DiagnoseCode[]> {
  const out: DiagnoseCode[] = [];
  const count = (selector: string) => page.locator(selector).count().catch(() => 0);
  out.push((await count("main")) > 0 ? "MAIN_PRESENT" : "MAIN_MISSING");
  // As capture judges it: a header at least 60px high.
  const header = (await count("header")) > 0 ? await page.locator("header").first().boundingBox({ timeout: 1_000 }).catch(() => null) : null;
  out.push(header && header.height >= 60 ? "HEADER_PRESENT" : "HEADER_MISSING");
  out.push((await count(POSTS)) > 0 ? "POSTS_PRESENT" : "POSTS_MISSING");
  const body = (await page.locator("body").first().innerText({ timeout: 1_000 }).catch(() => "")).slice(0, 4_000);
  if (PRIVATE_MARKER.test(body)) out.push("BODY_PRIVATE_MARKER");
  if (PAGE_UNAVAILABLE_MARKER.test(body)) out.push("BODY_UNAVAILABLE_MARKER");
  if ((await count(SIGNED_IN)) > 0) out.push("SIGNED_IN_NAV_PRESENT");
  if (CHALLENGE_PATH.test(path(page.url()))) out.push("CHALLENGE_PRESENT");
  const dialog = (await page.locator('[role="dialog"]').first().innerText({ timeout: 500 }).catch(() => "")).slice(0, 600);
  if ((await count(CAPTCHA_SELECTOR)) > 0 || /captcha|robot|ロボット/i.test(dialog)) out.push("CAPTCHA_PRESENT");
  return out;
}

function httpCode(status: number | undefined): DiagnoseCode {
  return status === 200 ? "HTTP_200" : status === 404 ? "HTTP_404" : "HTTP_OTHER";
}

async function signedIn(page: Page): Promise<boolean> {
  if (LOGIN_PATH.test(path(page.url()))) return false;
  if (await page.locator(LOGIN_FORM_SELECTOR).first().isVisible().catch(() => false)) return false;
  return (await page.locator(SIGNED_IN).count().catch(() => 0)) > 0;
}

/** Same-site redirects followed by hand in the guarded runs, as capture does. */
const MAX_HOPS = 4;

/** One run: open the target, sample it, then check the session on the home page. */
async function runMode(context: BrowserContext, mode: DiagnoseMode, options: DiagnoseOptions): Promise<void> {
  const { target, say } = options;
  const guard = MODES[mode].guard;
  const state: { offSite: boolean; redirect?: string } = { offSite: false };
  if (guard) await guardNavigation(context, target, state);
  // Only pages this code opens are kept; any other (a popup, with or without an opener) is closed at once.
  let opening = 0;
  context.on("page", (p) => {
    if (opening > 0) {
      opening -= 1;
      return;
    }
    void p.close().catch(() => undefined);
  });
  const leave = (p: Page) => {
    state.offSite = true;
    void p.close().catch(() => undefined);
  };
  const newPage = async () => {
    opening += 1;
    const p = await context.newPage();
    p.on("dialog", (d) => void d.dismiss().catch(() => undefined));
    if (!guard) {
      // Without interception nothing can hold a request back. Stop the run at the first main-frame
      // request (redirect hops included) or page that is off the site.
      p.on("request", (request) => {
        try {
          if (request.isNavigationRequest() && request.frame() === p.mainFrame() && !target.allowNavigation(request.url())) leave(p);
        } catch {
          // a request without a frame yet (a popup's); popups are closed above
        }
      });
      p.on("framenavigated", (frame) => {
        const url = frame.url();
        // about:blank(#blocked) and a failed load's error page are not a place the page went.
        if (url.startsWith("about:") || url.startsWith("chrome-error:")) return;
        if (frame === p.mainFrame() && !target.allowNavigation(url)) leave(p);
      });
    }
    return p;
  };
  /** Loads a URL; with the guard, allowed redirects are followed hop by hop in a fresh tab (as capture's open()). */
  const load = async (first: string): Promise<{ page: Page; status?: number }> => {
    let url = first;
    let page: Page | undefined;
    for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
      await page?.close().catch(() => undefined);
      page = await newPage();
      state.redirect = undefined;
      let status: number | undefined;
      try {
        status = (await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }))?.status();
      } catch {
        status = undefined; // a failed load, or a redirect the guard stopped (followed below)
      }
      if (!guard || state.offSite || state.redirect === undefined) return { page, status };
      url = state.redirect;
    }
    return { page: page!, status: undefined };
  };
  const stopped = (p: Page) => state.offSite || p.isClosed();

  const { page, status } = await load(target.url);
  if (stopped(page)) {
    say(`${mode} STOPPED_OFF_SITE`);
    return;
  }
  say(`${mode} ${MODES[mode].label} ${httpCode(status)}`);
  const start = Date.now();
  for (const at of options.sampleAtMs ?? SAMPLE_AT_MS) {
    const wait = start + at - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const codes = stopped(page) ? [] : await pageCodes(page);
    // Codes read while the page was leaving the site are not printed.
    if (stopped(page)) {
      say(`${mode} STOPPED_OFF_SITE`);
      return;
    }
    say(`${mode} t=${Math.round(at / 1000)}s ${codes.join(" ")}`);
  }
  await page.close().catch(() => undefined);

  // The signed-in navigation is drawn by script: look for it for a while before calling the session missing.
  const { page: home } = await load(options.homeUrl ?? INSTAGRAM_HOME);
  const until = Date.now() + (options.sessionWaitMs ?? SESSION_WAIT_MS);
  let ok = false;
  while (!stopped(home)) {
    ok = await signedIn(home);
    if (ok || Date.now() >= until) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (stopped(home)) {
    say(`${mode} STOPPED_OFF_SITE`);
    return;
  }
  say(`${mode} ${ok ? "SESSION_OK" : "SESSION_MISSING"}`);
  await home.close().catch(() => undefined);
}

export async function runDiagnose(options: DiagnoseOptions): Promise<DiagnoseOutcome> {
  await checkProfileLocation(options.profileDir, options.env);
  // No profile yet: nobody has signed in. Do not create one here.
  if (!(await lstat(options.profileDir).catch(() => null))) {
    options.say("SESSION_MISSING");
    return "SESSION_MISSING";
  }
  await prepareProfileDir(options.profileDir, options.env);
  const lock = await acquireLock(options.stateDir, new Date(), "browser.lock");
  if (!lock) return "BROWSER_BUSY";
  try {
    const modes = options.modes ?? ["A", "C", "B"];
    let ran = 0;
    let failed = 0;
    for (const [i, mode] of modes.entries()) {
      if (i > 0) await new Promise((r) => setTimeout(r, options.pauseMs ?? 5_000));
      const { headless } = MODES[mode];
      if (!headless && !options.hasDisplay) {
        options.say(`${mode} SKIPPED_NO_DISPLAY`);
        continue;
      }
      let context: BrowserContext | undefined;
      ran += 1;
      try {
        context = await options.launchPersistent(options.profileDir, {
          headless,
          args: PERSISTENT_ARGS,
          // The display reaches only the headed run (never Codex or the worker's children).
          env: headless ? childEnvironment(process.env) : childEnvironment(process.env, displayEnvironment(process.env)),
          ...CONTEXT_OPTIONS,
        });
        await runMode(context, mode, options);
      } catch {
        failed += 1;
        options.say(`${mode} BROWSER_ERROR`);
      } finally {
        await context?.close().catch(() => undefined);
      }
    }
    return ran > 0 && failed === ran ? "FAILED" : "DIAGNOSED";
  } finally {
    await checkProfileTree(options.profileDir, options.env, { tighten: true }).catch(() => undefined);
    await lock.release().catch(() => undefined);
  }
}
