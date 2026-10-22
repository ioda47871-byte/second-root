import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { crc32, deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runBounded, type BoundedResult } from "@/lib/design-agent/bounded-process";
import { codexLooksRateLimited, codexLooksSignedOut } from "@/lib/design-agent/codex";
import { checkPng, MOCKUP_PNG_LIMITS, PngError } from "@/lib/design-agent/design-image/png";
import {
  buildMockupPrompt,
  V1_PROMPT_CHARS,
  V2_HARD_RULE_COVERAGE,
  V2_PROMPT_MAX_CHARS,
  DIRECTION_PATH,
  DIRECTION_PATHS,
  loadPocInputs,
  parseDirectionVersion,
  POC_DISCLOSURE,
  POC_DISCLOSURE_V2,
  PocDirectionError,
  PocInputError,
} from "@/lib/design-agent/design-image/prompt";
import { classifyError, CodexEventTracker, IMAGE_ITEM_TYPES, ITEM_TYPES, MAX_PARTIAL_LINE_CHARS, type EventDiagnostics, type ImageLocationDiagnostics, type PocDiagnostics } from "@/lib/design-agent/design-image/diagnostics";
import {
  applyModelCatalog,
  classifyAnswerText,
  classifyImageFailureText,
  deriveImageOutcome,
  emptySessionFacts,
  failTimingOf,
  IMAGE_FAIL_TIMINGS,
  MAX_IMAGE_CALL_TIMINGS,
  MAX_MODELS_CACHE_BYTES,
  MAX_SESSION_LOG_BYTES,
  parseCodexVersion,
  readModelCatalog,
  readSessionFacts,
  toolModeOf,
} from "@/lib/design-agent/design-image/capability";
import { cleanupActivePoc, isInsidePath, lastPocDiagnostics, pocStopClass, REPORT_NOTES, REPORT_NOTES_V2, runDesignImagePoc, type PocOptions } from "@/lib/design-agent/design-image/run";
import { SandboxError, type CodexSandbox } from "@/lib/design-agent/sandbox";

// The design-image PoC (DEV-074) against a fake sandbox whose `run` plays the
// Codex CLI in-process: the sign-in check, then one `exec` that may leave a PNG
// where the real image tool does (CODEX_HOME/generated_images/<thread>/).
// No real Codex, no bubblewrap, no network.

const REPO = process.cwd();
const run = promisify(execFile);
const THREAD = "0f0e0d0c-0b0a-4908-8706-050403020100";
const OTHER_THREAD = "11111111-2222-4333-8444-555555555555";
const STALE_THREAD = "99999999-8888-4777-8666-555555555555";
const CODEX_TEXT = "CODEX-SAID-THIS-zzqx";

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

/** A valid greyscale PNG (8-bit) of the given size. */
function png(width = 1024, height = 1536): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const raw = Buffer.alloc((width + 1) * height, 0);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

type Exec = (ctx: { codexHome: string; cwd: string; prompt: string }) => Promise<Partial<BoundedResult>> | Partial<BoundedResult>;

let root: string;
let home: string;
let codexHome: string;
let tmpBase: string;
let outRoot: string;
let prompts: string[];
let execCwds: string[];
let prepared: Array<{ env: Record<string, string | undefined>; paths: string[] }>;
let versionCalls: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sr-img-poc-test-"));
  home = join(root, "home");
  codexHome = join(home, ".codex");
  tmpBase = join(root, "tmp");
  outRoot = join(home, "sr-design-image-poc");
  for (const d of [codexHome, tmpBase]) mkdirSync(d, { recursive: true });
  prompts = [];
  execCwds = [];
  prepared = [];
  versionCalls = [];
});

afterEach(() => {
  spawnSync("rm", ["-rf", root]);
});

const ok = (stdout = ""): BoundedResult => ({ code: 0, signal: null, stdout, stderr: "", timedOut: false });
const threadEvent = (id = THREAD) => `${JSON.stringify({ type: "thread.started", thread_id: id })}\n`;

/** Writes what the real CLI leaves: a session log (cwd in its first line) and, if given, image files of a thread. */
function leave(cwd: string, thread: string, images: Record<string, Buffer> = {}): void {
  const sessions = join(codexHome, "sessions", "2026", "10", "21");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, `rollout-2026-10-21T10-00-00-${thread}.jsonl`), `${JSON.stringify({ type: "session_meta", payload: { cwd } })}\n`);
  const dir = join(codexHome, "generated_images", thread);
  mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of Object.entries(images)) writeFileSync(join(dir, name), bytes);
}

function fakeSandbox(exec: Exec, login = "Logged in using ChatGPT\n"): CodexSandbox {
  return {
    env: { HOME: home, CODEX_HOME: codexHome },
    async run(args, o) {
      if (args[0] === "login") return ok(login);
      if (args[0] === "--version") {
        versionCalls.push(o.workDir);
        return ok("codex-cli 0.163.0\n");
      }
      execCwds.push(o.workDir);
      prompts.push(o.input ?? "");
      expect(args.slice(0, 5)).toEqual(["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--json"]);
      expect(args.some((a) => a.startsWith("--image"))).toBe(false); // no reference image is ever attached
      expect(args.at(-1)).toBe("-");
      return { ...ok(), ...(await exec({ codexHome, cwd: o.workDir, prompt: o.input ?? "" })) };
    },
  };
}

function options(exec: Exec, extra: Partial<PocOptions> = {}): PocOptions {
  return {
    humanApprovalConfirmed: true,
    repoDir: REPO,
    outRoot,
    workerPaths: { stateDir: join(home, ".local/state/sr-design-worker"), queueRoot: join(home, "sr-design-jobs"), outRoot: join(home, ".local/share/second-root-design") },
    tmpBase,
    env: { HOME: home, CODEX_HOME: codexHome, PATH: "/usr/bin:/bin", OPENAI_API_KEY: "sk-never-reaches-codex", SUPABASE_SERVICE_ROLE_KEY: "never" },
    prepareSandbox: async (env, paths) => {
      prepared.push({ env, paths });
      return fakeSandbox(exec);
    },
    timeoutMs: 60_000,
    workerCommit: "0123456789abcdef0123456789abcdef01234567",
    ...extra,
  };
}

const happy: Exec = ({ cwd }) => {
  leave(cwd, THREAD, { "ig_0001.png": png() });
  return ok(`${threadEvent()}${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: CODEX_TEXT } })}\n`);
};

const sessionLogs = () => {
  const dir = join(codexHome, "sessions");
  return existsSync(dir) ? (readdirSync(dir, { recursive: true }) as string[]).filter((n) => n.endsWith(".jsonl")) : [];
};
const imageDirs = () => (existsSync(join(codexHome, "generated_images")) ? readdirSync(join(codexHome, "generated_images")) : []);

describe("runDesignImagePoc: approval", () => {
  it("refuses without the approval: no file read, no directory, no sandbox", async () => {
    let called = false;
    const result = await runDesignImagePoc({
      ...options(happy),
      humanApprovalConfirmed: false,
      repoDir: join(root, "no-such-repo"),
      prepareSandbox: async () => {
        called = true;
        throw new Error("must not be called");
      },
    });
    expect(result).toEqual({ status: "refused", code: "POC_NOT_APPROVED" });
    expect(called).toBe(false);
    expect(existsSync(outRoot)).toBe(false);
    expect(readdirSync(tmpBase)).toEqual([]);
  });

  it("refuses an output dir inside the repository before any sandbox", async () => {
    let called = false;
    const result = await runDesignImagePoc({
      ...options(happy),
      outRoot: join(REPO, ".sr-img-poc-never", "out"),
      prepareSandbox: async () => {
        called = true;
        throw new Error("must not be called");
      },
    });
    expect(result).toEqual({ status: "stopped", code: "POC_OUTPUT_UNSAFE" });
    expect(called).toBe(false);
    expect(existsSync(join(REPO, ".sr-img-poc-never"))).toBe(false);
  });
});

describe("runDesignImagePoc: the one image call", () => {
  it("happy path: the image from generated_images/<thread>, 0700 / 0600 outside the repo, everything else cleaned up", async () => {
    // a thread dir that existed before the run (another Codex use) is never touched
    mkdirSync(join(codexHome, "generated_images", OTHER_THREAD), { recursive: true });
    writeFileSync(join(codexHome, "generated_images", OTHER_THREAD, "keep.png"), png(600, 600));
    // a session log + image dir that a cut-off design-agent call left (cwd sr-design-codex-…) are removed at the start
    leave("/tmp/sr-design-codex-AbC123", STALE_THREAD, { "old.png": png(600, 600) });
    // a session of the user's own Codex use is not
    const sessions = join(codexHome, "sessions", "2026", "10", "20");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, `rollout-x-${OTHER_THREAD}.jsonl`), `${JSON.stringify({ payload: { cwd: "/home/u/project" } })}\n`);

    const result = await runDesignImagePoc(options(happy));
    expect(result.status).toBe("done");
    if (result.status !== "done") return;
    expect(result.dir.startsWith(`${outRoot}/wagashi-`)).toBe(true);
    expect(result.dir.startsWith(REPO)).toBe(false);
    expect(statSync(outRoot).mode & 0o777).toBe(0o700);
    expect(statSync(result.dir).mode & 0o777).toBe(0o700);
    expect(readdirSync(result.dir).sort()).toEqual(["design-spec.json", "mockup.png", "report.json", "shop-facts.json"]);
    for (const f of readdirSync(result.dir)) expect(statSync(join(result.dir, f)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(result.dir, "mockup.png")).equals(png())).toBe(true);
    const report = JSON.parse(readFileSync(join(result.dir, "report.json"), "utf8"));
    expect(report).toMatchObject({ status: "IMAGE_GENERATED_NOT_IMPLEMENTED", shop: "wagashi", direction_version: "v2", width: 1024, height: 1536, aspect_h_per_w: 1.5, png_bytes: png().length, worker_commit: "0123456789abcdef0123456789abcdef01234567" });
    expect(Object.keys(report).sort()).toEqual(["aspect_h_per_w", "codex_ms", "direction_version", "height", "notes", "png_bytes", "png_chunks", "png_sha256", "prompt_chars", "shop", "status", "width", "worker_commit"]);
    // v2 is the default: its notes (concept-only food visuals, evaluation required) and its direction as design-spec.json
    expect(report.notes).toEqual([...REPORT_NOTES, "AI_FOOD_VISUALS_CONCEPT_ONLY", "EVALUATION_REQUIRED"]);
    expect(report.notes).toEqual([...REPORT_NOTES_V2]);
    expect(JSON.parse(readFileSync(join(result.dir, "shop-facts.json"), "utf8")).name).toBe("架空菓庵");
    expect(JSON.parse(readFileSync(join(result.dir, "design-spec.json"), "utf8"))).toEqual(JSON.parse(readFileSync(join(REPO, DIRECTION_PATHS.v2), "utf8")));

    // cleanup: this run's and the stale session logs gone, the user's own kept; image dirs: only the pre-existing one; work dir gone
    expect(sessionLogs()).toEqual([join("2026", "10", "20", `rollout-x-${OTHER_THREAD}.jsonl`)]);
    expect(imageDirs()).toEqual([OTHER_THREAD]);
    expect(existsSync(join(codexHome, "generated_images", OTHER_THREAD, "keep.png"))).toBe(true);
    expect(execCwds).toHaveLength(1);
    expect(execCwds[0]!).toMatch(/\/sr-design-codex-[A-Za-z0-9]{6}$/);
    expect(existsSync(execCwds[0]!)).toBe(false);
    expect(readdirSync(tmpBase)).toEqual([]);

    // the sandbox: the worker's protected paths and this PoC's output root; no API key or token in Codex's environment
    expect(prepared).toHaveLength(1);
    expect(prepared[0]!.paths).toEqual(expect.arrayContaining([outRoot, join(home, "sr-design-jobs"), join(home, ".local/share/second-root-design"), join(home, ".local/state/sr-design-worker"), join(home, ".ssh"), "/mnt/c"]));
    expect(prepared[0]!.env.OPENAI_API_KEY).toBeUndefined();
    expect(prepared[0]!.env.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
    expect(prepared[0]!.env.CODEX_HOME).toBe(codexHome);
  });

  it("v1 is still selectable: its direction as design-spec.json, direction_version v1, the v1 notes, the v1 prompt", async () => {
    const result = await runDesignImagePoc(options(happy, { directionVersion: "v1" }));
    expect(result.status).toBe("done");
    if (result.status !== "done") return;
    const report = JSON.parse(readFileSync(join(result.dir, "report.json"), "utf8"));
    expect(report.direction_version).toBe("v1");
    expect(report.notes).toEqual([...REPORT_NOTES]);
    expect(report.notes).not.toContain("AI_FOOD_VISUALS_CONCEPT_ONLY");
    expect(JSON.parse(readFileSync(join(result.dir, "design-spec.json"), "utf8"))).toEqual(JSON.parse(readFileSync(join(REPO, DIRECTION_PATH), "utf8")));
    expect(prompts).toEqual([buildMockupPrompt(await loadPocInputs(REPO, "v1"))]);
  });

  it("POC_DIRECTION_INVALID: a direction outside the fixed list is refused before any file, directory or sandbox", async () => {
    for (const bad of ["v3", "V2", "../v2", "", " v2"]) {
      prepared = [];
      const result = await runDesignImagePoc(options(happy, { directionVersion: bad as never }));
      expect(result).toEqual({ status: "refused", code: "POC_DIRECTION_INVALID" });
      expect(prepared).toEqual([]);
      expect(existsSync(outRoot)).toBe(false);
    }
    expect(prompts).toEqual([]);
  });

  it("output and result hold fixed codes and numbers only, never Codex's words", async () => {
    const result = await runDesignImagePoc(
      options(({ cwd }) => {
        leave(cwd, THREAD, { "a.png": png() });
        return { ...ok(`${threadEvent()}${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: CODEX_TEXT } })}\n`), stderr: CODEX_TEXT };
      }),
    );
    expect(result.status).toBe("done");
    if (result.status !== "done") return;
    expect(JSON.stringify(result)).not.toContain(CODEX_TEXT);
    for (const f of readdirSync(result.dir)) expect(readFileSync(join(result.dir, f)).toString("latin1")).not.toContain(CODEX_TEXT);
    const failed = await runDesignImagePoc(options(() => ({ code: 1, stdout: `${threadEvent()}${JSON.stringify({ type: "turn.failed", error: { message: CODEX_TEXT } })}\n`, stderr: CODEX_TEXT })));
    expect(failed).toEqual({ status: "stopped", code: "CODEX_EXEC_FAILED" });
  });

  it("CODEX_NO_THREAD: and an image dir left without a thread id is removed (only the new one)", async () => {
    mkdirSync(join(codexHome, "generated_images", OTHER_THREAD), { recursive: true });
    const result = await runDesignImagePoc(
      options(({ cwd }) => {
        leave(cwd, THREAD, { "a.png": png() });
        return ok("not json\n");
      }),
    );
    expect(result).toEqual({ status: "stopped", code: "CODEX_NO_THREAD" });
    expect(imageDirs()).toEqual([OTHER_THREAD]);
    expect(sessionLogs()).toEqual([]); // its cwd was this run's sr-design-codex- dir
    // no result dir; only this run's diagnostics dir (DEV-077)
    expect((existsSync(outRoot) ? readdirSync(outRoot) : []).filter((n) => !n.startsWith("diag-"))).toEqual([]);
  });

  it("CODEX_NO_IMAGE: a thread without a PNG", async () => {
    const result = await runDesignImagePoc(
      options(({ cwd }) => {
        leave(cwd, THREAD, { "note.txt": Buffer.from("x") });
        return ok(threadEvent());
      }),
    );
    expect(result).toEqual({ status: "stopped", code: "CODEX_NO_IMAGE" });
    expect(sessionLogs()).toEqual([]);
    expect(imageDirs()).toEqual([]);
    // no dir at all
    const none = await runDesignImagePoc(options(() => ok(threadEvent())));
    expect(none).toEqual({ status: "stopped", code: "CODEX_NO_IMAGE" });
  });

  it("CODEX_IMAGE_INVALID: bad CRC, truncated, trailing data, too small, a symlink", async () => {
    const good = png();
    const badCrc = Buffer.from(good);
    badCrc[badCrc.length - 20] ^= 0xff;
    const cases: Record<string, (dir: string) => void> = {
      crc: (dir) => writeFileSync(join(dir, "a.png"), badCrc),
      truncated: (dir) => writeFileSync(join(dir, "a.png"), good.subarray(0, good.length - 7)),
      trailing: (dir) => writeFileSync(join(dir, "a.png"), Buffer.concat([good, Buffer.from("extra")])),
      small: (dir) => writeFileSync(join(dir, "a.png"), png(256, 256)),
      symlink: (dir) => {
        writeFileSync(join(root, "outside.png"), good);
        symlinkSync(join(root, "outside.png"), join(dir, "a.png"));
      },
    };
    for (const [name, make] of Object.entries(cases)) {
      const result = await runDesignImagePoc(
        options(({ cwd }) => {
          leave(cwd, THREAD);
          make(join(codexHome, "generated_images", THREAD));
          return ok(threadEvent());
        }),
      );
      expect(result, name).toEqual({ status: "stopped", code: "CODEX_IMAGE_INVALID" });
      expect(imageDirs(), name).toEqual([]);
    }
    expect(existsSync(join(root, "outside.png"))).toBe(true);
  });

  it("CODEX_QUOTA, CODEX_TIMEOUT, CODEX_NOT_SIGNED_IN, CODEX_API_KEY_AUTH; Codex's answer never decides the machine state", async () => {
    const quota = await runDesignImagePoc(options(() => ({ code: 1, stdout: threadEvent(), stderr: "error: You've hit your usage limit." })));
    expect(quota).toEqual({ status: "stopped", code: "CODEX_QUOTA" });
    const timeout = await runDesignImagePoc(
      options(({ cwd }) => {
        leave(cwd, THREAD, { "partial.png": png() }); // the image dir of a run cut off before the thread id was read
        return { code: null, signal: "SIGKILL", timedOut: true };
      }),
    );
    expect(timeout).toEqual({ status: "stopped", code: "CODEX_TIMEOUT" });
    expect(imageDirs()).toEqual([]);
    expect(sessionLogs()).toEqual([]);
    const signedOut = await runDesignImagePoc(options(() => ({ code: 1, stdout: `${threadEvent()}${JSON.stringify({ type: "turn.failed", error: { message: "unexpected status 401 Unauthorized" } })}\n` })));
    expect(signedOut).toEqual({ status: "stopped", code: "CODEX_NOT_SIGNED_IN" });
    // the same words from the model are not a sign-out
    const said = await runDesignImagePoc(options(() => ({ code: 1, stdout: `${threadEvent()}${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "401 Unauthorized; usage limit" } })}\n` })));
    expect(said).toEqual({ status: "stopped", code: "CODEX_EXEC_FAILED" });
    const apiKey = await runDesignImagePoc({ ...options(happy), prepareSandbox: async () => fakeSandbox(happy, "Logged in using an API key - sk-***\n") });
    expect(apiKey).toEqual({ status: "stopped", code: "CODEX_API_KEY_AUTH" });
    const notIn = await runDesignImagePoc({ ...options(happy), prepareSandbox: async () => fakeSandbox(happy, "Not logged in\n") });
    expect(notIn).toEqual({ status: "stopped", code: "CODEX_NOT_SIGNED_IN" });
    expect(prompts).toHaveLength(4); // the sign-in failures never reached exec
  });

  it("a stop while Codex runs (signal): cleanupActivePoc removes the work dir, the session log and the new image dir", async () => {
    let release!: () => void;
    const running = runDesignImagePoc(
      options(({ cwd }) => {
        leave(cwd, THREAD, { "a.png": png() });
        return new Promise((resolve) => {
          release = () => resolve({ code: null, signal: "SIGKILL" });
        });
      }),
    );
    for (let i = 0; i < 100 && execCwds.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 20));
    await cleanupActivePoc();
    expect(existsSync(execCwds[0]!)).toBe(false);
    expect(imageDirs()).toEqual([]);
    expect(sessionLogs()).toEqual([]);
    release();
    expect(await running).toEqual({ status: "stopped", code: "CODEX_EXEC_FAILED" });
  });
});

