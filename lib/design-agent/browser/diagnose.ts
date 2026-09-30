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
export const SAMPLE_AT_MS = [1_000, 3_000, 8_000, 15_000];

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
  /** Tests only: the signed-in check page (production: INSTAGRAM_HOME). */
  homeUrl?: string;
  /** Whether a display exists for B (production: DISPLAY / WAYLAND_DISPLAY). */
  hasDisplay?: boolean;
  say: (line: string) => void;
}

export type DiagnoseOutcome = "DIAGNOSED" | "SESSION_MISSING" | "BROWSER_BUSY";

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

/** One run: open the target, sample it, then check the session on the home page. */
async function runMode(context: BrowserContext, mode: DiagnoseMode, options: DiagnoseOptions): Promise<void> {
  const { target, say } = options;
  const guard = MODES[mode].guard;
  const state: { offSite: boolean; redirect?: string } = { offSite: false };
  if (guard) await guardNavigation(context, target, state);
  // Popups are never needed; close any at once.
  context.on("page", (p) => {
    void p.opener().then((opener) => (opener ? p.close() : undefined)).catch(() => undefined);
  });
  const newPage = async () => {
    const p = await context.newPage();
    p.on("dialog", (d) => void d.dismiss().catch(() => undefined));
    if (!guard) {
      // Without interception nothing stops a redirect off the site; stop the run when the main frame leaves it.
      p.on("framenavigated", (frame) => {
        const url = frame.url();
        // about:blank and a failed load's error page are not a place the page went.
        if (url === "about:blank" || url.startsWith("chrome-error:")) return;
        if (frame === p.mainFrame() && !target.allowNavigation(url)) {
          state.offSite = true;
          void p.close().catch(() => undefined);
        }
      });
    }
    return p;
  };

  const page = await newPage();
  let status: number | undefined;
  try {
    status = (await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 45_000 }))?.status();
  } catch {
    status = undefined; // a failed load or a redirect the guard stopped
  }
  if (state.offSite) {
    say(`${mode} STOPPED_OFF_SITE`);
    return;
  }
  say(`${mode} ${MODES[mode].label} ${httpCode(status)}`);
  const start = Date.now();
  for (const at of options.sampleAtMs ?? SAMPLE_AT_MS) {
    const wait = start + at - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (state.offSite || page.isClosed()) {
      say(`${mode} STOPPED_OFF_SITE`);
      return;
    }
    say(`${mode} t=${Math.round(at / 1000)}s ${(await pageCodes(page)).join(" ")}`);
  }
  await page.close().catch(() => undefined);

  const home = await newPage();
  await home.goto(options.homeUrl ?? INSTAGRAM_HOME, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, Math.min(3_000, (options.sampleAtMs ?? SAMPLE_AT_MS)[0]! * 3)));
  if (state.offSite || home.isClosed()) {
    say(`${mode} STOPPED_OFF_SITE`);
    return;
  }
  say(`${mode} ${(await signedIn(home)) ? "SESSION_OK" : "SESSION_MISSING"}`);
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
    for (const [i, mode] of modes.entries()) {
      if (i > 0) await new Promise((r) => setTimeout(r, options.pauseMs ?? 5_000));
      const { headless } = MODES[mode];
      if (!headless && !options.hasDisplay) {
        options.say(`${mode} SKIPPED_NO_DISPLAY`);
        continue;
      }
      let context: BrowserContext | undefined;
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
        options.say(`${mode} BROWSER_ERROR`);
      } finally {
        await context?.close().catch(() => undefined);
      }
    }
    return "DIAGNOSED";
  } finally {
    await checkProfileTree(options.profileDir, options.env, { tighten: true }).catch(() => undefined);
    await lock.release().catch(() => undefined);
  }
}
