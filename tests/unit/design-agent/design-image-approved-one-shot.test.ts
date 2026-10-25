import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildMockupPrompt, loadPocInputs } from "../../../lib/design-agent/design-image/prompt";

const repo = process.cwd();
const worker = join(repo, "scripts/sales-design-worker/design-image-poc.sh");
const entry = join(repo, "scripts/sales-design-worker/run-wagashi-a-v4-once.sh");
const pin = "4e34f760ccde3f28df58316e9b55e6d21d6ac78d397bf770f6295fb1699157d9";

describe("DEV-110 owner-approved v4 entrypoint (offline)", () => {
  it("pins the exact reviewed v4 prompt by sha256 and UTF-16 character count", async () => {
    const prompt = buildMockupPrompt(await loadPocInputs(repo, "v4"));
    expect(prompt.length).toBe(4714);
    expect(createHash("sha256").update(prompt, "utf8").digest("hex")).toBe(pin);
    expect(prompt.length === 4714 && createHash("sha256").update(prompt).digest("hex") === pin).toBe(true);
    expect(createHash("sha256").update(prompt + "!").digest("hex")).not.toBe(pin);
    expect(createHash("sha256").update(prompt).digest("hex")).not.toBe("0".repeat(64));
    expect(prompt.length).not.toBe(4715);
  });

  it("runs the actual model-free PoC pin probe without approval, and refuses an incorrect pin", () => {
    const tsx = join(repo, "node_modules/.bin/tsx");
    const args = ["--no-cache", join(repo, "scripts/sales-design-worker/design-image-poc.ts"), "--check-pin-only"];
    const run = (sha: string) => spawnSync(tsx, args, {
      cwd: repo,
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...process.env,
        SR_DESIGN_IMAGE_POC_DIRECTION: "v4",
        SR_POC_EXPECTED_SHA: sha,
        SR_POC_EXPECTED_CHARS: "4714",
        SR_DESIGN_IMAGE_POC_LOCKED: "run.lock",
      },
    });
    const good = run(pin);
    expect(good.status, good.stdout + good.stderr).toBe(0);
    expect(good.stdout).toContain("POC_PIN_OK");
    const bad = run("0".repeat(64));
    expect(bad.status, bad.stdout + bad.stderr).toBe(23);
    expect(bad.stdout).toContain("POC_PIN_MISMATCH");
  });

  it("refuses a v4 invocation without a full approval pin BEFORE any preflight or Codex", () => {
    const test = (args: string[], env: Record<string, string>) =>
      spawnSync("bash", [worker, ...args], {
        cwd: repo,
        encoding: "utf8",
        env: { ...process.env, SR_DESIGN_IMAGE_POC_DIRECTION: "v4", ...env },
        timeout: 5000,
      });
    for (const args of [
      [],
      ["--human-approval-confirmed"],
      ["--human-approval-confirmed", "--expected-prompt-sha256", pin],
      ["--human-approval-confirmed", "--expected-prompt-sha256", pin, "--expected-prompt-chars", "4714"],
      ["--human-approval-confirmed", "--expected-prompt-sha256", pin, "--expected-prompt-chars", "4714", "--approval-id", "once-123"],
      ["--human-approval-confirmed", "--expected-prompt-sha256", "wrong", "--expected-prompt-chars", "4714", "--approval-id", "once-123"],
      ["--human-approval-confirmed", "--expected-prompt-sha256", pin, "--expected-prompt-chars", "4714", "--approval-id", "../escape"],
    ]) {
      const run = test(args, {});
      expect(run.status, run.stderr).not.toBe(0);
      expect(run.stdout).toMatch(/STOP:/);
      expect(run.stdout).not.toMatch(/== 1\. resource preflight|== 4\. design-image PoC/);
    }
  });

  it("the one-shot entry is fixed to the owner-approved v4 ID and cannot run outside the jail", () => {
    const body = readFileSync(entry, "utf8");
    expect(body).toContain("--approval-id wagashi-a-v4-20261025-01");
    expect(body).toContain("--expected-prompt-sha256 " + pin);
    expect(body).toContain("--expected-prompt-chars 4714");
    expect(body).toContain("SR_DESIGN_WORKER_NO_UPDATE=1");
    expect(body).toContain('--expected-commit "$REVIEWED_COMMIT"');
    expect(body).toContain("REVIEWED_COMMIT");
    expect(body).toContain("SR_CLAUDE_JAIL_REQUIRED");
    expect(body).toContain("0::/system.slice/sr-jail-claude.service");
    const run = spawnSync("bash", [entry, "--human-approval-confirmed", "--expected-commit", "9b79163825368d53bc066693b03cc21f7702b67d"], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, USER: "not-sr-designgen", HOME: "/tmp" },
      timeout: 5000,
    });
    expect(run.status).not.toBe(0);
    expect(run.stdout).toMatch(/sr-designgen user required/);
  });

  it("pin check precedes approval consumption, which precedes the existing one-call PoC", () => {
    const body = readFileSync(worker, "utf8");
    const check = body.indexOf('design-image-poc.ts" --check-pin-only');
    const marker = body.indexOf('mkdir -m 0700 "$LEDGER/$APPROVAL_ID"');
    const codex = body.indexOf('SR_DESIGN_IMAGE_POC_LOCKED=run.lock timeout');
    expect(check).toBeGreaterThan(0);
    expect(marker).toBeGreaterThan(check);
    expect(codex).toBeGreaterThan(marker);
    expect(body).toContain('POC_APPROVAL_ALREADY_USED');
    expect(body).toContain('POC_PIN_MISMATCH_OR_CHECK_ERROR');
    expect(body).toContain('POC_COMMIT_PIN_MISMATCH');
    expect(body).toContain('git status --porcelain --untracked-files=all');
    expect(body).toContain('POC_NO_UPDATE_REQUIRED');
    const verification = readFileSync(join(repo, "scripts/sales-design-worker/design-image-poc.ts"), "utf8");
    expect(verification).toContain('loadPocInputs(REPO, directionVersion)');
    expect(verification).toContain('buildMockupPrompt');
    expect(verification).toContain('createHash("sha256")');
    expect(verification).toContain('POC_PIN_OK');
    expect(verification).not.toContain('codex exec');
  });
});


