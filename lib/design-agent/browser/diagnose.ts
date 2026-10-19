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
  wallReason,
  type CaptureTarget,
  type NavigationState,
} from "../worker/capture";
import { checkProfileLocation, checkProfileTree, PERSISTENT_ARGS, prepareProfileDir, type ProfileEnv } from "./profile";
import { displayEnvironment, INSTAGRAM_HOME, type LaunchPersistent } from "./session";

/** The only page facts the diagnosis prints. */
export const DIAGNOSE_CODES = [
  "SESSION_OK",
  "SESSION_MISSING",
  /** The session check page is outside the target (the guard refuses it); nothing was opened. */
  "SESSION_NOT_CHECKED",
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

/**
 * How long a page or the browser may take to close (DEV-035). On a loaded machine a close racing a
 * refused navigation sometimes never settled and the run hung; a close that takes longer than this
 * ends the browser instead.
 */
export const CLOSE_TIMEOUT_MS = 10_000;
/**
 * DEV-060: ending a whole Chromium (Browser.close, then the process exit) is given at least this long,
 * whatever the page-close bound. A short close bound (tests use 1 s) is about pages; under CI load a
 * browser that was still talking to an off-site host sometimes took over 1 s to exit, which read as
 * BROWSER_STUCK although it did end. Production's bound (10 s) is above this, so nothing changes there.
 */
export const BROWSER_END_MIN_MS = 5_000;

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
  /** Tests only: how long a close may take (production: CLOSE_TIMEOUT_MS). */
  closeTimeoutMs?: number;
  /** Tests only: the targeted close used when page.close() does not settle (production: closeTargetByCdp). */
  closeTarget?: (page: Page, deadline: number) => Promise<boolean>;
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

/** Waits for `work` at most `ms`; true when it settled (resolved or failed) in time. */
async function settlesWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([work.then(() => true as const, () => true as const), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Each page's CDP target id, read when the run opened the page (DEV-041). */
const targetIds = new WeakMap<Page, string>();

/** The page's own target id, from its own CDP session (Target.getTargetInfo without an id names this target). */
async function readTargetId(page: Page): Promise<string> {
  const session = await page.context().newCDPSession(page);
  try {
    const { targetInfo } = await session.send("Target.getTargetInfo");
    return targetInfo.targetId;
  } finally {
    void session.detach().catch(() => undefined);
  }
}

/**
 * Remembers a page's target id right after the run opens it (DEV-041), so the targeted close below
 * still knows it when the page can no longer be attached to. Bounded and best effort: without it the
 * close looks the id up later.
 */
export async function rememberTargetId(page: Page, ms = 2_000): Promise<void> {
  const id = readTargetId(page).then(
    (value) => targetIds.set(page, value),
    () => undefined,
  );
  await settlesWithin(id, ms);
}

/**
 * Closes exactly this page's target through the browser's CDP session and reports whether Chromium
 * no longer lists it (DEV-041). The target is the page's own (remembered when it was opened, or read
 * from the page's own session): never matched by URL, as two pages may show the same URL. Success is
 * judged by the browser's own target list, not by Playwright's close event: page.close() already sends
 * Target.closeTarget and waits for that event, so a close whose event never arrives would otherwise
 * look stuck here too. A remembered id Chromium no longer lists counts as closed (that is the lost
 * detach this handles). Stops polling at `deadline`; the session is detached without waiting.
 */
export async function closeTargetByCdp(page: Page, deadline: number): Promise<boolean> {
  const browser = page.context().browser();
  if (!browser) return false;
  const id = targetIds.get(page) ?? (await readTargetId(page));
  const session = await browser.newBrowserCDPSession();
  try {
    if (Date.now() >= deadline) return false; // the caller has given up: send nothing more
    void session.send("Target.closeTarget", { targetId: id }).catch(() => undefined);
    while (Date.now() < deadline) {
      const { targetInfos } = await session.send("Target.getTargets");
      if (!targetInfos.some((t) => t.targetId === id)) return true;
      // DEV-055: a close sent while the page's cross-host navigation is still in flight can be dropped
      // (on CI the page kept running until a later close); ask again on every poll until it is gone.
      // Closing the same exact target again is harmless.
      void session.send("Target.closeTarget", { targetId: id }).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  } finally {
    void session.detach().catch(() => undefined);
  }
}

/**
 * Closes a page within bounded time (DEV-035, DEV-041): page.close() first; when that does not settle
 * within `ms` (seen on CI with a close racing a cross-host navigation), the page's own target is closed
 * through CDP and counts as closed once Chromium no longer lists it, again within `ms`. So one page
 * close takes at most 2 × `ms`. "timeout" when neither worked: the caller reports CLOSE_TIMEOUT and
 * ends the browser as before.
 *
 * DEV-055: with `now` (a page that already left the site without interception, mode C), the targeted
 * close starts at the same time as page.close() instead of after it gave up: such a page keeps running
 * the off-site host's scripts and requests until it is gone, so waiting up to `ms` for page.close() let
 * it talk to that host for seconds (seen on CI as ~200 requests). Still at most `ms` in total then.
 */
export async function closePageBounded(
  page: Page,
  ms: number,
  closeTarget: (page: Page, deadline: number) => Promise<boolean> = closeTargetByCdp,
  options: { now?: boolean } = {},
): Promise<"closed" | "target_closed" | "timeout"> {
  if (options.now) {
    const deadline = Date.now() + ms;
    let gone = false;
    let closedNormally = false;
    const normal = page.close().then(
      () => (closedNormally = true),
      () => undefined,
    );
    // The targeted close is tried again until the deadline: right after the page opened, its target id
    // may not be remembered yet (rememberTargetId is bounded), and reading it can fail while it moves.
    const targeted = (async () => {
      while (!gone && !closedNormally && Date.now() < deadline) {
        try {
          gone = (await closeTarget(page, deadline)) === true;
        } catch {
          gone = false;
        }
        if (!gone && !closedNormally && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
      }
    })();
    // Done as soon as either way has closed the page, or both have finished trying.
    const first = new Promise<void>((resolve) => {
      void normal.then(() => (closedNormally ? resolve() : undefined));
      void targeted.then(() => (gone ? resolve() : undefined));
      void Promise.allSettled([normal, targeted]).then(() => resolve());
    });
    await settlesWithin(first, ms);
    if (closedNormally) return "closed";
    return gone || page.isClosed() ? "target_closed" : "timeout";
  }
  if (await settlesWithin(page.close(), ms)) return "closed";
  if (page.isClosed()) return "closed"; // closed meanwhile, though close() itself did not settle
  const deadline = Date.now() + ms;
  let gone = false;
  const attempt = Promise.resolve()
    .then(() => closeTarget(page, deadline))
    .then((closed) => {
      gone = closed === true;
    });
  await settlesWithin(attempt, ms);
  return gone || page.isClosed() ? "target_closed" : "timeout";
}

/**
 * Closes the browser of a run within a bounded time: the context first, and when that does not
 * settle, the browser itself (CDP Browser.close and browser.close()). A browser that does not answer
 * at all is killed by Playwright's own close (SIGKILL after its timeout); "stuck" says the run did
 * not see it end in time.
 */
export async function closeBrowser(context: BrowserContext, ms: number, killMs: number = Math.max(ms, BROWSER_END_MIN_MS)): Promise<"closed" | "killed" | "stuck"> {
  if (await settlesWithin(context.close(), ms)) return "closed";
  const browser = context.browser();
  if (!browser) return "stuck";
  const cdp = browser
    .newBrowserCDPSession()
    .then((s) => s.send("Browser.close"))
    .catch(() => undefined);
  return (await settlesWithin(Promise.all([cdp, browser.close()]), killMs)) ? "killed" : "stuck";
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
  const closeMs = options.closeTimeoutMs ?? CLOSE_TIMEOUT_MS;
  const guarded = MODES[mode].guard;
  const state: NavigationState = { offSite: false };
  // A refused move only records why the run stops and wakes the run (DEV-035): closing the page inside
  // the request handler, while its navigation was in flight, sometimes left a close that never settled.
  // The run then stops at once (while loading, sampling or waiting for the home page) and closes the
  // page itself, once, within a bounded time; it does not wait for that navigation to finish.
  // The signal is armed again for each page the run opens.
  let stop: () => void = () => undefined;
  let stopped$ = Promise.resolve();
  const arm = () => {
    stopped$ = new Promise<void>((resolve) => {
      stop = resolve;
    });
  };
  /** Waits `ms`, or less when a refused move stops the run. */
  const pause = async (ms: number) => {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([new Promise<void>((resolve) => (timer = setTimeout(resolve, ms))), stopped$]);
    clearTimeout(timer);
  };
  const closed = new WeakSet<Page>();
  const closePage = async (p: Page) => {
    if (closed.has(p)) return;
    closed.add(p);
    // DEV-055: without interception a page that left the site is already on the other host: close it now.
    const result = await closePageBounded(p, closeMs, options.closeTarget, { now: !guarded && state.offSite });
    if (result === "timeout") throw new CloseTimeout();
    // Closed through CDP: should the page object still deliver events, they no longer reach this run.
    if (result === "target_closed") {
      p.removeAllListeners("request");
      p.removeAllListeners("framenavigated");
    }
  };
  const guard = guarded ? await guardNavigation(context, target, state) : null;
  // Only pages this code opens are kept; any other (a popup, with or without an opener) is closed at once.
  let opening = 0;
  context.on("page", (p) => {
    if (opening > 0) {
      opening -= 1;
      return;
    }
    void p.close().catch(() => undefined);
  });
  /**
   * Without interception (C): stops the run at a main-frame move the target refuses. The move may
   * already have happened (nothing holds it back), so it is named by where it went, whichever event
   * saw it first: an account page as the guard names it (a wall), else the kind of place off the site.
   */
  const refuse = (url: string) => {
    let kind: ReturnType<NonNullable<CaptureTarget["refusal"]>> | undefined;
    try {
      kind = target.refusal?.(url);
    } catch {
      kind = undefined;
    }
    if (kind === "wall") state.wall ??= url;
    else {
      state.offSite = true;
      state.offSiteDetail ??= kind === "same_site" ? "OFF_SITE_SAME_SITE_PATH" : kind === "other_host" ? "OFF_SITE_OTHER_HOST" : undefined;
    }
    stop();
  };
  const newPage = async () => {
    opening += 1;
    const p = guard ? await guard.newPage() : await context.newPage();
    await rememberTargetId(p);
    p.on("dialog", (d) => void d.dismiss().catch(() => undefined));
    if (!guard) {
      // Without interception nothing can hold a request back. Stop the run at the first main-frame
      // request (redirect hops included) or page that is off the site.
      p.on("request", (request) => {
        try {
          if (request.isNavigationRequest() && request.frame() === p.mainFrame() && !target.allowNavigation(request.url())) refuse(request.url());
        } catch {
          // a request without a frame yet (a popup's); popups are closed above
        }
      });
      p.on("framenavigated", (frame) => {
        const url = frame.url();
        // about:blank(#blocked) and a failed load's error page are not a place the page went.
        if (url.startsWith("about:") || url.startsWith("chrome-error:")) return;
        if (frame === p.mainFrame() && !target.allowNavigation(url)) refuse(url);
      });
    }
    return p;
  };
  /** Loads a URL; the browser follows allowed redirects itself (the guard checks each hop). */
  const load = async (url: string): Promise<{ page: Page; status?: number }> => {
    arm();
    const page = await newPage();
    state.wall = undefined;
    const loaded = page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }).then(
      (response) => ({ page, status: response?.status() }),
      () => ({ page }), // a failed load, or a hop the guard stopped
    );
    // Without interception a refused move does not end the navigation: stop waiting for it.
    return Promise.race([loaded, stopped$.then(() => ({ page }))]);
  };
  const stopped = (p: Page) => state.offSite || state.wall !== undefined || p.isClosed();
  const challenge = () => (state.wall !== undefined && wallReason(state.wall) === "CHALLENGE" ? " CHALLENGE_PRESENT" : "");
  /** Why sampling stopped: a wall the page was sent to, or STOPPED_OFF_SITE with where it was going (fixed codes, never the URL). */
  const stopLine = () =>
    state.wall !== undefined && !state.offSite ? `${mode} STOPPED_WALL${challenge()}` : `${mode} STOPPED_OFF_SITE${state.offSiteDetail ? ` ${state.offSiteDetail}` : ""}`;
  /** Samples the page over time; false when it left the site on the way. */
  const sample = async (page: Page): Promise<boolean> => {
    const start = Date.now();
    for (const at of options.sampleAtMs ?? SAMPLE_AT_MS) {
      const wait = start + at - Date.now();
      if (wait > 0 && !stopped(page)) await pause(wait);
      const codes = stopped(page) ? [] : await pageCodes(page);
      // Codes read while the page was leaving the site are not printed.
      if (stopped(page)) {
        say(stopLine());
        return false;
      }
      say(`${mode} t=${Math.round(at / 1000)}s ${codes.join(" ")}`);
    }
    await closePage(page);
    return true;
  };

  const { page, status } = await load(target.url);
  if (state.offSite || (state.wall === undefined && page.isClosed())) {
    say(stopLine());
    await closePage(page);
    return;
  }
  // The guard stopped a redirect to a sign-in / challenge page (never loaded): nothing to sample.
  if (state.wall !== undefined) {
    say(`${mode} ${MODES[mode].label} HTTP_OTHER${challenge()}`);
    await closePage(page);
  } else {
    say(`${mode} ${MODES[mode].label} ${httpCode(status)}`);
    if (!(await sample(page))) {
      await closePage(page);
      return;
    }
  }

  // The signed-in navigation is drawn by script: look for it for a while before calling the session missing.
  // The home page is not the target: when the target allows only the profile itself, it is not opened at
  // all (C could not hold its first request back) and the session is reported as not checked, never as
  // the target having left the site.
  const homeUrl = options.homeUrl ?? INSTAGRAM_HOME;
  if (!target.allowNavigation(homeUrl)) {
    say(`${mode} SESSION_NOT_CHECKED`);
    return;
  }
  const { page: home } = await load(homeUrl);
  const until = Date.now() + (options.sessionWaitMs ?? SESSION_WAIT_MS);
  let ok = false;
  while (!stopped(home)) {
    ok = await signedIn(home);
    if (ok || Date.now() >= until) break;
    await pause(500);
  }
  if (stopped(home)) {
    say(stopLine());
    await closePage(home);
    return;
  }
  say(`${mode} ${ok ? "SESSION_OK" : "SESSION_MISSING"}`);
  await closePage(home);
}

/** A page did not close in time; the run ends its browser (its lines so far stand). */
class CloseTimeout extends Error {
  constructor() {
    super("A page did not close in time.");
  }
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
      } catch (error) {
        // A page that would not close ends the run, not the diagnosis: what it printed stands.
        if (error instanceof CloseTimeout) options.say(`${mode} CLOSE_TIMEOUT`);
        else {
          failed += 1;
          options.say(`${mode} BROWSER_ERROR`);
        }
      } finally {
        if (context && (await closeBrowser(context, options.closeTimeoutMs ?? CLOSE_TIMEOUT_MS)) === "stuck") options.say(`${mode} BROWSER_STUCK`);
      }
    }
    return ran > 0 && failed === ran ? "FAILED" : "DIAGNOSED";
  } finally {
    await checkProfileTree(options.profileDir, options.env, { tighten: true }).catch(() => undefined);
    await lock.release().catch(() => undefined);
  }
}
