import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { analyzePhotos, sandboxPhotoCall, type PhotoInput } from "@/lib/design-agent/assets/photo-codex";
import { assertChatGptSignIn, CodexError, codexDotenvPresent as fromCodex, isEnvironmentFailure, runCodexJson } from "@/lib/design-agent/codex";
import { codexDotenvPresent } from "@/lib/design-agent/codex-dotenv";
import { codexDotenvPresent as fromCapability } from "@/lib/design-agent/design-image/capability";
import { prepareCodexSandbox, SandboxError } from "@/lib/design-agent/sandbox";
import { ENVIRONMENT_CODES, PUBLIC_MESSAGES } from "@/lib/design-agent/worker/messages";
import { pocPreflight } from "@/lib/design-agent/worker/poc";
import { makeLayout, PNG, runWorker, startMockSite, writeJob, type MockSite } from "./worker-support";

// DEV-079: no Codex process while $CODEX_HOME/.env exists. The CLI's arg0
// load_dotenv reads that file into its own environment before it parses its
// arguments (`--version` and `login status` too) and filters only CODEX_*
// keys, so an API key or base URL there would bypass the cleared environment.
// The check sits in the sandbox's run() (the one place every Codex process of
// every caller passes), so these tests drive the REAL prepareCodexSandbox.
// There is no bubblewrap in every test environment, so a stand-in "bwrap"
// answers the probe and runs the command (no isolation: the isolation itself
// is tested against real bubblewrap in sandbox.test.ts). Every Codex process
// it starts is logged, so "Codex was never started" is checked directly.

vi.setConfig({ testTimeout: 60_000 });

// lstat failing with EACCES for $CODEX_HOME/.env (the tests run as root here, where chmod would not stop lstat).
const deny = vi.hoisted(() => ({ dotenv: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const lstat = ((path: Parameters<typeof actual.lstat>[0], ...rest: unknown[]) => {
    if (deny.dotenv && String(path).endsWith("/.env")) return Promise.reject(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }));
    return (actual.lstat as (...a: unknown[]) => unknown)(path, ...rest);
  }) as typeof actual.lstat;
  return { ...actual, lstat, default: { ...actual, lstat } };
});

const CANARY = "DOTENV-CANARY-3b9e";

let root: string;
let home: string;
let codexHome: string;

/** The stand-in bubblewrap: answers the probe (optionally planting a .env on probe N), logs and runs every Codex process. */
function fakeBwrap(dir: string, plantOnProbe?: { n: number; codexHome: string }): { bin: string; spawned: () => string[] } {
  const log = join(dir, "codex-spawned.log");
  const count = join(dir, "probes");
  const bin = join(dir, "bwrap");
  const plant = plantOnProbe ? `n=$(cat '${count}' 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > '${count}'; [ "$n" -ge ${plantOnProbe.n} ] && : > '${plantOnProbe.codexHome}/.env'\n` : "";
  writeFileSync(
    bin,
    // TESTS ONLY: drops every bwrap option; the probe's script is not run.
    `#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done; shift\nif [ "$1" = /bin/sh ]; then\n${plant}echo PROBE_OK; exit 0\nfi\necho "$2" >> '${log}'\nPATH='${dirname(process.execPath)}':/usr/bin:/bin; export PATH\nexec "$@"\n`,
    { mode: 0o755 },
  );
  return { bin, spawned: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []) };
}

/** A Codex stand-in: signed in with ChatGPT, prints a version, answers exec with {} (optionally planting a .env while it runs). */
function fakeCli(dir: string, plantOnExec?: string): string {
  const bin = join(dir, "codex");
  const plant = plantOnExec ? ` : > '${plantOnExec}/.env';` : "";
  writeFileSync(
    bin,
    `#!/bin/sh\ncase "$1" in\n  login) echo "Logged in using ChatGPT";;\n  --version) echo "codex-cli 0.163.0";;\n  exec)${plant} cat >/dev/null; while [ $# -gt 0 ]; do [ "$1" = --output-last-message ] && echo '{"ok":true}' > "$2"; shift; done;;\nesac\n`,
    { mode: 0o755 },
  );
  return bin;
}