/** Execute the real shell gate with all external tools replaced by offline fakes. */
describe("DEV-110 safety gate with fake Git and zero Codex calls", () => {
  const commit = "9b79163825368d53bc066693b03cc21f7702b67d";
  const args = [
    "--human-approval-confirmed", "--expected-prompt-sha256", pin,
    "--expected-prompt-chars", "4714", "--expected-commit", commit,
    "--approval-id", "wagashi-a-v4-20261025-01",
  ];
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), "sr-dev110-"));
    const tools = join(root, "bin");
    const repoDir = join(root, "repo");
    const home = join(root, "home");
    mkdirSync(tools);
    mkdirSync(home);
    mkdirSync(join(repoDir, "scripts/ops"), { recursive: true });
    mkdirSync(join(repoDir, "scripts/sales-design-worker"), { recursive: true });
    mkdirSync(join(repoDir, "node_modules/.bin"), { recursive: true });
    cpSync(worker, join(repoDir, "scripts/sales-design-worker/design-image-poc.sh"));
    writeFileSync(join(repoDir, "scripts/sales-design-worker/design-image-poc.ts"), "// fake\n");
    writeFileSync(join(repoDir, "scripts/ops/wsl-resource-preflight.sh"), "#!/bin/bash\nexit 0\n");
    const git = join(tools, "git");
    writeFileSync(git, [
      "#!/bin/bash",
      'case "$*" in',
      '  "rev-parse --short=12 HEAD") head -c 12 git-head; echo ;;',
      '  "rev-parse HEAD") cat git-head ;;',
      '  "rev-parse origin/develop") cat git-origin ;;',
      '  "status --porcelain --untracked-files=all") [ -f git-dirty ] && echo " M dirty" || true ;;',
      '  *) echo "unexpected git $*" >&2; exit 77 ;;',
      'esac',
      "",
    ].join("\n"));
    chmodSync(git, 0o755);
    writeFileSync(join(repoDir, "git-head"), commit + "\n");
    writeFileSync(join(repoDir, "git-origin"), commit + "\n");
    const fakeTsx = join(repoDir, "node_modules/.bin/tsx");
    writeFileSync(fakeTsx, [
      "#!/bin/bash",
      'if [[ "$*" == *"--check-pin-only"* ]]; then',
      '  if [ "$SR_POC_EXPECTED_SHA" != "' + pin + '" ] || [ "$SR_POC_EXPECTED_CHARS" != "4714" ]; then exit 23; fi',
      '  echo "POC_PIN_OK fake"; exit 0',
      'fi',
      'echo "FAKE_MODEL_INVOKED" >> "$HOME/fake-count"',
      'echo "FAKE_DONE"; exit 0',
      "",
    ].join("\n"));
    chmodSync(fakeTsx, 0o755);
    const exec = (extra: string[] = [], override: Record<string, string> = {}) =>
      spawnSync("bash", [join(repoDir, "scripts/sales-design-worker/design-image-poc.sh"), ...args, ...extra], {
        cwd: repoDir, encoding: "utf8", timeout: 7000,
        env: {
          ...process.env, HOME: home,
          PATH: tools + ":" + (process.env.PATH ?? "/usr/bin:/bin"),
          SR_DESIGN_IMAGE_POC_DIRECTION: "v4",
          SR_DESIGN_WORKER_NO_UPDATE: "1",
          SR_DESIGN_WORKER_REF: "develop",
          ...override,
        },
      });
    return { root, home, repoDir, exec, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }
  it("wrong commit, dirty checkout, NO_UPDATE=0 and wrong SHA refuse before reserving approval", () => {
    const f = fixture();
    try {
      const receipt = join(f.home, ".local/state/sr-design-worker/poc-approval-used/wagashi-a-v4-20261025-01");
      writeFileSync(join(f.repoDir, "git-head"), "f".repeat(40) + "\n");
      expect(f.exec().status).toBe(26);
      expect(existsSync(receipt)).toBe(false);
      writeFileSync(join(f.repoDir, "git-head"), commit + "\n");
      writeFileSync(join(f.repoDir, "git-dirty"), "");
      expect(f.exec().status).toBe(26);
      expect(existsSync(receipt)).toBe(false);
      rmSync(join(f.repoDir, "git-dirty"));
      expect(f.exec([], { SR_DESIGN_WORKER_NO_UPDATE: "0" }).status).toBe(26);
      expect(existsSync(receipt)).toBe(false);
      // The fake TSX refuses any SHA other than the pinned prompt.
      const badArgs = [...args]; badArgs[2] = "0".repeat(64);
      const run = spawnSync("bash", [
        join(f.repoDir, "scripts/sales-design-worker/design-image-poc.sh"), ...badArgs,
      ], {
        cwd: f.repoDir, encoding: "utf8", timeout: 7000,
        env: {
          ...process.env, HOME: f.home, PATH: join(f.root, "bin") + ":" + (process.env.PATH ?? "/usr/bin:/bin"),
          SR_DESIGN_IMAGE_POC_DIRECTION: "v4", SR_DESIGN_WORKER_NO_UPDATE: "1",
        },
      });
      expect(run.status, run.stdout + run.stderr).toBe(2);
      expect(run.stdout).toContain("POC_V4_APPROVAL_SCOPE_MISMATCH");
      expect(existsSync(receipt)).toBe(false);
    } finally { f.cleanup(); }
  });
  it("one completed offline fake can reserve only once; replay never reaches the fake model", () => {
    const f = fixture();
    try {
      const first = f.exec();
      expect(first.status, first.stdout + first.stderr).toBe(0);
      expect(first.stdout).toContain("POC_APPROVAL_RESERVED");
      const counter = join(f.home, "fake-count");
      expect(readFileSync(counter, "utf8").trim().split("\n")).toHaveLength(1);
      const second = f.exec();
      expect(second.status, second.stdout + second.stderr).toBe(25);
      expect(second.stdout).toContain("POC_APPROVAL_ALREADY_USED");
      expect(readFileSync(counter, "utf8").trim().split("\n")).toHaveLength(1);
    } finally { f.cleanup(); }
  });
});