describe("review fixes (M1, L2, L3, N4)", () => {
  it("M1: a stop during the finally cleanup waits for the same, complete cleanup", async () => {
    let concurrent: Promise<void> | undefined;
    const result = runDesignImagePoc(
      options(({ cwd }) => {
        leave(cwd, THREAD, { "a.png": png() });
        // runs once the run has failed and its finally cleanup has started (it is awaiting its first rm)
        setImmediate(() => {
          concurrent = cleanupActivePoc();
        });
        return { code: 1, stdout: threadEvent() };
      }),
    );
    for (let i = 0; i < 500 && concurrent === undefined; i++) await new Promise((r) => setTimeout(r, 10));
    expect(concurrent).toBeDefined();
    await concurrent;
    // everything is gone when the concurrent caller's promise resolves (not only when the run's own finally ends)
    expect(imageDirs()).toEqual([]);
    expect(sessionLogs()).toEqual([]);
    expect(existsSync(execCwds[0]!)).toBe(false);
    expect(await result).toEqual({ status: "stopped", code: "CODEX_EXEC_FAILED" });
  });

  it("L2: when the snapshot of generated_images cannot be read, only the run's own thread dir is removed", async () => {
    // generated_images is not a directory at snapshot time (ENOTDIR, not ENOENT)
    writeFileSync(join(codexHome, "generated_images"), "x");
    const result = await runDesignImagePoc(
      options(({ cwd }) => {
        spawnSync("rm", ["-f", join(codexHome, "generated_images")]);
        // a thread dir the run could not see before (it may be another use's): never removed
        mkdirSync(join(codexHome, "generated_images", OTHER_THREAD), { recursive: true });
        leave(cwd, THREAD, { "a.png": png() });
        return ok(threadEvent());
      }),
    );
    expect(result.status).toBe("done");
    expect(imageDirs()).toEqual([OTHER_THREAD]);
  });

  it("L3: at exit only this run's session logs go; another design-agent call's live log stays", async () => {
    const otherCwd = "/tmp/sr-design-codex-Other1";
    const result = await runDesignImagePoc(
      options(({ cwd }) => {
        leave(otherCwd, OTHER_THREAD); // e.g. design-demo.ts running at the same time (no run lock)
        leave(cwd, THREAD); // this run's own log, the thread id never read
        return ok("no thread\n");
      }),
    );
    expect(result).toEqual({ status: "stopped", code: "CODEX_NO_THREAD" });
    expect(sessionLogs()).toEqual([join("2026", "10", "21", `rollout-2026-10-21T10-00-00-${OTHER_THREAD}.jsonl`)]);
  });

  it("N4: containment does not mistake a sibling named ..out for a child", () => {
    expect(isInsidePath("/a/b", "/a")).toBe(true);
    expect(isInsidePath("/a", "/a")).toBe(true);
    expect(isInsidePath("/a/..out", "/a")).toBe(true); // a child whose name starts with ".."
    expect(isInsidePath("/..out", "/a")).toBe(false);
    expect(isInsidePath("/b", "/a")).toBe(false);
    expect(isInsidePath("/a-b", "/a")).toBe(false);
  });
});

describe("the direction choice", () => {
  it("parseDirectionVersion: unset / empty is v2, v1 and v2 pass, anything else is POC_DIRECTION_INVALID", () => {
    expect(parseDirectionVersion(undefined)).toBe("v2");
    expect(parseDirectionVersion("")).toBe("v2");
    expect(parseDirectionVersion("v1")).toBe("v1");
    expect(parseDirectionVersion("v2")).toBe("v2");
    for (const bad of ["v3", "V1", "v1 ", "1", "../../etc/passwd", "wagashi-art-direction-v2.json"]) {
      expect(() => parseDirectionVersion(bad)).toThrow(PocDirectionError);
      try {
        parseDirectionVersion(bad);
      } catch (error) {
        expect((error as PocDirectionError).code).toBe("POC_DIRECTION_INVALID");
      }
    }
  });

  it("loadPocInputs: default v2, v1 on request, an unknown version refused", async () => {
    expect((await loadPocInputs(REPO)).version).toBe("v2");
    expect((await loadPocInputs(REPO, "v1")).version).toBe("v1");
    await expect(loadPocInputs(REPO, "v3" as never)).rejects.toBeInstanceOf(PocDirectionError);
  });

  it("the v2 direction: version 0.3-poc, the exact disclosure, 3 sections, no purchase / reservation UI", async () => {
    const v2 = JSON.parse(readFileSync(join(REPO, DIRECTION_PATHS.v2), "utf8"));
    expect(v2.version).toBe("0.3-poc");
    expect(v2.disclosure).toBe("架空店舗のデザイン提案｜和菓子の画像はAI生成のイメージです");
    expect(v2.sections.map((s: { id: string }) => s.id)).toEqual(["Hero", "Products", "ShopInfo"]);
    expect(v2.hard_rules.join("\n")).toContain(POC_DISCLOSURE_V2);
    expect(JSON.stringify(v2.web_ui)).not.toMatch(/購入|予約|注文/);
    expect(v2.web_ui.nav).toEqual(["商品・こだわり", "店舗情報"]);
    // v1 is kept unchanged for history
    expect(JSON.parse(readFileSync(join(REPO, DIRECTION_PATH), "utf8")).version).toBe("0.2-poc");
  });

  it("a v2 direction that drops the disclosure, adds a key, or names a reservation CTA is POC_INPUT_INVALID", async () => {
    const original = JSON.parse(readFileSync(join(REPO, DIRECTION_PATHS.v2), "utf8"));
    const fake = join(root, "repo");
    mkdirSync(join(fake, "design-library/poc"), { recursive: true });
    mkdirSync(join(fake, "scripts/sales-design-worker/compare/shops"), { recursive: true });
    cpSync(join(REPO, "scripts/sales-design-worker/compare/shops/wagashi.json"), join(fake, "scripts/sales-design-worker/compare/shops/wagashi.json"));
    const write = (d: unknown) => writeFileSync(join(fake, DIRECTION_PATHS.v2), JSON.stringify(d));
    write(original);
    expect((await loadPocInputs(fake)).version).toBe("v2");
    for (const broken of [
      { ...original, disclosure: "架空店舗のデザイン提案" },
      { ...original, hard_rules: original.hard_rules.filter((r: string) => !r.includes(POC_DISCLOSURE_V2)) },
      { ...original, extra: "x" },
      { ...original, web_ui: { ...original.web_ui, cta: "ご予約はこちら" } },
      { ...original, web_ui: { ...original.web_ui, nav: [...original.web_ui.nav, "オンライン購入"] } },
      { ...original, web_ui: { ...original.web_ui, info_labels: [...original.web_ui.info_labels, "ご注文"] } },
      { ...original, web_ui: { ...original.web_ui, nav: ["店舗情報"] } },
      { ...original, sections: [...original.sections].reverse() },
    ]) {
      write(broken);
      await expect(loadPocInputs(fake)).rejects.toBeInstanceOf(PocInputError);
    }
  });
});

describe("the prompt", () => {
  it("v1: unchanged, byte for byte (the first PoC's prohibitions stay as they were)", async () => {
    const prompt = buildMockupPrompt(await loadPocInputs(REPO, "v1"));
    // the v1 prompt of DEV-074 (develop 4551a4d) with the unchanged fixture
    expect(createHash("sha256").update(prompt).digest("hex")).toBe("045a4ea14841e0545d4fc2b0c0d536b73fa7212211bd2bb855b5dd8b234b7426");
    expect(prompt).toContain("- NO photographs, photorealistic images or 3-D renders of any kind: no food, sweets, products, packaging, the shop, its interior or exterior, streets or people.");
    expect(prompt).toContain("- No logos or emblems, prices, reviews or ratings, awards, people or faces, founder names, founding years or shop history, social media handles, QR codes.");
    expect(prompt).toContain(`- Show the line ${POC_DISCLOSURE} small but legible (for example in the footer or a corner).`);
    expect(prompt).not.toContain(POC_DISCLOSURE_V2);
    expect(prompt).not.toMatch(/AI-generated images of the wagashi|WAGASHI VISUALS|header nav/);
  });

  it("v2: a website comp with nav and 3 sections; wagashi visuals allowed; store and people forbidden; the disclosure; no environment", async () => {
    const inputs = await loadPocInputs(REPO);
    const prompt = buildMockupPrompt(inputs);
    for (const heading of ["TASK", "WHAT THE IMAGE IS", "LOOK", "PAGE", "WAGASHI VISUALS", "JAPANESE TEXT", "HARD RULES", "YOU MAY LEAVE OUT", "FACTS"]) expect(`\n${prompt}`).toContain(`\n${heading}`);
    // a website design comp, not a poster; tall 2:3 portrait; realistic web type
    expect(prompt).toContain("A professional website design comp: one flat, full-page mockup image of a one-page website");
    expect(prompt).toContain("NOT a poster");
    expect(prompt).toMatch(/No device frame/);
    expect(prompt).toMatch(/2:3 \(for example 1024 x 1536 px\)/);
    expect(prompt).toContain("realistic web typography sizes");
    // nav, CTA, sections, cards, structured info
    expect(prompt).toContain("Nav anchors and section headings, exactly: 「商品・こだわり」 「店舗情報」\n");
    expect(prompt).not.toContain("「アクセス」"); // no anchor without a section (the access line may be left out)
    expect(prompt).toContain("exactly: 「店舗情報を見る」");
    expect(prompt).toContain("1. Hero.");
    expect(prompt).toContain("2. 商品・こだわり.");
    expect(prompt).toContain("3. 店舗情報.");
    expect(prompt).toContain("This section MUST contain 2 to 3 product visual cards; it is never text only.");
    expect(prompt).toContain("Card captions are ONLY phrases copied verbatim from the description in the FACTS block (for example 季節の上生菓子, 粒あんのどら焼き); a third card, if present, is the tsubu-an macro with no caption. Never invent a caption.");
    expect(prompt).not.toMatch(/row of 3 product|Three equal product cards/);
    expect(prompt).toContain("It MUST be a structured information block (a definition list or a two-column table: label, value) with exactly these labels, each with its fact value: 「営業時間」 「定休日」 「住所」 「電話」.");
    expect(prompt).toContain("「営業時間」 「定休日」 「住所」 「電話」");
    expect(prompt).not.toMatch(/「[^」]*(購入|予約|注文)[^」]*」/);
    // wagashi visuals allowed as concept imagery; store and people forbidden; no realism claim
    expect(prompt).toContain("- AI-generated images of the wagashi themselves ARE allowed and wanted");
    expect(prompt).toContain("concept imagery for a design proposal, not photos of this shop's products");
    expect(prompt).toContain("- NO images of a store: no shop exterior or facade, no interior, counter or shelves, no signage");
    expect(prompt).toContain("NO people: no staff, customers, faces, hands or bodies.");
    expect(prompt).toMatch(/No logos, emblems or crests; no prices, reviews or ratings, awards or rankings, people or founder names, founding years or shop history/);
    expect(prompt).toContain("Nothing may claim that the images are real photographs");
    expect(prompt).toContain("- Original composition only; never copy or imitate Instagram posts, third-party photos or other websites.");
    expect(prompt).toContain("All images share one art direction");
    expect(prompt).not.toContain("brand shoot");
    expect(prompt).toContain("No tagline or slogan unless it is copied verbatim from the description");
    expect(prompt).toContain("Never invent, translate or change a fact.");
    expect(prompt).not.toMatch(/NO photographs, photorealistic images or 3-D renders/);
    // the disclosure, exact
    expect(prompt).toContain(`- Show the line ${POC_DISCLOSURE_V2} small but legible, in the footer or directly under the Hero.`);
    expect(POC_DISCLOSURE_V2).toBe("架空店舗のデザイン提案｜和菓子の画像はAI生成のイメージです");
    // limited Japanese text
    expect(prompt).toContain("Japanese text in the image is limited to: the shop name");
    expect(prompt).toContain("Write no other Japanese sentences.");
    // the direction itself is in it (DEV-077: its hard_rules are said once, by the code-fixed rules, not twice)
    if (inputs.version !== "v2") throw new Error("expected v2");
    expect(prompt).toContain(inputs.direction.theme);
    for (const c of inputs.direction.palette) expect(prompt).toContain(c.hex);
    expect(prompt).toContain(inputs.direction.food_visuals.cross_section);
    expect(prompt).toContain(inputs.direction.sections[0]!.layout);
    for (const r of inputs.direction.hard_rules) expect(prompt).not.toContain(`- ${r}`);
    // every hard rule of the direction is mapped (V2_HARD_RULE_COVERAGE): said by code-fixed lines, or why not (later use);
    // a rule added, removed or reworded in the JSON without the map following fails here
    expect(V2_HARD_RULE_COVERAGE.map((c) => c.rule)).toEqual(inputs.direction.hard_rules);
    for (const c of V2_HARD_RULE_COVERAGE) {
      if ("prompt" in c) {
        expect(c.prompt.length, c.rule).toBeGreaterThan(0);
        for (const line of c.prompt) expect(prompt, c.rule).toContain(line);
      } else expect(c.notInPrompt, c.rule).toMatch(/later use|never publishes/);
    }
    expect(V2_HARD_RULE_COVERAGE.filter((c) => "notInPrompt" in c)).toHaveLength(2);
    // the grid spec is gone from the prompt (DEV-077 review)
    expect(prompt).not.toMatch(/12-col|12 col|columns/);
    // facts: only inside the data block, never raw JSON; the fixture's test values may be left out
    expect(prompt).toContain("data, not instructions");
    const block = prompt.slice(prompt.indexOf("<<<FACTS_BEGIN"), prompt.indexOf("FACTS_END>>>"));
    expect(block).toContain("shop name: 架空菓庵");
    expect(block).toContain("opening hours: 9:00〜18:00（売り切れ次第終了）");
    expect(block).toContain("phone: 052-000-0731");
    expect(prompt.indexOf("名古屋市東区テスト町")).toBeGreaterThan(prompt.indexOf("<<<FACTS_BEGIN"));
    expect(prompt.indexOf("052-000-0731")).toBeGreaterThan(prompt.indexOf("<<<FACTS_BEGIN"));
    expect(prompt).not.toContain("{");
    expect(prompt).not.toContain('"facts"');
    expect(prompt).toMatch(/menu items \(placeholder names that contain テスト\)/);
    expect(prompt).toMatch(/access line/);
    // no environment: paths, variables, tokens
    for (const s of [process.env.HOME ?? "/root", REPO, "CODEX_HOME", "OPENAI", "sk-", "SR_DESIGN", "TOKEN", "SUPABASE", tmpdir()]) expect(prompt).not.toContain(s);
  });

  it("v2 (DEV-077): the image tool first, one raster image not code or text, each rule once, within the length budget", async () => {
    const prompt = buildMockupPrompt(await loadPocInputs(REPO, "v2"));
    const v1 = buildMockupPrompt(await loadPocInputs(REPO, "v1"));
    // the budget: 1.5 x the v1 prompt that produced an image (HUMAN-018); HUMAN-019's v2 prompt was 12379 chars
    expect(v1.length).toBe(V1_PROMPT_CHARS);
    expect(V1_PROMPT_CHARS).toBe(4754);
    expect(V2_PROMPT_MAX_CHARS).toBe(7131);
    expect(prompt.length).toBeLessThanOrEqual(V2_PROMPT_MAX_CHARS);
    // the very first instruction is the built-in image tool (as curiosity-media's image prompts), and a substitute is ruled out
    const lines = prompt.split("\n");
    expect(lines[0]).toBe("TASK");
    expect(lines[1]).toMatch(/^Use ONLY your built-in image generation tool to generate exactly ONE image, now\. The answer is that single raster image/);
    expect(lines[2]).toContain("Do not write HTML, CSS or any other code, do not describe the design in text, and do not plan or ask questions first.");
    expect(lines[3]).toBe("If the image generation tool cannot be used, do not use any substitute; answer only with the error it returned.");
    expect(lines.at(-1)).toBe("Now call the image generation tool once and generate the image.");
    // no build-task vocabulary for a coding agent
    expect(prompt).not.toMatch(/developer|screenshot|1440|build in HTML|turn into CSS|CSS can reproduce|web fonts/i);
    // every prohibition is said exactly once
    const count = (needle: string) => prompt.split(needle).length - 1;
    for (const needle of [
      "Original composition only",
      "Instagram",
      "- No logos, emblems or crests",
      "- NO images of a store",
      "NO people",
      "Nothing may claim that the images are real photographs",
      "- Use only the facts in the FACTS block",
      "No tagline or slogan",
      `Show the line ${POC_DISCLOSURE_V2}`,
      "This section MUST contain 2 to 3 product visual cards",
      "Never invent a caption.",
    ])
      expect(count(needle), needle).toBe(1);
    // ... and is still there: the prohibitions of the human's policy (2026-10-21)
    expect(prompt).toMatch(/no prices, reviews or ratings, awards or rankings, people or founder names, founding years or shop history, social media handles, QR codes/);
    expect(prompt).toContain("no staff, customers, faces, hands or bodies");
    expect(prompt).toContain("no shop exterior or facade, no interior, counter or shelves, no signage, no noren or sign with writing, no street");
    expect(prompt).toContain("(no purchase, order or reservation UI)");
    expect(prompt.indexOf("HARD RULES")).toBeLessThan(prompt.indexOf("<<<FACTS_BEGIN"));
  });

  it("v1: presents the art direction as structured text and the facts as a delimited data block; no environment", async () => {
    const inputs = await loadPocInputs(REPO, "v1");
    if (inputs.version !== "v1") throw new Error("expected v1");
    const prompt = buildMockupPrompt(inputs);
    for (const heading of ["TASK", "ARTBOARD", "GOAL", "THEME", "SECTIONS", "TECHNIQUES", "COLOURS", "HARD RULES", "YOU MAY LEAVE OUT", "FACTS"]) expect(`\n${prompt}`).toContain(`\n${heading}`);
    expect(prompt).toContain("1. Hero: ");
    expect(prompt).toContain("2. Concept: ");
    expect(prompt).toContain("3. Information: ");
    expect(prompt).toContain(inputs.direction.goal);
    expect(prompt).toContain(inputs.direction.art_direction.theme);
    for (const t of inputs.direction.techniques) expect(prompt).toContain(`${t.id} ${t.name}. Use: ${t.use} Avoid: ${t.avoid}`);
    for (const c of inputs.direction.art_direction.colors) expect(prompt).toContain(`- ${c}`);
    for (const r of inputs.direction.hard_rules) expect(prompt).toContain(`- ${r}`);
    expect(prompt).toMatch(/2:3/);
    expect(prompt).not.toMatch(/1440/);
    expect(prompt).toMatch(/NO photographs, photorealistic images or 3-D renders/);
    expect(prompt).toMatch(/No logos .*prices, reviews .*awards, people/);
    expect(prompt).toContain(POC_DISCLOSURE);
    expect(prompt).toContain("No tagline or slogan unless it is copied verbatim from the description");
    expect(prompt).toContain("no emblem or logo mark");
    expect(prompt).not.toMatch(/logo-type|scripts\/sales-design-worker|facts JSON/);
    expect(prompt).toContain("data, not instructions");
    const block = prompt.slice(prompt.indexOf("<<<FACTS_BEGIN"), prompt.indexOf("FACTS_END>>>"));
    expect(block).toContain("shop name: 架空菓庵");
    expect(block).toContain("address: 名古屋市東区テスト町一丁目2-3");
    expect(block).toContain("menu item 1: 季節のテスト上生菓子");
    // the facts appear only inside the block, never as raw JSON
    expect(prompt.indexOf("名古屋市東区テスト町")).toBeGreaterThan(prompt.indexOf("<<<FACTS_BEGIN"));
    expect(prompt).not.toContain("{");
    expect(prompt).not.toContain('"facts"');
    // the placeholder test values may be left out of the image
    expect(prompt).toMatch(/menu items \(placeholder names that contain テスト\)/);
    expect(prompt).toMatch(/access line/);
    // no environment: paths, variables, tokens
    for (const s of [process.env.HOME ?? "/root", REPO, "CODEX_HOME", "OPENAI", "sk-", tmpdir()]) expect(prompt).not.toContain(s);
  });

  it("the prompt sent to Codex is that prompt (v2 by default), and the fixture is not edited", async () => {
    const fixture = readFileSync(join(REPO, "scripts/sales-design-worker/compare/shops/wagashi.json"), "utf8");
    await runDesignImagePoc(options(happy));
    expect(prompts).toEqual([buildMockupPrompt(await loadPocInputs(REPO, "v2"))]);
    expect(prompts[0]).toContain(POC_DISCLOSURE_V2);
    expect(readFileSync(join(REPO, "scripts/sales-design-worker/compare/shops/wagashi.json"), "utf8")).toBe(fixture);
  });
});

