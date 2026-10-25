import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
