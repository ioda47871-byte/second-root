/**
 * Signed-in Instagram capture with the worker's dedicated browser profile
 * (DEV-028 PoC). Not connected to the worker yet.
 *
 * login   — opens a visible Chromium on the dedicated profile at
 *           instagram.com and waits. A PERSON signs in by hand (password,
 *           2FA, any challenge). This code never types, clicks or fills
 *           anything, and never reads a cookie; it only watches for the
 *           signed-in page (no login form, the signed-in navigation shown),
 *           then closes the window so Chromium keeps the session in the
 *           profile.
 * capture — opens one public profile page headless with the same profile
 *           and takes at most three privacy-processed screenshots, through
 *           the same guarded capture as the signed-out worker, with the
 *           account's own parts (navigation, messages, notifications,
 *           "followed by", suggestions) hidden and cropped away. A signed-out
 *           page, a challenge or a CAPTCHA stops the capture; nothing is
 *           worked around.
 */
import type { BrowserContext, LaunchOptions, Page } from "playwright";
import { childEnvironment } from "../worker/env";
import { acquireLock } from "../worker/state";
import { captureInContext, CONTEXT_OPTIONS, SIGNED_IN, type CaptureTarget, type UnavailableReason } from "../worker/capture";

/** WSLg display variables, for the visible sign-in window only. */
export function displayEnvironment(base: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY"]) {
    const value = base[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}
import { lstat } from "node:fs/promises";
import { checkProfileLocation, checkProfileTree, PERSISTENT_ARGS, prepareProfileDir, type ProfileEnv } from "./profile";

export const INSTAGRAM_HOME = "https://www.instagram.com/";
const LOGIN_PATH = /^\/(accounts\/(login|signup|emailsignup)|challenge|checkpoint|suspended)/;
export const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;

export type LaunchPersistent = (
  dir: string,
  options: LaunchOptions & { viewport?: { width: number; height: number } | null } & Record<string, unknown>,
) => Promise<BrowserContext>;

export type LoginCode = "LOGIN_OK" | "LOGIN_NOT_COMPLETED" | "LOGIN_TIMEOUT" | "BROWSER_BUSY";

export interface LoginOptions {
  profileDir: string;
  stateDir: string;
  env: ProfileEnv;
  launchPersistent: LaunchPersistent;
  timeoutMs?: number;
  pollMs?: number;
  /** Tests only: where the window starts (production: INSTAGRAM_HOME). */
  startUrl?: string;
  /** Tests only: stands in for the person at the window. */
  onPage?: (page: Page) => Promise<void>;
}

async function signedIn(page: Page): Promise<boolean> {
  let path: string;
  try {
    path = new URL(page.url()).pathname;
  } catch {
    return false;
  }
  if (LOGIN_PATH.test(path)) return false;
  if (await page.locator('input[type="password"], input[name="password"]').first().isVisible().catch(() => false)) return false;
  return (await page.locator(SIGNED_IN).count().catch(() => 0)) > 0;
}

export async function runLogin(options: LoginOptions): Promise<LoginCode> {
  await prepareProfileDir(options.profileDir, options.env);
  const lock = await acquireLock(options.stateDir, new Date(), "browser.lock");
  if (!lock) return "BROWSER_BUSY";
  let context: BrowserContext | undefined;
  try {
    context = await options.launchPersistent(options.profileDir, {
      headless: false,
      args: PERSISTENT_ARGS,
      // The display reaches only this visible sign-in window (never Codex or the worker's children).
      env: childEnvironment(process.env, displayEnvironment(process.env)),
      viewport: null,
      acceptDownloads: false,
    });
    const closed = new Promise<"closed">((r) => context!.once("close", () => r("closed")));
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(options.startUrl ?? INSTAGRAM_HOME, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => undefined);
    if (options.onPage) void options.onPage(page);
    const until = Date.now() + (options.timeoutMs ?? LOGIN_TIMEOUT_MS);
    const poll = options.pollMs ?? 2_000;
    while (Date.now() < until) {
      const tick = await Promise.race([closed, new Promise<"tick">((r) => setTimeout(() => r("tick"), poll))]);
      if (tick === "closed") return "LOGIN_NOT_COMPLETED";
      // The person may have opened other tabs; any of them counts.
      for (const p of context.pages()) {
        if (await signedIn(p)) {
          await new Promise((r) => setTimeout(r, Math.min(3_000, poll * 2))); // let Chromium write the session
          return "LOGIN_OK";
        }
      }
    }
    return "LOGIN_TIMEOUT";
  } finally {
    await context?.close().catch(() => undefined);
    await checkProfileTree(options.profileDir, options.env, { tighten: true }).catch(() => undefined);
    await lock.release().catch(() => undefined);
  }
}

export type SignedInCaptureCode =
  | "CAPTURED"
  | "LOGIN_REQUIRED"
  | "INSTAGRAM_CHALLENGE"
  | "INSTAGRAM_CAPTCHA"
  | "PUBLIC_SOURCE_UNAVAILABLE"
  | "CAPTURE_FAILED"
  | "BROWSER_BUSY";

export type SignedInCaptureResult = { code: SignedInCaptureCode; reason?: UnavailableReason | string; files: string[]; softened: number };

export interface SignedInCaptureOptions {
  profileDir: string;
  stateDir: string;
  env: ProfileEnv;
  target: CaptureTarget;
  outDir: string;
  launchPersistent: LaunchPersistent;
  settleMs?: number;
}

export async function runSignedInCapture(options: SignedInCaptureOptions): Promise<SignedInCaptureResult> {
  await checkProfileLocation(options.profileDir, options.env);
  // No profile yet: nobody has signed in. Do not create one here.
  if (!(await lstat(options.profileDir).catch(() => null))) return { code: "LOGIN_REQUIRED", reason: "NO_PROFILE", files: [], softened: 0 };
  await prepareProfileDir(options.profileDir, options.env);
  const lock = await acquireLock(options.stateDir, new Date(), "browser.lock");
  if (!lock) return { code: "BROWSER_BUSY", files: [], softened: 0 };
  let context: BrowserContext | undefined;
  try {
    const launched = await options.launchPersistent(options.profileDir, {
      headless: true,
      args: PERSISTENT_ARGS,
      env: childEnvironment(process.env),
      ...CONTEXT_OPTIONS,
    });
    context = launched;
    const result = await captureInContext(launched, {
      target: options.target,
      outDir: options.outDir,
      settleMs: options.settleMs,
      session: "signed-in",
      scratch: async () => {
        const page = await launched.newPage();
        return { page, close: () => page.close() };
      },
    });
    if (result.status === "captured") return { code: "CAPTURED", files: result.files, softened: result.softened };
    if (result.status === "retry") return { code: "CAPTURE_FAILED", reason: result.reason, files: [], softened: 0 };
    const byReason: Partial<Record<UnavailableReason, SignedInCaptureCode>> = {
      LOGIN_WALL: "LOGIN_REQUIRED",
      CHALLENGE: "INSTAGRAM_CHALLENGE",
      CAPTCHA: "INSTAGRAM_CAPTCHA",
    };
    return { code: byReason[result.reason] ?? "PUBLIC_SOURCE_UNAVAILABLE", reason: result.reason, files: [], softened: 0 };
  } catch {
    return { code: "CAPTURE_FAILED", reason: "CAPTURE_ERROR", files: [], softened: 0 };
  } finally {
    await context?.close().catch(() => undefined);
    await checkProfileTree(options.profileDir, options.env, { tighten: true }).catch(() => undefined);
    await lock.release().catch(() => undefined);
  }
}