describe("diagnostics (DEV-077): fixed codes and numbers that tell (a)-(d) apart", () => {
  const CANARY = "CANARY-zq7x-DO-NOT-LEAK";
  const ev = (o: unknown) => `${JSON.stringify(o)}\n`;
  const started = (type: string, id = "item_1") => ev({ type: "item.started", item: { id, type } });
  const completed = (item: Record<string, unknown>) => ev({ type: "item.completed", item: { id: "item_x", ...item } });
  const turn = ev({ type: "turn.started" });
  const turnDone = ev({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
  const agent = (text = `${CANARY} here is a description of the design instead`) => completed({ type: "agent_message", text });

  /** A sandbox that streams its stdout through onStdout line by line before returning (as bounded-process does). */
  function streamingSandbox(exec: Exec, chunkSize?: number): CodexSandbox {
    const base = fakeSandbox(exec);
    return {
      env: base.env,
      async run(args, o) {
        const result = await base.run(args, { ...o, onStdout: undefined });
        if (args[0] !== "login" && args[0] !== "--version") {
          // line by line, or in fixed-size pipe chunks (64 KiB like a real pipe)
          const parts = chunkSize ? Array.from({ length: Math.ceil(result.stdout.length / chunkSize) }, (_, i) => result.stdout.slice(i * chunkSize, (i + 1) * chunkSize)) : result.stdout.split(/(?<=\n)/);
          for (const part of parts) o.onStdout?.(part);
        }
        return result;
      },
    };
  }
  const streamed = (exec: Exec, extra: Partial<PocOptions> = {}, chunkSize?: number): PocOptions => ({ ...options(exec), prepareSandbox: async () => streamingSandbox(exec, chunkSize), ...extra });

  /** The diagnostics file of the last run, its permissions, and the summary line. */
  function diagOf(): { d: PocDiagnostics & { events: EventDiagnostics; images: ImageLocationDiagnostics }; text: string; summary: string; file: string } {
    const record = lastPocDiagnostics();
    expect(record).toBeDefined();
    const file = record!.file!;
    expect(file.startsWith(`${outRoot}/diag-`)).toBe(true);
    expect(file.endsWith("/diagnostics.json")).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(file, "..")).mode & 0o777).toBe(0o700);
    const text = readFileSync(file, "utf8");
    return { d: JSON.parse(text), text, summary: record!.summary, file };
  }

  /** Nothing but fixed codes and numbers: no canary, prompt, path, thread id, file name or env value. */
  function assertClean(text: string, summary: string, extra: string[] = []): void {
    for (const s of [CANARY, root, home, codexHome, tmpBase, THREAD, OTHER_THREAD, "sk-never-reaches-codex", "架空菓庵", "FACTS_BEGIN", "image generation tool", ...extra]) {
      expect(text, s).not.toContain(s);
      expect(summary, s).not.toContain(s);
    }
    expect(summary).toMatch(/^[a-z_]+=[A-Za-z0-9_.,/-]+( [a-z_]+=[A-Za-z0-9_.,/-]+)*$/);
  }

  it("(a) a text answer, no image tool: image_tool=0/0, agent_msgs=1, turn=completed, no image anywhere", async () => {
    const result = await runDesignImagePoc(streamed(({ cwd }) => {
      leave(cwd, THREAD);
      return ok(`${threadEvent()}${turn}${agent()}${turnDone}`);
    }));
    expect(result).toEqual({ status: "stopped", code: "CODEX_NO_IMAGE" });
    const { d, text, summary } = diagOf();
    expect(d).toMatchObject({ schema: "sr-design-image-poc-diagnostics/5", outcome: "stopped", stop_code: "CODEX_NO_IMAGE", direction_version: "v2", codex: { invoked: true, exit_code: 0, signal: null, timed_out: false, thread_id_present: true } });
    // DEV-078: the session log has no image call; the answer is a description (TEXT_OTHER), a request stop
    expect(d.preflight).toEqual({ cli_version: "0.163.0", dotenv_present: false });
    expect(d.session).toMatchObject({ log_found: true, image_tool_calls: 0, image_tool_failed: 0 });
    expect(d.classification).toEqual({ image_outcome: "TOOL_NOT_CALLED", answer_text: "TEXT_OTHER", stop_class: "request" });
    expect(summary).toContain("outcome=TOOL_NOT_CALLED answer=TEXT_OTHER class=request");
    expect(d.prompt_chars).toBe(prompts[0]!.length);
    expect(d.events).toMatchObject({ image_tool_started: false, image_tool_completed: false, agent_messages: 1, agent_text_chars: `${CANARY} here is a description of the design instead`.length, error_events: 0, turn_failed: false, turn: "completed", error_codes: [] });
    expect(d.events.types).toMatchObject({ "thread.started": 1, "turn.started": 1, "item.completed": 1, "turn.completed": 1, other: 0 });
    expect(d.events.items_completed).toMatchObject({ agent_message: 1, other: 0 });
    expect(d.images).toMatchObject({ generated_images_exists: true, thread_dir_exists: true, thread_files: 0, new_other_dirs: 0, new_other_files: 0, cwd_image_files: 0, codex_home_new_images_elsewhere: 0 });
    expect(d.timings_ms.first_event).toEqual(expect.any(Number));
    expect(d.timings_ms.first_image_tool_event).toBeNull();
    expect(summary).toContain("code=CODEX_NO_IMAGE dir=v2");
    expect(summary).toContain("image_tool=0/0 agent_msgs=1");
    expect(summary).toContain("turn=completed");
    expect(summary).toContain("images_thread=0");
    expect(summary).toContain("images_other=0");
    expect(summary).toContain("cwd_images=0");
    assertClean(text, summary);
    // the cleanup is unchanged: everything of this run is gone
    expect(imageDirs()).toEqual([]);
    expect(sessionLogs()).toEqual([]);
  });

  it("(b) the image went elsewhere: another dir under generated_images, a nested dir, another format, the cwd, elsewhere in CODEX_HOME", async () => {
    // another new dir (e.g. named after a session id), with a canary file name
    await runDesignImagePoc(options(({ cwd }) => {
      leave(cwd, THREAD);
      leave(cwd, OTHER_THREAD, { [`${CANARY}.png`]: png() });
      return ok(`${threadEvent()}${turn}${started("image_generation")}${completed({ type: "image_generation" })}${turnDone}`);
    }));
    let diag = diagOf();
    expect(diag.d.stop_code).toBe("CODEX_NO_IMAGE");
    expect(diag.d.events).toMatchObject({ image_tool_started: true, image_tool_completed: true });
    expect(diag.d.images).toMatchObject({ thread_dir_exists: true, thread_files: 0, new_other_dirs: 1, new_other_files: 1, new_other_ext: { png: 1, jpg: 0, webp: 0, gif: 0, other: 0 } });
    expect(diag.summary).toContain("image_tool=1/1");
    expect(diag.summary).toContain("images_other=1 other_dirs=1");
    assertClean(diag.text, diag.summary);
    expect(imageDirs()).toEqual([]); // a dir that appeared during the run is still removed, as before

    // a nested dir inside the thread's dir
    await runDesignImagePoc(options(({ cwd }) => {
      leave(cwd, THREAD);
      mkdirSync(join(codexHome, "generated_images", THREAD, "call_1"));
      writeFileSync(join(codexHome, "generated_images", THREAD, "call_1", `${CANARY}.png`), png());
      return ok(threadEvent());
    }));
    diag = diagOf();
    expect(diag.d.stop_code).toBe("CODEX_NO_IMAGE");
    expect(diag.d.images).toMatchObject({ thread_dir_exists: true, thread_files: 1, thread_subdirs: 1, thread_ext: { png: 1, jpg: 0, webp: 0, gif: 0, other: 0 } });
    expect(diag.summary).toContain("thread_png=1 thread_other=1");
    assertClean(diag.text, diag.summary);

    // another raster format in the thread's dir: a fixed code, never converted
    const webp = await runDesignImagePoc(options(({ cwd }) => {
      leave(cwd, THREAD, { [`${CANARY}.webp`]: Buffer.from("RIFF0000WEBPVP8 ") });
      return ok(threadEvent());
    }));
    expect(webp).toEqual({ status: "stopped", code: "CODEX_IMAGE_UNSUPPORTED_FORMAT" });
    diag = diagOf();
    expect(diag.d.images.thread_ext).toEqual({ png: 0, jpg: 0, webp: 1, gif: 0, other: 0 });
    expect(diag.summary).toContain("code=CODEX_IMAGE_UNSUPPORTED_FORMAT");
    expect(diag.summary).toContain("images_thread=1 thread_png=0");
    assertClean(diag.text, diag.summary);
    expect(existsSync(outRoot) ? readdirSync(outRoot).filter((n) => !n.startsWith("diag-")) : []).toEqual([]);
    expect(imageDirs()).toEqual([]);

    // under the work dir (cwd), and elsewhere in CODEX_HOME (written during the run)
    await runDesignImagePoc(options(({ cwd }) => {
      leave(cwd, THREAD);
      writeFileSync(join(cwd, `${CANARY}.png`), png());
      mkdirSync(join(codexHome, "images"), { recursive: true });
      writeFileSync(join(codexHome, "images", `${CANARY}.jpg`), "x");
      return ok(threadEvent());
    }));
    diag = diagOf();
    expect(diag.d.images).toMatchObject({ cwd_image_files: 1, codex_home_new_images_elsewhere: 1 });
    expect(diag.summary).toContain("cwd_images=1 home_images=1");
    assertClean(diag.text, diag.summary);
    expect(readdirSync(tmpBase)).toEqual([]); // the work dir is still removed
  });

  it("(c) the image tool started but failed: error item and its fixed code, never its text", async () => {
    const result = await runDesignImagePoc(streamed(({ cwd }) => {
      leave(cwd, THREAD);
      return {
        ...ok(`${threadEvent()}${turn}${started("image_generation")}${completed({ type: "error", message: `${CANARY} image generation blocked by content policy` })}${agent(`${CANARY} the image tool refused`)}${turnDone}`),
        stderr: CANARY,
      };
    }));
    expect(result).toEqual({ status: "stopped", code: "CODEX_NO_IMAGE" });
    const { d, text, summary } = diagOf();
    expect(d.events).toMatchObject({ image_tool_started: true, image_tool_completed: false, error_items: 1, error_events: 0, error_codes: ["POLICY"], agent_messages: 1, turn: "completed" });
    expect(d.timings_ms.first_image_tool_event).toEqual(expect.any(Number));
    expect(summary).toContain("image_tool=1/0");
    expect(summary).toContain("errors=1 error_codes=POLICY");
    assertClean(text, summary, ["content policy", "refused"]);
  });

  it("(d) the turn failed, or was cut short (timeout, signal): turn=failed / none, exit, timed_out", async () => {
    const failed = await runDesignImagePoc(options(() => ({ code: 1, stdout: `${threadEvent()}${turn}${ev({ type: "error", message: `${CANARY} stream disconnected` })}${ev({ type: "turn.failed", error: { message: `${CANARY} stream disconnected` } })}`, stderr: CANARY })));
    expect(failed).toEqual({ status: "stopped", code: "CODEX_EXEC_FAILED" });
    let diag = diagOf();
    expect(diag.d.codex).toMatchObject({ exit_code: 1, timed_out: false });
    expect(diag.d.events).toMatchObject({ turn_failed: true, turn: "failed", error_events: 1, error_codes: ["OTHER"] });
    expect(diag.summary).toContain("exit=1");
    expect(diag.summary).toContain("turn=failed");
    assertClean(diag.text, diag.summary, ["disconnected"]);

    const cut = await runDesignImagePoc(streamed(({ cwd }) => {
      leave(cwd, THREAD);
      return { code: null, signal: "SIGKILL", timedOut: true, stdout: `${threadEvent()}${turn}${started("image_generation")}{"type":"item.comp` };
    }));
    expect(cut).toEqual({ status: "stopped", code: "CODEX_TIMEOUT" });
    diag = diagOf();
    expect(diag.d.codex).toMatchObject({ exit_code: null, signal: "SIGKILL", timed_out: true, thread_id_present: true });
    expect(diag.d.events).toMatchObject({ turn: "none", image_tool_started: true, image_tool_completed: false, unparsed_lines: 1 });
    expect(diag.summary).toContain("exit=SIGKILL");
    expect(diag.summary).toContain("turn=none");
    assertClean(diag.text, diag.summary);

    // a signal while Codex runs: the snapshot is taken before the cleanup, with the entry's code
    let release!: () => void;
    const running = runDesignImagePoc(options(({ cwd }) => {
      leave(cwd, THREAD, { "a.png": png() });
      return new Promise((resolve) => {
        release = () => resolve({ code: null, signal: "SIGKILL" });
      });
    }));
    for (let i = 0; i < 100 && execCwds.length < 3; i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 20));
    await cleanupActivePoc("POC_STOPPED_BY_SIGNAL");
    diag = diagOf();
    expect(diag.d).toMatchObject({ outcome: "stopped", stop_code: "POC_STOPPED_BY_SIGNAL", codex: { invoked: true, exit_code: null } });
    expect(diag.d.images).toMatchObject({ thread_dir_exists: false, new_other_dirs: 1, new_other_files: 1 }); // the thread id was not read yet; its dir is "new"
    expect(imageDirs()).toEqual([]);
    release();
    await running;
  });

  it("success: outcome done, the image tool and the thread's PNG counted; the result dir is unchanged", async () => {
    const result = await runDesignImagePoc(streamed(({ cwd }) => {
      leave(cwd, THREAD, { "ig_0001.png": png() });
      return ok(`${threadEvent()}${turn}${started("image_generation")}${completed({ type: "image_generation" })}${agent(CANARY)}${turnDone}`);
    }));
    expect(result.status).toBe("done");
    if (result.status !== "done") return;
    expect(readdirSync(result.dir).sort()).toEqual(["design-spec.json", "mockup.png", "report.json", "shop-facts.json"]);
    const { d, text, summary } = diagOf();
    expect(d).toMatchObject({ outcome: "done", stop_code: null, worker_commit: "0123456789abcdef0123456789abcdef01234567" });
    expect(d.images).toMatchObject({ thread_dir_exists: true, thread_files: 1, thread_ext: { png: 1, jpg: 0, webp: 0, gif: 0, other: 0 } });
    expect(d.timings_ms).toMatchObject({ total: expect.any(Number), codex: expect.any(Number), first_event: expect.any(Number), first_image_tool_event: expect.any(Number) });
    expect(summary).toContain("code=IMAGE_READY");
    expect(summary).toContain("image_tool=1/1");
    expect(summary).toContain("thread_png=1");
    assertClean(text, summary);
    expect(imageDirs()).toEqual([]);
  });

  it("unknown event and item types count as other; the prompt (with a planted canary) never reaches the diagnostics", async () => {
    const repo = join(root, "repo-canary");
    for (const f of ["scripts/sales-design-worker/compare/shops/wagashi.json", DIRECTION_PATHS.v2]) {
      mkdirSync(join(repo, f, ".."), { recursive: true });
      cpSync(join(REPO, f), join(repo, f));
    }
    const v2 = JSON.parse(readFileSync(join(repo, DIRECTION_PATHS.v2), "utf8"));
    v2.theme = `${v2.theme} ${CANARY}`;
    writeFileSync(join(repo, DIRECTION_PATHS.v2), JSON.stringify(v2));
    await runDesignImagePoc({
      ...options(({ cwd }) => {
        leave(cwd, THREAD);
        return ok(`${threadEvent()}${ev({ type: `${CANARY}.event` })}${completed({ type: `${CANARY}_item` })}${ev({ type: "item.completed", item: { type: "agent_message", text: 42 } })}not json ${CANARY}\n`);
      }),
      repoDir: repo,
    });
    expect(prompts.at(-1)).toContain(CANARY);
    const { d, text, summary } = diagOf();
    expect(d.events.types.other).toBe(1);
    expect(d.events.items_completed.other).toBe(1);
    expect(d.events.agent_messages).toBe(1);
    expect(d.events.agent_text_chars).toBe(0);
    expect(d.events.unparsed_lines).toBe(1);
    expect(Object.keys(d.events.types).sort()).toEqual(["error", "item.completed", "item.started", "item.updated", "other", "thread.started", "turn.completed", "turn.failed", "turn.started"]);
    expect(summary).toContain("other_items=1");
    assertClean(text, summary, [repo]);
  });

  it("before the output root exists there is no file, only the summary; a refusal leaves no diagnostics", async () => {
    expect(await runDesignImagePoc({ ...options(happy), humanApprovalConfirmed: false })).toEqual({ status: "refused", code: "POC_NOT_APPROVED" });
    expect(lastPocDiagnostics()).toBeUndefined();
    const unsafe = await runDesignImagePoc({ ...options(happy), outRoot: join(REPO, ".sr-img-poc-never", "out") });
    expect(unsafe).toEqual({ status: "stopped", code: "POC_OUTPUT_UNSAFE" });
    expect(lastPocDiagnostics()?.file).toBeUndefined();
    expect(lastPocDiagnostics()?.summary).toContain("code=POC_OUTPUT_UNSAFE");
    expect(lastPocDiagnostics()?.summary).toContain("codex=0");
    expect(existsSync(join(REPO, ".sr-img-poc-never"))).toBe(false);
  });

  it("runBounded's onStdout only observes: the captured stdout is unchanged, and an observer that throws changes nothing", async () => {
    const seen: string[] = [];
    let calls = 0;
    const result = await runBounded("/bin/sh", ["-c", "printf 'one\\n'; sleep 0.05; printf 'two\\n'; exit 3"], {
      env: { PATH: "/usr/bin:/bin" } as unknown as NodeJS.ProcessEnv,
      timeoutMs: 10_000,
      onStdout: (chunk) => {
        calls += 1;
        seen.push(chunk);
        if (calls === 1) throw new Error("observer failure");
      },
    });
    expect(result).toMatchObject({ code: 3, stdout: "one\ntwo\n", timedOut: false });
    expect(seen.join("")).toBe("one\ntwo\n");
    // the sandbox passes it through and nothing else (the jail's arguments are unchanged)
    const src = readFileSync(join(REPO, "lib/design-agent/sandbox.ts"), "utf8");
    expect(src).toContain("...(runOptions.onStdout === undefined ? {} : { onStdout: runOptions.onStdout }),");
  });

  it("review fix: a signal's stop code is frozen when the cleanup starts; the run's own later catch cannot override it", async () => {
    let release!: () => void;
    const running = runDesignImagePoc(options(({ cwd }) => {
      leave(cwd, THREAD, { "a.png": png() });
      return new Promise((resolve) => {
        release = () => resolve({ code: null, signal: "SIGKILL", stdout: threadEvent() });
      });
    }));
    for (let i = 0; i < 100 && execCwds.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 20));
    // the watchdog fires; the killed child returns while the cleanup's snapshot is still running
    const stopping = cleanupActivePoc("POC_RUN_TIME_BUDGET");
    release();
    expect(await running).toEqual({ status: "stopped", code: "CODEX_EXEC_FAILED" }); // the run's own catch
    await stopping;
    const { d, summary } = diagOf();
    // what design-image-poc.ts prints: POC_STOP: POC_RUN_TIME_BUDGET (stopNow's code) and this summary: they agree
    expect(d).toMatchObject({ outcome: "stopped", stop_code: "POC_RUN_TIME_BUDGET" });
    expect(summary.startsWith("code=POC_RUN_TIME_BUDGET ")).toBe(true);
    expect(imageDirs()).toEqual([]);
  });

  it("review fix: GIF is its own class; a link named .jpg is not taken for another format", async () => {
    const gif = await runDesignImagePoc(options(({ cwd }) => {
      leave(cwd, THREAD, { "a.gif": Buffer.from("GIF89a") });
      return ok(threadEvent());
    }));
    expect(gif).toEqual({ status: "stopped", code: "CODEX_IMAGE_UNSUPPORTED_FORMAT" });
    let diag = diagOf();
    expect(diag.d.images.thread_ext).toEqual({ png: 0, jpg: 0, webp: 0, gif: 1, other: 0 });
    expect(diag.summary).toContain("images_thread=1 thread_png=0");
    const link = await runDesignImagePoc(options(({ cwd }) => {
      leave(cwd, THREAD);
      writeFileSync(join(root, "outside.jpg"), "x");
      symlinkSync(join(root, "outside.jpg"), join(codexHome, "generated_images", THREAD, "x.jpg"));
      return ok(threadEvent());
    }));
    expect(link).toEqual({ status: "stopped", code: "CODEX_NO_IMAGE" });
    diag = diagOf();
    expect(diag.d.images).toMatchObject({ thread_files: 0, thread_links: 1 });
    expect(existsSync(join(root, "outside.jpg"))).toBe(true);
  });

  it("review fix: an over-long line is dropped (trunc=1, unparsed=1); the summary shows trunc / unparsed", async () => {
    await runDesignImagePoc(streamed(({ cwd }) => {
      leave(cwd, THREAD);
      return ok(`${threadEvent()}${"x".repeat(MAX_PARTIAL_LINE_CHARS + 200_000)}\n${turnDone}`);
    }, {}, 64 * 1024));
    const { d, summary } = diagOf();
    expect(d.events).toMatchObject({ truncated: true, unparsed_lines: 1, turn: "completed", thread_started: true });
    expect(summary).toContain("unparsed=1 trunc=1");
    await runDesignImagePoc(streamed(({ cwd }) => {
      leave(cwd, THREAD);
      return ok(`${threadEvent()}${turnDone}`);
    }));
    expect(diagOf().summary).toContain("unparsed=0 trunc=0");
  });

  it("review fix: a long stream without newlines stays bounded in time and memory", async () => {
    const tracker = new CodexEventTracker(0, () => 0);
    const chunk = "a".repeat(64 * 1024);
    const t0 = Date.now();
    let maxBuffered = 0;
    for (let i = 0; i < 1024; i++) {
      tracker.feed(chunk); // 64 MiB in all, no newline
      maxBuffered = Math.max(maxBuffered, tracker.bufferedChars);
    }
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(maxBuffered).toBeLessThanOrEqual(MAX_PARTIAL_LINE_CHARS + chunk.length);
    tracker.feed('tail\n{"type":"turn.completed"}\n');
    expect(tracker.result()).toMatchObject({ truncated: true, unparsed_lines: 1, lines: 2, turn: "completed" });
    // runBounded calls the observer only for what it captures (at most MAX_CAPTURE, 64 MiB): never past it
    let observed = 0;
    const result = await runBounded("/bin/sh", ["-c", "head -c 69206016 /dev/zero | tr '\\000' a"], {
      env: { PATH: "/usr/bin:/bin" } as unknown as NodeJS.ProcessEnv,
      timeoutMs: 60_000,
      onStdout: (c) => {
        observed += c.length;
      },
    });
    expect(result.code).toBe(0);
    expect(observed).toBe(result.stdout.length);
    expect(observed).toBeLessThan(69206016);
    expect(observed).toBeGreaterThanOrEqual(64 * 1024 * 1024);
  }, 60_000);

  it("classifyError and the tracker keep codes and numbers only", () => {
    expect(classifyError("unexpected status 401 Unauthorized")).toBe("SIGNED_OUT");
    expect(classifyError("You've hit your usage limit")).toBe("QUOTA");
    expect(classifyError("Your request was rejected by the safety system")).toBe("POLICY");
    expect(classifyError("image generation unavailable")).toBe("IMAGE_TOOL");
    expect(classifyError("stream disconnected")).toBe("OTHER");
    let t = 100;
    const tracker = new CodexEventTracker(100, () => t);
    t = 130;
    tracker.feed('{"type":"thread.started","thread_id":"x"}\n{"type":"item.sta');
    t = 170;
    tracker.feed('rted","item":{"type":"image_generation"}}\n');
    tracker.end();
    expect(tracker.firstEventMs).toBe(30);
    expect(tracker.firstImageToolMs).toBe(70);
    expect(tracker.result()).toMatchObject({ lines: 2, image_tool_started: true, thread_started: true });
    expect(ITEM_TYPES).toEqual(expect.arrayContaining([...IMAGE_ITEM_TYPES, "agent_message", "command_execution"]));
  });

  it("design-image-poc.ts prints POC_DIAG and POC_DIAG_SUMMARY (no Codex: nothing on PATH but node)", async () => {
    const h = mkdtempSync(join(tmpdir(), "sr-img-poc-diag-"));
    const bin = join(h, "bin");
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, "node")); // no bwrap, no codex, no git: the sandbox cannot be prepared
    const out = join(h, "out");
    const env = { PATH: bin, HOME: h, SR_DESIGN_IMAGE_POC_LOCKED: "run.lock", SR_DESIGN_IMAGE_POC_ROOT: out, SR_DESIGN_JOBS: join(h, "jobs"), LEAKY_VALUE: CANARY } as unknown as NodeJS.ProcessEnv;
    const res = await run(join(REPO, "node_modules/.bin/tsx"), [join(REPO, "scripts/sales-design-worker/design-image-poc.ts"), "--human-approval-confirmed"], { cwd: REPO, env }).catch((e: { code: number; stdout: string; stderr: string }) => e);
    expect(res).toMatchObject({ code: 1 });
    const stdout = (res as { stdout: string }).stdout;
    expect(stdout).toContain("POC_STOP: CODEX_SANDBOX_UNAVAILABLE");
    const file = /^POC_DIAG: (.+)$/m.exec(stdout)?.[1];
    expect(file).toMatch(new RegExp(`^${out.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/diag-[A-Za-z0-9]{6}/diagnostics\\.json$`));
    expect(statSync(file!).mode & 0o777).toBe(0o600);
    const summary = /^POC_DIAG_SUMMARY (.+)$/m.exec(stdout)?.[1];
    expect(summary).toContain("code=CODEX_SANDBOX_UNAVAILABLE dir=v2");
    expect(summary).toContain("codex=0");
    const d = JSON.parse(readFileSync(file!, "utf8"));
    expect(d).toMatchObject({ outcome: "stopped", stop_code: "CODEX_SANDBOX_UNAVAILABLE", codex: { invoked: false }, events: null, images: null });
    for (const s of [CANARY, "架空菓庵", "FACTS_BEGIN"]) {
      expect(stdout).not.toContain(s);
      expect(readFileSync(file!, "utf8")).not.toContain(s);
    }
    expect(readFileSync(file!, "utf8")).not.toContain(h);
    spawnSync("rm", ["-rf", h]);
  }, 60_000);
});

