import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ProfileEnv } from "@/lib/design-agent/browser/profile";
import { runLogin, type LaunchPersistent } from "@/lib/design-agent/browser/session";
import { requestCapture } from "@/lib/design-agent/capture-helper/client";
import { checkSpool, runCaptureHelper, type HelperOptions } from "@/lib/design-agent/capture-helper/helper";
import { startMockSite, type MockSite } from "./worker-support";

// The capture helper's spool interface (DEV-028 Phase 3), same Linux user
// here (the cross-user boundary itself is tested in cross-user.test.ts).
// Fictional mock pages only.

vi.setConfig({ testTimeout: 90_000 });
const REPO = resolve(__dirname, "../../..");
const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {};
const launchPersistent: LaunchPersistent = (dir, options) => chromium.launchPersistentContext(dir, { ...options, headless: true, ...exe });
const CANARY = "CANARY-HELPER-SECRET-91b2";

let site: MockSite;
beforeAll(async () => {
  site = await startMockSite();
});
afterAll(() => site.server.close());

function layout() {
  const root = mkdtempSync(join(tmpdir(), "sr-helper-"));
  chmodSync(root, 0o700);
  const home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  const spool = join(root, "spool");
  mkdirSync(spool, { mode: 0o755 });
  mkdirSync(join(spool, "requests"));
  chmodSync(join(spool, "requests"), 0o3730);
  mkdirSync(join(spool, "results"));
  chmodSync(join(spool, "results"), 0o2750);
  const env: ProfileEnv = { repoDir: REPO, home, uid: process.getuid?.(), user: userInfo().username, expectedUser: userInfo().username };
  const options: HelperOptions = {
    spoolRoot: spool,
    profileDir: join(home, ".local", "share", "sr-instagram-browser"),
    stateDir: join(home, "state"),
    workRoot: join(home, "work"),
    env,
    launchPersistent,
    settleMs: 300,
    sleep: async () => undefined,
    limits: { perRun: 3, minIntervalMs: 0, perDay: 30 },
    targetFor: (source) => site.target(source.username),
  };
  return { root, home, spool, env, options, out: join(root, "out") };
}

async function signIn(l: ReturnType<typeof layout>) {
  await runLogin({ profileDir: l.options.profileDir, stateDir: l.options.stateDir, env: l.env, launchPersistent, startUrl: `${site.origin}/home_signed_in/`, pollMs: 200 });
}

/** A request answered by one helper run, as the two sides do it (the client polls while the helper runs). */
async function ask(l: ReturnType<typeof layout>, requestId: string, url: string, over: Partial<HelperOptions> = {}) {
  const pending = requestCapture({ requestId, url, destDir: join(l.out, requestId), spoolRoot: l.spool, timeoutMs: 60_000, pollMs: 100 });
  for (let i = 0; i < 50 && !existsSync(join(l.spool, "requests", `${requestId}.json`)); i += 1) await new Promise((r) => setTimeout(r, 50));
  const run = await runCaptureHelper({ ...l.options, ...over });
  return { result: await pending, run };
}

