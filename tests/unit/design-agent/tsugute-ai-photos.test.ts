/**
 * DEV-185: the つぐ手 (fictional) AI demo photos — one owner-approved Codex run, at most 6 image calls — tested OFFLINE.
 * No Codex, no image tool, no bubblewrap, no network: the shell gate runs against fake git/id/getent/tsx, the image run
 * against an in-process fake sandbox that plays the CLI, and every picture is a synthetic PNG made at test time under
 * os.tmpdir() (never written to the repository).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { BoundedResult } from "@/lib/design-agent/bounded-process";
import { generateImagesInOneRun, MAX_BATCH_IMAGES, type ImageBatchResult } from "@/lib/design-agent/design-image/image-once";
import { writeTsugutePhotos } from "@/lib/design-agent/design-image/tsugute-photos";
import { AI_DEMO_PUBLIC_LABEL, checkPhotoRights, loadForbiddenSha256, measurePhotoBytes, toPublicPhotoRecord } from "@/lib/design-agent/quality-pipeline/photo-rights";
import { edgesFor, PhotoSlotEdges, PhotoSlotInventory, requestFor } from "@/lib/design-agent/quality-pipeline/photo-slots";
import { buildTsugutePhotosPrompt, cropReaches, DEMO_LABEL, GENERATOR, slotPromptSha256, TSUGUTE_COMMON, TSUGUTE_PHOTOS_APPROVAL_ID, TSUGUTE_SLOTS } from "@/lib/design-agent/quality-pipeline/tsugute-ai-photos";
import type { CodexSandbox } from "@/lib/design-agent/sandbox";
import { swapPage } from "../../../scripts/design-artifact/photo-swap";
import { importTsuguteAiPhotos } from "../../../scripts/design-artifact/tsugute-ai-intake";
import { TSUGUTE_PROMPT_CHARS, TSUGUTE_PROMPT_SHA256 } from "../../../scripts/sales-design-worker/tsugute-photos";
import { colourPng } from "./phase2f/fixtures";

const REPO = resolve(__dirname, "../../..");
const ENTRY = join(REPO, "scripts/sales-design-worker/run-tsugute-photos-once.sh");
const GATE = join(REPO, "scripts/sales-design-worker/tsugute-photos-gate.sh");
const TS_ENTRY = join(REPO, "scripts/sales-design-worker/tsugute-photos.ts");
const TSX = join(REPO, "node_modules/.bin/tsx");
const PIN = "dab7f2603c7495c4381035391a24ae98cc8bd07064295233fab034964ec33ed0";
const CHARS = "4133";
const ID = "tsugute-photos-20261106-01";
const COMMIT = "9b79163825368d53bc066693b03cc21f7702b67d";
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

describe("DEV-185 pins", () => {
  it("the prompt is pinned by SHA-256 and length, the same in the TS entry, the gate and the one-shot entry", () => {
    const prompt = buildTsugutePhotosPrompt();
    expect(sha(prompt)).toBe(PIN);
    expect(String(prompt.length)).toBe(CHARS);
    expect([TSUGUTE_PROMPT_SHA256, String(TSUGUTE_PROMPT_CHARS)]).toEqual([PIN, CHARS]);
    expect(TSUGUTE_PHOTOS_APPROVAL_ID).toBe(ID);
    const entry = readFileSync(ENTRY, "utf8");
    expect(entry).toContain(`--expected-prompt-sha256 ${PIN}`);
    expect(entry).toContain(`--expected-prompt-chars ${CHARS}`);
    expect(entry).toContain(`--approval-id ${ID}`);
    expect(entry).toContain('--expected-commit "$REVIEWED_COMMIT"');
    expect(entry).toContain("0::/system.slice/sr-jail-claude.service");
    const gate = readFileSync(GATE, "utf8");
    expect(gate).toContain(`PIN_SHA="${PIN}"`);
    expect(gate).toContain(`PIN_CHARS="${CHARS}"`);
    expect(gate).toContain(`PIN_ID="${ID}"`);
  });

  it("the prompt is built from the brief: its common paragraph and the 6 slot prompts, verbatim, in the brief's order", () => {
    const brief = readFileSync(join(REPO, "docs/design/tsugute-ai-photo-brief.md"), "utf8");
    expect(brief).toContain("```\n" + TSUGUTE_COMMON + "\n```");
    const prompt = buildTsugutePhotosPrompt();
    let at = prompt.indexOf("COMMON:");
    for (const s of TSUGUTE_SLOTS) {
      expect(brief).toContain(`**${s.slot_id}** (${s.aspect}, ${s.target.width}×${s.target.height})\n   \`${s.prompt}\``);
      const next = prompt.indexOf(s.prompt, at);
      expect(next, s.slot_id).toBeGreaterThan(at);
      at = next;
    }
    expect(prompt).toContain("exactly 6 times");
    expect(prompt).toContain("do not retry");
  });

  it("each slot's 2× target and 1.5× floor are what the swap asks for on d1-v10 (requestFor with the range edges)", () => {
    const dir = join(REPO, "design-library/research/quality-pipeline/poc/tsugute");
    const inv = PhotoSlotInventory.parse(JSON.parse(readFileSync(join(dir, "photo-slots-d1-v10.json"), "utf8")));
    const edges = edgesFor(inv, PhotoSlotEdges.parse(JSON.parse(readFileSync(join(dir, "photo-slot-edges-d1-v10.json"), "utf8"))))!;
    expect(inv.slots.map((s) => s.slot_id)).toEqual(TSUGUTE_SLOTS.map((s) => s.slot_id));
    for (const s of TSUGUTE_SLOTS) {
      const slot = inv.slots.find((x) => x.slot_id === s.slot_id)!;
      const two = requestFor(slot, { edges: edges.get(s.slot_id)! });
      const floor = requestFor(slot, { edges: edges.get(s.slot_id)!, scale: 1.5 });
      if (!two.ok || !floor.ok) throw new Error(s.slot_id);
      expect([two.aspect, floor.min_width_px, floor.min_height_px], s.slot_id).toEqual([s.aspect, s.floor.width, s.floor.height]);
      // the brief's target is the larger of d1-v3 and d1-v10: never below d1-v10's 2×
      expect(s.target.width >= two.min_width_px && s.target.height >= two.min_height_px, s.slot_id).toBe(true);
    }
  });

  it("the TS pin probe passes the pinned prompt and refuses a wrong pin; a forged lock alone never reaches Codex", () => {
    const run = (args: string[], env: Record<string, string>) => spawnSync(TSX, ["--no-cache", TS_ENTRY, ...args], { cwd: REPO, encoding: "utf8", timeout: 30_000, env: { ...process.env, ...env } });
    const good = run(["--check-pin-only"], { SR_TSUGUTE_PHOTOS_LOCKED: "run.lock", SR_TSUGUTE_EXPECTED_SHA: PIN, SR_TSUGUTE_EXPECTED_CHARS: CHARS });
    expect(good.status, good.stdout + good.stderr).toBe(0);
    expect(good.stdout).toContain("POC_PIN_OK");
    const bad = run(["--check-pin-only"], { SR_TSUGUTE_PHOTOS_LOCKED: "run.lock", SR_TSUGUTE_EXPECTED_SHA: "0".repeat(64), SR_TSUGUTE_EXPECTED_CHARS: CHARS });
    expect(bad.status).toBe(23);
    expect(bad.stdout).toContain("POC_PIN_MISMATCH");
    const unlocked = run(["--human-approval-confirmed", "--budget-seconds=3000"], {});
    expect(unlocked.status).toBe(2);
    const forged = run(["--human-approval-confirmed", "--budget-seconds=3000"], { SR_TSUGUTE_PHOTOS_LOCKED: "run.lock", SR_TSUGUTE_EXPECTED_SHA: PIN, SR_TSUGUTE_EXPECTED_CHARS: CHARS });
    expect(forged.status, forged.stdout).toBe(2);
    expect(forged.stdout).toMatch(/POC_TSUGUTE_APPROVAL_(PIN_REQUIRED|NOT_RESERVED)/);
  }, 60_000);
});

describe("DEV-185 isolation", () => {
  it("only the TS entry imports the run's module; only the gate starts the TS entry; nothing else names the approval marker", () => {
    const grep = (re: string, ...paths: string[]) => spawnSync("git", ["grep", "--untracked", "-lE", re, "--", ...paths], { cwd: REPO, encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean).sort();
    expect(grep("design-image/tsugute-photos|generateImagesInOneRun", "lib", "app", "components", "scripts", ":!lib/design-agent/design-image")).toEqual(["scripts/sales-design-worker/tsugute-photos.ts"]);
    expect(grep("sales-design-worker/tsugute-photos\\.ts", ".", ":!tests/**", ":!docs/**", ":!.ai/**", ":!*.ts")).toEqual(["scripts/sales-design-worker/tsugute-photos-gate.sh"]);
    expect(grep("tsugute-photos-gate\\.sh", ".", ":!tests/**", ":!docs/**", ":!.ai/**", ":!*.ts", ":!scripts/sales-design-worker/tsugute-photos-gate.sh")).toEqual(["scripts/sales-design-worker/run-tsugute-photos-once.sh"]);
    expect(grep("tsugute-photos-20261106-01", ".", ":!tests/**", ":!docs/**", ":!.ai/**")).toEqual(["lib/design-agent/quality-pipeline/tsugute-ai-photos.ts", "scripts/sales-design-worker/run-tsugute-photos-once.sh", "scripts/sales-design-worker/tsugute-photos-gate.sh", "scripts/sales-design-worker/tsugute-photos.ts"]);
  });
});

describe("DEV-185 one-shot entry: user and cgroup", () => {
  it("refuses a wrong user, a missing commit, and a forged sr-designgen outside the jailed service", () => {
    const wrongUser = spawnSync("bash", [ENTRY, "--human-approval-confirmed", "--expected-commit", COMMIT], { cwd: REPO, encoding: "utf8", timeout: 5000, env: { ...process.env, HOME: "/tmp" } });
    expect(wrongUser.status).toBe(2);
    expect(wrongUser.stdout).toContain("sr-designgen user required");
    const noCommit = spawnSync("bash", [ENTRY, "--human-approval-confirmed"], { cwd: REPO, encoding: "utf8", timeout: 5000 });
    expect(noCommit.status).toBe(2);
    const dir = mkdtempSync(join(tmpdir(), "dev185-cg-"));
    try {
      writeFileSync(join(dir, "id"), '#!/bin/bash\nif [ "$1" = "-un" ]; then echo sr-designgen; else /usr/bin/id "$@"; fi\n');
      chmodSync(join(dir, "id"), 0o755);
      const forged = spawnSync("bash", [ENTRY, "--human-approval-confirmed", "--expected-commit", COMMIT], { cwd: REPO, encoding: "utf8", timeout: 5000, env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: "/home/sr-designgen" } });
      expect(forged.status, forged.stdout + forged.stderr).toBe(2);
      expect(forged.stdout).toContain("SR_CLAUDE_JAIL_REQUIRED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("DEV-185 gate with fake git/id/tsx and zero Codex calls", () => {
  const args = ["--human-approval-confirmed", "--expected-prompt-sha256", PIN, "--expected-prompt-chars", CHARS, "--expected-commit", COMMIT, "--approval-id", ID];
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), "dev185-gate-"));
    const tools = join(root, "bin");
    const repo = join(root, "repo");
    const home = join(root, "home");
    for (const d of [tools, home, join(repo, "scripts/ops"), join(repo, "scripts/sales-design-worker"), join(repo, "node_modules/.bin")]) mkdirSync(d, { recursive: true });
    cpSync(GATE, join(repo, "scripts/sales-design-worker/tsugute-photos-gate.sh"));
    writeFileSync(join(repo, "scripts/sales-design-worker/tsugute-photos.ts"), "// fake\n");
    writeFileSync(join(repo, "scripts/ops/wsl-resource-preflight.sh"), '#!/bin/bash\necho PREFLIGHT >> "$HOME/preflight-count"\nexit 0\n');
    const tool = (name: string, body: string[]) => {
      writeFileSync(join(tools, name), ["#!/bin/bash", ...body, ""].join("\n"));
      chmodSync(join(tools, name), 0o755);
    };
    tool("git", [
      'case "$*" in',
      '  "rev-parse --short=12 HEAD") head -c 12 git-head; echo ;;',
      '  "rev-parse HEAD") cat git-head ;;',
      '  "rev-parse origin/develop") cat git-origin ;;',
      '  "status --porcelain --untracked-files=all") [ -f git-dirty ] && echo " M dirty" || true ;;',
      '  *) echo "unexpected git $*" >&2; exit 77 ;;',
      "esac",
    ]);
    tool("id", ['case "$1" in', "  -u) echo 1001 ;;", "  -un) echo sr-designgen ;;", '  *) /usr/bin/id "$@" ;;', "esac"]);
    tool("getent", ['printf "sr-designgen:x:1001:1001::%s/home:/bin/bash\\n" "$(dirname "$PWD")"']);
    writeFileSync(join(repo, "git-head"), `${COMMIT}\n`);
    writeFileSync(join(repo, "git-origin"), `${COMMIT}\n`);
    writeFileSync(
      join(repo, "node_modules/.bin/tsx"),
      [
        "#!/bin/bash",
        'if [[ "$*" == *"--check-pin-only"* ]]; then',
        `  [ "$SR_TSUGUTE_EXPECTED_SHA" = "${PIN}" ] && [ "$SR_TSUGUTE_EXPECTED_CHARS" = "${CHARS}" ] && [ "$SR_TSUGUTE_PHOTOS_LOCKED" = run.lock ] || exit 23`,
        '  echo "POC_PIN_OK fake"; exit 0',
        "fi",
        'echo "FAKE_MODEL_INVOKED" >> "$HOME/fake-count"',
        // the env allowlist drops unknown variables, so the fake's exit code comes from a file
        'exit "$(cat "$HOME/fake-exit" 2>/dev/null || echo 0)"',
        "",
      ].join("\n"),
    );
    chmodSync(join(repo, "node_modules/.bin/tsx"), 0o755);
    const exec = (a: string[] = args, env: Record<string, string> = {}) =>
      spawnSync("bash", [join(repo, "scripts/sales-design-worker/tsugute-photos-gate.sh"), ...a], {
        cwd: repo,
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, HOME: home, PATH: `${tools}:${process.env.PATH ?? "/usr/bin:/bin"}`, SR_DESIGN_WORKER_NO_UPDATE: "1", ...env },
      });
    const marker = join(home, ".local/state/sr-design-worker/poc-approval-used", ID);
    const count = () => (existsSync(join(home, "fake-count")) ? readFileSync(join(home, "fake-count"), "utf8").trim().split("\n").length : 0);
    return { root, repo, home, exec, marker, count, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }

  it("refuses any other prompt pin, length, approval id or a malformed commit before the preflight, the lock or the marker", () => {
    const f = fixture();
    try {
      const swap = (i: number, v: string) => args.map((a, j) => (j === i ? v : a));
      for (const a of [swap(2, "0".repeat(64)), swap(4, "4134"), swap(8, "tsugute-photos-20261106-02"), swap(6, "abc"), args.slice(0, 6), args.slice(1)]) {
        const r = f.exec(a);
        expect(r.status, a.join(" ")).toBe(2);
        expect(r.stdout).toMatch(/STOP:|usage:/);
        expect(r.stdout).not.toContain("== 1. resource preflight");
      }
      expect(existsSync(f.marker)).toBe(false);
      expect(existsSync(join(f.home, "preflight-count"))).toBe(false);
      expect(f.count()).toBe(0);
    } finally {
      f.cleanup();
    }
  });

  it("wrong commit, moved origin/develop, a dirty tree or NO_UPDATE=0 refuse without consuming the approval", () => {
    const f = fixture();
    try {
      writeFileSync(join(f.repo, "git-head"), `${"f".repeat(40)}\n`);
      expect(f.exec().stdout).toContain("POC_COMMIT_PIN_MISMATCH");
      writeFileSync(join(f.repo, "git-head"), `${COMMIT}\n`);
      writeFileSync(join(f.repo, "git-origin"), `${"e".repeat(40)}\n`);
      expect(f.exec().status).toBe(26);
      writeFileSync(join(f.repo, "git-origin"), `${COMMIT}\n`);
      writeFileSync(join(f.repo, "git-dirty"), "");
      expect(f.exec().status).toBe(26);
      rmSync(join(f.repo, "git-dirty"));
      expect(f.exec(args, { SR_DESIGN_WORKER_NO_UPDATE: "0" }).status).toBe(26);
      expect(existsSync(f.marker)).toBe(false);
      expect(f.count()).toBe(0);
    } finally {
      f.cleanup();
    }
  });

  it("consumes the marker before the run; a second run (even after a failed first one) is refused and never reaches the model", () => {
    const f = fixture();
    try {
      writeFileSync(join(f.home, "fake-exit"), "1");
      const first = f.exec();
      expect(first.status, first.stdout + first.stderr).toBe(1);
      expect(first.stdout.indexOf("POC_APPROVAL_RESERVED")).toBeLessThan(first.stdout.indexOf("tsugute-photos.ts exit 1"));
      expect(readFileSync(join(f.marker, "receipt"), "utf8")).toBe(`direction=tsugute-photos\nsha256=${PIN}\ncommit=${COMMIT}\n`);
      expect((statSync(f.marker).mode & 0o777).toString(8)).toBe("700");
      expect(f.count()).toBe(1);
      const second = f.exec();
      expect(second.status).toBe(25);
      expect(second.stdout).toContain("POC_APPROVAL_ALREADY_USED");
      expect(f.count()).toBe(1);
      // nor through another HOME or state dir
      const other = join(f.root, "other-home");
      mkdirSync(other);
      expect(f.exec(args, { HOME: other }).status).toBe(27);
      expect(f.exec(args, { XDG_STATE_HOME: join(f.root, "alt") }).status).toBe(27);
      expect(f.count()).toBe(1);
    } finally {
      f.cleanup();
    }
  });

  it("a held worker lock stops before the marker", () => {
    const f = fixture();
    const state = join(f.home, ".local/state/sr-design-worker");
    mkdirSync(state, { recursive: true });
    const holder = spawnSync("bash", ["-c", `exec 9>"${join(state, "run.lock")}"; flock -n 9 && bash "${join(f.repo, "scripts/sales-design-worker/tsugute-photos-gate.sh")}" ${args.join(" ")}`], {
      cwd: f.repo,
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, HOME: f.home, PATH: `${join(f.root, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`, SR_DESIGN_WORKER_NO_UPDATE: "1" },
    });
    try {
      expect(holder.status, holder.stdout + holder.stderr).toBe(3);
      expect(existsSync(f.marker)).toBe(false);
      expect(f.count()).toBe(0);
    } finally {
      f.cleanup();
    }
  });
});

describe("DEV-185 generateImagesInOneRun (fake CLI): one run, at most 6 calls, no retry", () => {
  const THREAD = "0f0e0d0c-0b0a-4908-8706-050403020100";
  let root: string;
  let codexHome: string;
  let tmpBase: string;
  let execs: number;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dev185-run-"));
    codexHome = join(root, "home", ".codex");
    tmpBase = join(root, "tmp");
    for (const d of [codexHome, tmpBase]) mkdirSync(d, { recursive: true });
    execs = 0;
  });
  const ok = (stdout = ""): BoundedResult => ({ code: 0, signal: null, stdout, stderr: "", timedOut: false });
  const started = `${JSON.stringify({ type: "thread.started", thread_id: THREAD })}\n`;
  /** what the CLI leaves: a session log with one record per image call, and one PNG per completed call (in order) */
  function leave(cwd: string, statuses: Array<"completed" | "failed">, pngs = statuses.filter((s) => s === "completed").length) {
    const sessions = join(codexHome, "sessions", "2026", "11", "06");
    mkdirSync(sessions, { recursive: true });
    const recs = [
      { type: "session_meta", payload: { id: THREAD, cwd, cli_version: "0.163.0", model_provider: "openai" } },
      { type: "turn_context", payload: { cwd, model: "gpt-6.1-sol" } },
      ...statuses.map((status, i) => ({ type: "response_item", payload: { type: "image_generation_call", id: `ig_${i}`, status } })),
    ];
    writeFileSync(join(sessions, `rollout-2026-11-06T10-00-00-${THREAD}.jsonl`), recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const dir = join(codexHome, "generated_images", THREAD);
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < pngs; i++) {
      const p = join(dir, `ig_${i}.png`);
      writeFileSync(p, colourPng(1536 + i, 1024));
      const t = new Date(Date.UTC(2026, 10, 6, 10, 0, i));
      utimesSync(p, t, t);
    }
  }
  const box = (exec: (cwd: string) => Partial<BoundedResult>): CodexSandbox => ({
    env: { HOME: join(root, "home"), CODEX_HOME: codexHome },
    async run(a, o) {
      if (a[0] === "login") return ok("Logged in using ChatGPT\n");
      if (a[0] === "--version") return ok("codex-cli 0.163.0\n");
      execs += 1;
      return { ...ok(), ...exec(o.workDir) };
    },
  });
  const run = (exec: (cwd: string) => Partial<BoundedResult>) => generateImagesInOneRun({ sandbox: box(exec), prompt: "p", timeoutMs: 60_000, tmpBase, maxImages: 6 });

  it("6 completed calls: 6 pictures in call order, model and CLI as reported, nothing left behind", async () => {
    const r = await run((cwd) => (leave(cwd, Array(6).fill("completed")), ok(started)));
    expect(r).toMatchObject({ stopCode: null, outcome: "IMAGE_SAVED", imageCalls: 6, imageFailed: 0, model: "gpt-6.1-sol", cliVersion: "0.163.0" });
    expect(r.images.map((i) => i.width)).toEqual([1536, 1537, 1538, 1539, 1540, 1541]);
    expect(execs).toBe(1);
    expect(readdirSync(join(codexHome, "generated_images"))).toEqual([]);
  });

  it("more than 6 image calls (or PNGs) is refused whole: no picture is handed on", async () => {
    const seven = await run((cwd) => (leave(cwd, Array(7).fill("completed"), 6), ok(started)));
    expect(seven).toMatchObject({ stopCode: "CODEX_IMAGE_CALLS_EXCEEDED", images: [], imageCalls: 7 });
    const pngs = await run((cwd) => (leave(cwd, Array(6).fill("completed"), 7), ok(started)));
    expect(pngs).toMatchObject({ stopCode: "CODEX_IMAGE_CALLS_EXCEEDED", images: [] });
    await expect(generateImagesInOneRun({ sandbox: box(() => ok()), prompt: "p", timeoutMs: 1, tmpBase, maxImages: MAX_BATCH_IMAGES + 1 })).rejects.toThrow();
  });

  it("a failed call stops the batch with the tool's code; the run is never repeated", async () => {
    const r = await run((cwd) => (leave(cwd, ["completed", "completed", "failed"]), ok(started)));
    expect(r.stopCode).toBe("CODEX_IMAGE_TOOL_FAILED");
    expect(r).toMatchObject({ imageCalls: 3, imageFailed: 1 });
    expect(r.images).toHaveLength(2);
    expect(execs).toBe(1);
    const t = await run((cwd) => (leave(cwd, ["completed"]), { ...ok(started), code: null, timedOut: true }));
    expect(t).toMatchObject({ stopCode: "CODEX_TIMEOUT" });
    expect(execs).toBe(2);
  });

  it("fewer pictures than calls, or none, is not a complete batch", async () => {
    expect((await run((cwd) => (leave(cwd, Array(3).fill("completed"), 2), ok(started)))).stopCode).toBe("CODEX_IMAGE_COUNT_MISMATCH");
    expect((await run((cwd) => (leave(cwd, []), ok(started)))).stopCode).toBe("CODEX_NO_IMAGE");
  });
});