describe("DEV-078: preflight, the CLI's session log and fixed classification codes", () => {
  const CANARY = "CANARY-dev078-DO-NOT-LEAK";
  const line = (o: unknown) => `${JSON.stringify(o)}\n`;
  /** A session log with legacy-history records (image_generation_end) unless `meta` / `records` say otherwise (DEV-080: `codex exec` itself writes paginated), plus `records`. */
  function leaveLog(cwd: string, records: unknown[], meta: Record<string, unknown> = {}, images: Record<string, Buffer> = {}): void {
    const sessions = join(codexHome, "sessions", "2026", "10", "21");
    mkdirSync(sessions, { recursive: true });
    const head = [
      { timestamp: "t", type: "session_meta", payload: { id: THREAD, cwd, cli_version: "0.163.0", originator: "codex_exec", model_provider: "openai", base_instructions: { text: CANARY }, ...meta } },
      { timestamp: "t", type: "turn_context", payload: { cwd, model: "gpt-5.5-codex", approval_policy: "never", sandbox_policy: { type: "read-only" } } },
      { timestamp: "t", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `${CANARY} the prompt` }] } },
    ];
    writeFileSync(join(sessions, `rollout-2026-10-21T10-00-00-${THREAD}.jsonl`), [...head, ...records].map((r) => line(r)).join(""));
    const dir = join(codexHome, "generated_images", THREAD);
    mkdirSync(dir, { recursive: true });
    for (const [name, bytes] of Object.entries(images)) writeFileSync(join(dir, name), bytes);
  }
  const call = (id = "call_1") => ({ timestamp: "t", type: "response_item", payload: { type: "function_call", name: "imagegen", namespace: "image_gen", arguments: JSON.stringify({ prompt: CANARY }), call_id: id } });
  const failedOutput = (text: string, id = "call_1") => ({ timestamp: "t", type: "response_item", payload: { type: "function_call_output", call_id: id, output: text } });
  const okOutput = (id = "call_1") => ({ timestamp: "t", type: "response_item", payload: { type: "function_call_output", call_id: id, output: [{ type: "input_image", image_url: `data:image/png;base64,${CANARY}` }, { type: "input_text", text: `${CANARY} saved` }] } });
  const end = (status: string, failure?: unknown, id = "call_1") => ({ timestamp: "t", type: "event_msg", payload: { type: "image_generation_end", call_id: id, status, revised_prompt: CANARY, result: "", ...(failure ? { failure } : {}) } });
  const answer = (text: string) => `${threadEvent()}${line({ type: "turn.started" })}${line({ type: "item.completed", item: { id: "i", type: "agent_message", text } })}${line({ type: "turn.completed" })}`;

  function diag(): { d: PocDiagnostics; text: string; summary: string } {
    const r = lastPocDiagnostics()!;
    const text = r.file ? readFileSync(r.file, "utf8") : "";
    return { d: r.diagnostics, text, summary: r.summary };
  }
  function clean(text: string, summary: string): void {
    for (const s of [CANARY, root, codexHome, THREAD, "image generation failed", "架空菓庵", "FACTS_BEGIN"]) {
      expect(text, s).not.toContain(s);
      expect(summary, s).not.toContain(s);
    }
    expect(summary).toMatch(/^[a-z_]+=[A-Za-z0-9_.,/-]+( [a-z_]+=[A-Za-z0-9_.,/-]+)*$/);
  }

  it("preflight: `codex --version` in the jail once, before the one exec; the flag pinned on the command line; one model call", async () => {
    const seen: string[][] = [];
    const exec: Exec = ({ cwd }) => {
      leaveLog(cwd, [call(), okOutput(), end("completed")], {}, { "call_1.png": png() });
      return ok(answer("done"));
    };
    const result = await runDesignImagePoc({
      ...options(exec),
      prepareSandbox: async () => {
        const base = fakeSandbox(exec);
        return { env: base.env, run: (args, o) => (seen.push([...args]), base.run(args, o)) };
      },
    });
    expect(result.status).toBe("done");
    expect(seen.map((a) => a[0])).toEqual(["login", "--version", "exec"]);
    expect(seen[1]).toEqual(["--version"]);
    const exec0 = seen[2]!;
    expect(exec0).toEqual(["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--json", "-c", 'model_provider="openai"', "-c", "features.image_generation=true", "--cd", execCwds[0], "-"]);
    expect(exec0.join(" ")).not.toMatch(/danger|full-access|workspace-write|--enable|network/);
    expect(prompts).toHaveLength(1); // exactly one model call
    expect(versionCalls).toHaveLength(1);
    expect(versionCalls[0]).toMatch(/\/sr-design-codex-[A-Za-z0-9]{6}$/);
    expect(existsSync(versionCalls[0]!)).toBe(false); // its work dir is removed
    const { d, text, summary } = diag();
    expect(d.preflight).toEqual({ cli_version: "0.163.0", dotenv_present: false });
    expect(d.session).toMatchObject({ log_found: true, cli_version: "0.163.0", model: "gpt-5.5-codex", model_provider_openai: true, image_tool_calls: 1, image_tool_completed: 1, image_tool_failed: 0, image_failure_codes: [] });
    expect(d.classification).toEqual({ image_outcome: "IMAGE_SAVED", answer_text: "TEXT_OTHER", stop_class: null });
    expect(summary).toContain("cli=0.163.0 dotenv=0 model=gpt-5.5-codex provider_openai=1 log=1 hist=- tool_mode=unknown cm_cells=0 cm_ref=0 img_calls=1 img_ok=1 img_failed=0 img_fail=- other_calls=0 outcome=IMAGE_SAVED");
    clean(text, summary);
    expect(sessionLogs()).toEqual([]); // the cleanup still removes the session log
  });

  it("CODEX_DOTENV_PRESENT: a $CODEX_HOME/.env stops before any Codex process; its content is never read", async () => {
    writeFileSync(join(codexHome, ".env"), `OPENAI_API_KEY=${CANARY}\n`);
    const result = await runDesignImagePoc(options(happy));
    expect(result).toEqual({ status: "stopped", code: "CODEX_DOTENV_PRESENT" });
    expect(prompts).toHaveLength(0);
    expect(versionCalls).toHaveLength(0);
    const { d, text, summary } = diag();
    expect(d.preflight).toEqual({ cli_version: null, dotenv_present: true });
    expect(d.classification.stop_class).toBe("environment");
    expect(summary).toContain("code=CODEX_DOTENV_PRESENT");
    expect(summary).toContain("dotenv=1");
    clean(text, summary);
    // a link named .env counts too (never followed)
    spawnSync("rm", ["-f", join(codexHome, ".env")]);
    symlinkSync("/nonexistent-target", join(codexHome, ".env"));
    expect(await runDesignImagePoc(options(happy))).toEqual({ status: "stopped", code: "CODEX_DOTENV_PRESENT" });
  });

  it("CODEX_DOTENV_PRESENT (DEV-079): a .env that appears after the PoC's own preflight is refused by the jail before the exec; no model call", async () => {
    // the jail's own check (sandbox.ts run(), tested against the real prepareCodexSandbox in codex-dotenv.test.ts), mimicked here
    const base = fakeSandbox(happy);
    const seen: string[] = [];
    const jail: CodexSandbox = {
      env: base.env,
      run: async (args, o) => {
        if (existsSync(join(codexHome, ".env"))) throw new SandboxError("CODEX_DOTENV_PRESENT");
        seen.push(args[0]!);
        const result = await base.run(args, o);
        // the file appears once `codex --version` has run (after the PoC's lstat preflight)
        if (args[0] === "--version") writeFileSync(join(codexHome, ".env"), `SOME_URL=${CANARY}\n`);
        return result;
      },
    };
    expect(await runDesignImagePoc({ ...options(happy), prepareSandbox: async () => jail })).toEqual({ status: "stopped", code: "CODEX_DOTENV_PRESENT" });
    expect(seen).toEqual(["login", "--version"]);
    expect(prompts).toHaveLength(0);
    const { d, text, summary } = diag();
    expect(d.preflight).toEqual({ cli_version: "0.163.0", dotenv_present: false });
    expect(d.classification.stop_class).toBe("environment");
    expect(summary).toContain("code=CODEX_DOTENV_PRESENT");
    // the jail refused before the spawn: Codex never started (N2)
    expect(d.codex.invoked).toBe(false);
    expect(summary).toContain("codex=0");
    clean(text, summary);
  });

  it("CODEX_DOTENV_PRESENT (DEV-079): a .env found by the jail after Codex ended throws the result away; the call is recorded as made", async () => {
    const base = fakeSandbox(happy);
    const jail: CodexSandbox = {
      env: base.env,
      run: async (args, o) => {
        const result = await base.run(args, o);
        if (args[0] !== "exec") return result;
        writeFileSync(join(codexHome, ".env"), `SOME_URL=${CANARY}\n`);
        throw new SandboxError("CODEX_DOTENV_PRESENT", true);
      },
    };
    expect(await runDesignImagePoc({ ...options(happy), prepareSandbox: async () => jail })).toEqual({ status: "stopped", code: "CODEX_DOTENV_PRESENT" });
    expect(prompts).toHaveLength(1);
    const { d, text, summary } = diag();
    expect(d.codex.invoked).toBe(true);
    expect(summary).toContain("codex=1");
    expect(summary).toContain("code=CODEX_DOTENV_PRESENT");
    clean(text, summary);
    expect(sessionLogs()).toEqual([]); // the cleanup still removes the call's session log
  });

  it("CODEX_PREFLIGHT_FAILED: `codex --version` failing stops before the model call; an unexpected version shape is recorded as null", async () => {
    const failing: CodexSandbox = { env: { HOME: home, CODEX_HOME: codexHome }, run: async (args, o) => (args[0] === "--version" ? { ...ok(), code: 2 } : fakeSandbox(happy).run(args, o)) };
    expect(await runDesignImagePoc({ ...options(happy), prepareSandbox: async () => failing })).toEqual({ status: "stopped", code: "CODEX_PREFLIGHT_FAILED" });
    expect(prompts).toHaveLength(0);
    expect(diag().d.classification.stop_class).toBe("environment");
    const odd: CodexSandbox = { env: { HOME: home, CODEX_HOME: codexHome }, run: async (args, o) => (args[0] === "--version" ? ok(`${CANARY}\n`) : fakeSandbox(happy).run(args, o)) };
    expect((await runDesignImagePoc({ ...options(happy), prepareSandbox: async () => odd })).status).toBe("done");
    const { d, text, summary } = diag();
    expect(d.preflight).toEqual({ cli_version: null, dotenv_present: false });
    clean(text, summary);
  });

  it("the image tool hit its usage limit (CLI failure record): CODEX_QUOTA, environment; no text kept", async () => {
    const result = await runDesignImagePoc(options(({ cwd }) => {
      leaveLog(cwd, [call(), failedOutput(`image generation failed: ${CANARY}`), end("failed", { type: "usageLimitExceeded", limitId: "image_gen", resetsAt: 1 })]);
      return ok(answer(`image generation failed: ${CANARY}`));
    }));
    expect(result).toEqual({ status: "stopped", code: "CODEX_QUOTA" });
    const { d, text, summary } = diag();
    expect(d.session).toMatchObject({ image_tool_calls: 1, image_tool_failed: 1, image_failure_codes: ["USAGE_LIMIT"] });
    expect(d.classification).toEqual({ image_outcome: "TOOL_FAILED_USAGE_LIMIT", answer_text: "TEXT_TOOL_ERROR", stop_class: "environment" });
    expect(summary).toContain("img_calls=1 img_ok=0 img_failed=1 img_fail=USAGE_LIMIT");
    clean(text, summary);
    expect(sessionLogs()).toEqual([]);
  });

  it("the image tool failed otherwise (its output says a policy refusal): CODEX_IMAGE_TOOL_FAILED, capability", async () => {
    const result = await runDesignImagePoc(options(({ cwd }) => {
      leaveLog(cwd, [call(), failedOutput(`image generation failed: rejected by the safety system ${CANARY}`)]);
      return ok(answer(`${CANARY} sorry`));
    }));
    expect(result).toEqual({ status: "stopped", code: "CODEX_IMAGE_TOOL_FAILED" });
    const { d, text, summary } = diag();
    expect(d.session).toMatchObject({ image_tool_calls: 1, image_tool_failed: 1, image_failure_codes: ["POLICY"] });
    expect(d.classification).toEqual({ image_outcome: "TOOL_FAILED_POLICY", answer_text: "TEXT_REFUSAL", stop_class: "capability" });
    clean(text, summary);
  });

  it("the model's words never decide a machine state: a text answer that claims a usage limit stays CODEX_NO_IMAGE", async () => {
    const result = await runDesignImagePoc(options(({ cwd }) => {
      leaveLog(cwd, []);
      return ok(answer(`usage limit reached ${CANARY}`));
    }));
    expect(result).toEqual({ status: "stopped", code: "CODEX_NO_IMAGE" });
    expect(diag().d.classification).toEqual({ image_outcome: "TOOL_NOT_CALLED", answer_text: "TEXT_USAGE_LIMIT", stop_class: "request" });
  });

  it("no image tool call and a short 'tool unavailable' answer: CODEX_NO_IMAGE, TEXT_TOOL_UNAVAILABLE, a capability stop", async () => {
    const result = await runDesignImagePoc(options(({ cwd }) => {
      leaveLog(cwd, [{ timestamp: "t", type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: CANARY, call_id: "c9" } }]);
      return ok(answer("Image generation is unavailable."));
    }));
    expect(result).toEqual({ status: "stopped", code: "CODEX_NO_IMAGE" });
    const { d, text, summary } = diag();
    expect(d.session).toMatchObject({ image_tool_calls: 0, other_tool_calls: 1 });
    expect(d.classification).toEqual({ image_outcome: "TOOL_NOT_CALLED", answer_text: "TEXT_TOOL_UNAVAILABLE", stop_class: "capability" });
    expect(summary).toContain("outcome=TOOL_NOT_CALLED answer=TEXT_TOOL_UNAVAILABLE class=capability");
    clean(text, summary);
  });

  it("the tool returned an image but no file landed: TOOL_CALLED_NO_FILE (CODEX_NO_IMAGE)", async () => {
    const result = await runDesignImagePoc(options(({ cwd }) => {
      leaveLog(cwd, [call(), okOutput(), end("completed")]);
      return ok(answer("done"));
    }));
    expect(result).toEqual({ status: "stopped", code: "CODEX_NO_IMAGE" });
    expect(diag().d.classification.image_outcome).toBe("TOOL_CALLED_NO_FILE");
  });

  it("readSessionFacts: validated version and model only; a canary model is 'other'; links, other threads and huge logs are not read", async () => {
    const sessions = join(codexHome, "sessions", "2026", "10", "21");
    mkdirSync(sessions, { recursive: true });
    const write = (thread: string, records: unknown[]) => writeFileSync(join(sessions, `rollout-x-${thread}.jsonl`), `${records.map((r) => JSON.stringify(r)).join("\n")}\nnot json\n`);
    write(THREAD, [
      { type: "session_meta", payload: { cli_version: `${CANARY}`, model_provider: "custom" } },
      { type: "turn_context", payload: { model: `${CANARY}` } },
      { type: "response_item", payload: { type: "image_generation_call", id: "ig_1", status: "completed", result: CANARY } },
      { type: "event_msg", payload: { type: "item_completed", item: { type: "imageGeneration", id: "ig_2", status: "failed", failure: { type: "usageLimitExceeded" } } } },
    ]);
    write(OTHER_THREAD, [call("x"), failedOutput("quota", "x")]);
    const f = await readSessionFacts(codexHome, THREAD);
    expect(f).toMatchObject({ log_found: true, cli_version: null, model: "other", model_provider_openai: false, image_tool_calls: 2, image_tool_completed: 1, image_tool_failed: 1, image_failure_codes: ["USAGE_LIMIT"], unparsed_lines: 1 });
    expect(JSON.stringify(f)).not.toContain(CANARY);
    expect(await readSessionFacts(codexHome, undefined)).toEqual(emptySessionFacts());
    expect(await readSessionFacts(codexHome, "../../etc")).toEqual(emptySessionFacts());
    // a link is never followed
    const t3 = "33333333-3333-4333-8333-333333333333";
    symlinkSync(join(sessions, `rollout-x-${THREAD}.jsonl`), join(sessions, `rollout-y-${t3}.jsonl`));
    expect((await readSessionFacts(codexHome, t3)).log_found).toBe(false);
  });

  describe("review F1: the real record order (call → image_generation_end → function_call_output)", () => {
    const facts = async (records: unknown[]) => {
      leaveLog(join(root, "cwd-x"), records);
      return readSessionFacts(codexHome, THREAD);
    };
    it("end(failed) without a failure object + a policy text in the output → POLICY (text refines, OTHER only at the end)", async () => {
      expect(await facts([call(), end("failed"), failedOutput(`image generation failed: rejected by the safety system ${CANARY}`)])).toMatchObject({ image_tool_calls: 1, image_tool_failed: 1, image_failure_codes: ["POLICY"] });
    });
    it("end(failed) + 'rate limit 429' in the output → USAGE_LIMIT, and the run stops as CODEX_QUOTA", async () => {
      expect(await facts([call(), end("failed"), failedOutput("image generation failed: rate limit 429")])).toMatchObject({ image_tool_failed: 1, image_failure_codes: ["USAGE_LIMIT"] });
      const result = await runDesignImagePoc(options(({ cwd }) => {
        leaveLog(cwd, [call(), end("failed"), failedOutput("image generation failed: rate limit 429")]);
        return ok(answer("x"));
      }));
      expect(result).toEqual({ status: "stopped", code: "CODEX_QUOTA" });
      expect(lastPocDiagnostics()!.diagnostics.classification).toMatchObject({ image_outcome: "TOOL_FAILED_USAGE_LIMIT", stop_class: "environment" });
    });
    it("end(failed, usageLimitExceeded) + any output → USAGE_LIMIT (the structured failure wins over a policy text)", async () => {
      expect(await facts([call(), end("failed", { type: "usageLimitExceeded", limitId: "image_gen", resetsAt: null }), failedOutput("safety system")])).toMatchObject({ image_tool_failed: 1, image_failure_codes: ["USAGE_LIMIT"] });
      // the output first, the structured failure later: the same
      expect(await facts([call(), failedOutput("safety system"), end("failed", { type: "usageLimitExceeded" })])).toMatchObject({ image_failure_codes: ["USAGE_LIMIT"] });
    });
    it("end(failed) + a neutral output text → OTHER (assigned at the end)", async () => {
      expect(await facts([call(), end("failed"), failedOutput("image generation failed: boom")])).toMatchObject({ image_tool_failed: 1, image_failure_codes: ["OTHER"] });
    });
    it("end(completed) + an output without an image → completed (the structured status wins over the output's shape): TOOL_CALLED_NO_FILE", async () => {
      const f = await facts([call(), end("completed"), failedOutput("no image here, rate limit")]);
      expect(f).toMatchObject({ image_tool_calls: 1, image_tool_completed: 1, image_tool_failed: 0, image_failure_codes: [] });
      expect(deriveImageOutcome(f, false)).toBe("TOOL_CALLED_NO_FILE");
    });
    it("no end record: the output's shape decides (an image → completed, none → failed with the text's code)", async () => {
      expect(await facts([call(), okOutput()])).toMatchObject({ image_tool_completed: 1, image_tool_failed: 0 });
      expect(await facts([call(), failedOutput("quota exceeded")])).toMatchObject({ image_tool_failed: 1, image_failure_codes: ["USAGE_LIMIT"] });
    });
    it("mixed results (N6): every failed call's code is listed; any failure without a saved PNG is TOOL_FAILED_* (USAGE_LIMIT > POLICY > OTHER)", async () => {
      const f = await facts([call("a"), end("completed", undefined, "a"), okOutput("a"), call("b"), end("failed", undefined, "b"), failedOutput("safety system", "b"), call("c"), end("failed", undefined, "c"), failedOutput("boom", "c")]);
      expect(f).toMatchObject({ image_tool_calls: 3, image_tool_completed: 1, image_tool_failed: 2, image_failure_codes: ["POLICY", "OTHER"] });
      expect(deriveImageOutcome(f, false)).toBe("TOOL_FAILED_POLICY");
      expect(deriveImageOutcome(f, true)).toBe("IMAGE_SAVED");
    });
  });

  it("review N1/N4: a log over the cap is not read to EOF (truncated); a matching non-regular entry is skipped, an unreadable file is flagged apart", async () => {
    const sessions = join(codexHome, "sessions", "2026", "10", "21");
    mkdirSync(sessions, { recursive: true });
    const big = join(sessions, `rollout-big-${THREAD}.jsonl`);
    writeFileSync(big, "");
    truncateSync(big, MAX_SESSION_LOG_BYTES + 1); // sparse: one byte over the cap
    const f = await readSessionFacts(codexHome, THREAD);
    expect(f).toMatchObject({ log_found: true, truncated: true, unreadable: false, lines: 0 });
    expect(deriveImageOutcome(f, false)).toBe("NO_SESSION_LOG");
    spawnSync("rm", ["-f", big]);
    const locked = join(sessions, `rollout-locked-${THREAD}.jsonl`);
    writeFileSync(locked, "{}\n");
    chmodSync(locked, 0o000);
    const g = await readSessionFacts(codexHome, THREAD);
    // root can still read a 000 file; elsewhere it is unreadable — either way never "truncated"
    expect(g.truncated).toBe(false);
    if (process.getuid?.() !== 0) expect(g).toMatchObject({ log_found: true, unreadable: true });
    chmodSync(locked, 0o600);
  });

  it("review N2: a symlinked sessions dir is never walked; a log whose real path leaves CODEX_HOME is not read", async () => {
    const elsewhere = join(root, "elsewhere-sessions");
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, `rollout-x-${THREAD}.jsonl`), `${JSON.stringify({ type: "turn_context", payload: { model: "gpt-5" } })}\n`);
    symlinkSync(elsewhere, join(codexHome, "sessions"));
    expect(await readSessionFacts(codexHome, THREAD)).toEqual(emptySessionFacts());
    // a real sessions dir whose sub-dir is a link out of CODEX_HOME
    spawnSync("rm", ["-f", join(codexHome, "sessions")]);
    mkdirSync(join(codexHome, "archived_sessions"), { recursive: true });
    symlinkSync(elsewhere, join(codexHome, "archived_sessions", "2026"));
    const f = await readSessionFacts(codexHome, THREAD);
    expect(f.model).toBeNull();
    expect(f.lines).toBe(0);
  });

  it("review N3: a model slug longer than 32 characters is 'other'", async () => {
    leaveLog(join(root, "cwd-m"), [{ timestamp: "t", type: "turn_context", payload: { model: `gpt-${"x".repeat(29)}` } }]);
    expect((await readSessionFacts(codexHome, THREAD)).model).toBe("other"); // the later turn_context wins
    leaveLog(join(root, "cwd-m"), [{ timestamp: "t", type: "turn_context", payload: { model: `gpt-${"x".repeat(28)}` } }]);
    expect((await readSessionFacts(codexHome, THREAD)).model).toBe(`gpt-${"x".repeat(28)}`);
  });

  it("review N5: a signal before the thread id came: the session is read through this run's cwd-matched log, before the cleanup removes it", async () => {
    let release!: () => void;
    const running = runDesignImagePoc(
      options(({ cwd }) => {
        leaveLog(cwd, [call(), end("failed", { type: "usageLimitExceeded" })]);
        // another design-agent call's log (another cwd) is never read
        const sessions = join(codexHome, "sessions", "2026", "10", "21");
        writeFileSync(join(sessions, `rollout-other-${OTHER_THREAD}.jsonl`), `${JSON.stringify({ type: "session_meta", payload: { cwd: join(tmpBase, "sr-design-codex-OTHER1") } })}\n${JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "o" } })}\n`);
        return new Promise((resolve) => {
          release = () => resolve({ code: null, signal: "SIGKILL" });
        });
      }),
    );
    for (let i = 0; i < 100 && execCwds.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 20));
    await cleanupActivePoc("POC_STOPPED_BY_SIGNAL");
    const d = lastPocDiagnostics()!.diagnostics;
    expect(d.stop_code).toBe("POC_STOPPED_BY_SIGNAL");
    expect(d.session).toMatchObject({ log_found: true, image_tool_calls: 1, image_tool_failed: 1, image_failure_codes: ["USAGE_LIMIT"], other_tool_calls: 0 });
    expect(d.classification).toMatchObject({ image_outcome: "TOOL_FAILED_USAGE_LIMIT", stop_class: "interrupted" });
    expect(sessionLogs().some((n) => n.includes(THREAD))).toBe(false); // the cleanup still removed this run's log
    release();
    await running;
  });

  describe("DEV-080: paginated history (Extension item_completed) and code mode (exec cells), as Codex CLI 0.159.0 writes them", () => {
    /** session_meta as `codex exec` 0.159.0 writes it (paginated history). */
    const META_159 = { cli_version: "0.159.0", history_mode: "paginated" };
    const turn = (model: string) => ({ timestamp: "t", type: "turn_context", payload: { cwd: "x", model, approval_policy: "never", sandbox_policy: { type: "read-only" } } });
    /**
     * event_msg item_completed with TurnItem::Extension, ExtensionItem kind image_gen.generation. The item is camelCase
     * (ImageGenerationItem `rename_all = "camelCase"`: revisedPrompt, savedPath) and may carry the base64 result;
     * `snake` writes the legacy-style snake_case keys instead (an extra case: neither spelling is ever recorded).
     */
    const ext = (status: string, failure?: unknown, id = "call_1", result = "", snake = false) => {
      const text = snake
        ? { revised_prompt: `${CANARY} revised`, saved_path: `/home/x/.codex/generated_images/${THREAD}/${CANARY}.png` }
        : { revisedPrompt: `${CANARY} revised`, savedPath: `/home/x/.codex/generated_images/${THREAD}/${CANARY}.png` };
      return {
        timestamp: "t",
        type: "event_msg",
        payload: { type: "item_completed", thread_id: THREAD, turn_id: "turn_1", item: { type: "Extension", kind: "image_gen.generation", id, status, ...text, result, failure: failure ?? null } },
      };
    };
    const cell = (input: string, id = "cell_1") => ({ timestamp: "t", type: "response_item", payload: { type: "custom_tool_call", status: "completed", call_id: id, name: "exec", input } });
    const cellOutput = (id = "cell_1") => ({ timestamp: "t", type: "response_item", payload: { type: "custom_tool_call_output", call_id: id, output: `${CANARY} cell output` } });
    const imagegenCell = () => cell(`const r = await tools.image_gen__imagegen({ prompt: "${CANARY}" });\ntext(JSON.stringify(r));`);

    it("paginated, direct mode: function_call imagegen + Extension item failed (usageLimitExceeded) → CODEX_QUOTA, environment", async () => {
      const result = await runDesignImagePoc(options(({ cwd }) => {
        leaveLog(cwd, [turn("gpt-5.5"), call(), ext("failed", { type: "usageLimitExceeded", limitId: "image_gen", resetsAt: 1761100000 }), failedOutput(`image generation failed: ${CANARY}`)], META_159);
        return ok(answer(`${CANARY}`));
      }));
      expect(result).toEqual({ status: "stopped", code: "CODEX_QUOTA" });
      const { d, text, summary } = diag();
      expect(d.session).toMatchObject({ cli_version: "0.159.0", model: "gpt-5.5", history_mode: "paginated", tool_mode: "direct", code_mode_cells: 0, code_mode_imagegen_ref: false, image_tool_calls: 1, image_tool_failed: 1, image_failure_codes: ["USAGE_LIMIT"] });
      expect(d.classification).toMatchObject({ image_outcome: "TOOL_FAILED_USAGE_LIMIT", stop_class: "environment" });
      expect(summary).toContain("log=1 hist=paginated tool_mode=direct cm_cells=0 cm_ref=0 img_calls=1 img_ok=0 img_failed=1 img_fail=USAGE_LIMIT");
      clean(text, summary);
      expect(sessionLogs()).toEqual([]); // still removed after reading
    });

    it("the Extension item's structured failure decides even when the tool output says nothing (and wins over a policy text)", async () => {
      const facts = async (records: unknown[]) => {
        leaveLog(join(root, "cwd-e"), records, META_159);
        return readSessionFacts(codexHome, THREAD);
      };
      expect(await facts([call(), ext("failed", { type: "usageLimitExceeded" }), failedOutput("safety system")])).toMatchObject({ image_tool_calls: 1, image_failure_codes: ["USAGE_LIMIT"] });
      expect(await facts([call(), ext("failed", { type: "requestFailed" }), failedOutput("rate limit 429")])).toMatchObject({ image_tool_failed: 1, image_failure_codes: ["OTHER"] });
      // in_progress is not an end status: the output's shape decides
      expect(await facts([call(), ext("in_progress"), okOutput()])).toMatchObject({ image_tool_calls: 1, image_tool_completed: 1, image_tool_failed: 0 });
      // an Extension item of another kind is not the image tool
      const other = ext("failed", { type: "usageLimitExceeded" }, "z");
      (other.payload.item as Record<string, unknown>).kind = "web.search";
      expect(await facts([other])).toMatchObject({ image_tool_calls: 0 });
      // the snake_case spelling of the text fields: read the same, and never recorded
      const snake = await facts([call(), ext("failed", { type: "usageLimitExceeded" }, "call_1", CANARY, true)]);
      expect(snake).toMatchObject({ image_tool_calls: 1, image_failure_codes: ["USAGE_LIMIT"] });
      expect(JSON.stringify(snake)).not.toContain(CANARY);
    });

    it("paginated, code mode: an exec cell naming image_gen__imagegen + an Extension item failed (other) → img_calls=1, CODEX_IMAGE_TOOL_FAILED", async () => {
      const result = await runDesignImagePoc(options(({ cwd }) => {
        leaveLog(cwd, [turn("gpt-5.6-sol"), imagegenCell(), ext("failed", { type: "requestFailed", message: CANARY }, "ig_call_9"), cellOutput()], META_159);
        return ok(answer(`image generation failed: ${CANARY}`));
      }));
      expect(result).toEqual({ status: "stopped", code: "CODEX_IMAGE_TOOL_FAILED" });
      const { d, text, summary } = diag();
      expect(d.session).toMatchObject({ history_mode: "paginated", tool_mode: "code_mode_only", code_mode_cells: 1, code_mode_imagegen_ref: true, image_tool_calls: 1, image_tool_failed: 1, image_failure_codes: ["OTHER"], other_tool_calls: 0 });
      expect(d.classification).toMatchObject({ image_outcome: "TOOL_FAILED", stop_class: "capability" });
      expect(summary).toContain("hist=paginated tool_mode=code_mode_only cm_cells=1 cm_ref=1 img_calls=1 img_ok=0 img_failed=1 img_fail=OTHER");
      clean(text, summary);
      expect(text).not.toContain("image_gen__imagegen");
      expect(summary).not.toContain("image_gen__imagegen");
    });

    it("code mode, an exec cell but no Extension item: TOOL_NOT_SEEN_CODE_MODE (inconclusive), never TOOL_NOT_CALLED / request — whatever the answer", async () => {
      for (const words of ["Here is the design.", "Image generation is unavailable.", `sorry ${CANARY}`]) {
        const result = await runDesignImagePoc(options(({ cwd }) => {
          leaveLog(cwd, [turn("gpt-5.6-sol"), imagegenCell(), cellOutput()], META_159);
          return ok(answer(words));
        }));
        expect(result).toEqual({ status: "stopped", code: "CODEX_NO_IMAGE" });
        const { d, text, summary } = diag();
        expect(d.session).toMatchObject({ image_tool_calls: 0, code_mode_cells: 1, code_mode_imagegen_ref: true });
        expect(d.classification.image_outcome).toBe("TOOL_NOT_SEEN_CODE_MODE");
        expect(d.classification.stop_class).toBe("inconclusive");
        expect(summary).toContain("outcome=TOOL_NOT_SEEN_CODE_MODE");
        clean(text, summary);
      }
      // an exec cell that never names the image tool, with an unknown model: still not "not called"
      leaveLog(join(root, "cwd-c"), [turn("gpt-x-unknown"), cell("text('hi')")], META_159);
      const f = await readSessionFacts(codexHome, THREAD);
      expect(f).toMatchObject({ tool_mode: "unknown", code_mode_cells: 1, code_mode_imagegen_ref: false });
      expect(deriveImageOutcome(f, false)).toBe("TOOL_NOT_SEEN_CODE_MODE");
      // a code_mode_only model with no cell at all: the same
      leaveLog(join(root, "cwd-c"), [turn("gpt-5.6-terra")], META_159);
      expect(deriveImageOutcome(await readSessionFacts(codexHome, THREAD), false)).toBe("TOOL_NOT_SEEN_CODE_MODE");
    });

    it("direct mode with no call at all: TOOL_NOT_CALLED (request)", async () => {
      const result = await runDesignImagePoc(options(({ cwd }) => {
        leaveLog(cwd, [turn("gpt-5.5")], META_159);
        return ok(answer("Here is the design: a header ..."));
      }));
      expect(result).toEqual({ status: "stopped", code: "CODEX_NO_IMAGE" });
      const { d, text, summary } = diag();
      expect(d.session).toMatchObject({ tool_mode: "direct", code_mode_cells: 0, image_tool_calls: 0 });
      expect(d.classification).toEqual({ image_outcome: "TOOL_NOT_CALLED", answer_text: "TEXT_OTHER", stop_class: "request" });
      clean(text, summary);
    });

    it("an Extension item completed (from a code-mode cell) with the PNG present: IMAGE_SAVED; a large base64 result is parsed, never kept", async () => {
      const big = Buffer.alloc(12 * 1024 * 1024, 7).toString("base64") + CANARY; // ~16 MiB on one JSON line
      const result = await runDesignImagePoc(options(({ cwd }) => {
        leaveLog(cwd, [turn("gpt-5.6-sol"), imagegenCell(), ext("completed", undefined, "ig_1", big), cellOutput()], META_159, { "ig_1.png": png() });
        return ok(answer("done"));
      }));
      expect(result.status).toBe("done");
      const { d, text, summary } = diag();
      expect(d.session).toMatchObject({ image_tool_calls: 1, image_tool_completed: 1, image_tool_failed: 0, code_mode_cells: 1, unparsed_lines: 0, truncated: false });
      expect(d.classification).toEqual({ image_outcome: "IMAGE_SAVED", answer_text: "TEXT_OTHER", stop_class: null });
      clean(text, summary);
      expect(text.length).toBeLessThan(64 * 1024);
    });

    it("history_mode: legacy / paginated / other / absent; a legacy log still reads image_generation_end", async () => {
      const mode = async (meta: Record<string, unknown>, records: unknown[] = []) => {
        leaveLog(join(root, "cwd-h"), records, meta);
        return readSessionFacts(codexHome, THREAD);
      };
      expect((await mode({ history_mode: "paginated" })).history_mode).toBe("paginated");
      expect(await mode({ history_mode: "legacy" }, [call(), end("failed", { type: "usageLimitExceeded" })])).toMatchObject({ history_mode: "legacy", image_tool_calls: 1, image_failure_codes: ["USAGE_LIMIT"] });
      expect((await mode({ history_mode: CANARY })).history_mode).toBe("other");
      expect((await mode({})).history_mode).toBeNull();
      expect(JSON.stringify(await mode({ history_mode: CANARY }))).not.toContain(CANARY);
    });

    it("the caps still hold: a log over 64 MiB whose only record is an Extension item is not read (truncated → NO_SESSION_LOG)", async () => {
      const sessions = join(codexHome, "sessions", "2026", "10", "21");
      mkdirSync(sessions, { recursive: true });
      const path = join(sessions, `rollout-big-${THREAD}.jsonl`);
      writeFileSync(path, `${JSON.stringify(ext("failed", { type: "usageLimitExceeded" }))}\n`);
      truncateSync(path, MAX_SESSION_LOG_BYTES + 1); // sparse: the rest is NUL bytes
      const f = await readSessionFacts(codexHome, THREAD);
      expect(f).toMatchObject({ log_found: true, truncated: true, lines: 0, image_tool_calls: 0 });
      expect(deriveImageOutcome(f, false)).toBe("NO_SESSION_LOG");
    });

    it("toolModeOf: gpt-5.5 direct, the bundled code_mode_only slugs, anything else unknown", () => {
      expect(toolModeOf("gpt-5.5")).toBe("direct");
      for (const m of ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "codex-auto-review"]) expect(toolModeOf(m), m).toBe("code_mode_only");
      for (const m of [null, "other", "gpt-5.5-codex", "gpt-5"]) expect(toolModeOf(m)).toBe("unknown");
    });

    describe("DEV-081: why a called image tool failed (failure.type allowlist, fixed reasons from Codex's own text) and the models cache", () => {
      /** turn_context as 0.159.0 writes it for HUMAN-021b: a remote-catalog model and a reasoning effort. */
      const turn161 = (effort: unknown = "medium") => ({ timestamp: "t", type: "turn_context", payload: { cwd: "x", model: "gpt-6.1-sol", effort, summary: "auto", approval_policy: "never", sandbox_policy: { type: "read-only" } } });
      /** Rust's Debug of the HTTP body inside TransportError::Http's Display: `http 429 Too Many Requests: Some("{\"error\":…}")`. */
      const httpError = (status: string, body: Record<string, unknown>) => `image generation failed: http ${status}: Some(${JSON.stringify(JSON.stringify(body))})`;
      /** An uncaught rejection inside the cell: the output is `Script failed …` + `Script error:\n<the tool's message>` (code_mode/mod.rs:286-289). */
      const cellError = (message: string, id = "cell_1") => ({
        timestamp: "t",
        type: "response_item",
        payload: { type: "custom_tool_call_output", call_id: id, output: [{ type: "input_text", text: "Script failed\nWall time 1.2 seconds\nOutput:\n" }, { type: "input_text", text: `Script error:\n${message}` }] },
      });
      const facts = async (records: unknown[]) => {
        leaveLog(join(root, "cwd-81"), records, META_159);
        return readSessionFacts(codexHome, THREAD);
      };
      const writeCache = (models: unknown[], extra: Record<string, unknown> = {}) =>
        writeFileSync(
          join(codexHome, "models_cache.json"),
          JSON.stringify({ fetched_at: new Date(Date.now() - 30_000).toISOString(), etag: `W/"${CANARY}"`, client_version: "0.159.0", identity: CANARY, models, ...extra }, null, 2),
        );
      const model = (slug: string, more: Record<string, unknown> = {}) => ({ slug, display_name: CANARY, description: CANARY, base_instructions: CANARY, priority: 1, visibility: "list", input_modalities: ["text", "image"], ...more });

      it("HUMAN-021b's shape: a code-mode call whose Extension item failed with failure: null and no readable text → type none, reason NO_TEXT, TOOL_FAILED (capability)", async () => {
        const result = await runDesignImagePoc(options(({ cwd }) => {
          leaveLog(cwd, [turn161(), imagegenCell(), ext("failed", null, "ig_call_1"), cellOutput()], META_159);
          return ok(answer(`${CANARY} the tool failed`));
        }));
        expect(result).toEqual({ status: "stopped", code: "CODEX_IMAGE_TOOL_FAILED" });
        const { d, text, summary } = diag();
        expect(d.session).toMatchObject({ model: "gpt-6.1-sol", effort: "medium", tool_mode: "unknown", tool_mode_source: "slug", image_tool_failed: 1, image_failure_codes: ["OTHER"], image_failure_types: ["none"], image_failure_reasons: ["NO_TEXT"], image_failure_http: [], image_failure_api_codes: [] });
        expect(d.classification).toMatchObject({ image_outcome: "TOOL_FAILED", stop_class: "capability" });
        expect(summary).toContain("img_fail=OTHER other_calls=0 outcome=TOOL_FAILED"); // the DEV-080 fields are unchanged
        expect(summary).toContain("img_fail_type=none img_fail_reason=NO_TEXT img_fail_src=none img_http=- img_err=- cm_arg_err=0 effort=medium tool_mode_src=slug model_cache=absent");
        clean(text, summary);
      });

      it("code mode, the usage-limit 429 whose limit id is not image_gen (failure: null): the cell's error text gives USAGE_LIMIT / 429 → CODEX_QUOTA; no text is kept", async () => {
        const msg = httpError("429 Too Many Requests", { error: { type: "usage_limit_reached", message: CANARY, plan_type: "plus", resets_at: 1761200000 } });
        const result = await runDesignImagePoc(options(({ cwd }) => {
          leaveLog(cwd, [turn161(), imagegenCell(), ext("failed", null, "ig_call_1"), cellError(msg)], META_159);
          return ok(answer(`image generation failed ${CANARY}`));
        }));
        expect(result).toEqual({ status: "stopped", code: "CODEX_QUOTA" });
        const { d, text, summary } = diag();
        expect(d.session).toMatchObject({ image_failure_codes: ["USAGE_LIMIT"], image_failure_types: ["none"], image_failure_reasons: ["USAGE_LIMIT"], image_failure_http: [429], image_failure_api_codes: ["usage_limit_reached"] });
        expect(d.classification).toMatchObject({ image_outcome: "TOOL_FAILED_USAGE_LIMIT", stop_class: "environment" });
        expect(summary).toContain("img_fail_type=none img_fail_reason=USAGE_LIMIT img_fail_src=cell_error img_http=429 img_err=usage_limit_reached");
        clean(text, summary);
        for (const s of ["plus", "1761200000", "Too Many Requests", "Script error"]) expect(text + summary, s).not.toContain(s);
      });

      it("transient (5xx / timeout / connection) → TOOL_FAILED_TRANSIENT, stop CODEX_IMAGE_TOOL_FAILED, class transient; never retried", async () => {
        for (const [msg, reason, http] of [
          [httpError("502 Bad Gateway", { error: { message: CANARY } }), "HTTP_5XX", [502]],
          ["image generation failed: timeout", "TIMEOUT", []],
          [`image generation failed: connection failed: ${CANARY}`, "NETWORK", []],
          ["image generation failed: server overloaded", "HTTP_5XX", []],
        ] as const) {
          prompts.length = 0;
          const result = await runDesignImagePoc(options(({ cwd }) => {
            leaveLog(cwd, [turn161(), imagegenCell(), ext("failed", null, "ig_call_1"), cellError(msg)], META_159);
            return ok(answer("x"));
          }));
          expect(result, msg).toEqual({ status: "stopped", code: "CODEX_IMAGE_TOOL_FAILED" });
          expect(prompts).toHaveLength(1); // one model call, no retry
          const { d, text, summary } = diag();
          expect(d.session, msg).toMatchObject({ image_failure_codes: ["TRANSIENT"], image_failure_reasons: [reason], image_failure_http: [...http] });
          expect(d.classification, msg).toMatchObject({ image_outcome: "TOOL_FAILED_TRANSIENT", stop_class: "transient" });
          clean(text, summary);
        }
      });

      it("not supported (404 / model_not_found / usage_not_included) → TOOL_FAILED_UNSUPPORTED (capability); policy (moderation_blocked) → TOOL_FAILED_POLICY", async () => {
        const run = async (msg: string) => {
          await runDesignImagePoc(options(({ cwd }) => {
            leaveLog(cwd, [turn161(), imagegenCell(), ext("failed", null, "ig_call_1"), cellError(msg)], META_159);
            return ok(answer("x"));
          }));
          return diag();
        };
        for (const msg of [
          httpError("404 Not Found", { error: { code: "model_not_found", message: CANARY } }),
          httpError("403 Forbidden", { error: { type: "usage_not_included", message: CANARY } }),
        ]) {
          const { d, text, summary } = await run(msg);
          expect(d.session?.image_failure_reasons, msg).toEqual(["NOT_SUPPORTED"]);
          expect(d.classification, msg).toMatchObject({ image_outcome: "TOOL_FAILED_UNSUPPORTED", stop_class: "capability" });
          expect(d.stop_code).toBe("CODEX_IMAGE_TOOL_FAILED");
          clean(text, summary);
        }
        const { d, text, summary } = await run(httpError("400 Bad Request", { error: { code: "moderation_blocked", message: CANARY } }));
        expect(d.session).toMatchObject({ image_failure_reasons: ["POLICY"], image_failure_http: [400], image_failure_api_codes: ["moderation_blocked"] });
        expect(d.classification).toMatchObject({ image_outcome: "TOOL_FAILED_POLICY", stop_class: "capability" });
        clean(text, summary);
      });

      it("the text decides only the reason when a structured failure exists; an unknown failure.type is 'other', never its value", async () => {
        const f1 = await facts([call(), ext("failed", { type: "usageLimitExceeded", limitId: "image_gen", resetsAt: 1 }), failedOutput("image generation failed: http 502 Bad Gateway: None")]);
        expect(f1).toMatchObject({ image_failure_codes: ["USAGE_LIMIT"], image_failure_types: ["usageLimitExceeded"], image_failure_reasons: ["HTTP_5XX"], image_failure_http: [502] });
        const f2 = await facts([call(), ext("failed", { type: CANARY, detail: CANARY }), failedOutput(`image generation failed: ${CANARY}`)]);
        expect(f2).toMatchObject({ image_failure_codes: ["OTHER"], image_failure_types: ["other"], image_failure_reasons: ["OTHER"] });
        expect(JSON.stringify(f2)).not.toContain(CANARY);
      });

      it("direct mode: the call's own output is classified; a call refused before it started (no item) is no_record / INVALID_ARGS", async () => {
        const f1 = await facts([turn("gpt-5.5"), call(), ext("failed", null), failedOutput(httpError("503 Service Unavailable", { error: { code: "server_is_overloaded" } }))]);
        expect(f1).toMatchObject({ tool_mode: "direct", image_failure_codes: ["TRANSIENT"], image_failure_types: ["none"], image_failure_reasons: ["HTTP_5XX"], image_failure_http: [503], image_failure_api_codes: ["server_is_overloaded"] });
        expect(deriveImageOutcome(f1, false)).toBe("TOOL_FAILED_TRANSIENT");
        const f2 = await facts([turn("gpt-5.5"), call(), failedOutput("unknown field `size`, expected one of `prompt`, `transparent_background`, `referenced_image_paths`, `num_last_images_to_include`")]);
        expect(f2).toMatchObject({ image_tool_failed: 1, image_failure_codes: ["OTHER"], image_failure_types: ["no_record"], image_failure_reasons: ["INVALID_ARGS"] });
        // DEV-078's text codes still hold for a direct output without Codex's prefix
        expect(await facts([call(), failedOutput("rate limit 429")])).toMatchObject({ image_failure_codes: ["USAGE_LIMIT"], image_failure_reasons: ["HTTP_429"] });
        expect(await facts([call(), failedOutput("refused by the safety system")])).toMatchObject({ image_failure_codes: ["POLICY"] });
      });

      it("code mode: a yielded cell's rejection read through `wait`; an argument error before the start (no item) sets cm_arg_err only for a cell that named the tool", async () => {
        const wait = { timestamp: "t", type: "response_item", payload: { type: "function_call", name: "wait", arguments: JSON.stringify({ cell_id: "1" }), call_id: "w_1" } };
        const waitOut = {
          timestamp: "t",
          type: "response_item",
          payload: { type: "function_call_output", call_id: "w_1", output: [{ type: "input_text", text: "Script failed\nWall time 61.0 seconds\nOutput:\n" }, { type: "input_text", text: "Script error:\nimage generation failed: http 500 Internal Server Error: None" }] },
        };
        expect(await facts([turn161(), imagegenCell(), ext("failed", null, "ig_1"), cellOutput(), wait, waitOut])).toMatchObject({ image_failure_codes: ["TRANSIENT"], image_failure_reasons: ["HTTP_5XX"], image_failure_sources: ["cell_error"], image_failure_http: [500], other_tool_calls: 1 });
        const argErr = cellError("missing field `prompt`");
        const f = await facts([turn161(), imagegenCell(), argErr]);
        expect(f).toMatchObject({ image_tool_calls: 0, code_mode_arg_error: true, image_failure_reasons: [] });
        expect(deriveImageOutcome(f, false)).toBe("TOOL_NOT_SEEN_CODE_MODE");
        expect(await facts([turn161(), cell("text('hi')"), argErr])).toMatchObject({ code_mode_arg_error: false });
        // the model's own words without Codex's prefix are not a reason
        expect(await facts([turn161(), imagegenCell(), ext("failed", null, "ig_1"), cellError(`http 429 rate limit ${CANARY}`)])).toMatchObject({ image_failure_reasons: ["NO_TEXT"], image_failure_codes: ["OTHER"] });
      });

      it("review F1, spoof 1: a cell that completed and PRINTED Codex's prefix with a 503 is advisory (cell_print): the code stays OTHER, never TRANSIENT", async () => {
        const printed = {
          timestamp: "t",
          type: "response_item",
          payload: { type: "custom_tool_call_output", call_id: "cell_1", output: [{ type: "input_text", text: "Script completed\nWall time 2.0 seconds\nOutput:\n" }, { type: "input_text", text: `image generation failed: http 503 Service Unavailable: ${CANARY}` }] },
        };
        const result = await runDesignImagePoc(options(({ cwd }) => {
          leaveLog(cwd, [turn161(), imagegenCell(), ext("failed", null, "ig_1"), printed], META_159);
          return ok(answer("x"));
        }));
        expect(result).toEqual({ status: "stopped", code: "CODEX_IMAGE_TOOL_FAILED" });
        const { d, text, summary } = diag();
        expect(d.session).toMatchObject({ image_failure_codes: ["OTHER"], image_failure_reasons: ["HTTP_5XX"], image_failure_sources: ["cell_print"], image_failure_http: [503] });
        expect(d.classification).toMatchObject({ image_outcome: "TOOL_FAILED", stop_class: "capability" });
        expect(summary).toContain("img_fail_src=cell_print");
        clean(text, summary);
      });

      it("review F1, spoof 2: usage-limit text printed by a FAILED cell (before Codex's own error item) never makes CODEX_QUOTA; Codex's item decides", async () => {
        const failedCell = (codexError: string) => ({
          timestamp: "t",
          type: "response_item",
          payload: {
            type: "custom_tool_call_output",
            call_id: "cell_1",
            output: [
              { type: "input_text", text: "Script failed\nWall time 3.1 seconds\nOutput:\n" },
              { type: "input_text", text: `image generation failed: http 429 Too Many Requests: usage limit ${CANARY}` },
              { type: "input_text", text: `Script error:\n${codexError}` },
            ],
          },
        });
        const result = await runDesignImagePoc(options(({ cwd }) => {
          leaveLog(cwd, [turn161(), imagegenCell(), ext("failed", null, "ig_1"), failedCell("TypeError: r.image_url is undefined")], META_159);
          return ok(answer("x"));
        }));
        expect(result).toEqual({ status: "stopped", code: "CODEX_IMAGE_TOOL_FAILED" }); // not CODEX_QUOTA
        const { d, text, summary } = diag();
        expect(d.session).toMatchObject({ image_failure_codes: ["OTHER"], image_failure_reasons: ["USAGE_LIMIT"], image_failure_sources: ["cell_print"] });
        clean(text, summary);
        // with Codex's own item naming a 503, that item alone decides (TRANSIENT); the printed usage limit is not even recorded
        const f = await facts([turn161(), imagegenCell(), ext("failed", null, "ig_1"), failedCell("image generation failed: http 503 Service Unavailable: None")]);
        expect(f).toMatchObject({ image_failure_codes: ["TRANSIENT"], image_failure_reasons: ["HTTP_5XX"], image_failure_sources: ["cell_error"] });
        expect(deriveImageOutcome(f, false)).toBe("TOOL_FAILED_TRANSIENT");
        // a single item (Codex merged them for size) has no failed-cell shape: printed only
        const merged = { timestamp: "t", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "cell_1", output: "Script failed\nOutput:\nScript error:\nimage generation failed: http 503 x" } };
        expect(await facts([turn161(), imagegenCell(), ext("failed", null, "ig_1"), merged])).toMatchObject({ image_failure_codes: ["OTHER"], image_failure_sources: ["cell_print"] });
      });

      it("review F1: POLICY wins over USAGE_LIMIT in text (one text, and two failed cells)", async () => {
        expect(classifyImageFailureText("image generation failed: http 400 Bad Request: usage limit / moderation_blocked").reason).toBe("POLICY");
        const f = await facts([
          turn161(),
          imagegenCell(),
          ext("failed", null, "ig_1"),
          cellError(httpError("429 Too Many Requests", { error: { type: "usage_limit_reached" } })),
          cell(`await tools.image_gen__imagegen({ prompt: "${CANARY}" })`, "cell_2"),
          ext("failed", null, "ig_2"),
          cellError(httpError("400 Bad Request", { error: { code: "moderation_blocked" } }), "cell_2"),
        ]);
        expect(f).toMatchObject({ image_tool_failed: 2, image_failure_codes: ["POLICY"], image_failure_sources: ["cell_error"] });
        expect(deriveImageOutcome(f, false)).toBe("TOOL_FAILED_POLICY");
      });

      it("review F2: a 4xx is never TIMEOUT / NETWORK / 5xx; NOT_SUPPORTED only for 403 / 404 / an allowlisted code, not a 400's words", () => {
        const r = (t: string) => classifyImageFailureText(t).reason;
        expect(r("image generation failed: http 400 Bad Request: Some(\"size is not supported\")")).toBe("BAD_REQUEST");
        expect(r("image generation failed: http 400 Bad Request: Some(\"upstream timeout\")")).toBe("BAD_REQUEST");
        expect(r("image generation failed: http 408 Request Timeout: None")).toBe("BAD_REQUEST");
        expect(r("image generation failed: http 422 Unprocessable Entity: Some(\"connection failed\")")).toBe("BAD_REQUEST");
        expect(r("image generation failed: http 400 Bad Request: Some(\"internal server error\")")).toBe("BAD_REQUEST");
        expect(r("image generation failed: http 403 Forbidden: None")).toBe("NOT_SUPPORTED");
        expect(r("image generation failed: http 404 Not Found: None")).toBe("NOT_SUPPORTED");
        expect(r(httpError("400 Bad Request", { error: { code: "model_not_found" } }))).toBe("NOT_SUPPORTED");
        expect(r(httpError("403 Forbidden", { error: { type: "authentication_error" } }))).toBe("AUTH");
        expect(r("image generation failed: usage not included")).toBe("NOT_SUPPORTED");
        expect(r("image generation failed: timeout")).toBe("TIMEOUT");
        expect(r("image generation failed: not supported")).toBe("OTHER");
      });

      it("review F3: a models cache written by another CLI version is `stale`: not applied, the slug hint stays", async () => {
        await runDesignImagePoc(options(({ cwd }) => {
          writeCache([model("gpt-6.1-sol", { tool_mode: "code_mode_only" })], { client_version: "0.158.0" });
          leaveLog(cwd, [turn161(), imagegenCell(), ext("failed", null, "ig_1"), cellOutput()], META_159);
          return ok(answer("x"));
        }));
        const { d, text, summary } = diag();
        expect(d.model_catalog).toMatchObject({ cache: "stale", client_version: "0.158.0", model_listed: true, tool_mode: null, image_input: null });
        expect(d.session).toMatchObject({ tool_mode: "unknown", tool_mode_source: "slug" });
        expect(summary).toContain("tool_mode_src=slug model_cache=stale model_cache_cli=0.158.0");
        expect(summary).toContain("model_tool_mode=- model_image_input=-");
        clean(text, summary);
      });

      it("classifyImageFailureText returns fixed values only; unknown API codes are 'other'; a non-error JSON type is ignored", () => {
        const cases: Array<[string, string, number | null, string | null]> = [
          [httpError("429 Too Many Requests", { error: { type: "usage_limit_reached" } }), "USAGE_LIMIT", 429, "usage_limit_reached"],
          [httpError("429 Too Many Requests", { error: { code: "rate_limit_exceeded" } }), "HTTP_429", 429, "rate_limit_exceeded"],
          [httpError("401 Unauthorized", { error: { message: CANARY } }), "AUTH", 401, null],
          [httpError("400 Bad Request", { error: { code: "invalid_value", message: CANARY } }), "BAD_REQUEST", 400, "invalid_value"],
          [httpError("400 Bad Request", { error: { code: `${CANARY.toLowerCase()}_error` } }), "BAD_REQUEST", 400, "other"],
          ["image generation failed: api error 404 Not Found: no such model", "NOT_SUPPORTED", 404, null],
          ["image generation failed: stream error: failed to decode image generation response: EOF", "BAD_RESPONSE", null, null],
          ["image generation returned no image data", "NO_IMAGE_DATA", null, null],
          ["image generation failed: cyber policy: blocked", "POLICY", null, null],
          [`image generation failed: ${CANARY} {"type":"input_text"}`, "OTHER", null, null],
          ["`num_last_images_to_include` must be between 1 and 5", "INVALID_ARGS", null, null],
        ];
        for (const [t, reason, http, code] of cases) {
          const r = classifyImageFailureText(t);
          expect(r, t).toEqual({ reason, http, api_code: code });
          expect(JSON.stringify(r)).not.toContain(CANARY);
        }
      });

      it("models cache: the model's tool_mode and image input (fixed values only) replace the slug hint; identity / etag / descriptions never come out", async () => {
        const result = await runDesignImagePoc(options(({ cwd }) => {
          writeCache([model("gpt-5.5", { tool_mode: null }), model("gpt-6.1-sol", { tool_mode: "code_mode_only" })]);
          leaveLog(cwd, [turn161(), imagegenCell(), ext("failed", null, "ig_1"), cellOutput()], META_159);
          return ok(answer("x"));
        }));
        expect(result).toEqual({ status: "stopped", code: "CODEX_IMAGE_TOOL_FAILED" });
        const { d, text, summary } = diag();
        expect(d.model_catalog).toMatchObject({ cache: "found", client_version: "0.159.0", models: 2, model_listed: true, tool_mode: "code_mode_only", image_input: true });
        expect(d.model_catalog!.age_s).toBeGreaterThanOrEqual(25);
        expect(d.session).toMatchObject({ tool_mode: "code_mode_only", tool_mode_source: "cache" });
        expect(summary).toContain("tool_mode=code_mode_only cm_cells=1");
        expect(summary).toMatch(/model_cache=found model_cache_cli=0\.159\.0 model_cache_age_s=\d+ model_listed=1 model_tool_mode=code_mode_only model_image_input=1/);
        clean(text, summary);
        expect(text).not.toContain("W/");
        expect(existsSync(join(codexHome, "models_cache.json"))).toBe(true); // read only, never removed or changed
      });

      it("readModelCatalog: absent / link / too large / invalid / not listed / tool_mode none → direct / text-only input; never throws", async () => {
        const cachePath = join(codexHome, "models_cache.json");
        expect(await readModelCatalog(codexHome, "gpt-6.1-sol")).toMatchObject({ cache: "absent", model_listed: null });
        writeCache([model("gpt-5.5", { tool_mode: null, input_modalities: ["text"] }), model("gpt-6.1-sol", { tool_mode: CANARY })]);
        const own = await readModelCatalog(codexHome, "gpt-5.5");
        expect(own).toMatchObject({ cache: "found", model_listed: true, tool_mode: "none", image_input: false });
        expect(applyModelCatalog({ ...emptySessionFacts(), model: "gpt-5.5", cli_version: "0.159.0" }, own)).toMatchObject({ tool_mode: "direct", tool_mode_source: "cache" });
        // review F3: another CLI version's cache is never applied
        expect(applyModelCatalog({ ...emptySessionFacts(), model: "gpt-5.5", cli_version: "0.163.0" }, own).tool_mode_source).toBe("slug");
        const odd = await readModelCatalog(codexHome, "gpt-6.1-sol");
        expect(odd).toMatchObject({ tool_mode: "other" });
        expect(applyModelCatalog(emptySessionFacts(), odd).tool_mode_source).toBe("slug");
        expect(JSON.stringify(odd)).not.toContain(CANARY);
        expect(await readModelCatalog(codexHome, "gpt-9")).toMatchObject({ cache: "found", model_listed: false, tool_mode: null });
        expect(await readModelCatalog(codexHome, "other")).toMatchObject({ cache: "found", model_listed: null });
        writeCache([model("gpt-6.1-sol", { input_modalities: undefined })]);
        expect(await readModelCatalog(codexHome, "gpt-6.1-sol")).toMatchObject({ tool_mode: "none", image_input: true }); // Codex's default: text + image
        writeFileSync(cachePath, `{"models": ${CANARY}`);
        expect(await readModelCatalog(codexHome, "gpt-6.1-sol")).toMatchObject({ cache: "invalid" });
        writeFileSync(cachePath, "");
        truncateSync(cachePath, MAX_MODELS_CACHE_BYTES + 1);
        expect(await readModelCatalog(codexHome, "gpt-6.1-sol")).toMatchObject({ cache: "too_large" });
        const elsewhere = join(root, "elsewhere-cache.json");
        writeFileSync(elsewhere, JSON.stringify({ models: [model("gpt-6.1-sol")] }));
        spawnSync("rm", ["-f", cachePath]);
        symlinkSync(elsewhere, cachePath);
        expect(await readModelCatalog(codexHome, "gpt-6.1-sol")).toMatchObject({ cache: "unreadable", model_listed: null });
        expect(await readModelCatalog(join(root, "no-such-home"), "gpt-6.1-sol")).toMatchObject({ cache: "absent" });
      });

      it("effort: allowlisted values; anything else is 'other' (never its value)", async () => {
        expect((await facts([turn161("xhigh")])).effort).toBe("xhigh");
        const odd = await facts([turn161(CANARY)]);
        expect(odd.effort).toBe("other");
        expect(JSON.stringify(odd)).not.toContain(CANARY);
        expect((await facts([turn("gpt-5.5")])).effort).toBeNull();
      });

      it("pocStopClass: transient only for CODEX_IMAGE_TOOL_FAILED + TOOL_FAILED_TRANSIENT; UNSUPPORTED stays capability", () => {
        expect(pocStopClass("CODEX_IMAGE_TOOL_FAILED", "TOOL_FAILED_TRANSIENT")).toBe("transient");
        expect(pocStopClass("CODEX_IMAGE_TOOL_FAILED", "TOOL_FAILED_UNSUPPORTED")).toBe("capability");
        expect(pocStopClass("CODEX_IMAGE_TOOL_FAILED", "TOOL_FAILED")).toBe("capability");
        expect(pocStopClass("CODEX_NO_IMAGE", "TOOL_FAILED_TRANSIENT")).toBe("request");
      });
    });

    describe("DEV-084: each image call's duration (ItemCompleted timestamps) and a fixed timing bucket per failed call", () => {
      /** HUMAN-018 started at about this time (any epoch ms works; only the difference is recorded). */
      const T0 = 1_761_100_000_000;
      /** ext() with the ItemCompleted event's own started_at_ms / completed_at_ms (protocol.rs:1948-1960: on the payload, not the item). */
      const timed = (status: string, ms: unknown, id: string, started: unknown = T0) => {
        const r = ext(status, null, id);
        return { ...r, payload: { ...r.payload, started_at_ms: started, completed_at_ms: typeof ms === "number" && typeof started === "number" ? started + ms : ms } };
      };
      const facts = async (records: unknown[]) => {
        leaveLog(join(root, "cwd-84"), records, META_159);
        return readSessionFacts(codexHome, THREAD);
      };

      it("HUMAN-018's shape: a failed call at 155 584 ms, then a second call by the model that completed in 32 648 ms", async () => {
        const f = await facts([imagegenCell(), timed("failed", 155_584, "ig_1"), cellOutput(), cell(`await tools.image_gen__imagegen({ prompt: "${CANARY}" })`, "cell_2"), timed("completed", 32_648, "ig_2", T0 + 170_000), cellOutput("cell_2")]);
        expect(f).toMatchObject({ image_tool_calls: 2, image_tool_completed: 1, image_tool_failed: 1, image_call_ms: [155_584, 32_648], image_fail_timings: ["140-170s"] });
      });

      it("HUMAN-021b's shape through the run: one failed call at 157 684 ms → img_call_ms and img_fail_timing in the summary; nothing else changes", async () => {
        const result = await runDesignImagePoc(options(({ cwd }) => {
          leaveLog(cwd, [imagegenCell(), timed("failed", 157_684, "ig_call_1"), cellOutput()], META_159);
          return ok(answer(`${CANARY} the tool failed`));
        }));
        expect(result).toEqual({ status: "stopped", code: "CODEX_IMAGE_TOOL_FAILED" });
        const { d, text, summary } = diag();
        expect(d.schema).toBe("sr-design-image-poc-diagnostics/5");
        expect(d.session).toMatchObject({ image_tool_failed: 1, image_failure_codes: ["OTHER"], image_call_ms: [157_684], image_fail_timings: ["140-170s"] });
        expect(d.classification).toMatchObject({ image_outcome: "TOOL_FAILED", stop_class: "capability" });
        expect(summary).toMatch(/ img_call_ms=157684 img_fail_timing=140-170s$/);
        clean(text, summary);
        expect(text + summary).not.toContain(String(T0));
      });

      it("no usable timestamps → no duration and `unknown` (legacy end record, missing / non-numeric / negative / zero / over a day); in_progress is not an end", async () => {
        const legacy = { timestamp: "t", type: "event_msg", payload: { type: "image_generation_end", call_id: "call_1", status: "failed", result: "" } };
        expect(await facts([call(), legacy, failedOutput("image generation failed: timeout")])).toMatchObject({ image_tool_failed: 1, image_call_ms: [], image_fail_timings: ["unknown"], image_failure_reasons: ["TIMEOUT"] });
        // 0: Codex's fallback started_at_ms = completed_at_ms when no start was recorded (session/mod.rs:2618-2630)
        for (const [ms, started] of [[undefined, undefined], ["155584", T0], [-1, T0], [0, T0], [24 * 3600 * 1000 + 1, T0], [1000, -5], [1.5, T0]] as const) {
          const f = await facts([imagegenCell(), timed("failed", ms, "ig_1", started), cellOutput()]);
          expect(f, `${String(ms)} ${String(started)}`).toMatchObject({ image_tool_failed: 1, image_call_ms: [], image_fail_timings: ["unknown"] });
        }
        const pending = await facts([imagegenCell(), timed("in_progress", 5_000, "ig_1"), cellOutput()]);
        expect(pending.image_call_ms).toEqual([]);
        expect(pending.image_fail_timings).toEqual([]);
        expect((await facts([imagegenCell(), timed("completed", 20_000, "ig_1"), cellOutput()])).image_fail_timings).toEqual([]);
      });

      it("at most MAX_IMAGE_CALL_TIMINGS durations are kept", async () => {
        const many = Array.from({ length: MAX_IMAGE_CALL_TIMINGS + 4 }, (_, i) => timed("failed", 1_000 + i, `ig_${i}`));
        const f = await facts([imagegenCell(), ...many, cellOutput()]);
        expect(f.image_tool_failed).toBe(MAX_IMAGE_CALL_TIMINGS + 4);
        expect(f.image_call_ms).toHaveLength(MAX_IMAGE_CALL_TIMINGS);
        expect(f.image_fail_timings).toHaveLength(MAX_IMAGE_CALL_TIMINGS);
      });

      it("failTimingOf: fixed buckets with the boundaries on the lower side", () => {
        expect(IMAGE_FAIL_TIMINGS).toEqual(["<5s", "5-60s", "60-140s", "140-170s", ">170s", "unknown"]);
        const cases: Array<[unknown, string]> = [[0, "unknown"], [1, "<5s"], [4_999, "<5s"], [5_000, "5-60s"], [59_999, "5-60s"], [60_000, "60-140s"], [139_999, "60-140s"], [140_000, "140-170s"], [155_584, "140-170s"], [157_760, "140-170s"], [169_999, "140-170s"], [170_000, ">170s"], [305_000, ">170s"], [null, "unknown"], [undefined, "unknown"], [-1, "unknown"], [Number.NaN, "unknown"], [2.5, "unknown"], [24 * 3600 * 1000 + 1, "unknown"]];
        for (const [ms, bucket] of cases) expect(failTimingOf(ms as number), String(ms)).toBe(bucket);
      });
    });
  });

  it("classifyAnswerText / parseCodexVersion / deriveImageOutcome / pocStopClass return fixed codes only", () => {
    expect(classifyAnswerText(undefined)).toBe("TEXT_NONE");
    expect(classifyAnswerText("  ")).toBe("TEXT_NONE");
    for (const t of ["Image generation is unavailable.", "The image generation tool is not available in this session.", "I don't have access to an image generation tool.", "I cannot generate images here.", "No image tool available.", "画像生成ツールは利用できません。"]) expect(classifyAnswerText(t), t).toBe("TEXT_TOOL_UNAVAILABLE");
    expect(classifyAnswerText("image generation failed: boom")).toBe("TEXT_TOOL_ERROR");
    expect(classifyAnswerText("You've hit your usage limit.")).toBe("TEXT_USAGE_LIMIT");
    expect(classifyAnswerText("Sorry, I can't help with that.")).toBe("TEXT_REFUSAL");
    expect(classifyAnswerText("Here is the design: a header ...")).toBe("TEXT_OTHER");
    expect(parseCodexVersion("codex-cli 0.163.0\n")).toBe("0.163.0");
    expect(parseCodexVersion("codex-cli 0.164.0-alpha.8\n")).toBe("0.164.0-alpha.8");
    expect(parseCodexVersion(`codex-cli ${CANARY}\n`)).toBeNull();
    expect(parseCodexVersion("")).toBeNull();
    const f = { ...emptySessionFacts(), log_found: true };
    expect(deriveImageOutcome(f, true)).toBe("IMAGE_SAVED");
    expect(deriveImageOutcome(emptySessionFacts(), false)).toBe("NO_SESSION_LOG");
    expect(deriveImageOutcome({ ...f, truncated: true }, false)).toBe("NO_SESSION_LOG");
    expect(deriveImageOutcome(f, false)).toBe("TOOL_NOT_CALLED");
    expect(deriveImageOutcome({ ...f, image_tool_calls: 1, image_tool_failed: 1, image_failure_codes: ["OTHER"] }, false)).toBe("TOOL_FAILED");
    expect(deriveImageOutcome({ ...f, image_tool_calls: 1, image_tool_completed: 1 }, false)).toBe("TOOL_CALLED_NO_FILE");
    expect(pocStopClass("CODEX_QUOTA")).toBe("environment");
    expect(pocStopClass("CODEX_IMAGE_TOOL_FAILED")).toBe("capability");
    expect(pocStopClass("CODEX_NO_IMAGE", "TOOL_NOT_CALLED", "TEXT_OTHER")).toBe("request");
    expect(pocStopClass("CODEX_NO_IMAGE", "TOOL_NOT_CALLED", "TEXT_TOOL_UNAVAILABLE")).toBe("capability");
    expect(pocStopClass("CODEX_NO_IMAGE", "TOOL_CALLED_NO_FILE", "TEXT_TOOL_UNAVAILABLE")).toBe("request");
    expect(pocStopClass("CODEX_NO_IMAGE", "TOOL_NOT_SEEN_CODE_MODE", "TEXT_OTHER")).toBe("inconclusive");
    expect(pocStopClass("CODEX_NO_IMAGE", "TOOL_NOT_SEEN_CODE_MODE", "TEXT_TOOL_UNAVAILABLE")).toBe("inconclusive");
    expect(deriveImageOutcome({ ...f, code_mode_cells: 1 }, false)).toBe("TOOL_NOT_SEEN_CODE_MODE");
    expect(deriveImageOutcome({ ...f, tool_mode: "code_mode_only" }, false)).toBe("TOOL_NOT_SEEN_CODE_MODE");
    expect(deriveImageOutcome({ ...f, tool_mode: "direct" }, false)).toBe("TOOL_NOT_CALLED");
    expect(parseCodexVersion("codex-cli 0.159.0\n")).toBe("0.159.0");
    expect(pocStopClass("POC_STOPPED_BY_SIGNAL")).toBe("interrupted");
    expect(pocStopClass("SOMETHING_NEW")).toBe("interrupted");
  });
});