describe("capture helper: one request, one privacy-processed answer", () => {
  it("captures with the helper's profile and hands back only fixed-name PNGs and codes", async () => {
    const l = layout();
    await signIn(l);
    const { result, run } = await ask(l, "job-001", "https://www.instagram.com/li_shop/");
    expect(run.processed).toEqual([{ requestId: "job-001", code: "CAPTURED" }]);
    expect(result.code).toBe("CAPTURED");
    expect(result.files.map((f) => f.split("/").pop())).toEqual(["profile.png", "grid-top.png", "grid-lower.png"]);
    for (const f of result.files) expect(readFileSync(f).subarray(1, 4).toString()).toBe("PNG");
    const dir = join(l.spool, "results", "job-001");
    expect(readdirSync(dir).sort()).toEqual(["grid-lower.png", "grid-top.png", "profile.png", "status.json"]);
    expect(statSync(dir).mode & 0o777).toBe(0o750);
    for (const name of readdirSync(dir)) expect(statSync(join(dir, name)).mode & 0o777).toBe(0o640);
    const status = readFileSync(join(dir, "status.json"), "utf8");
    expect(status).not.toMatch(/li_shop|instagram|http|127\.0\.0\.1|sr-instagram-browser|cookie|session/i);
    // the request is gone, the helper's own working copy too
    expect(readdirSync(join(l.spool, "requests"))).toEqual([]);
    expect(readdirSync(l.options.workRoot)).toEqual([]);
  });

  it("never signs in: no session means LOGIN_REQUIRED, and later requests wait for a person", async () => {
    const l = layout();
    const first = requestCapture({ requestId: "job-a", url: "https://www.instagram.com/li_shop/", destDir: join(l.out, "a"), spoolRoot: l.spool, timeoutMs: 30_000, pollMs: 100 });
    const second = requestCapture({ requestId: "job-b", url: "https://www.instagram.com/li_shop/", destDir: join(l.out, "b"), spoolRoot: l.spool, timeoutMs: 1_500, pollMs: 100 });
    await new Promise((r) => setTimeout(r, 300));
    const run = await runCaptureHelper(l.options);
    expect(await first).toMatchObject({ code: "LOGIN_REQUIRED", reason: "NO_PROFILE", files: [] });
    expect(run.processed).toEqual([{ requestId: "job-a", code: "LOGIN_REQUIRED" }]);
    expect((await second).code).toBe("CAPTURE_HELPER_TIMEOUT");
    expect(existsSync(l.options.profileDir)).toBe(false); // nothing created, nothing typed
  });

  it("limits how much it can be asked: per run, per day", async () => {
    const l = layout();
    await signIn(l);
    const asks = ["job-1", "job-2"].map((id) => requestCapture({ requestId: id, url: "https://www.instagram.com/li_shop/", destDir: join(l.out, id), spoolRoot: l.spool, timeoutMs: 1_500, pollMs: 100 }));
    await new Promise((r) => setTimeout(r, 300));
    const run = await runCaptureHelper({ ...l.options, limits: { perRun: 1, minIntervalMs: 0, perDay: 30 } });
    expect(run.processed).toHaveLength(1);
    expect(run.deferred).toBe(1);
    await Promise.all(asks);
    const capped = await ask(l, "job-3", "https://www.instagram.com/li_shop/", { limits: { perRun: 3, minIntervalMs: 0, perDay: 1 } });
    expect(capped.result.code).toBe("RATE_CAPPED");
    // the pause between captures is honoured
    const waits: number[] = [];
    const paced = await ask(l, "job-4", "https://www.instagram.com/li_shop/", { limits: { perRun: 3, minIntervalMs: 60_000, perDay: 30 }, sleep: async (ms) => void waits.push(ms) });
    expect(paced.run.processed).toEqual([{ requestId: "job-4", code: "CAPTURED" }]);
    expect(waits.length).toBe(1);
    expect(waits[0]).toBeGreaterThan(50_000);
  });
});

