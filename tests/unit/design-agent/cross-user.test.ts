import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The Unix boundary between the worker / Claude / Codex user and the user
// that owns the signed-in Instagram browser profile (DEV-028 Phase 3), with
// REAL Linux users, laid out exactly as scripts/sales-design-capture/admin.sh
// installs them. Needs root to create the users: it runs in CI in its own
// step (sudo, SR_CROSS_USER_TEST=1) and in a root container; elsewhere it
// is skipped.

// Creating users (useradd -m) takes a while on a CI runner.
vi.setConfig({ hookTimeout: 180_000, testTimeout: 60_000 });

const enabled = process.getuid?.() === 0 && process.env.SR_CROSS_USER_TEST === "1";
if (process.env.SR_CROSS_USER_TEST === "1" && !enabled) throw new Error("SR_CROSS_USER_TEST=1 needs root (the step would skip silently)");
const CANARY = "CANARY-CROSS-USER-COOKIE-3d81";
const HELPER = "srx-igcapture";
const REQUESTER = "srx-designgen";
const GROUP = "srx-capture";

const sh = (cmd: string) => spawnSync("sh", ["-c", cmd], { encoding: "utf8" });
/** Runs a shell snippet as the requester; returns its stdout (one word per check). */
const asRequester = (script: string) => spawnSync("runuser", ["-u", REQUESTER, "--", "sh", "-c", script], { encoding: "utf8" });

