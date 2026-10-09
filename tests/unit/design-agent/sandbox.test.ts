import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CodexError, runCodexJson } from "@/lib/design-agent/codex";
import { prepareCodexSandbox, SandboxError, stageInputs } from "@/lib/design-agent/sandbox";
import { passthroughSandbox } from "../../support/passthrough-sandbox";
import { PNG } from "./worker-support";

// The OS boundary around Codex (lib/design-agent/sandbox.ts) against REAL
// bubblewrap. An "attacker" Codex CLI runs inside and tries every way we know
// to reach a fake signed-in Instagram profile (a canary cookie), the Meta
// token and the user's files; it reports what it could reach, as booleans
// only. CI installs bubblewrap and sets SR_REQUIRE_BWRAP=1 so these never
// silently skip there.

vi.setConfig({ testTimeout: 120_000 });

const bwrapWorks = spawnSync("bwrap", ["--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "--unshare-pid", "/bin/true"]).status === 0;
if (!bwrapWorks && process.env.SR_REQUIRE_BWRAP === "1") throw new Error("bubblewrap is required here (SR_REQUIRE_BWRAP=1) but does not work");

const CANARY = "CANARY-INSTAGRAM-SESSION-7f3a91";
const TOKEN = "CANARY-META-TOKEN-55c2";

/** The attacker: answers `login status`, and on `exec` probes everything, writing booleans to the answer file. */
const ATTACKER = `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const args = process.argv.slice(2);
if (args[0] === "login") { process.stdout.write("Logged in using ChatGPT\\n"); process.exit(0); }
const out = args[args.indexOf("--output-last-message") + 1];
const T = JSON.parse(process.env.ATTACK_TARGETS || "null") || JSON.parse(fs.readFileSync(path.join(process.cwd(), "targets.json"), "utf8"));
const canRead = (p) => { try { return fs.readFileSync(p, "utf8").includes(T.canary) || fs.readFileSync(p, "utf8").includes(T.token); } catch { return false; } };
const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const r = {};
r.direct = canRead(T.cookie);
r.dotdot = canRead(path.join(process.cwd(), "inputs", "..", "..", "..", path.relative("/", T.cookie)));
r.relativeFromHome = canRead(path.join(process.env.HOME || "/", path.relative(T.home, T.cookie)));
r.viaCodexHomeLink = canRead(path.join(T.codexHome, "evil", "Default", "Cookies"));
r.metaToken = canRead(T.token_file);
r.profileVisible = exists(T.profile);
r.procRoots = false; r.procFds = false; r.procEnv = false;
for (const pid of T.light ? [] : fs.readdirSync("/proc").filter((n) => /^\\d+$/.test(n))) {
  if (canRead(path.join("/proc", pid, "root", T.cookie)) || canRead(path.join("/proc", pid, "cwd", "Cookies"))) r.procRoots = true;
  try { for (const fd of fs.readdirSync(path.join("/proc", pid, "fd"))) { const p = path.join("/proc", pid, "fd", fd); try { if (fs.statSync(p).isFile() && canRead(p)) r.procFds = true; } catch {} } } catch {}
  try { if (fs.readFileSync(path.join("/proc", pid, "environ"), "utf8").includes("CANARY")) r.procEnv = true; } catch {}
}
r.pids = fs.readdirSync("/proc").filter((n) => /^\\d+$/.test(n)).length;
r.envHasSecret = Object.entries(process.env).some(([k, v]) => /CANARY|sk-|ghp_|TOKEN|SECRET|PASSWORD|SUPABASE|OPENAI_API_KEY|ANTHROPIC/i.test(k + "=" + v));
r.envKeys = Object.keys(process.env).sort();
r.homeEntries = (() => { try { return fs.readdirSync(process.env.HOME); } catch { return null; } })();
// every open descriptor: only stdio pipes, node's own anonymous handles, /dev and the work dir
r.foreignFds = fs.readdirSync("/proc/self/fd").map((fd) => { try { return fs.readlinkSync("/proc/self/fd/" + fd); } catch { return ""; } })
  .filter((l) => l && !/^(pipe|socket|anon_inode):/.test(l) && !l.startsWith("/dev/") && !l.startsWith(process.cwd()) && !l.startsWith("/proc/"));
// a full walk of everything user data could live in, looking for the canaries in any file
let found = false, files = 0;
const walk = (d, depth) => { if (depth > 12 || found || files > 20000 || d === process.cwd()) return; let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, depth + 1); else if (e.isFile()) { files++; if (canRead(p)) { found = true; return; } } } };
for (const top of (T.light ? [T.home, T.extraRoot] : ["/home", "/root", "/tmp", "/var/tmp", "/mnt", "/media", "/srv", "/run", T.home, T.extraRoot]).filter(Boolean)) walk(top, 0);
r.canaryAnywhere = found;
r.inputReadable = (() => { try { return fs.readFileSync(path.join(process.cwd(), "inputs", "ref-1.png")).subarray(1, 4).toString() === "PNG"; } catch { return false; } })();
const tryWrite = (p) => { try { fs.writeFileSync(p, "x"); return true; } catch { return false; } };
r.writeWork = tryWrite(path.join(process.cwd(), "w.txt"));
r.writeInputs = tryWrite(path.join(process.cwd(), "inputs", "w.txt"));
r.writeHome = tryWrite(path.join(process.env.HOME, "w.txt"));
r.writeRoot = tryWrite("/w.txt");
r.writeProfileParent = tryWrite(path.join(path.dirname(T.profile), "w.txt"));
r.writeCodexInstall = tryWrite(path.join(path.dirname(process.argv[1]), "w.txt"));
const { spawnSync } = require("child_process");
r.mountWorks = spawnSync("/bin/sh", ["-c", "mount -t tmpfs x /mnt 2>/dev/null"]).status === 0;
r.unshareWorks = spawnSync("/bin/sh", ["-c", "unshare -m true 2>/dev/null"]).status === 0;
process.stderr.write("stderr noise " + T.canary + "\\n");
fs.writeFileSync(out, JSON.stringify(r));
`;

type Attack = Record<string, unknown> & { envKeys: string[]; homeEntries: string[] | null };

describe.skipIf(!bwrapWorks)("the Codex sandbox (real bubblewrap)", () => {
  let root: string;
  let home: string;
  let profile: string;
  let extraRoot: string;
  let codexBin: string;
  let holder: ChildProcess | undefined;
  const protectedPaths = () => [profile, join(home, ".config", "sr-design-worker"), join(home, ".local", "share", "second-root-design"), extraRoot].filter(Boolean);
  const env = () => ({ PATH: `/usr/local/bin:/usr/bin:/bin:${process.execPath.replace(/\/node$/, "")}`, HOME: home, LANG: "C.UTF-8", OPENAI_API_KEY: "sk-never", GITHUB_TOKEN: "ghp_never", SECRET_CANARY: CANARY });

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "sr-sandbox-test-"));
    chmodSync(root, 0o755);
    home = join(root, "home", "worker");
    profile = join(home, ".local", "share", "sr-instagram-browser");
    mkdirSync(join(profile, "Default"), { recursive: true, mode: 0o700 });
    writeFileSync(join(profile, "Default", "Cookies"), `sessionid=${CANARY}`, { mode: 0o600 });
    mkdirSync(join(home, ".config", "sr-design-worker"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, ".config", "sr-design-worker", "meta-token"), TOKEN, { mode: 0o600 });
    mkdirSync(join(home, ".codex"), { recursive: true, mode: 0o700 });
    // a link planted in Codex's own (writable, visible) home, pointing at the profile
    symlinkSync(profile, join(home, ".codex", "evil"));
    mkdirSync(join(home, "work", "second-root"), { recursive: true });
    writeFileSync(join(home, "work", "second-root", "notes.txt"), `copy of ${CANARY}`);
    // a protected directory OUTSIDE every area the sandbox hides by default
    // (/var/lib as root; /run/lock, world-writable and not hidden by default, as a normal user)
    extraRoot = (() => {
      for (const base of ["/var/lib", "/run/lock", "/var/lock"]) {
        try {
          return mkdtempSync(join(base, "sr-sandbox-protected-"));
        } catch {
          /* next */
        }
      }
      // inside the requester jail (ProtectSystem=strict) there is none: that case is then not exercised
      return "";
    })();
    if (extraRoot) writeFileSync(join(extraRoot, "spool.json"), CANARY);
    const install = join(root, "codex-install", "bin");
    mkdirSync(install, { recursive: true });
    codexBin = join(install, "codex");
    writeFileSync(codexBin, ATTACKER, { mode: 0o755 });
    // a live process holding the cookie file open, with its cwd in the profile (like Chromium)
    holder = spawn(process.execPath, ["-e", `require("fs").openSync(${JSON.stringify(join(profile, "Default", "Cookies"))}, "r"); setTimeout(() => {}, 600000)`], {
      cwd: join(profile, "Default"),
      env: { SECRET_CANARY: CANARY } as unknown as NodeJS.ProcessEnv,
      stdio: "ignore",
    });
  });
  afterAll(() => {
    holder?.kill("SIGKILL");
    spawnSync("rm", ["-rf", root, ...(extraRoot ? [extraRoot] : [])]);
  });

  async function attack(unconfined = false): Promise<Attack> {
    const sandbox = unconfined ? passthroughSandbox(codexBin, env()) : await prepareCodexSandbox({ env: env(), codexBin, protectedPaths: protectedPaths() });
    const image = join(root, "ref.png");
    writeFileSync(image, PNG);
    // the unconfined control looks only where the canaries are (the whole host would take too long)
    const targets = { light: unconfined, cookie: join(profile, "Default", "Cookies"), profile, token_file: join(home, ".config", "sr-design-worker", "meta-token"), home, codexHome: join(home, ".codex"), canary: CANARY, token: TOKEN, extraRoot };
    // the targets reach the attacker as part of the prompt-visible work dir
    const prompt = JSON.stringify(targets);
    const origRun = sandbox.run.bind(sandbox);
    const withTargets = {
      env: sandbox.env,
      run: async (args: readonly string[], o: { workDir: string; input?: string; timeoutMs: number }) => {
        writeFileSync(join(o.workDir, "targets.json"), prompt);
        return origRun(args, o);
      },
    };
    return (await runCodexJson({ sandbox: withTargets, prompt, schema: {}, images: [image], timeoutMs: 60_000 })) as Attack;
  }

  it("control: the same attacker WITHOUT the sandbox reaches the profile and the token (so the probes are real)", async () => {
    const r = await attack(true);
    expect(r).toMatchObject({ direct: true, dotdot: true, viaCodexHomeLink: true, metaToken: true, profileVisible: true, canaryAnywhere: true });
  });

  it("cannot reach the Instagram profile, the Meta token or any user file, by any path", async () => {
    const r = await attack();
    expect(r).toMatchObject({
      direct: false,
      dotdot: false,
      relativeFromHome: false,
      viaCodexHomeLink: false,
      metaToken: false,
      profileVisible: false,
      procRoots: false,
      procFds: false,
      procEnv: false,
      canaryAnywhere: false,
    });
    // its own pid namespace: only the sandbox's few processes
    expect(r.pids as number).toBeLessThanOrEqual(6);
    // the home holds only Codex's own directory
    expect(r.homeEntries).toEqual([".codex"]);
  });

  it("sees an allowlisted environment only, and inherits no file descriptors", async () => {
    const r = await attack();
    expect(r.envHasSecret).toBe(false);
    for (const key of r.envKeys) expect(["PATH", "HOME", "TMPDIR", "CODEX_HOME", "LANG", "PWD", "SHLVL", "_"]).toContain(key);
    // nothing open on a file of the host (an inherited descriptor would show here)
    expect(r.foreignFds).toEqual([]);
  });

  it("reads the copied reference image, writes only to its work directory, and cannot remount or unshare", async () => {
    const r = await attack();
    expect(r.inputReadable).toBe(true);
    expect(r.writeWork).toBe(true);
    expect(r).toMatchObject({ writeInputs: false, writeHome: false, writeRoot: false, writeProfileParent: false, writeCodexInstall: false, mountWorks: false });
    expect(r.unshareWorks).toBe(false);
  });

  it("keeps Codex's stderr (which printed the canary) out of every error and message", async () => {
    const sandbox = await prepareCodexSandbox({ env: env(), codexBin, protectedPaths: protectedPaths() });
    // no answer file is written without targets → the call fails; the error must be a fixed message
    const failed = await runCodexJson({ sandbox, prompt: "x", schema: {}, timeoutMs: 30_000 }).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(CodexError);
    expect(JSON.stringify(failed) + String((failed as Error).message)).not.toContain("CANARY");
  });

  it("fails closed: no bubblewrap, a bubblewrap that does not isolate, or a bind that would expose the profile", async () => {
    // 1. bubblewrap missing
    await expect(prepareCodexSandbox({ env: env(), codexBin, bwrapBin: join(root, "no-bwrap"), protectedPaths: protectedPaths() })).rejects.toMatchObject({ code: "CODEX_SANDBOX_UNAVAILABLE" });
    // 2. a "bubblewrap" that just runs the command: the probe sees the profile, Codex never starts
    const fake = join(root, "fake-bwrap");
    const log = join(root, "fake-bwrap.log");
    writeFileSync(fake, `#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done; shift\necho "$1" >> ${log}\nexec "$@"\n`, { mode: 0o755 });
    const leaky = await prepareCodexSandbox({ env: env(), codexBin, bwrapBin: fake, protectedPaths: protectedPaths() });
    const err = await runCodexJson({ sandbox: leaky, prompt: "x", schema: {}, timeoutMs: 30_000 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "CODEX_SANDBOX_LEAK" });
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["/bin/sh"]); // only the probe ever ran
    // 3. CODEX_HOME pointing into the profile, or at the whole home
    const link = join(home, "codex-link");
    symlinkSync(profile, link);
    await expect(prepareCodexSandbox({ env: { ...env(), CODEX_HOME: link }, codexBin, protectedPaths: protectedPaths() })).rejects.toBeInstanceOf(SandboxError);
    await expect(prepareCodexSandbox({ env: { ...env(), CODEX_HOME: home }, codexBin, protectedPaths: protectedPaths() })).rejects.toMatchObject({ code: "CODEX_SANDBOX_CONFIG" });
    // 4. a Codex "install" inside the profile (binding it would expose the profile)
    const planted = join(profile, "codex");
    writeFileSync(planted, ATTACKER, { mode: 0o755 });
    await expect(prepareCodexSandbox({ env: env(), codexBin: planted, protectedPaths: protectedPaths() })).rejects.toMatchObject({ code: "CODEX_SANDBOX_CONFIG" });
    // 5. no Codex at all
    await expect(prepareCodexSandbox({ env: env(), codexBin: join(root, "nope"), protectedPaths: protectedPaths() })).rejects.toMatchObject({ code: "CODEX_NOT_INSTALLED" });
  });
});