describe("DEV-185 output bundle", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "dev185-out-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const batch = (n: number, over: Partial<ImageBatchResult> = {}): ImageBatchResult => ({
    images: Array.from({ length: n }, (_, i) => ({ png: colourPng(1536, 1024 + i), width: 1536, height: 1024 + i })),
    outcome: "IMAGE_SAVED",
    stopCode: null,
    imageCalls: n,
    imageFailed: 0,
    threadId: null,
    cliVersion: "0.163.0",
    model: "gpt-6.1-sol",
    codexMs: 1000,
    ...over,
  });

  it("writes a new 0700 dir with <slot>.png (0600) and a manifest of slot → file, SHA-256, size and prompt hashes", async () => {
    const prompt = buildTsugutePhotosPrompt();
    const { dir, manifest } = await writeTsugutePhotos({ outRoot: root, batch: batch(6), commit: COMMIT, prompt, generatedAt: "2026-11-06T10:00:00.000Z" });
    expect((statSync(dir).mode & 0o777).toString(8)).toBe("700");
    expect(readdirSync(dir).sort()).toEqual(["manifest.json", ...TSUGUTE_SLOTS.map((s) => `${s.slot_id}.png`)].sort());
    for (const f of readdirSync(dir)) expect((statSync(join(dir, f)).mode & 0o777).toString(8), f).toBe("600");
    expect(manifest).toMatchObject({ status: "complete", stop_code: null, prompt_sha256: PIN, prompt_chars: 4133, approval_id: ID, demo_only: true, model: "gpt-6.1-sol" });
    expect(manifest.slots.map((s) => s.slot_id)).toEqual(TSUGUTE_SLOTS.map((s) => s.slot_id));
    expect(manifest.slots[0]!.sha256).toBe(sha(readFileSync(join(dir, "ph-ware.png"))));
    expect(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))).toEqual(manifest);
    // 1536×1024 cropped to 4:3 is 1365×1024: above ph-ware's 1.5× floor, below its 2× target
    expect(manifest.slots[0]).toMatchObject({ meets_floor_1_5x: true, meets_target_2x: false });
    expect(cropReaches({ width: 1024, height: 1024 }, "1:1", { width: 1250, height: 1250 })).toBe(false);
  });

  it("a stopped batch is recorded as stopped (the import refuses it)", async () => {
    const { manifest } = await writeTsugutePhotos({ outRoot: root, batch: batch(2, { stopCode: "CODEX_IMAGE_TOOL_FAILED", imageCalls: 3, imageFailed: 1 }), commit: COMMIT, prompt: "p", generatedAt: "2026-11-06T10:00:00.000Z" });
    expect(manifest).toMatchObject({ status: "stopped", stop_code: "CODEX_IMAGE_TOOL_FAILED" });
    const { manifest: few } = await writeTsugutePhotos({ outRoot: root, batch: batch(5), commit: COMMIT, prompt: "p", generatedAt: "2026-11-06T10:00:00.000Z" });
    expect(few).toMatchObject({ status: "stopped", stop_code: "CODEX_IMAGES_INCOMPLETE" });
  });
});