describe.skipIf(!enabled)("the capture user's files are out of the requester's reach (real users)", () => {
  let spool: string;
  let holder: ChildProcess | undefined;
  const helperHome = `/home/${HELPER}`;
  const cookie = `${helperHome}/.local/share/sr-instagram-browser/Default/Cookies`;

  beforeAll(() => {
    for (const cmd of [
      `getent group ${GROUP} >/dev/null || groupadd --system ${GROUP}`,
      `id ${HELPER} >/dev/null 2>&1 || useradd -m -s /bin/bash ${HELPER}`,
      `id ${REQUESTER} >/dev/null 2>&1 || useradd -m -s /bin/bash ${REQUESTER}`,
      `usermod -aG ${GROUP} ${REQUESTER}`,
      `usermod -aG ${GROUP} ${HELPER}`,
      `chmod 700 ${helperHome}`,
      `runuser -u ${HELPER} -- sh -c 'mkdir -p ~/.local/share/sr-instagram-browser/Default && chmod 700 ~/.local/share/sr-instagram-browser && printf %s ${CANARY} > ~/.local/share/sr-instagram-browser/Default/Cookies && chmod 600 ~/.local/share/sr-instagram-browser/Default/Cookies'`,
    ]) {
      const r = sh(cmd);
      if (r.status !== 0) throw new Error(`setup failed: ${cmd}`);
    }
    spool = mkdtempSync("/srv/sr-capture-test-");
    sh(`chmod 755 ${spool} && install -d -o ${HELPER} -g ${GROUP} -m 3730 ${spool}/requests && install -d -o ${HELPER} -g ${GROUP} -m 2750 ${spool}/results && chmod 3730 ${spool}/requests && chmod 2750 ${spool}/results`);
    // an earlier request of "someone else" (private to its writer) and an answered result
    sh(`runuser -u ${HELPER} -- sh -c 'printf x > ${spool}/requests/other.json; chmod 600 ${spool}/requests/other.json; mkdir -m 750 ${spool}/results/job-1 && printf ok > ${spool}/results/job-1/status.json && chmod 640 ${spool}/results/job-1/status.json'`);
    // a process of the capture user holding the cookie open, with its cwd in the profile (like Chromium)
    holder = spawn("runuser", ["-u", HELPER, "--", "sh", "-c", `cd ~/.local/share/sr-instagram-browser/Default && SECRET=${CANARY} exec sleep 600 < Cookies`], { stdio: "ignore" });
  });
  afterAll(() => {
    holder?.kill("SIGKILL");
    sh(`pkill -u ${HELPER} sleep; rm -rf ${spool}`);
  });

  it("cannot read the profile, by path, link, /proc of the capture user's processes or a hard link", async () => {
    await new Promise((r) => setTimeout(r, 300));
    const out = asRequester(`
      cat ${cookie} 2>/dev/null && echo READ_DIRECT
      ls ${helperHome} >/dev/null 2>&1 && echo LIST_HOME
      ln -s ${cookie} ~/l 2>/dev/null; cat ~/l 2>/dev/null && echo READ_LINK
      ln ${cookie} ~/h 2>/dev/null && echo HARDLINK
      for p in $(pgrep -u ${HELPER}); do
        cat /proc/$p/environ 2>/dev/null | grep -q CANARY && echo PROC_ENVIRON
        cat /proc/$p/cwd/Cookies 2>/dev/null && echo PROC_CWD
        cat /proc/$p/fd/0 2>/dev/null && echo PROC_FD
        cat /proc/$p/root${cookie} 2>/dev/null && echo PROC_ROOT
        cat /proc/$p/mem 2>/dev/null >/dev/null && echo PROC_MEM
      done
      echo DONE`);
    expect(out.stdout.trim().split("\n")).toEqual(["DONE"]);
    expect(out.stdout).not.toContain(CANARY);
  });

  it("can only create a request: not list, read, replace or delete others', and not write results", () => {
    const out = asRequester(`
      printf '{}' > ${spool}/requests/mine.json && echo CREATE_OK
      ls ${spool}/requests >/dev/null 2>&1 && echo LIST
      cat ${spool}/requests/other.json 2>/dev/null && echo READ_OTHER
      rm -f ${spool}/requests/other.json 2>/dev/null; [ -e ${spool}/requests/other.json ] || echo DELETED_OTHER
      mv ${spool}/requests/mine.json ${spool}/requests/other.json 2>/dev/null && echo REPLACED_OTHER
      printf x > ${spool}/results/planted 2>/dev/null && echo WRITE_RESULTS
      ln -s ${cookie} ${spool}/results/job-1/profile.png 2>/dev/null && echo LINK_IN_RESULT
      printf x > ${spool}/results/job-1/status.json 2>/dev/null && echo OVERWRITE_STATUS
      cat ${spool}/results/job-1/status.json >/dev/null && echo READ_RESULT_OK
      echo DONE`);
    expect(out.stdout.trim().split("\n")).toEqual(["CREATE_OK", "READ_RESULT_OK", "DONE"]);
  });

  it("a request written by the requester's client is readable by the helper (through the spool group), not by others", () => {
    asRequester(`umask 077; printf '{}' > ${spool}/requests/r2.json && chmod 640 ${spool}/requests/r2.json`);
    expect(spawnSync("runuser", ["-u", HELPER, "--", "cat", `${spool}/requests/r2.json`], { encoding: "utf8" }).stdout).toBe("{}");
    expect(spawnSync("runuser", ["-u", "nobody", "--", "cat", `${spool}/requests/r2.json`]).status).not.toBe(0);
  });

  it("is not in the capture user's own group and cannot become that user", () => {
    const out = asRequester(`
      id -nG | tr ' ' '\\n' | grep -qx ${HELPER} && echo IN_HELPER_GROUP
      sudo -n -u ${HELPER} true 2>/dev/null && echo SUDO_HELPER
      su -c true ${HELPER} </dev/null 2>/dev/null && echo SU_HELPER
      echo DONE`);
    expect(out.stdout.trim().split("\n")).toEqual(["DONE"]);
  });

  it("the spool layout matches what the helper requires (checkSpool)", async () => {
    const { checkSpool } = await import("@/lib/design-agent/capture-helper/helper");
    const uid = Number(sh(`id -u ${HELPER}`).stdout.trim());
    await expect(checkSpool(spool, uid)).resolves.toBeUndefined();
    await expect(checkSpool(spool, Number(sh(`id -u ${REQUESTER}`).stdout.trim()))).rejects.toMatchObject({ code: "SPOOL_UNSAFE" });
    expect(join(spool, "requests")).toMatch(/requests$/);
  });
});