describe("checkPng", () => {
  it("accepts a complete PNG and refuses every malformed one", () => {
    expect(checkPng(png())).toEqual({ width: 1024, height: 1536, chunks: 3 });
    const bad = (b: Buffer) => expect(() => checkPng(b)).toThrow(PngError);
    const good = png();
    bad(Buffer.from("not a png at all, not a png at all, not a png at all, not a png at all"));
    bad(good.subarray(0, 40)); // truncated
    bad(Buffer.concat([good, Buffer.alloc(1)])); // trailing data after IEND
    bad(good.subarray(0, good.length - 12)); // no IEND
    const crc = Buffer.from(good);
    crc[29] ^= 1; // IHDR CRC
    bad(crc);
    bad(png(300, 1536)); // too narrow
    bad(png(9000, 600)); // too wide
    const sig = Buffer.from(good);
    sig[1] = 0;
    bad(sig);
    // too large in bytes
    expect(() => checkPng(good, { ...MOCKUP_PNG_LIMITS, maxBytes: good.length - 1 })).toThrow(PngError);
    // IHDR not first / no IDAT
    const ihdr = good.subarray(8, 33);
    const iend = chunk("IEND", Buffer.alloc(0));
    bad(Buffer.concat([good.subarray(0, 8), ihdr, iend]));
    bad(Buffer.concat([good.subarray(0, 8), chunk("tEXt", Buffer.from("a\0b")), ihdr, good.subarray(33)]));
  });
});