describe("DEV-185 rights: ai_generated_demo", () => {
  const FORBIDDEN = loadForbiddenSha256(REPO);
  const BYTES = colourPng(1600, 1200);
  const INFO = measurePhotoBytes(BYTES)!;
  const provenance = { generator: "codex-cli image_generation (owner WSL, sr-designgen jail, one run)", model: "gpt-6.1-sol", generated_at: "2026-11-06T10:00:00Z", prompt_sha256: PIN, approval_id: ID, demo_only: true };
  const record = (over: Record<string, unknown> = {}) => ({
    schema: "photo_rights_v0",
    asset_id: "photo-tsugute-ai-ware",
    sha256: INFO.sha256,
    bytes: INFO.bytes,
    width: INFO.width,
    height: INFO.height,
    format: "png",
    source_kind: "ai_generated_demo",
    owner: "Second Root (AI-generated demo)",
    license: `ai-generated demo, owner approval ${ID}`,
    paid: false,
    allowed_uses: { edit: true, crop: true, commercial: true, public_web: false },
    consent_record_ref: ID,
    received_at: "2026-11-06",
    expiry: null,
    private_path: ".intake/photos/tsugute-ai-ph-ware.png",
    depicts_identifiable_person: false,
    depicts_real_shop: false,
    ai_provenance: provenance,
    ...over,
  });
  const check = (r: unknown, o: { aiDemoAllowed?: boolean; purpose?: "public_site" } = {}) => checkPhotoRights(r, INFO, { now: "2026-11-07", forbiddenSha256: FORBIDDEN, aiDemoAllowed: true, ...o });
  const codes = (r: ReturnType<typeof check>) => (r.ok ? [] : r.codes);

  it("is accepted with its full provenance for a caller that allows AI demo pictures; the public record labels it a demo image", () => {
    const r = check(record());
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    const pub = toPublicPhotoRecord(r.record);
    expect(pub).toMatchObject({ source_kind: "ai_generated_demo", demo_image: true, ai_generated: true, label: AI_DEMO_PUBLIC_LABEL, prompt_sha256: PIN });
    expect(AI_DEMO_PUBLIC_LABEL).toMatch(/Not a real product, workshop or craftsperson/);
    expect(JSON.stringify(pub)).not.toContain(".intake");
  });

  it("is refused without provenance, with an incomplete one, or a non-demo flag", () => {
    const bare: Record<string, unknown> = record();
    delete bare.ai_provenance;
    expect(codes(check(bare))).toEqual(["RIGHTS_MISSING_AI_PROVENANCE"]);
    for (const k of ["generator", "model", "generated_at", "prompt_sha256", "approval_id", "demo_only"]) {
      const p: Record<string, unknown> = { ...provenance };
      delete p[k];
      expect(codes(check(record({ ai_provenance: p }))), k).toEqual(["RIGHTS_MISSING_AI_PROVENANCE"]);
    }
    expect(codes(check(record({ ai_provenance: { ...provenance, demo_only: false } })))).toEqual(["RIGHTS_MISSING_AI_PROVENANCE"]);
    expect(codes(check(record({ ai_provenance: { ...provenance, model: "unknown" } })))).toEqual(["RIGHTS_MISSING_AI_PROVENANCE"]);
    expect(codes(check(record({ ai_provenance: { ...provenance, generated_at: "2026-11-06" } })))).toEqual(["RIGHTS_MISSING_AI_PROVENANCE"]);
    expect(codes(check(record({ ai_provenance: { ...provenance, generated_at: "2026-12-01T00:00:00Z" } })))).toEqual(["AI_GENERATED_IN_FUTURE"]);
  });

  it("is refused by default (every other caller), for a public site, and provenance cannot dress up another kind", () => {
    expect(codes(checkPhotoRights(record(), INFO, { now: "2026-11-07", forbiddenSha256: FORBIDDEN }))).toEqual(["AI_DEMO_NOT_ALLOWED"]);
    expect(codes(check(record({ allowed_uses: { edit: true, crop: true, commercial: true, public_web: true }, client_confirmation_ref: "x" }), { purpose: "public_site" }))).toEqual(["AI_DEMO_NOT_FOR_PUBLIC_SITE"]);
    expect(codes(check(record({ source_kind: "owner_provided" })))).toEqual(["AI_PROVENANCE_ON_NON_AI_SOURCE"]);
  });

  it("keeps every other rights check", () => {
    const bad = check(record({ paid: true, depicts_identifiable_person: true, depicts_real_shop: true, allowed_uses: { edit: true, crop: false, commercial: true, public_web: false }, sha256: "0".repeat(64) }));
    expect(codes(bad).sort()).toEqual(["HASH_MISMATCH", "IDENTIFIABLE_PERSON", "NOT_ALLOWED_FOR_CROP", "PAID_SOURCE_NOT_APPROVED", "REAL_SHOP_DEPICTED"]);
  });
});

