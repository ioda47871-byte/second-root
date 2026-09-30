/**
 * Dedicated Instagram browser of the design worker (DEV-028 PoC). Run by hand
 * as the WSL worker user; see docs/operations/design-browser-wsl.md.
 *
 *   npm run -s sales:design-browser -- login
 *   npm run -s sales:design-browser -- capture --source-file ~/sr-design-input/<shop>/source.json
 *   npm run -s sales:design-browser -- check
 *
 * login opens a visible Chromium on the dedicated profile; a person signs in
 * by hand. capture takes at most three privacy-processed screenshots of one
 * public profile with that session. Output is codes, counts and the capture
 * directory only: never a cookie, a session value, the profile path's
 * contents or the source URL.
 */
import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { chromium } from "playwright";
import { checkProfileLocation, checkProfileTree, currentProfileEnv, DEFAULT_PROFILE_DIR, ProfileError, purgeOldCaptures } from "../../lib/design-agent/browser/profile";
import { runLogin, runSignedInCapture, type LaunchPersistent } from "../../lib/design-agent/browser/session";
import { instagramTarget } from "../../lib/design-agent/worker/capture";
import { parseInstagramProfileUrl } from "../../lib/design-agent/worker/source-url";

const REPO = resolve(__dirname, "../..");
process.umask(0o077);

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--") ? argv[i + 1] : undefined;
};
const expand = (p: string) => resolve(p.replace(/^~(?=$|\/)/, homedir()));
const insideRepo = (p: string) => !relative(REPO, p).startsWith("..");
const say = (line: string) => process.stdout.write(`${line}\n`);

const profileDir = DEFAULT_PROFILE_DIR;
const stateDir = join(expand(process.env.XDG_STATE_HOME ?? "~/.local/state"), "sr-design-worker");
const capturesRoot = expand("~/.local/share/second-root-design/browser-captures");

const launchPersistent: LaunchPersistent = (dir, options) =>
  chromium.launchPersistentContext(dir, {
    ...options,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : { channel: "chromium" }),
  });

async function login(): Promise<number> {
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    say("DISPLAY_UNAVAILABLE (WSLg is needed for the sign-in window)");
    return 2;
  }
  say("A Chromium window opens on instagram.com. Sign in there by hand; this tool never types or clicks.");
  say("When the signed-in home appears, the window closes by itself (or close it to cancel).");
  const code = await runLogin({ profileDir, stateDir, env: currentProfileEnv(REPO), launchPersistent });
  say(code);
  return code === "LOGIN_OK" ? 0 : code === "BROWSER_BUSY" ? 3 : 5;
}

async function capture(): Promise<number> {
  const sourceFile = flag("source-file");
  if (!sourceFile) {
    say("usage: capture --source-file <file.json with instagram_url>");
    return 2;
  }
  const sourcePath = expand(sourceFile);
  if (insideRepo(sourcePath)) {
    say("SOURCE_FILE_IN_REPO (keep it outside the repository)");
    return 2;
  }
  let raw: unknown;
  try {
    raw = (JSON.parse(await readFile(sourcePath, "utf8")) as { instagram_url?: unknown }).instagram_url;
  } catch {
    say("SOURCE_FILE_INVALID");
    return 2;
  }
  const source = parseInstagramProfileUrl(raw);
  if (!source) {
    say("SOURCE_URL_INVALID (https://www.instagram.com/<profile>/ only)");
    return 2;
  }
  await purgeOldCaptures(capturesRoot);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const outDir = join(capturesRoot, stamp);
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  let result: Awaited<ReturnType<typeof runSignedInCapture>>;
  try {
    result = await runSignedInCapture({ profileDir, stateDir, env: currentProfileEnv(REPO), target: instagramTarget(source), outDir, launchPersistent });
  } catch (error) {
    await rm(outDir, { recursive: true, force: true });
    throw error;
  }
  if (result.code !== "CAPTURED") {
    await rm(outDir, { recursive: true, force: true });
    say(result.reason ? `${result.code} (${result.reason})` : result.code);
    return result.code === "LOGIN_REQUIRED" ? 5 : result.code === "INSTAGRAM_CHALLENGE" || result.code === "INSTAGRAM_CAPTCHA" ? 6 : result.code === "BROWSER_BUSY" ? 3 : 4;
  }
  say(`CAPTURED ${result.files.length} image(s), ${result.softened} media area(s) softened`);
  say(`  ${outDir}  (deleted automatically after 24 hours; never copy these into the repository or a demo)`);
  return 0;
}

async function check(): Promise<number> {
  const env = currentProfileEnv(REPO);
  await checkProfileLocation(profileDir, env);
  if (!(await lstat(profileDir).catch(() => null))) {
    say("PROFILE_MISSING (run login first)");
    return 5;
  }
  await checkProfileTree(profileDir, env, { tighten: false });
  say("PROFILE_OK");
  return 0;
}

const command = argv[0];
const main = command === "login" ? login : command === "capture" ? capture : command === "check" ? check : null;
if (!main) {
  say("usage: login | capture --source-file <file> | check");
  process.exit(2);
}
main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    say(error instanceof ProfileError ? error.code : "BROWSER_TOOL_FAILED");
    process.exit(2);
  },
);
