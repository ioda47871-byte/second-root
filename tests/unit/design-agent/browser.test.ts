import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { checkProfileLocation, checkProfileTree, prepareProfileDir, purgeOldCaptures, type ProfileEnv } from "@/lib/design-agent/browser/profile";
import { DIAGNOSE_CODES, runDiagnose, type DiagnoseMode } from "@/lib/design-agent/browser/diagnose";
import { displayEnvironment, runLogin, runSignedInCapture, type LaunchPersistent } from "@/lib/design-agent/browser/session";
import { childEnvironment } from "@/lib/design-agent/worker/env";
import { hideAccountChrome } from "@/lib/design-agent/worker/capture";
import { acquireLock } from "@/lib/design-agent/worker/state";
import { startMockSite, type MockSite } from "./worker-support";

// Dedicated signed-in browser profile (DEV-028 PoC) against local mock pages.
// No real Instagram, no real account, no real session.

vi.setConfig({ testTimeout: 60_000 });

const REPO = resolve(__dirname, "../../..");
const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {};
// Tests run the sign-in window headless (no display here); everything else is as in production.
const launchPersistent: LaunchPersistent = (dir, options) => chromium.launchPersistentContext(dir, { ...options, headless: true, ...exe });

let site: MockSite;
beforeAll(async () => {
  site = await startMockSite();
});
afterAll(() => site.server.close());

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "srdw-home-"));
  chmodSync(home, 0o700);
  const env: ProfileEnv = { repoDir: REPO, home, uid: process.getuid?.(), user: userInfo().username, expectedUser: userInfo().username };
  return { home, env, profile: join(home, ".local", "share", "sr-instagram-browser"), state: join(home, "state"), out: join(home, "out") };
}