describe("DEV-185 intake → swap dry run with synthetic placeholder PNGs labelled as the AI kind", () => {
  let root: string;
  let pipeline: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "dev185-swap-"));
    pipeline = join(root, "pipeline");
    mkdirSync(join(pipeline, ".intake", "photos"), { recursive: true });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** a run dir as the one-shot run leaves it, with synthetic flat-colour PNGs at each slot's 2× target */
  async function runDir(name: string, over: Record<string, unknown> = {}) {
    const dir = join(root, name);
    mkdirSync(dir);
    const slots = [];
    for (const [i, s] of TSUGUTE_SLOTS.entries()) {
      const png = await sharp({ create: { width: s.target.width, height: s.target.height, channels: 3, background: { r: 40 * i, g: 120, b: 200 - 20 * i } } }).png().toBuffer();
      writeFileSync(join(dir, `${s.slot_id}.png`), png);
      slots.push({ slot_id: s.slot_id, file: `${s.slot_id}.png`, sha256: sha(png), bytes: png.length, width: s.target.width, height: s.target.height, format: "png", slot_prompt_sha256: slotPromptSha256(s), meets_floor_1_5x: true, meets_target_2x: true });
    }
    const manifest = { schema: "tsugute_ai_photos_v0", shop: "tsugute", demo_only: true, label: DEMO_LABEL, approval_id: ID, commit: COMMIT, prompt_sha256: PIN, prompt_chars: 4133, generator: GENERATOR, model: "gpt-6.1-sol", cli_version: "0.163.0", generated_at: "2026-11-06T10:00:00.000Z", status: "complete", stop_code: null, image_tool_calls: 6, image_tool_failed: 0, codex_ms: 1, slot_mapping: "call_order", slots, ...over };
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
    return dir;
  }

  it("imports a complete run as ai_generated_demo records and the d1-v10 swap accepts them (no render)", async () => {
    const from = await runDir("ok");
    const manifestOut = join(root, "swap-manifest.json");
    const r = importTsuguteAiPhotos({ from, manifestOut, pipelineRoot: pipeline });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect((statSync(manifestOut).mode & 0o777).toString(8)).toBe("600");
    expect(readdirSync(join(pipeline, ".intake", "photos")).sort()).toEqual(TSUGUTE_SLOTS.map((s) => `tsugute-ai-${s.slot_id}.png`).sort());
    const out = join(root, "swap-out");
    const res = await swapPage({ pageDir: "design-library/research/quality-pipeline/poc/tsugute/fidelity/d1-v10", manifest: JSON.parse(readFileSync(manifestOut, "utf8")), out, pipelineRoot: pipeline, now: "2026-11-07" });
    expect(res.ok, JSON.stringify(res.ok ? null : res.refusals)).toBe(true);
    if (!res.ok) return;
    const slots = res.summary.slots as Array<{ photos: Array<Record<string, unknown>> }>;
    for (const s of slots) expect(s.photos[0]).toMatchObject({ source_kind: "ai_generated_demo", demo_image: true, label: AI_DEMO_PUBLIC_LABEL });
    // a second import never overwrites the private copies
    const again = importTsuguteAiPhotos({ from, manifestOut: join(root, "swap-manifest-2.json"), pipelineRoot: pipeline });
    expect(again.ok).toBe(false);
  });

  it("refuses a stopped run, a missing model, a changed picture, and a manifest written inside the repository", async () => {
    const pr = join(root, "p2");
    mkdirSync(join(pr, ".intake", "photos"), { recursive: true });
    const codesOf = (r: ReturnType<typeof importTsuguteAiPhotos>) => (r.ok ? [] : r.codes);
    expect(codesOf(importTsuguteAiPhotos({ from: await runDir("stopped", { status: "stopped", stop_code: "CODEX_IMAGE_TOOL_FAILED" }), manifestOut: join(root, "m1.json"), pipelineRoot: pr }))).toContain("RUN_NOT_COMPLETE");
    expect(codesOf(importTsuguteAiPhotos({ from: await runDir("nomodel", { model: null }), manifestOut: join(root, "m2.json"), pipelineRoot: pr }))).toContain("MODEL_NOT_REPORTED");
    const changed = await runDir("changed");
    writeFileSync(join(changed, "ph-kake.png"), colourPng(1370, 1028));
    expect(codesOf(importTsuguteAiPhotos({ from: changed, manifestOut: join(root, "m3.json"), pipelineRoot: pr }))).toContain("FILE_MISMATCH:ph-kake");
    expect(codesOf(importTsuguteAiPhotos({ from: await runDir("inrepo"), manifestOut: join(REPO, "dev185-should-not-exist.json"), pipelineRoot: pr }))).toContain("MANIFEST_OUT_NOT_PRIVATE");
    expect(existsSync(join(REPO, "dev185-should-not-exist.json"))).toBe(false);
    // PR #227 M1: a hand-written manifest next to any 6 PNGs is not the approved run
    expect(codesOf(importTsuguteAiPhotos({ from: await runDir("prompt", { prompt_sha256: "b".repeat(64) }), manifestOut: join(root, "m4.json"), pipelineRoot: pr }))).toEqual(["RUN_PROMPT_NOT_APPROVED"]);
    expect(codesOf(importTsuguteAiPhotos({ from: await runDir("chars", { prompt_chars: 4134 }), manifestOut: join(root, "m5.json"), pipelineRoot: pr }))).toEqual(["RUN_PROMPT_NOT_APPROVED"]);
    expect(codesOf(importTsuguteAiPhotos({ from: await runDir("gen", { generator: "some other generator" }), manifestOut: join(root, "m6.json"), pipelineRoot: pr }))).toEqual(["RUN_GENERATOR_UNKNOWN"]);
    expect(codesOf(importTsuguteAiPhotos({ from: await runDir("label", { label: "real product photo" }), manifestOut: join(root, "m7.json"), pipelineRoot: pr }))).toEqual(["RUN_DEMO_LABEL_MISSING"]);
    const slotDir = await runDir("slotprompt");
    const mf = JSON.parse(readFileSync(join(slotDir, "manifest.json"), "utf8"));
    mf.slots[2].slot_prompt_sha256 = "c".repeat(64);
    writeFileSync(join(slotDir, "manifest.json"), JSON.stringify(mf));
    expect(codesOf(importTsuguteAiPhotos({ from: slotDir, manifestOut: join(root, "m8.json"), pipelineRoot: pr }))).toEqual(["SLOT_PROMPT_NOT_APPROVED:ph-hibi"]);
    expect(readdirSync(join(pr, ".intake", "photos"))).toEqual([]);
  });
});
