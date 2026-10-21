import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { crc32, deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BoundedResult } from "@/lib/design-agent/bounded-process";
import { codexLooksRateLimited, codexLooksSignedOut } from "@/lib/design-agent/codex";
import { checkPng, MOCKUP_PNG_LIMITS, PngError } from "@/lib/design-agent/design-image/png";
import {
  buildMockupPrompt,
  DIRECTION_PATH,
  DIRECTION_PATHS,
  loadPocInputs,
  parseDirectionVersion,
  POC_DISCLOSURE,
  POC_DISCLOSURE_V2,
  PocDirectionError,
  PocInputError,
} from "@/lib/design-agent/design-image/prompt";
import { cleanupActivePoc, isInsidePath, REPORT_NOTES, REPORT_NOTES_V2, runDesignImagePoc, type PocOptions } from "@/lib/design-agent/design-image/run";
import type { CodexSandbox } from "@/lib/design-agent/sandbox";

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
    expect(existsSync(outRoot) ? readdirSync(outRoot) : []).toEqual([]);
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
    for (const heading of ["TASK", "WHAT THE IMAGE IS", "ARTBOARD", "GOAL", "THEME", "PALETTE", "TYPOGRAPHY", "GRID", "WEB UI", "SECTIONS", "WAGASHI VISUALS", "TECHNIQUES", "AVOID", "JAPANESE TEXT", "HARD RULES", "YOU MAY LEAVE OUT", "FACTS"])
      expect(`\n${prompt}`).toContain(`\n${heading}`);
    // a website design comp, not a poster; tall 2:3 portrait; realistic web type
    expect(prompt).toContain("A professional website design comp: a full-page desktop screenshot-style mockup");
    expect(prompt).toContain("NOT a poster");
    expect(prompt).toMatch(/No device frame/);
    expect(prompt).toMatch(/2:3 \(for example 1024 x 1536 px\)/);
    expect(prompt).toContain("realistic web typography sizes");
    // nav, CTA, sections, cards, structured info
    expect(prompt).toContain("Nav anchors, exactly: 「商品・こだわり」 「店舗情報」\n");
    expect(prompt).not.toContain("「アクセス」"); // no anchor without a section (the access line may be left out)
    expect(prompt).toContain("exactly: 「店舗情報を見る」");
    expect(prompt).toContain("1. Hero.");
    expect(prompt).toContain("2. 商品・こだわり.");
    expect(prompt).toContain("3. 店舗情報.");
    expect(prompt).toContain("This section MUST contain 2 to 3 product visual cards; it is never text only.");
    expect(prompt).toContain("Card captions are ONLY phrases copied verbatim from the description in the FACTS block (for example 季節の上生菓子, 粒あんのどら焼き); a third card, if present, is the tsubu-an macro with no caption. Never invent a caption.");
    expect(prompt).toContain("a row of 2 to 3 product visual cards");
    expect(prompt).not.toMatch(/row of 3 product|Three equal product cards/);
    expect(prompt).toContain("It MUST be a structured information block (a definition list or a two-column table: label, value).");
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
    expect(prompt).toContain("one consistent art direction.");
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
    // the direction itself is in it
    expect(prompt).toContain(inputs.direction.goal);
    for (const r of inputs.direction.hard_rules) expect(prompt).toContain(`- ${r}`);
    if (inputs.version !== "v2") throw new Error("expected v2");
    for (const c of inputs.direction.palette) expect(prompt).toContain(c.hex);
    expect(prompt).toContain(inputs.direction.food_visuals.cross_section);
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