describe.skipIf(!enabled)("a real round trip between the two users (requester client ↔ helper)", () => {
  it("the requester reads the helper's status and PNGs through the spool group", async () => {
    const { build } = await import("esbuild");
    // (the users exist from the suite above; a fresh spool laid out as admin.sh does)
    const spool = mkdtempSync("/srv/sr-capture-rt-");
    sh(`chmod 755 ${spool} && install -d -o ${HELPER} -g ${GROUP} -m 3730 ${spool}/requests && install -d -o ${HELPER} -g ${GROUP} -m 2750 ${spool}/results && chmod 3730 ${spool}/requests && chmod 2750 ${spool}/results`);
    const work = mkdtempSync("/tmp/sr-xu-");
    sh(`chmod 755 ${work}`);
    const repo = process.cwd();
    writeFileSync(
      join(work, "helper-entry.ts"),
      `import { runCaptureHelper, writeResult } from ${JSON.stringify(join(repo, "lib/design-agent/capture-helper/helper"))};
import { userInfo } from "node:os";
import { writeFileSync, mkdirSync } from "node:fs";
const [spool] = process.argv.slice(2);
const home = userInfo().homedir;
const env = { repoDir: "/nonexistent-repo", home, uid: process.getuid(), user: userInfo().username, expectedUser: userInfo().username };
(async () => {
  const run = await runCaptureHelper({ spoolRoot: spool, profileDir: home + "/.local/share/no-profile-yet", stateDir: home + "/state", workRoot: home + "/work", env,
    launchPersistent: async () => { throw new Error("never"); }, sleep: async () => {}, limits: { perRun: 3, minIntervalMs: 0, perDay: 30 } });
  mkdirSync(home + "/png", { recursive: true });
  const png = home + "/png/profile.png";
  writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
  await writeResult(spool + "/results", "job-png", { code: "CAPTURED", files: [], softened: 2 }, [png], new Date());
  console.log(JSON.stringify(run.processed));
})();`,
    );
    writeFileSync(
      join(work, "client-entry.ts"),
      `import { requestCapture } from ${JSON.stringify(join(repo, "lib/design-agent/capture-helper/client"))};
import { userInfo } from "node:os";
const [spool, id, timeout] = process.argv.slice(2);
requestCapture({ requestId: id, url: "https://www.instagram.com/li_shop/", destDir: userInfo().homedir + "/got-" + id, spoolRoot: spool, timeoutMs: Number(timeout), pollMs: 200 })
  .then((r) => console.log(JSON.stringify({ code: r.code, reason: r.reason, files: r.files.map((f) => f.split("/").pop()) })));`,
    );
    for (const name of ["helper", "client"]) {
      await build({ entryPoints: [join(work, `${name}-entry.ts`)], bundle: true, platform: "node", format: "cjs", outfile: join(work, `${name}.cjs`), external: ["playwright"], logLevel: "silent" });
    }
    sh(`chmod 644 ${work}/*.cjs`);
    const node = process.execPath;
    sh(`rm -rf /home/${HELPER}/state /home/${HELPER}/work`); // (users persist between local runs)
    // 1. the requester asks (and waits); 2. the helper answers as its own user; 3. the requester reads the answer
    const asking = spawn("runuser", ["-u", REQUESTER, "--", node, join(work, "client.cjs"), spool, "job-rt", "20000"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    asking.stdout.on("data", (d) => (out += d));
    await new Promise((r) => setTimeout(r, 1500));
    const helper = spawnSync("runuser", ["-u", HELPER, "--", node, join(work, "helper.cjs"), spool], { encoding: "utf8" });
    expect(helper.status, helper.stderr).toBe(0);
    expect(JSON.parse(helper.stdout.trim())).toEqual([{ requestId: "job-rt", code: "LOGIN_REQUIRED" }]);
    await new Promise((r) => asking.on("close", r));
    expect(JSON.parse(out.trim())).toEqual({ code: "LOGIN_REQUIRED", reason: "NO_PROFILE", files: [] });
    const got = spawnSync("runuser", ["-u", REQUESTER, "--", node, join(work, "client.cjs"), spool, "job-png", "2000"], { encoding: "utf8" });
    expect(JSON.parse(got.stdout.trim())).toEqual({ code: "CAPTURED", files: ["profile.png"] });
    sh(`rm -rf ${work} ${spool}`);
  });
});