const env = () => ({ PATH: `/usr/bin:/bin:${dirname(process.execPath)}`, HOME: home, CODEX_HOME: codexHome, LANG: "C.UTF-8" });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "sr-dotenv-test-"));
  home = join(root, "home");
  codexHome = join(home, ".codex");
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => {
  deny.dotenv = false;
  rmSync(join(codexHome, ".env"), { recursive: true, force: true });
});

const VARIANTS: Array<[string, () => void]> = [
  ["a file", () => writeFileSync(join(codexHome, ".env"), `SOME_KEY=${CANARY}\n`)],
  [
    "a link to a file",
    () => {
      writeFileSync(join(root, "elsewhere.env"), `SOME_KEY=${CANARY}\n`);
      symlinkSync(join(root, "elsewhere.env"), join(codexHome, ".env"));
    },
  ],
  ["a dangling link", () => symlinkSync(join(root, "no-such-file"), join(codexHome, ".env"))],
  ["a directory", () => mkdirSync(join(codexHome, ".env"))],
  [
    "unreadable (EACCES)",
    () => {
      deny.dotenv = true;
    },
  ],
];

async function sandboxFor(dir: string, plant?: number, plantOnExec = false) {
  mkdirSync(dir, { recursive: true });
  const bwrap = fakeBwrap(dir, plant === undefined ? undefined : { n: plant, codexHome });
  const sandbox = await prepareCodexSandbox({ env: env(), codexBin: fakeCli(dir, plantOnExec ? codexHome : undefined), bwrapBin: bwrap.bin, protectedPaths: [] });
  return { sandbox, spawned: bwrap.spawned };
}

const shown = (error: unknown) => `${String(error)} ${(error as Error).message} ${JSON.stringify(error)}`;