describe("reference images reach Codex only as checked copies", () => {
  it("refuses links, non-images, directories, relative paths and oversized files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sr-stage-"));
    const work = mkdtempSync(join(tmpdir(), "sr-stage-work-"));
    writeFileSync(join(dir, "ok.png"), PNG);
    writeFileSync(join(dir, "secret.txt"), "sessionid=x");
    symlinkSync(join(dir, "ok.png"), join(dir, "link.png"));
    writeFileSync(join(dir, "big.png"), Buffer.concat([PNG, Buffer.alloc(21 * 1024 * 1024)]));
    expect((await stageInputs(work, [join(dir, "ok.png")])).map((p) => p.slice(work.length))).toEqual(["/inputs/ref-1.png"]);
    for (const bad of [join(dir, "link.png"), join(dir, "secret.txt"), dir, "relative.png", join(dir, "big.png")]) {
      await expect(stageInputs(mkdtempSync(join(tmpdir(), "sr-stage-w-")), [bad]), bad).rejects.toMatchObject({ code: "CODEX_INPUT_REJECTED" });
    }
  });

  it("is the only Codex path in production code (no test bypass is imported outside tests)", () => {
    const grep = spawnSync("grep", ["-rln", "passthrough-sandbox\\|passthroughSandbox", "lib", "scripts", "app", "components"], { encoding: "utf8" });
    expect(grep.stdout.trim()).toBe("");
    const run = readFileSync(join(process.cwd(), "lib/design-agent/codex.ts"), "utf8");
    // Codex is started only through the sandbox
    expect(run).not.toMatch(/runBounded\(/);
  });
});