describe("profile location and permissions", () => {
  it("refuses the wrong user, relative paths, the repository, Windows drives and places outside home", async () => {
    const s = sandbox();
    await expect(checkProfileLocation(s.profile, { ...s.env, expectedUser: "sr-designgen-other" })).rejects.toMatchObject({ code: "WRONG_USER" });
    await expect(checkProfileLocation("relative/profile", s.env)).rejects.toMatchObject({ code: "PROFILE_NOT_ABSOLUTE" });
    await expect(checkProfileLocation(join(REPO, "tmp-profile"), { ...s.env, home: REPO })).rejects.toMatchObject({ code: "PROFILE_IN_REPO" });
    await expect(checkProfileLocation("/mnt/c/Users/someone/profile", { ...s.env, home: "/mnt/c/Users/someone" })).rejects.toMatchObject({ code: "PROFILE_ON_WINDOWS_DRIVE" });
    await expect(checkProfileLocation("/var/tmp/profile", s.env)).rejects.toMatchObject({ code: "PROFILE_OUTSIDE_HOME" });
    // a parent that is a link into the repository
    symlinkSync(join(REPO, "docs"), join(s.home, "linked"));
    await expect(checkProfileLocation(join(s.home, "linked", "profile"), s.env)).rejects.toMatchObject({ code: "PROFILE_IN_REPO" });
    await expect(checkProfileLocation(s.profile, s.env)).resolves.toBeUndefined();
  });

  it("creates the profile 0700, refuses links, other owners and foreign links inside, and tightens permissions", async () => {
    const s = sandbox();
    await prepareProfileDir(s.profile, s.env);
    expect(statSync(s.profile).mode & 0o777).toBe(0o700);
    // a file and a directory left readable by others are tightened
    writeFileSync(join(s.profile, "Cookies"), "x", { mode: 0o644 });
    mkdirSync(join(s.profile, "Default"), { mode: 0o755 });
    chmodSync(join(s.profile, "Default"), 0o755);
    await expect(checkProfileTree(s.profile, s.env, { tighten: false })).rejects.toMatchObject({ code: "PROFILE_UNSAFE_ENTRY" });
    await checkProfileTree(s.profile, s.env, { tighten: true });
    expect(statSync(join(s.profile, "Cookies")).mode & 0o077).toBe(0);
    expect(statSync(join(s.profile, "Default")).mode & 0o077).toBe(0);
    // Chromium's own lock link is fine; any other link is not
    symlinkSync("somehost-123", join(s.profile, "SingletonLock"));
    await checkProfileTree(s.profile, s.env, { tighten: false });
    symlinkSync("/etc/passwd", join(s.profile, "Default", "evil"));
    await expect(checkProfileTree(s.profile, s.env, { tighten: true })).rejects.toMatchObject({ code: "PROFILE_UNSAFE_ENTRY" });
    // owned by someone else
    await expect(checkProfileTree(s.profile, { ...s.env, uid: 12345 }, { tighten: true })).rejects.toMatchObject({ code: "PROFILE_WRONG_OWNER" });
    // the profile itself as a link
    const other = sandbox();
    mkdirSync(join(other.home, ".local", "share"), { recursive: true });
    mkdirSync(join(other.home, "real"), { mode: 0o700 });
    symlinkSync(join(other.home, "real"), other.profile);
    await expect(prepareProfileDir(other.profile, other.env)).rejects.toMatchObject({ code: "PROFILE_IS_LINK" });
  });

  it("never follows a link while walking the profile (a loop to / is refused at once)", async () => {
    const s = sandbox();
    await prepareProfileDir(s.profile, s.env);
    mkdirSync(join(s.profile, "Default"), { mode: 0o700 });
    symlinkSync("/", join(s.profile, "Default", "loop"));
    const started = Date.now();
    await expect(checkProfileTree(s.profile, s.env, { tighten: true })).rejects.toMatchObject({ code: "PROFILE_UNSAFE_ENTRY" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("resolves a linked ancestor that exists before creating anything", async () => {
    const s = sandbox();
    const elsewhere = mkdtempSync(join(tmpdir(), "srdw-elsewhere-"));
    symlinkSync(elsewhere, join(s.home, ".local"));
    await expect(prepareProfileDir(s.profile, s.env)).rejects.toMatchObject({ code: "PROFILE_OUTSIDE_HOME" });
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("removes only capture folders older than a day", async () => {
    const s = sandbox();
    mkdirSync(s.out, { recursive: true });
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    for (const name of ["20260901T000000Z", "20260930T000000Z", "keep-me"]) mkdirSync(join(s.out, name));
    utimesSync(join(s.out, "20260901T000000Z"), old, old);
    utimesSync(join(s.out, "keep-me"), old, old);
    expect(await purgeOldCaptures(s.out)).toBe(1);
    expect(readdirSync(s.out).sort()).toEqual(["20260930T000000Z", "keep-me"]);
  });
});

describe("login (a person signs in; the tool only watches)", () => {
  it("reports LOGIN_OK once the signed-in page appears, and keeps the profile private", async () => {
    const s = sandbox();
    const code = await runLogin({
      profileDir: s.profile,
      stateDir: s.state,
      env: s.env,
      launchPersistent,
      startUrl: `${site.origin}/login_page/`,
      pollMs: 200,
      timeoutMs: 20_000,
      // stands in for the person: after a moment the window shows the signed-in home
      onPage: async (page) => {
        await new Promise((r) => setTimeout(r, 600));
        await page.goto(`${site.origin}/home_signed_in/`);
      },
    });
    expect(code).toBe("LOGIN_OK");
    expect(statSync(s.profile).mode & 0o077).toBe(0);
    await checkProfileTree(s.profile, s.env, { tighten: false });
    expect(existsSync(join(s.state, "browser.lock"))).toBe(false);
  });

  it("reports LOGIN_NOT_COMPLETED when the window is closed, LOGIN_TIMEOUT when nobody signs in", async () => {
    const s = sandbox();
    expect(
      await runLogin({ profileDir: s.profile, stateDir: s.state, env: s.env, launchPersistent, startUrl: `${site.origin}/login_page/`, pollMs: 200, onPage: async (page) => void (await page.context().close()) }),
    ).toBe("LOGIN_NOT_COMPLETED");
    expect(await runLogin({ profileDir: s.profile, stateDir: s.state, env: s.env, launchPersistent, startUrl: `${site.origin}/login_page/`, pollMs: 200, timeoutMs: 1_500 })).toBe("LOGIN_TIMEOUT");
  });

  it("keeps a session written in one run of the profile for the next run (same Chromium options)", async () => {
    const s = sandbox();
    await prepareProfileDir(s.profile, s.env);
    const opts = { args: ["--password-store=basic", "--disable-sync", "--no-first-run"], headless: true, ...exe };
    const first = await chromium.launchPersistentContext(s.profile, opts);
    await (await first.newPage()).goto(`${site.origin}/set_session/`);
    await first.close();
    const second = await chromium.launchPersistentContext(s.profile, opts);
    const page = await second.newPage();
    await page.goto(`${site.origin}/echo_session/`);
    expect(await page.locator("#has").innerText()).toBe("yes");
    await second.close();
  });

  it("never types, clicks or fills anything, and never reads cookies (source check)", () => {
    const files = ["lib/design-agent/browser/session.ts", "lib/design-agent/browser/profile.ts", "lib/design-agent/browser/diagnose.ts", "lib/design-agent/worker/capture.ts", "scripts/sales-design-browser/browser.ts"];
    for (const f of files) {
      const text = readFileSync(join(REPO, f), "utf8");
      expect(text, f).not.toMatch(/\.(click|dblclick|fill|type|press|check|uncheck|selectOption|setInputFiles|tap|pressSequentially)\(|keyboard\.|\.cookies\(|storageState|addCookies/);
    }
  });
});

describe("signed-in capture", () => {
  const signedInProfile = async () => {
    const s = sandbox();
    await runLogin({
      profileDir: s.profile,
      stateDir: s.state,
      env: s.env,
      launchPersistent,
      startUrl: `${site.origin}/home_signed_in/`,
      pollMs: 200,
    });
    mkdirSync(s.out, { recursive: true, mode: 0o700 });
    return s;
  };
  const capture = (s: ReturnType<typeof sandbox>, username: string) =>
    runSignedInCapture({ profileDir: s.profile, stateDir: s.state, env: s.env, target: site.target(username), outDir: s.out, launchPersistent, settleMs: 300 });

  it("captures a public profile with the dedicated profile: three private PNGs, media softened", async () => {
    const s = await signedInProfile();
    const result = await capture(s, "li_shop");
    expect(result.code).toBe("CAPTURED");
    expect(result.files.map((f) => f.split("/").pop())).toEqual(["profile.png", "grid-top.png", "grid-lower.png"]);
    expect(result.softened).toBeGreaterThan(0);
    for (const f of result.files) {
      expect(readFileSync(f).subarray(0, 4).toString("latin1")).toBe("\x89PNG");
      expect(statSync(f).mode & 0o077).toBe(0);
    }
    await checkProfileTree(s.profile, s.env, { tighten: false });
    // nothing about the session is in the result
    expect(JSON.stringify(result)).not.toMatch(/sr-instagram-browser|Cookies|session/i);
  });

  it.each([
    ["a signed-out page", "example_shop", "LOGIN_REQUIRED"],
    ["a challenge", "li_challenge", "INSTAGRAM_CHALLENGE"],
    ["a CAPTCHA", "li_captcha", "INSTAGRAM_CAPTCHA"],
  ] as const)("stops on %s without working around it", async (_label, username, code) => {
    const s = await signedInProfile();
    const result = await capture(s, username);
    expect(result.code).toBe(code);
    expect(result.files).toEqual([]);
  });

  it("stops when a signed-in page has no main content to crop to", async () => {
    const s = await signedInProfile();
    expect(await capture(s, "li_nomain")).toMatchObject({ code: "PUBLIC_SOURCE_UNAVAILABLE", reason: "EMPTY_PAGE" });
  });

  it("stops with LOGIN_REQUIRED and creates nothing when nobody has signed in yet", async () => {
    const s = sandbox();
    const result = await capture(s, "li_shop");
    expect(result).toMatchObject({ code: "LOGIN_REQUIRED", reason: "NO_PROFILE" });
    expect(existsSync(s.profile)).toBe(false);
  });

  it("does not share the profile with a run that holds it", async () => {
    const s = await signedInProfile();
    const held = await acquireLock(s.state, new Date(), "browser.lock");
    expect((await capture(s, "li_shop")).code).toBe("BROWSER_BUSY");
    await held!.release();
  });

  it.each([
    ["a 404", "li_no_such_page", "HTTP_404"],
    ["a 410", "li_gone", "HTTP_410"],
    ["a private-account text", "li_private", "BODY_PRIVATE"],
    ["a page-unavailable text", "li_unavailable", "BODY_PAGE_UNAVAILABLE"],
  ] as const)("says which signal made %s unavailable", async (_label, username, detail) => {
    const s = await signedInProfile();
    expect(await capture(s, username)).toMatchObject({ code: "PUBLIC_SOURCE_UNAVAILABLE", reason: detail });
  });
});

describe("navigation guard (browser-native requests, every hop checked before it is sent)", () => {
  const signedInProfile = async () => {
    const s = sandbox();
    await runLogin({ profileDir: s.profile, stateDir: s.state, env: s.env, launchPersistent, startUrl: `${site.origin}/set_session/`, pollMs: 200, onPage: async (page) => void (await page.goto(`${site.origin}/home_signed_in/`)) });
    mkdirSync(s.out, { recursive: true, mode: 0o700 });
    return s;
  };
  const capture = (s: ReturnType<typeof sandbox>, username: string) =>
    runSignedInCapture({ profileDir: s.profile, stateDir: s.state, env: s.env, target: site.target(username), outDir: s.out, launchPersistent, settleMs: 300 });
  const offSiteHits = (from: number) => site.requests.slice(from).filter((r) => r.startsWith("localhost:"));

  it("keeps the browser's own request headers on an allowed navigation (sec-fetch-*, accept-language, cookie, user agent)", async () => {
    const s = await signedInProfile();
    await capture(s, "li_headers");
    const h = site.lastHeaders;
    expect(h["sec-fetch-mode"]).toBe("navigate");
    expect(h["sec-fetch-dest"]).toBe("document");
    expect(h["sec-fetch-site"]).toBeDefined();
    expect(h["accept-language"]).toMatch(/^ja/);
    expect(String(h["cookie"])).toContain("fake_session=FICTIONAL");
    expect(h["user-agent"]).toMatch(/Chrome\//);
  });

  it("reaches the header and posts of a signed-in page that is 'unavailable' to a request without the browser's headers", async () => {
    const s = await signedInProfile();
    expect((await capture(s, "li_fetch_sensitive")).code).toBe("CAPTURED");
  });

  it("follows a same-site redirect", async () => {
    const s = await signedInProfile();
    expect((await capture(s, "hop_li_shop")).code).toBe("CAPTURED");
  });

  it.each([
    ["an off-site redirect", "li_offsite"],
    ["an off-site hop in the middle of a redirect chain", "li_offsite_hop"],
    ["a script navigation off the site", "li_js_offsite"],
  ] as const)("stops %s before the destination receives any request", async (_label, username) => {
    const s = await signedInProfile();
    const before = site.requests.length;
    expect(await capture(s, username)).toMatchObject({ code: "PUBLIC_SOURCE_UNAVAILABLE", reason: "OFF_SITE_REDIRECT" });
    expect(offSiteHits(before)).toEqual([]);
  });

  it("stops a redirect to a challenge before loading it", async () => {
    const s = await signedInProfile();
    const before = site.requests.length;
    expect((await capture(s, "li_challenge")).code).toBe("INSTAGRAM_CHALLENGE");
    expect(site.requests.slice(before).some((r) => r.includes("/challenge/"))).toBe(false);
  });

  it("never lets a popup leave, and does not count an off-site frame as the page's navigation", async () => {
    const s = await signedInProfile();
    const before = site.requests.length;
    expect((await capture(s, "li_popup")).code).toBe("CAPTURED");
    expect((await capture(s, "li_iframe")).code).toBe("CAPTURED");
    expect(offSiteHits(before)).toEqual([]);
  });

  it("never logs a cookie or session value, and uses no fetch/fulfill, clicks, input or extra scrolling", async () => {
    const s = await signedInProfile();
    const out = JSON.stringify(await capture(s, "li_shop")) + JSON.stringify(await capture(s, "li_unavailable"));
    expect(out).not.toMatch(/FICTIONAL|fake_session|cookie/i);
    const capture_ts = readFileSync(join(REPO, "lib/design-agent/worker/capture.ts"), "utf8");
    expect(capture_ts).not.toMatch(/route\.fetch\(|route\.fulfill\(|\.fulfill\(\{/);
    expect(capture_ts.match(/mouse\.wheel\(/g)).toHaveLength(1);
    for (const f of ["lib/design-agent/browser/diagnose.ts", "lib/design-agent/browser/session.ts"]) {
      expect(readFileSync(join(REPO, f), "utf8"), f).not.toMatch(/mouse\.|route\.fetch|route\.fulfill|keyboard\./);
    }
  });
});

describe("diagnose", () => {
  const signedInProfile = async () => {
    const s = sandbox();
    await runLogin({ profileDir: s.profile, stateDir: s.state, env: s.env, launchPersistent, startUrl: `${site.origin}/home_signed_in/`, pollMs: 200 });
    return s;
  };
  const diagnose = async (s: ReturnType<typeof sandbox>, username: string, over: { modes?: DiagnoseMode[]; home?: string; hasDisplay?: boolean; samples?: number[] } = {}) => {
    const lines: string[] = [];
    const outcome = await runDiagnose({
      profileDir: s.profile,
      stateDir: s.state,
      env: s.env,
      target: site.target(username),
      launchPersistent,
      modes: over.modes ?? ["A", "C"],
      sampleAtMs: over.samples ?? [200, 2_500],
      pauseMs: 0,
      sessionWaitMs: 1_500,
      homeUrl: `${site.origin}/${over.home ?? "home_signed_in"}/`,
      hasDisplay: over.hasDisplay ?? false,
      say: (l) => lines.push(l),
    });
    return { outcome, lines };
  };
  const STRUCTURE = /^(A|B|C)$|^t=\d+s$|^headless\+guard$|^headless\+no-interception$|^headed\+guard$|^STOPPED_OFF_SITE$|^SKIPPED_NO_DISPLAY$|^BROWSER_ERROR$/;
  const onlyCodes = (lines: string[]) => {
    for (const word of lines.join(" ").split(/\s+/)) expect(DIAGNOSE_CODES.includes(word as never) || STRUCTURE.test(word), word).toBe(true);
  };

  it("sees the same page with the guard as without interception (the guard keeps the browser's own headers)", async () => {
    const s = await signedInProfile();
    const { outcome, lines } = await diagnose(s, "li_fetch_sensitive");
    expect(outcome).toBe("DIAGNOSED");
    expect(lines).toEqual([
      "A headless+guard HTTP_200",
      "A t=0s MAIN_PRESENT HEADER_PRESENT POSTS_PRESENT SIGNED_IN_NAV_PRESENT",
      "A t=3s MAIN_PRESENT HEADER_PRESENT POSTS_PRESENT SIGNED_IN_NAV_PRESENT",
      "A SESSION_OK",
      "C headless+no-interception HTTP_200",
      "C t=0s MAIN_PRESENT HEADER_PRESENT POSTS_PRESENT SIGNED_IN_NAV_PRESENT",
      "C t=3s MAIN_PRESENT HEADER_PRESENT POSTS_PRESENT SIGNED_IN_NAV_PRESENT",
      "C SESSION_OK",
    ]);
    onlyCodes(lines);
  });

  it("shows text that disappears while the page renders (hydration)", async () => {
    const s = await signedInProfile();
    const { lines } = await diagnose(s, "li_hydrate", { modes: ["A"] });
    expect(lines[1]).toContain("BODY_UNAVAILABLE_MARKER");
    expect(lines[1]).toContain("POSTS_MISSING");
    expect(lines[2]).not.toContain("BODY_UNAVAILABLE_MARKER");
    expect(lines[2]).toContain("POSTS_PRESENT");
  });

  it("reports HTTP, private, CAPTCHA, challenge and a lost session as codes only", async () => {
    const s = await signedInProfile();
    const samples = [200];
    expect((await diagnose(s, "li_no_such_page", { modes: ["A"], samples })).lines[0]).toBe("A headless+guard HTTP_404");
    expect((await diagnose(s, "li_gone", { modes: ["C"], samples })).lines[0]).toBe("C headless+no-interception HTTP_OTHER");
    expect((await diagnose(s, "li_private", { modes: ["A"], samples })).lines[1]).toContain("BODY_PRIVATE_MARKER");
    expect((await diagnose(s, "li_captcha", { modes: ["A"], samples })).lines[1]).toContain("CAPTCHA_PRESENT");
    // a same-site redirect is followed as capture follows it, with and without the guard
    // the guard stops a redirect to a challenge before loading it; without interception the browser shows it
    expect((await diagnose(s, "li_challenge", { modes: ["A"], samples })).lines[0]).toBe("A headless+guard HTTP_OTHER CHALLENGE_PRESENT");
    expect((await diagnose(s, "li_challenge", { modes: ["C"], samples })).lines[1]).toContain("CHALLENGE_PRESENT");
    expect((await diagnose(s, "hop_li_shop", { modes: ["A"], samples })).lines.slice(0, 2)).toEqual([
      "A headless+guard HTTP_200",
      "A t=0s MAIN_PRESENT HEADER_PRESENT POSTS_PRESENT SIGNED_IN_NAV_PRESENT",
    ]);
    const lost = await diagnose(s, "li_shop", { modes: ["A"], samples, home: "login_page" });
    expect(lost.lines.at(-1)).toBe("A SESSION_MISSING");
    onlyCodes(lost.lines);
  });

  it("stops without interception when the page leaves the site, and never prints a URL, username or page text", async () => {
    const s = await signedInProfile();
    const before = site.requests.length;
    const { lines } = await diagnose(s, "li_offsite", { modes: ["C"], samples: [200] });
    expect(lines).toEqual(["C STOPPED_OFF_SITE"]);
    // an off-site hop in the middle of a redirect chain also stops the run
    expect((await diagnose(s, "li_offsite_hop", { modes: ["C"], samples: [200] })).lines).toEqual(["C STOPPED_OFF_SITE"]);
    // the session check does not run after leaving the site
    expect(site.requests.slice(before).some((r) => r.includes("home_signed_in"))).toBe(false);
    // a popup the page opens by itself (no opener) is closed at once without the guard
    // (its first request may already be out: nothing can hold it back without interception)
    const popup = await diagnose(s, "li_popup", { modes: ["C"], samples: [200, 1_500] });
    expect(popup.lines).toEqual(["C headless+no-interception HTTP_200", "C t=0s MAIN_PRESENT HEADER_PRESENT POSTS_PRESENT SIGNED_IN_NAV_PRESENT", "C t=2s MAIN_PRESENT HEADER_PRESENT POSTS_PRESENT SIGNED_IN_NAV_PRESENT", "C SESSION_OK"]);
    const all = (await diagnose(s, "li_shop", { modes: ["A", "C"], samples: [200] })).lines.join("\n");
    expect(all).not.toMatch(/li_shop|example_shop|Fictional|LEAK|localhost|127\.0\.0\.1|http|sr-instagram-browser|fake_session/);
  });

  it("runs the headed check only with a display, and refuses to run without a profile or while it is in use", async () => {
    const s = await signedInProfile();
    expect((await diagnose(s, "li_shop", { modes: ["B"], samples: [200] })).lines).toEqual(["B SKIPPED_NO_DISPLAY"]);
    expect((await diagnose(s, "li_shop", { modes: ["B"], samples: [200], hasDisplay: true })).lines[0]).toBe("B headed+guard HTTP_200");
    const held = await acquireLock(s.state, new Date(), "browser.lock");
    expect((await diagnose(s, "li_shop")).outcome).toBe("BROWSER_BUSY");
    await held!.release();
    const empty = sandbox();
    expect(await diagnose(empty, "li_shop")).toEqual({ outcome: "SESSION_MISSING", lines: ["SESSION_MISSING"] });
    expect(existsSync(empty.profile)).toBe(false);
    await checkProfileTree(s.profile, s.env, { tighten: false });
  });
});

describe("the signed-in account's own parts are hidden before screenshots", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, ...exe });
  });
  afterAll(async () => browser.close());

  it("hides navigation, the messages dock, dialogs, followed-by and suggested accounts, keeps the profile", async () => {
    const page = await browser.newPage();
    await page.goto(`${site.origin}/li_shop/`);
    expect(await hideAccountChrome(page)).toBeGreaterThanOrEqual(5);
    const visible = (text: string) =>
      page.evaluate((t) => {
        const hits = Array.from(document.querySelectorAll("body *")).filter((el) => el.children.length === 0 && (el.textContent ?? "").includes(t));
        return hits.some((el) => getComputedStyle(el).visibility !== "hidden");
      }, text);
    for (const leak of ["LEAK-OWN-ACCOUNT", "LEAK-DM-PEER", "LEAK-DIALOG", "LEAK-FRIEND-NAME", "LEAK-SUGGESTED-NAME", "Notifications 3"]) expect(await visible(leak), leak).toBe(false);
    expect(await visible("Fictional bakery bio for tests.")).toBe(true);
    expect(await visible("example_shop")).toBe(true);
  });

  it("keeps a Japanese bio that mentions おすすめ, and never hides a sticky box around the profile", async () => {
    const page = await browser.newPage();
    await page.goto(`${site.origin}/li_jp/`);
    await hideAccountChrome(page);
    const visible = (text: string) =>
      page.evaluate((t) => {
        const hits = Array.from(document.querySelectorAll("body *")).filter((el) => el.children.length === 0 && (el.textContent ?? "").includes(t));
        return hits.some((el) => getComputedStyle(el).visibility !== "hidden");
      }, text);
    expect(await visible("季節のおすすめマフィン")).toBe(true);
    // a bio word that is exactly "おすすめ" in its own element stays visible, and so does its line
    expect(await page.evaluate(() => getComputedStyle(document.querySelector("header b")!).visibility)).toBe("visible");
    expect(await page.evaluate(() => getComputedStyle(document.querySelector("header b")!.parentElement!).visibility)).toBe("visible");
    expect(await visible("example_shop")).toBe(true);
    expect(await visible("LEAK-JP-SUGGESTED")).toBe(false);
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('a[href*="/p/"]')!).visibility)).toBe("visible");
  });
});

describe("the session never reaches Codex", () => {
  it("gives the display only to the sign-in window, never to the shared child environment", () => {
    const base = { PATH: "/usr/bin", HOME: "/home/x", DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0", XAUTHORITY: "/home/x/.Xauthority" };
    const shared = childEnvironment(base);
    expect(shared.DISPLAY).toBeUndefined();
    expect(shared.WAYLAND_DISPLAY).toBeUndefined();
    expect(shared.XAUTHORITY).toBeUndefined();
    expect(displayEnvironment(base)).toEqual({ DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0", XAUTHORITY: "/home/x/.Xauthority" });
    expect(childEnvironment(base, displayEnvironment(base)).DISPLAY).toBe(":0");
  });

  it("keeps the browser profile out of the worker, Codex and child environments", () => {
    for (const f of ["lib/design-agent/codex.ts", "lib/design-agent/worker/run.ts", "lib/design-agent/worker/env.ts", "scripts/sales-design-worker/worker.ts"]) {
      const text = readFileSync(join(REPO, f), "utf8");
      expect(text, f).not.toMatch(/sr-instagram-browser|design-agent\/browser|browser\/profile|browser\/session/);
    }
  });
});