describe("codexLooksSignedOut", () => {
  it("reads stderr and the CLI's error / turn.failed events only", () => {
    expect(codexLooksSignedOut("", "Error: refresh token was revoked. Please log out and sign in again.")).toBe(true);
    expect(codexLooksSignedOut(`${JSON.stringify({ type: "error", message: "401 Unauthorized" })}\n`, "")).toBe(true);
    expect(codexLooksSignedOut(`${JSON.stringify({ type: "turn.failed", error: { message: "invalid_grant" } })}\n`, "")).toBe(true);
    expect(codexLooksSignedOut(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "401 Unauthorized, not logged in" } })}\n`, "")).toBe(false);
    expect(codexLooksSignedOut("", "usage limit reached")).toBe(false);
    // the quota check is unchanged
    expect(codexLooksRateLimited("", "usage limit reached")).toBe(true);
    expect(codexLooksRateLimited("", "401 Unauthorized")).toBe(false);
  });
});

describe("entry points refuse", () => {
  it("design-image-poc.ts: without the flag, and without the shell's lock token: exit 2, nothing started", async () => {
    const h = mkdtempSync(join(tmpdir(), "sr-img-poc-cli-"));
    const tsx = join(REPO, "node_modules/.bin/tsx");
    const entry = join(REPO, "scripts/sales-design-worker/design-image-poc.ts");
    const env = { PATH: process.env.PATH, HOME: h } as unknown as NodeJS.ProcessEnv;
    const noFlag = await run(tsx, [entry], { cwd: REPO, env }).catch((e: { code: number; stderr: string }) => e);
    expect(noFlag).toMatchObject({ code: 2 });
    expect((noFlag as { stderr: string }).stderr).toContain("STOP: --human-approval-confirmed is missing");
    const direct = await run(tsx, [entry, "--human-approval-confirmed"], { cwd: REPO, env }).catch((e: { code: number; stderr: string }) => e);
    expect(direct).toMatchObject({ code: 2 });
    expect((direct as { stderr: string }).stderr).toContain("STOP: start the PoC with scripts/sales-design-worker/design-image-poc.sh");
    // under the shell's token, a direction outside the fixed list: exit 2, POC_DIRECTION_INVALID, nothing started
    const badDirection = await run(tsx, [entry, "--human-approval-confirmed"], { cwd: REPO, env: { ...env, SR_DESIGN_IMAGE_POC_LOCKED: "run.lock", SR_DESIGN_IMAGE_POC_DIRECTION: "v3", SR_DESIGN_IMAGE_POC_ROOT: join(h, "out") } as unknown as NodeJS.ProcessEnv }).catch((e: { code: number; stdout: string }) => e);
    expect(badDirection).toMatchObject({ code: 2 });
    expect((badDirection as { stdout: string }).stdout).toContain("POC_STOP: POC_DIRECTION_INVALID");
    expect(readdirSync(h)).toEqual([]);
    spawnSync("rm", ["-rf", h]);
  }, 60_000);

  it("design-image-poc.sh: STOP before the preflight, the lock, git, npm or tsx; with the flag a clean environment, the lock and the budget", async () => {
    const repo = join(root, "repo");
    const bin = join(root, "bin");
    const h = join(root, "shhome");
    const record = join(root, "record.log");
    for (const d of [join(repo, "scripts/sales-design-worker"), join(repo, "scripts/ops"), join(repo, "node_modules/.bin"), bin, h]) mkdirSync(d, { recursive: true });
    cpSync(join(REPO, "scripts/sales-design-worker/design-image-poc.sh"), join(repo, "scripts/sales-design-worker/design-image-poc.sh"));
    writeFileSync(join(repo, "scripts/sales-design-worker/design-image-poc.ts"), "");
    writeFileSync(join(repo, "package-lock.json"), "{}");
    const tool = (path: string, name: string, extra = "") => {
      writeFileSync(path, `#!/bin/bash\necho "${name} $*" >> '${record}'\n${extra}\nexit 0\n`);
      chmodSync(path, 0o755);
    };
    tool(join(bin, "git"), "git", "echo 0123456789ab");
    tool(join(bin, "npm"), "npm");
    tool(join(repo, "scripts/ops/wsl-resource-preflight.sh"), "preflight");
    tool(join(repo, "node_modules/.bin/tsx"), "tsx", `env | cut -d= -f1 | sort | tr '\\n' ' ' | sed 's/^/env /' >> '${record}'`);
    const script = join(repo, "scripts/sales-design-worker/design-image-poc.sh");
    const env = { PATH: `${bin}:${process.env.PATH}`, HOME: h, OPENAI_API_KEY: "sk-test", GITHUB_TOKEN: "x", SUPABASE_SERVICE_ROLE_KEY: "x", SR_DESIGN_WORKER_NO_UPDATE: "1" } as unknown as NodeJS.ProcessEnv;

    const refused = await run("bash", [script], { env }).catch((e: { code: number; stdout: string }) => e);
    expect(refused).toMatchObject({ code: 2 });
    expect((refused as { stdout: string }).stdout).toContain("STOP: --human-approval-confirmed is missing");
    expect(existsSync(record)).toBe(false);
    expect(await run("bash", [script, "--human-approval-confirmed", "--extra"], { env }).catch((e: { code: number }) => e)).toMatchObject({ code: 2 });
    expect(existsSync(record)).toBe(false);
    // a direction outside v1 / v2: STOP before the preflight, the lock, git or tsx
    for (const bad of ["v3", "V2", "../v1", "v2;id"]) {
      const wrong = await run("bash", [script, "--human-approval-confirmed"], { env: { ...env, SR_DESIGN_IMAGE_POC_DIRECTION: bad } as unknown as NodeJS.ProcessEnv }).catch((e: { code: number; stdout: string }) => e);
      expect(wrong).toMatchObject({ code: 2 });
      expect((wrong as { stdout: string }).stdout).toContain("STOP: POC_DIRECTION_INVALID");
      expect(existsSync(record)).toBe(false);
    }

    await run("bash", [script, "--human-approval-confirmed"], { env: { ...env, SR_DESIGN_IMAGE_POC_BUDGET_SECONDS: "10800" } as unknown as NodeJS.ProcessEnv });
    const log = readFileSync(record, "utf8");
    expect(log).toContain("preflight");
    expect(log).toMatch(/tsx .*scripts\/sales-design-worker\/design-image-poc\.ts --human-approval-confirmed --budget-seconds=\d+/);
    expect(Number(/--budget-seconds=(\d+)/.exec(log)![1])).toBeLessThanOrEqual(3300 - 120);
    const seen = /^env (.*)$/m.exec(log)![1]!;
    for (const secret of ["OPENAI_API_KEY", "GITHUB_TOKEN", "SUPABASE_SERVICE_ROLE_KEY"]) expect(seen).not.toContain(secret);
    expect(seen).toContain("SR_DESIGN_IMAGE_POC_LOCKED");
    expect(seen).not.toContain("SR_DESIGN_IMAGE_POC_DIRECTION"); // unset: the entry takes v2
    expect(log).not.toMatch(/systemctl|timer/);

    // v1 on request: the allowlist passes SR_DESIGN_IMAGE_POC_DIRECTION through to the entry
    writeFileSync(record, "");
    await run("bash", [script, "--human-approval-confirmed"], { env: { ...env, SR_DESIGN_IMAGE_POC_DIRECTION: "v1" } as unknown as NodeJS.ProcessEnv });
    expect(/^env (.*)$/m.exec(readFileSync(record, "utf8"))![1]!).toContain("SR_DESIGN_IMAGE_POC_DIRECTION");

    // a budget too short for the one call: STOP, tsx never starts
    writeFileSync(record, "");
    const short = await run("bash", [script, "--human-approval-confirmed"], { env: { ...env, SR_DESIGN_IMAGE_POC_BUDGET_SECONDS: "600" } as unknown as NodeJS.ProcessEnv }).catch((e: { code: number; stdout: string }) => e);
    expect(short).toMatchObject({ code: 1 });
    expect((short as { stdout: string }).stdout).toContain("STOP: POC_RUN_TIME_BUDGET");
    expect(readFileSync(record, "utf8")).not.toContain("tsx");

    // a worker run (run.sh) holds the run lock: STOP, exit 3, the PoC never starts
    writeFileSync(record, "");
    const lockFile = join(h, ".local/state/sr-design-worker/run.lock");
    const holder = execFile("flock", ["-x", lockFile, "sleep", "30"]);
    try {
      for (let i = 0; i < 50 && !(await run("flock", ["-n", lockFile, "true"]).then(() => false, () => true)); i++) await new Promise((r) => setTimeout(r, 100));
      const busy = await run("bash", [script, "--human-approval-confirmed"], { env }).catch((e: { code: number; stdout: string }) => e);
      expect(busy).toMatchObject({ code: 3 });
      expect((busy as { stdout: string }).stdout).toContain("STOP: a design worker run (run.sh) is in progress");
      expect(readFileSync(record, "utf8")).not.toContain("tsx");
    } finally {
      holder.kill();
    }
  }, 60_000);
});