describe("codexDotenvPresent (lstat only)", () => {
  it("is one shared function: codex.ts and the design-image PoC use the same one", () => {
    expect(fromCodex).toBe(codexDotenvPresent);
    expect(fromCapability).toBe(codexDotenvPresent);
  });

  it("absent → false; a file, a link (dangling too), a directory or an lstat error → true", async () => {
    expect(await codexDotenvPresent(codexHome)).toBe(false);
    // a CODEX_HOME that does not exist yet: nothing there
    expect(await codexDotenvPresent(join(root, "missing", ".codex"))).toBe(false);
    for (const [name, make] of VARIANTS) {
      make();
      expect(await codexDotenvPresent(codexHome), name).toBe(true);
      deny.dotenv = false;
      rmSync(join(codexHome, ".env"), { recursive: true, force: true });
    }
  });

  it("never opens or reads the file (no read of a .env path at all)", () => {
    const src = readFileSync(join(process.cwd(), "lib/design-agent/codex-dotenv.ts"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(code).not.toMatch(/\b(readFile|open|createReadStream|realpath|stat|access)\b(?!\w)/);
    expect(code).toMatch(/\blstat\(/);
  });
});

describe("the sandbox refuses every Codex process while $CODEX_HOME/.env exists", () => {
  it(".env absent: login status, --version and exec run as before", async () => {
    const { sandbox, spawned } = await sandboxFor(join(root, "absent"));
    await assertChatGptSignIn({ sandbox });
    const work = mkdtempSync(join(tmpdir(), "sr-design-codex-"));
    const version = await sandbox.run(["--version"], { workDir: work, timeoutMs: 30_000 });
    expect(version.stdout).toContain("codex-cli 0.163.0");
    expect(await runCodexJson({ sandbox, prompt: "x", schema: {}, timeoutMs: 30_000 })).toEqual({ ok: true });
    expect(spawned()).toEqual(["login", "--version", "login", "exec"]);
    rmSync(work, { recursive: true, force: true });
  });

  for (const [name, make] of VARIANTS) {
    it(`.env as ${name}: sandbox.run, assertChatGptSignIn and runCodexJson stop with CODEX_DOTENV_PRESENT, Codex never starts`, async () => {
      const { sandbox, spawned } = await sandboxFor(join(root, name.replace(/\W+/g, "-")));
      make();
      const work = mkdtempSync(join(tmpdir(), "sr-design-codex-"));
      for (const args of [["--version"], ["login", "status"], ["exec", "-"]]) {
        const err = await sandbox.run(args, { workDir: work, timeoutMs: 30_000 }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SandboxError);
        expect(err).toMatchObject({ code: "CODEX_DOTENV_PRESENT" });
      }
      const signIn = await assertChatGptSignIn({ sandbox }).catch((e: unknown) => e);
      const json = await runCodexJson({ sandbox, prompt: "x", schema: {}, timeoutMs: 30_000 }).catch((e: unknown) => e);
      for (const err of [signIn, json]) {
        expect(err).toBeInstanceOf(CodexError);
        expect(err).toMatchObject({ code: "CODEX_DOTENV_PRESENT", message: "A .env file exists in the Codex home; Codex was not started." });
        // neither the contents nor the path
        expect(shown(err)).not.toContain(CANARY);
        expect(shown(err)).not.toContain(codexHome);
      }
      expect(spawned()).toEqual([]);
      rmSync(work, { recursive: true, force: true });
    });
  }

  it("checks again right before the spawn: a .env that appears after the first call stops the next one, and one that appears during the probe stops that one", async () => {
    // probe 1: sign-in (no .env yet) runs; the .env appears during probe 2 (the exec): refused before the spawn
    const { sandbox, spawned } = await sandboxFor(join(root, "mid-run"), 2);
    const err = await runCodexJson({ sandbox, prompt: "x", schema: {}, timeoutMs: 30_000 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "CODEX_DOTENV_PRESENT" });
    expect(spawned()).toEqual(["login"]);
    expect(existsSync(join(codexHome, ".env"))).toBe(true);
  });

  it("checks once more after Codex ended: a .env that appeared while it ran (a lost race) is detected and the result thrown away", async () => {
    const { sandbox, spawned } = await sandboxFor(join(root, "after-run"), undefined, true);
    const work = mkdtempSync(join(tmpdir(), "sr-design-codex-"));
    const raw = await sandbox.run(["exec", "-"], { workDir: work, input: "x", timeoutMs: 30_000 }).catch((e: unknown) => e);
    expect(raw).toBeInstanceOf(SandboxError);
    expect(raw).toMatchObject({ code: "CODEX_DOTENV_PRESENT", started: true });
    rmSync(join(codexHome, ".env"), { force: true });
    // through runCodexJson: the answer Codex wrote is never returned
    const err = await runCodexJson({ sandbox, prompt: "x", schema: {}, timeoutMs: 30_000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodexError);
    expect(err).toMatchObject({ code: "CODEX_DOTENV_PRESENT" });
    expect(spawned()).toEqual(["exec", "login", "exec"]);
    rmSync(work, { recursive: true, force: true });
  });

  it("a refusal before the spawn says nothing was started", async () => {
    const { sandbox } = await sandboxFor(join(root, "before-spawn"));
    writeFileSync(join(codexHome, ".env"), "");
    const work = mkdtempSync(join(tmpdir(), "sr-design-codex-"));
    expect(await sandbox.run(["--version"], { workDir: work, timeoutMs: 30_000 }).catch((e: unknown) => e)).toMatchObject({ code: "CODEX_DOTENV_PRESENT", started: false });
    rmSync(work, { recursive: true, force: true });
  });

  it("is an environment failure with a fixed public message in the worker (stops the run, never counted against the job)", () => {
    expect(isEnvironmentFailure("CODEX_DOTENV_PRESENT")).toBe(true);
    expect(ENVIRONMENT_CODES.has("CODEX_DOTENV_PRESENT")).toBe(true);
    expect(PUBLIC_MESSAGES.CODEX_DOTENV_PRESENT).toMatch(/Codex was not started/);
  });
});

describe("every entry point stops before Codex starts", () => {
  it("photos (photo-codex): the analysis call stops with CODEX_DOTENV_PRESENT", async () => {
    const { sandbox, spawned } = await sandboxFor(join(root, "photos"));
    writeFileSync(join(codexHome, ".env"), `SOME_KEY=${CANARY}\n`);
    const inputs = [{ assetId: "asset-aaaaaaaaaaaaaaaaaaaaaaaa", png: PNG, width: 1, height: 1 }] as unknown as PhotoInput[];
    const result = await analyzePhotos({ call: sandboxPhotoCall(sandbox), inputs, category: "baked_goods" });
    expect(result).toEqual({ ok: false, code: "CODEX_DOTENV_PRESENT", problems: [] });
    expect(spawned()).toEqual([]);
  });

  it("the photo PoC preflight records the sign-in check as CODEX_DOTENV_PRESENT", async () => {
    const { sandbox, spawned } = await sandboxFor(join(root, "photo-poc"));
    writeFileSync(join(codexHome, ".env"), `SOME_KEY=${CANARY}\n`);
    const queue = join(root, "photo-poc", "jobs");
    const result = await pocPreflight({
      jobId: "poc-job",
      queueRoot: queue,
      outRoot: join(root, "photo-poc", "out"),
      env: { HOME: home, SR_DESIGN_ASSETS_ROOT: join(root, "photo-poc", "assets") },
      repoDir: process.cwd(),
      prepareSandbox: async () => sandbox,
    });
    expect(result.ready).toBe(false);
    expect(result.checks).toContainEqual({ check: "codex_chatgpt_sign_in", ok: false, code: "CODEX_DOTENV_PRESENT" });
    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(spawned()).toEqual([]);
  });

  describe("the design worker", () => {
    let site: MockSite;
    beforeAll(async () => {
      site = await startMockSite();
    });
    afterAll(() => {
      site.server.close();
    });

    /** runWorker with the REAL sandbox around the worker's fake Codex (runWorker writes it to <bin>/codex). */
    const realSandbox = (l: ReturnType<typeof makeLayout>, plant?: number) => {
      const bwrap = fakeBwrap(l.root, plant === undefined ? undefined : { n: plant, codexHome: join(l.root, "codex-home") });
      const prepareSandbox = (e: NodeJS.ProcessEnv) => prepareCodexSandbox({ env: e, codexBin: join(l.bin, "codex"), bwrapBin: bwrap.bin, protectedPaths: [] });
      return { prepareSandbox, spawned: bwrap.spawned };
    };

    it("at the sign-in check: stops the run (exit class 'stopped'), puts nothing in the ledger, keeps the job in the inbox; no Codex process", async () => {
      for (const [name, make] of [
        ["file", (h: string) => writeFileSync(join(h, ".env"), `SOME_KEY=${CANARY}\n`)],
        ["dangling link", (h: string) => symlinkSync("/nonexistent-dotenv-target", join(h, ".env"))],
      ] as const) {
        const l = makeLayout();
        const h = join(l.root, "codex-home");
        mkdirSync(h, { recursive: true, mode: 0o700 });
        make(h);
        writeJob(l, "job-dotenv");
        const { prepareSandbox, spawned } = realSandbox(l);
        const { report, logs } = await runWorker(l, site, { prepareSandbox });
        expect(report, name).toMatchObject({ status: "stopped", code: "CODEX_DOTENV_PRESENT" });
        expect(readdirSync(join(l.queue, "inbox")), name).toEqual(["job-dotenv.json"]);
        expect(existsSync(join(l.state, "ledger.json")) ? (JSON.parse(readFileSync(join(l.state, "ledger.json"), "utf8")) as { jobs: unknown }).jobs : {}).toEqual({});
        expect(spawned(), name).toEqual([]);
        expect(JSON.stringify({ report, logs })).not.toContain(CANARY);
        expect(JSON.stringify({ report, logs })).not.toContain(h);
        rmSync(l.root, { recursive: true, force: true });
      }
    });

    it("mid-job (a .env appears after the sign-in): the job goes back to the inbox, the run stops with CODEX_DOTENV_PRESENT, no partial result", async () => {
      const l = makeLayout();
      writeJob(l, "job-dotenv-mid");
      // probe 1 is the sign-in; the .env appears during probe 2 (the first exec)
      const { prepareSandbox, spawned } = realSandbox(l, 2);
      const { report } = await runWorker(l, site, { prepareSandbox });
      expect(report).toMatchObject({ status: "stopped", code: "CODEX_DOTENV_PRESENT" });
      expect(readdirSync(join(l.queue, "inbox"))).toEqual(["job-dotenv-mid.json"]);
      expect(existsSync(join(l.out, "job-dotenv-mid"))).toBe(false);
      expect(existsSync(join(l.state, "ledger.json")) ? (JSON.parse(readFileSync(join(l.state, "ledger.json"), "utf8")) as { jobs: unknown }).jobs : {}).toEqual({});
      expect(spawned()).toEqual(["login"]);
      chmodSync(l.root, 0o700);
      rmSync(l.root, { recursive: true, force: true });
    });
  });
});