describe("capture helper: what a requester cannot do", () => {
  const write = (l: ReturnType<typeof layout>, name: string, body: unknown) => writeFileSync(join(l.spool, "requests", name), typeof body === "string" ? body : JSON.stringify(body));
  const ok = (id: string, url = "https://www.instagram.com/li_shop/") => ({ version: 1, request_id: id, kind: "instagram_profile", url });

  it("answers REQUEST_INVALID for links, hard links, FIFOs, directories, oversize, extra fields, other URLs and id mismatches", async () => {
    const l = layout();
    await signIn(l);
    const secret = join(l.home, "secret.txt");
    writeFileSync(secret, JSON.stringify({ ...ok("job-link"), note: CANARY }));
    symlinkSync(secret, join(l.spool, "requests", "job-link.json"));
    const hard = join(l.home, "hard.json");
    writeFileSync(hard, JSON.stringify(ok("job-hard")));
    linkSync(hard, join(l.spool, "requests", "job-hard.json"));
    spawnSync("mkfifo", [join(l.spool, "requests", "job-fifo.json")]);
    mkdirSync(join(l.spool, "requests", "job-dir.json"));
    write(l, "job-big.json", JSON.stringify(ok("job-big")) + " ".repeat(5000));
    write(l, "job-extra.json", { ...ok("job-extra"), out: "/tmp/x", args: ["--dump"] });
    write(l, "job-file.json", ok("job-file", "file:///etc/passwd"));
    write(l, "job-other.json", ok("job-other", "https://example.com/"));
    write(l, "job-post.json", ok("job-post", "https://www.instagram.com/p/abc/"));
    write(l, "job-cmd.json", ok("job-cmd", "https://www.instagram.com/$(id)/"));
    write(l, "job-mismatch.json", ok("job-other-id"));
    write(l, "not-a-request", "x");
    write(l, "..json", "x");
    const run = await runCaptureHelper({ ...l.options, limits: { perRun: 20, minIntervalMs: 0, perDay: 30 } });
    const codes = Object.fromEntries(run.processed.map((p) => [p.requestId, p.code]));
    for (const id of ["job-link", "job-hard", "job-fifo", "job-dir", "job-big", "job-extra", "job-file", "job-other", "job-post", "job-cmd", "job-mismatch"]) expect(codes[id], id).toBe("REQUEST_INVALID");
    // nothing was captured, nothing from the linked file came back, the spool is clean
    expect(Object.values(codes).every((c) => c === "REQUEST_INVALID")).toBe(true);
    expect(spawnSync("grep", ["-r", CANARY, l.spool]).status).not.toBe(0);
    expect(readdirSync(join(l.spool, "requests"))).toEqual([]);
    expect(readFileSync(secret, "utf8")).toContain(CANARY); // the link's target is untouched
  });

  it("never walks into what a requester put in requests/ (no deletion outside the spool through links), and odd entries never stop a valid request", async () => {
    const l = layout();
    await signIn(l);
    const victim = join(l.home, "victim");
    mkdirSync(victim);
    for (let i = 0; i < 5; i += 1) writeFileSync(join(victim, `f${i}`), CANARY);
    const req = join(l.spool, "requests");
    mkdirSync(join(req, "zz"));
    symlinkSync(victim, join(req, "zz", "sub")); // a directory holding a link to the helper's own files
    symlinkSync(victim, join(req, "zz2")); // a link straight to them
    mkdirSync(join(req, "job-full.json"));
    writeFileSync(join(req, "job-full.json", "x"), "x"); // a non-empty directory named like a request
    write(l, "job-good.json", ok("job-good"));
    const run = await runCaptureHelper(l.options);
    expect(readdirSync(victim).sort()).toEqual(["f0", "f1", "f2", "f3", "f4"]);
    expect(run.processed).toContainEqual({ requestId: "job-good", code: "CAPTURED" });
    expect(run.processed).toContainEqual({ requestId: "job-full", code: "REQUEST_INVALID" });
  });

  it("after a sign-in wall it does not open the browser again until a person signs in", async () => {
    const l = layout();
    let launches = 0;
    const counting: typeof launchPersistent = (dir, o) => ((launches += 1), launchPersistent(dir, o));
    await signIn(l);
    // the session "expires": a signed-out page is a login wall
    const first = await ask(l, "job-w1", "https://www.instagram.com/few_posts/", { launchPersistent: counting });
    expect(first.result.code).toBe("LOGIN_REQUIRED");
    const before = launches;
    const second = await ask(l, "job-w2", "https://www.instagram.com/li_shop/", { launchPersistent: counting });
    expect(second.result).toMatchObject({ code: "LOGIN_REQUIRED", reason: "WAITING_FOR_PERSON" });
    expect(launches).toBe(before);
    // a person signs in (sales:design-browser login removes the wall)
    spawnSync("rm", ["-f", join(l.options.stateDir, "wall.json")]);
    expect((await ask(l, "job-w3", "https://www.instagram.com/li_shop/", { launchPersistent: counting })).result.code).toBe("CAPTURED");
  });

  it("result files carry the spool's group (setgid kept), so the requester can read them", async () => {
    const l = layout();
    await signIn(l);
    await ask(l, "job-grp", "https://www.instagram.com/li_shop/");
    const results = statSync(join(l.spool, "results"));
    const dir = statSync(join(l.spool, "results", "job-grp"));
    expect(dir.mode & 0o2000).toBe(0o2000);
    expect(dir.gid).toBe(results.gid);
    for (const name of readdirSync(join(l.spool, "results", "job-grp"))) expect(statSync(join(l.spool, "results", "job-grp", name)).gid).toBe(results.gid);
  });

  it("does nothing at all when the spool is not exactly as installed", async () => {
    const l = layout();
    chmodSync(join(l.spool, "requests"), 0o0777);
    await expect(runCaptureHelper(l.options)).rejects.toMatchObject({ code: "SPOOL_UNSAFE" });
    chmodSync(join(l.spool, "requests"), 0o3730);
    chmodSync(join(l.spool, "results"), 0o2770);
    await expect(checkSpool(l.spool, l.env.uid)).rejects.toMatchObject({ code: "SPOOL_UNSAFE" });
    chmodSync(join(l.spool, "results"), 0o2750);
    await expect(checkSpool(l.spool, (l.env.uid ?? 0) + 1)).rejects.toMatchObject({ code: "SPOOL_UNSAFE" });
    await expect(checkSpool(l.spool, l.env.uid)).resolves.toBeUndefined();
  });

  it("the client refuses bad ids and URLs before writing anything, and a planted or malformed result", async () => {
    const l = layout();
    for (const [id, url] of [
      ["../../etc", "https://www.instagram.com/li_shop/"],
      ["job-ok", "https://evil.example/"],
      ["job-ok", "https://www.instagram.com/accounts/login/"],
    ]) {
      expect((await requestCapture({ requestId: id!, url: url!, destDir: join(l.out, "x"), spoolRoot: l.spool, timeoutMs: 100 })).code).toBe("CAPTURE_REQUEST_INVALID");
    }
    expect(readdirSync(join(l.spool, "requests"))).toEqual([]);
    // a status that names a file outside the fixed set, and a status that is a link
    mkdirSync(join(l.spool, "results", "job-bad"), { mode: 0o750 });
    writeFileSync(join(l.spool, "results", "job-bad", "status.json"), JSON.stringify({ version: 1, request_id: "job-bad", code: "CAPTURED", files: ["../../../home/x/Cookies"], softened: 0, finished_at: "x" }));
    expect((await requestCapture({ requestId: "job-bad", url: "https://www.instagram.com/li_shop/", destDir: join(l.out, "bad"), spoolRoot: l.spool, timeoutMs: 100 })).code).toBe("CAPTURE_RESULT_INVALID");
    mkdirSync(join(l.spool, "results", "job-lnk"), { mode: 0o750 });
    writeFileSync(join(l.home, "fake-status.json"), JSON.stringify({ version: 1, request_id: "job-lnk", code: "CAPTURED", files: ["profile.png"], softened: 0, finished_at: "x" }));
    symlinkSync(join(l.home, "fake-status.json"), join(l.spool, "results", "job-lnk", "status.json"));
    expect((await requestCapture({ requestId: "job-lnk", url: "https://www.instagram.com/li_shop/", destDir: join(l.out, "lnk"), spoolRoot: l.spool, timeoutMs: 300, pollMs: 100 })).code).toBe("CAPTURE_HELPER_TIMEOUT");
    expect(existsSync(join(l.out, "lnk", "profile.png"))).toBe(false);
  });

  it("deletes results after a day", async () => {
    const l = layout();
    mkdirSync(join(l.spool, "results", "job-old"), { mode: 0o750 });
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    utimesSync(join(l.spool, "results", "job-old"), old, old);
    const run = await runCaptureHelper(l.options);
    expect(run.removedResults).toBe(1);
    expect(existsSync(join(l.spool, "results", "job-old"))).toBe(false);
  });
});