describe("isolation of the PoC's output", () => {
  it("only the PoC itself names ~/sr-design-image-poc or imports lib/design-agent/design-image (renderer, worker, preview, assets never read it)", () => {
    const grep = spawnSync("grep", ["-rlE", "--exclude-dir=design-image", "sr-design-image-poc|design-agent/design-image|from \"\\./design-image|from \"\\.\\./design-image", "lib", "app", "components", "scripts"], { cwd: REPO, encoding: "utf8" });
    const files = grep.stdout.trim().split("\n").filter(Boolean).sort();
    expect(files).toEqual(["scripts/sales-design-worker/design-image-poc.ts"]);
  });

  it("the v2 direction, the direction files and the AI food-visual policy stay inside the PoC (worker, demo, presets, renderer, asset store never read them)", () => {
    const grep = spawnSync(
      "git",
      ["grep", "--untracked", "-lE", "wagashi-art-direction-v2|AI_FOOD_VISUALS", "--", ".", ":!docs", ":!.ai", ":!design-library/poc", ":!lib/design-agent/design-image", ":!tests/unit/design-agent/design-image-poc.test.ts"],
      { cwd: REPO, encoding: "utf8" },
    );
    expect(grep.status === 0 || grep.status === 1).toBe(true); // 1: no match
    const files = grep.stdout.trim().split("\n").filter(Boolean).sort();
    for (const f of files) expect(["scripts/sales-design-worker/design-image-poc.sh", "scripts/sales-design-worker/design-image-poc.ts"]).toContain(f);
    // nor does anything else name the PoC's direction files or their table
    const dirs = spawnSync(
      "git",
      ["grep", "--untracked", "-lE", "design-library/poc|DIRECTION_PATHS", "--", ".", ":!docs", ":!.ai", ":!design-library/poc", ":!lib/design-agent/design-image", ":!tests/unit/design-agent/design-image-poc.test.ts"],
      { cwd: REPO, encoding: "utf8" },
    );
    expect(dirs.status === 0 || dirs.status === 1).toBe(true);
    for (const f of dirs.stdout.trim().split("\n").filter(Boolean)) expect(["scripts/sales-design-worker/design-image-poc.sh", "scripts/sales-design-worker/design-image-poc.ts"]).toContain(f);
  });
});
