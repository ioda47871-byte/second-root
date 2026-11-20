import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { REASK_LINE, RUBRIC_SHA256 } from "@/lib/design-agent/imagefirst-worker/audit-rubric";
import { AuditRecord, deriveViewport } from "@/lib/design-agent/imagefirst-worker/audit-schema";
import { CLAUDE_PRINT_ARGS } from "@/lib/design-agent/imagefirst-worker/claude-cli";
import { auditIdCheck, AuditStop, DUMMY_AUDIT_ID, loadAuditMaterial, runClaudeAudit, type ClaudeAuditOptions } from "@/lib/design-agent/imagefirst-worker/claude-audit";
import { checkRealApprovalId } from "@/lib/design-agent/imagefirst-worker/cycle";
import { verifyPreviews } from "@/lib/design-agent/imagefirst-worker/preview";
import { DUMMY_ID, DUMMY_RECORD, runReviewPoc } from "@/lib/design-agent/imagefirst-worker/review-poc";
import { readFile } from "node:fs/promises";
import { answerTemplate, cleanupTemps, copyDelivered, fakeClaude, ID, makeDelivered, readLog, REPO, sha, tmp, treeHashes, type Delivered } from "./claude-audit-support";

// Issue #302: the IMAGE_FIRST design-image audit by the Claude CLI without Remote Control (claude-audit.ts), offline. A
// fake `claude` (a node script) stands in for the CLI; the bundle and previews are made by the real pack → inbox →
// previews path from harmless synthetic pictures. No real claude, no Codex, no model, no network.

vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });
let base: Delivered;
let material: Awaited<ReturnType<typeof loadAuditMaterial>>;
beforeAll(async () => {
  base = await makeDelivered();
  material = await loadAuditMaterial((rel) => readFile(join(REPO, rel)));
});
afterAll(cleanupTemps);

type Setup = { d: Delivered; home: string; bin: string; log: string; opts: ClaudeAuditOptions };
/** A fresh copy of the delivered fixture, a scratch HOME with the fake's settings, and the audit's options. */
function setup(cfg: Record<string, unknown> = {}, extra: Partial<ClaudeAuditOptions> = {}): Setup {
  const d = copyDelivered(base);
  const home = tmp("sr-audit-home-");
  const { bin, log } = fakeClaude(home, cfg);
  const env = { PATH: process.env.PATH, HOME: home, ANTHROPIC_API_KEY: "CANARY-key", ANTHROPIC_AUTH_TOKEN: "CANARY-token", ANTHROPIC_BASE_URL: "http://127.0.0.1:9", ANTHROPIC_OTHER: "CANARY-other", CLAUDE_CODE_OAUTH_TOKEN: "CANARY-oauth", CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "CANARY-refresh", OPENAI_API_KEY: "CANARY-openai" };
  const opts: ClaudeAuditOptions = { approvalId: d.id, runsDir: d.runs, stateDir: d.state, material, claudeBin: bin, env, jailIdle: async () => true, now: () => Date.parse("2026-11-20T02:00:00Z"), ...extra };
  return { d, home, bin, log, opts };
}
const refused = async (p: Promise<unknown>, code: string) => {
  const e = await p.then(() => null, (error: unknown) => error);
  expect(e).toBeInstanceOf(AuditStop);
  expect((e as AuditStop).code).toBe(code);
};
const auditDir = (s: Setup) => join(s.d.inbox, "audits", s.d.id);
const markerDir = (s: Setup) => join(s.d.state, "audits");
const readRecord = (s: Setup) => AuditRecord.parse(JSON.parse(readFileSync(join(auditDir(s), "audit.json"), "utf8")));
/** Nothing spent and nothing written: no claude process at all, no marker, no audit directory. */
const nothingSpent = (s: Setup) => {
  expect(readLog(s.log)).toEqual([]);
  expect(existsSync(markerDir(s))).toBe(false);
  expect(existsSync(join(s.d.inbox, "audits"))).toBe(false);
};
const previewsDir = (d: Delivered) => join(d.inbox, "previews", d.id);
const indexOf = (d: Delivered) => JSON.parse(readFileSync(join(previewsDir(d), "INDEX.json"), "utf8")) as { previews: { file: string; kind: string; source: string; preview_sha256: string; tile?: { index: number } }[] };
const git = (...a: string[]) => spawnSync("git", a, { cwd: REPO, encoding: "utf8" }).stdout;

describe("Issue #302: the Claude CLI audit, happy path", () => {
  it("one call per viewport, exactly the verified preview bytes, the no-tools flags, no credential in the child, a valid record with the verdict computed in code", async () => {
    const s = setup();
    const repoBefore = git("status", "--porcelain", "--untracked-files=all");
    const r = await runClaudeAudit(s.opts);
    expect(r).toMatchObject({ status: "completed", code: null, approval_id: s.d.id, bundle_sha256: s.d.bundleSha, verdict: "show_owner", calls: 2 });
    const log = readLog(s.log);
    expect(log.map((l) => l.bin)).toEqual(["auth", "claude", "claude"]);
    const calls = log.filter((l) => l.bin === "claude");
    expect(calls.map((c) => c.viewport)).toEqual(["desktop_1440", "mobile_390"]);
    // the decoded image bytes are the INDEX.json previews of each composite: overview first, then the tiles in order
    const ix = indexOf(s.d);
    const want = (src: string) => ix.previews.filter((p) => p.source === src).sort((a, b) => (a.kind === "overview" ? -1 : b.kind === "overview" ? 1 : (a.tile?.index ?? 0) - (b.tile?.index ?? 0)));
    const pc = want("composites/pc.png");
    expect(pc.length).toBe(7); // 1440 × 9000 → 6 tiles + 1 overview
    expect(calls[0]!.shas).toEqual(pc.map((p) => p.preview_sha256));
    expect(calls[1]!.shas).toEqual(want("composites/sp.png").map((p) => p.preview_sha256));
    for (const c of calls) {
      expect(c.argv).toEqual([...CLAUDE_PRINT_ARGS]);
      expect((c.argv as string[]).some((a) => /model/i.test(a))).toBe(false);
      expect(new Set(c.media as string[])).toEqual(new Set(["image/png"]));
    }
    for (const l of log) {
      expect(l.forbidden).toEqual([]);
      expect(l.envKeys).not.toContain("OPENAI_API_KEY");
      expect(String(l.cwd).startsWith(REPO)).toBe(false);
      expect(String(l.cwd).startsWith(s.d.state)).toBe(true);
      expect(existsSync(String(l.cwd))).toBe(false); // the empty cwd is removed afterwards
    }
    // the record: strict, bound to the bytes the worker attached, the verdict derived (the answer has no verdict)
    const rec = readRecord(s);
    expect(rec).toMatchObject({ status: "completed", stop_code: null, advisory_only: true, human_confirmed: false, registers_success_case: false, not_owner_evaluation: true });
    expect(rec.binding).toMatchObject({ approval_id: s.d.id, bundle_sha256: s.d.bundleSha, rubric_sha256: RUBRIC_SHA256, previews_index_sha256: sha(readFileSync(join(previewsDir(s.d), "INDEX.json"))) });
    expect(rec.binding.images.filter((i) => i.viewport === "desktop_1440").map((i) => i.preview_sha256)).toEqual(calls[0]!.shas);
    expect(rec.binding.images.filter((i) => i.viewport === "mobile_390").map((i) => i.preview_sha256)).toEqual(calls[1]!.shas);
    expect(rec.derived.desktop_1440).toEqual(deriveViewport(rec.viewports.desktop_1440!));
    expect(rec.derived.desktop_1440!.generic_patterns_seen).toEqual(["section_layout:grid_cards"]);
    expect(rec.auditor).toMatchObject({ via: "claude_cli_print_no_tools", model_reported: "fake-test-model", cli_version: "0.0.0-test", calls: 2, reasks: 0 });
    // private: 0700 directories, 0600 files; the one-use marker; AUDIT.md for the owner; nothing in the repository
    expect(statSync(auditDir(s)).mode & 0o777).toBe(0o700);
    expect(statSync(join(s.d.inbox, "audits")).mode & 0o777).toBe(0o700);
    for (const f of ["audit.json", "AUDIT.md"]) expect(statSync(join(auditDir(s), f)).mode & 0o777).toBe(0o600);
    expect(readdirSync(auditDir(s)).sort()).toEqual(["AUDIT.md", "audit.json"]);
    expect(readFileSync(join(auditDir(s), "AUDIT.md"), "utf8")).toMatch(/Advisory only\.[\s\S]*show_owner/);
    expect(readdirSync(markerDir(s))).toEqual([`${s.d.bundleSha}.${RUBRIC_SHA256}.used`]);
    expect(statSync(markerDir(s)).mode & 0o777).toBe(0o700);
    expect(git("status", "--porcelain", "--untracked-files=all")).toBe(repoBefore);
  });

  it("never touches claims, the ledger, the sealed bundle, the inbox copy, the previews or Codex (content hashes)", async () => {
    const s = setup();
    mkdirSync(join(s.d.state, "claims"), { mode: 0o700 });
    writeFileSync(join(s.d.state, "claims", `${s.d.id}.used`), JSON.stringify({ approval_id: s.d.id, claimed_at: "2026-11-20T01:00:00Z" }), { mode: 0o600 });
    const ledger = join(s.home, ".local", "state", "sr-design-worker", "phase2f-live");
    mkdirSync(join(ledger, "approvals"), { recursive: true, mode: 0o700 });
    writeFileSync(join(ledger, "approvals", "x.json"), "{}", { mode: 0o600 });
    // a codex on PATH that would record any start
    const bin = tmp("sr-audit-codex-");
    writeFileSync(join(bin, "codex"), `#!/bin/sh\necho started >> "${join(bin, "codex.log")}"\n`, { mode: 0o755 });
    s.opts.env = { ...s.opts.env, PATH: `${bin}:${process.env.PATH}` };
    const watch = [join(s.d.state, "claims"), join(s.d.state, "deliveries"), ledger, join(s.d.runs, "bundles"), join(s.d.inbox, s.d.id), join(s.d.inbox, "previews"), join(s.d.inbox, ".records")];
    const before = watch.map(treeHashes);
    expect((await runClaudeAudit(s.opts)).status).toBe("completed");
    expect(watch.map(treeHashes)).toEqual(before);
    expect(existsSync(join(bin, "codex.log"))).toBe(false);
    expect(readdirSync(s.d.state).sort()).toEqual(["audits", "claims", "deliveries"]); // the lock is released, no cwd left
  });

  it("a malformed answer gets ONE re-ask with the same bytes; the second answer is used", async () => {
    const s = setup({ modes: ["nojson"] });
    const r = await runClaudeAudit(s.opts);
    expect(r).toMatchObject({ status: "completed", calls: 3 });
    const calls = readLog(s.log).filter((l) => l.bin === "claude");
    expect(calls.map((c) => [c.viewport, c.reask])).toEqual([["desktop_1440", false], ["desktop_1440", true], ["mobile_390", false]]);
    expect(calls[1]!.shas).toEqual(calls[0]!.shas);
    expect(readRecord(s).auditor).toMatchObject({ calls: 3, reasks: 1 });
    expect(REASK_LINE).not.toMatch(/I could not decide/); // the answer is never echoed back
  });

  it("an answer that names its own verdict, an unknown image or a low score without a finding is not used", async () => {
    for (const mode of ["verdict", "badlabel", "incoherent"]) {
      const s = setup({ modes: [mode] });
      expect((await runClaudeAudit(s.opts)).status, mode).toBe("completed");
      expect(readLog(s.log).filter((l) => l.bin === "claude").map((c) => c.reask), mode).toEqual([false, true, false]);
    }
  });

  it("the verdict is computed in code: low scores → revise, a hard fail → drop (whatever the model thinks)", async () => {
    const low = setup({ answer: answerTemplate({ score: 3 }) });
    expect((await runClaudeAudit(low.opts)).verdict).toBe("revise");
    expect(readRecord(low).derived.desktop_1440!.low_criteria.length).toBe(5);
    const hard = setup({ answer: answerTemplate({ hit: "fabricated_text" }) });
    expect((await runClaudeAudit(hard.opts)).verdict).toBe("drop");
    expect(readRecord(hard).derived.mobile_390!.hard_fail_hits).toEqual(["fabricated_text"]);
  });

  it("--dry-run verifies and plans only: no claude process, no marker, nothing written", async () => {
    const s = setup({}, { dryRun: true });
    const r = await runClaudeAudit(s.opts);
    expect(r).toMatchObject({ status: "planned", calls: 0, dir: null });
    expect(r.plan.map((p) => [p.viewport, p.images])).toEqual([["desktop_1440", 7], ["mobile_390", 4]]); // SP 390 × 3120 → 3 tiles + 1 overview
    nothingSpent(s);
  });
});

describe("Issue #302: refusals before anything is spent", () => {
  it("a preview changed after delivery → PREVIEW_SHA_MISMATCH", async () => {
    const s = setup();
    const tile = indexOf(s.d).previews.find((p) => p.kind === "tile")!;
    const f = join(previewsDir(s.d), tile.file);
    const b = readFileSync(f);
    b[b.length - 20] ^= 0xff;
    chmodSync(f, 0o600);
    writeFileSync(f, b);
    await refused(runClaudeAudit(s.opts), "PREVIEW_SHA_MISMATCH");
    nothingSpent(s);
  });

  it("the inbox bundle changed → BUNDLE_UNVERIFIED", async () => {
    const s = setup();
    const f = join(s.d.inbox, s.d.id, "parts", "pc-1.png");
    const b = readFileSync(f);
    b[100] ^= 0xff;
    writeFileSync(f, b);
    await refused(runClaudeAudit(s.opts), "BUNDLE_UNVERIFIED");
    nothingSpent(s);
  });

  it("symlinks are refused, never followed (previews directory, one preview file, the bundle directory)", async () => {
    const a = setup();
    renameSync(previewsDir(a.d), `${previewsDir(a.d)}-real`);
    symlinkSync(`${previewsDir(a.d)}-real`, previewsDir(a.d));
    await refused(runClaudeAudit(a.opts), "PREVIEWS_DIR_UNSAFE");
    nothingSpent(a);
    const b = setup();
    const file = join(previewsDir(b.d), indexOf(b.d).previews[0]!.file);
    renameSync(file, join(b.d.work, "moved.png"));
    symlinkSync(join(b.d.work, "moved.png"), file);
    await refused(runClaudeAudit(b.opts), "PREVIEW_FILE_SET_MISMATCH");
    nothingSpent(b);
    const c = setup();
    renameSync(join(c.d.inbox, c.d.id), join(c.d.work, "bundle-real"));
    symlinkSync(join(c.d.work, "bundle-real"), join(c.d.inbox, c.d.id));
    await refused(runClaudeAudit(c.opts), "BUNDLE_UNVERIFIED");
    nothingSpent(c);
  });

  it("not delivered: no receiver record, a delivery job not delivered or for other bytes, no previews", async () => {
    const a = setup();
    rmSync(join(a.d.inbox, ".records", `${a.d.id}.json`));
    await refused(runClaudeAudit(a.opts), "AUDIT_NOT_DELIVERED");
    nothingSpent(a);
    const b = setup();
    const jobPath = join(b.d.state, "deliveries", `${b.d.id}.json`);
    const job = JSON.parse(readFileSync(jobPath, "utf8")) as Record<string, unknown>;
    writeFileSync(jobPath, JSON.stringify({ ...job, state: "sealed" }));
    await refused(runClaudeAudit(b.opts), "AUDIT_NOT_DELIVERED");
    writeFileSync(jobPath, JSON.stringify({ ...job, bundle_sha256: "f".repeat(64) }));
    await refused(runClaudeAudit(b.opts), "DELIVERY_MISMATCH");
    rmSync(jobPath);
    await refused(runClaudeAudit(b.opts), "AUDIT_NOT_DELIVERED");
    nothingSpent(b);
    const c = setup();
    rmSync(previewsDir(c.d), { recursive: true });
    await refused(runClaudeAudit(c.opts), "AUDIT_NOT_DELIVERED");
    nothingSpent(c);
    const e = setup();
    await refused(runClaudeAudit({ ...e.opts, approvalId: "hoshigama-imagefirst-d3-20261121-01" }), "AUDIT_NOT_DELIVERED");
    nothingSpent(e);
  });

  it("the jailed Claude active or unknown → JAIL_ACTIVE / JAIL_STATE_UNKNOWN (they share ~/.claude)", async () => {
    const a = setup({}, { jailIdle: async () => false });
    await refused(runClaudeAudit(a.opts), "JAIL_ACTIVE");
    nothingSpent(a);
    const b = setup({}, { jailIdle: async () => null });
    await refused(runClaudeAudit(b.opts), "JAIL_STATE_UNKNOWN");
    const c = setup({}, { jailIdle: () => Promise.reject(new Error("x")) });
    await refused(runClaudeAudit(c.opts), "JAIL_STATE_UNKNOWN");
    nothingSpent(c);
  });

  it("an API-key login or no login → refused after `auth status` only: no call, no marker", async () => {
    for (const [auth, code] of [["apikey", "CLAUDE_API_KEY_AUTH"], ["signedout", "CLAUDE_NOT_SIGNED_IN"], ["garbled", "CLAUDE_NOT_SIGNED_IN"]] as const) {
      const s = setup({ auth });
      await refused(runClaudeAudit(s.opts), code);
      expect(readLog(s.log).map((l) => l.bin)).toEqual(["auth"]);
      expect(existsSync(markerDir(s))).toBe(false);
      expect(existsSync(join(s.d.inbox, "audits"))).toBe(false);
    }
  });

  it("over the per-call limits → AUDIT_INPUT_TOO_LARGE, never shrunk, nothing spent", async () => {
    const a = setup({}, { limits: { maxImages: 6, maxBytes: 18 * 1024 * 1024 } });
    await refused(runClaudeAudit(a.opts), "AUDIT_INPUT_TOO_LARGE");
    nothingSpent(a);
    const b = setup({}, { limits: { maxImages: 20, maxBytes: 4096 } });
    await refused(runClaudeAudit(b.opts), "AUDIT_INPUT_TOO_LARGE");
    nothingSpent(b);
    // a caller may only lower the limits
    const c = setup({}, { limits: { maxImages: 999, maxBytes: 999 * 1024 * 1024 }, dryRun: true });
    expect((await runClaudeAudit(c.opts)).status).toBe("planned");
  });

  it("a second run is blocked by the one-use marker (and the audit is never overwritten)", async () => {
    const s = setup();
    expect((await runClaudeAudit(s.opts)).status).toBe("completed");
    const first = readFileSync(join(auditDir(s), "audit.json"));
    await refused(runClaudeAudit(s.opts), "AUDIT_EXISTS");
    rmSync(auditDir(s), { recursive: true });
    const calls = readLog(s.log).length;
    await refused(runClaudeAudit(s.opts), "AUDIT_ALREADY_SPENT");
    expect(readLog(s.log).length).toBe(calls);
    // the owner removes the marker (and the audit directory) by hand: then one more audit may spend
    rmSync(markerDir(s), { recursive: true });
    expect((await runClaudeAudit(s.opts)).status).toBe("completed");
    expect(readFileSync(join(auditDir(s), "audit.json")).equals(first)).toBe(true);
  });

  it("the worker's lock held → AUDIT_LOCKED", async () => {
    const s = setup();
    writeFileSync(join(s.d.state, "imagefirst.lock"), JSON.stringify({ token: "t", pid: process.pid, at: new Date().toISOString() }), { mode: 0o600 });
    const live = { ...s.opts };
    delete live.now; // the lock's age is measured on the real clock
    await refused(runClaudeAudit(live), "AUDIT_LOCKED");
    nothingSpent(s);
  });
});

describe("Issue #302: failures after the marker are recorded and stop (no retry)", () => {
  const stopped = async (cfg: Record<string, unknown>, code: string, calls: number, extra: Partial<ClaudeAuditOptions> = {}) => {
    const s = setup(cfg, extra);
    const r = await runClaudeAudit(s.opts);
    expect(r).toMatchObject({ status: "stopped", code, verdict: null, calls });
    expect(readLog(s.log).filter((l) => l.bin === "claude").length).toBe(calls);
    const rec = readRecord(s);
    expect(rec).toMatchObject({ status: "stopped", stop_code: code, advisory_only: true, human_confirmed: false });
    expect(rec.derived.verdict).toBeNull();
    expect(readdirSync(markerDir(s)).length).toBe(1); // spent: a re-run needs the owner
    return { s, rec };
  };
  it("an expired login in the call → CLAUDE_NOT_SIGNED_IN", () => stopped({ mode: "expired" }, "CLAUDE_NOT_SIGNED_IN", 1));
  it("quota → CLAUDE_QUOTA, no re-ask", () => stopped({ mode: "quota" }, "CLAUDE_QUOTA", 1));
  it("timeout → CLAUDE_TIMEOUT", () => stopped({ mode: "sleep" }, "CLAUDE_TIMEOUT", 1, { timeoutMs: 5_000 }));
  it("a crash (even with 401 in a line number) → CLAUDE_EXEC_FAILED", async () => {
    await stopped({ mode: "broken" }, "CLAUDE_EXEC_FAILED", 1);
    await stopped({ mode: "line401" }, "CLAUDE_EXEC_FAILED", 1);
  });
  it("malformed twice → AUDIT_SCHEMA after exactly one re-ask", async () => {
    const { s, rec } = await stopped({ mode: "nojson" }, "AUDIT_SCHEMA", 2);
    expect(readLog(s.log).filter((l) => l.bin === "claude").map((c) => c.reask)).toEqual([false, true]);
    expect(rec.viewports).toEqual({ desktop_1440: null, mobile_390: null });
  });
  it("the second viewport failing keeps the first viewport's answer in the stopped record", async () => {
    const { rec } = await stopped({ modes: ["ok", "quota"] }, "CLAUDE_QUOTA", 2);
    expect(rec.viewports.desktop_1440).not.toBeNull();
    expect(rec.viewports.mobile_390).toBeNull();
  });
  it("a stop requested during a call → CLAUDE_ABORTED recorded (the child group is stopped)", async () => {
    const ac = new AbortController();
    const s = setup({ mode: "sleep" }, { signal: ac.signal });
    const p = runClaudeAudit(s.opts);
    // abort once the call has started (never during `auth status`, whatever the machine's load)
    const t = setInterval(() => {
      if (readLog(s.log).some((l) => l.bin === "claude")) {
        clearInterval(t);
        ac.abort();
      }
    }, 50);
    expect(await p).toMatchObject({ status: "stopped", code: "CLAUDE_ABORTED", calls: 1 });
    clearInterval(t);
    expect(readRecord(s).stop_code).toBe("CLAUDE_ABORTED");
  });

  it("a stop requested before anything → AUDIT_ABORTED, nothing spent", async () => {
    const ac = new AbortController();
    ac.abort();
    const s = setup({}, { signal: ac.signal });
    await refused(runClaudeAudit(s.opts), "AUDIT_ABORTED");
    nothingSpent(s);
  });
});

describe("Issue #302: the dummy id, consistent with the review delivery", () => {
  it("the reserved dummy id is refused like deliver-review does, accepted only with dummy: true (and the dummy only)", async () => {
    expect(DUMMY_AUDIT_ID).toBe(DUMMY_ID);
    for (const id of [DUMMY_ID, "hoshigama-imagefirst-d3-20261120-01", "hoshigama-imagefirst-d3-20260230-01", "hoshigama-imagefirst-d3-19991231-01", "x", "hoshigama-imagefirst-d3-20261120-1"]) expect(auditIdCheck(id, false), id).toBe(checkRealApprovalId(id));
    const work = tmp("sr-audit-poc-");
    const runs = join(work, "sr-runs");
    mkdirSync(runs, { mode: 0o700 });
    const poc = await runReviewPoc({ workDir: work, inboxDir: join(runs, "review-inbox") });
    expect(poc.delivery.state).toBe("delivered");
    expect((await verifyPreviews(join(runs, "review-inbox", "previews", DUMMY_ID))).plan_id).toBe(DUMMY_RECORD.plan_id);
    const home = tmp("sr-audit-poc-home-");
    const { bin, log } = fakeClaude(home, {});
    const state = join(work, "audit-state");
    const opts: ClaudeAuditOptions = { approvalId: DUMMY_ID, runsDir: runs, stateDir: state, material, claudeBin: bin, env: { PATH: process.env.PATH, HOME: home }, jailIdle: async () => true };
    await refused(runClaudeAudit(opts), "APPROVAL_ID_RESERVED");
    await refused(runClaudeAudit({ ...opts, approvalId: "hoshigama-imagefirst-d3-20261120-01", dummy: true }), "DUMMY_ID_REQUIRED");
    expect(readLog(log)).toEqual([]);
    const r = await runClaudeAudit({ ...opts, dummy: true });
    expect(r).toMatchObject({ status: "completed", approval_id: DUMMY_ID, calls: 2 });
    // the dummy's PC composite (1440 × 4800) → 4 tiles + overview; SP (390 × 3120) → 3 tiles + overview
    expect(readLog(log).filter((l) => l.bin === "claude").map((c) => (c.shas as string[]).length)).toEqual([5, 4]);
  });
});

describe("Issue #302: the CLI as a process (fake claude and systemctl in test mode only)", () => {
  const CLI = join(REPO, "scripts/sales-design-worker/imagefirst-audit.ts");
  const run = (args: string[], env: Record<string, string>) => {
    const r = spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], { cwd: REPO, encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env } as unknown as NodeJS.ProcessEnv, timeout: 100_000 });
    const lines = r.stdout.trim().split("\n").filter(Boolean);
    return { status: r.status, lines, out: JSON.parse(lines[lines.length - 1] ?? "null") as Record<string, unknown> | null };
  };
  /** A HOME with the delivered fixture at ~/sr-runs and the worker's state at $XDG_STATE_HOME/sr-design-worker/imagefirst-worker. */
  const homeWith = (cfg: Record<string, unknown> = {}) => {
    const d = copyDelivered(base);
    const home = d.work;
    const xdg = join(home, ".local", "state");
    mkdirSync(join(xdg, "sr-design-worker"), { recursive: true, mode: 0o700 });
    renameSync(d.state, join(xdg, "sr-design-worker", "imagefirst-worker"));
    const { bin, log } = fakeClaude(home, cfg);
    const sys = join(tmp("sr-audit-sys-"), "systemctl");
    writeFileSync(sys, `#!/bin/sh\nif [ "$1" = show ]; then echo inactive; else echo disabled; fi\n`, { mode: 0o755 });
    return { d, home, bin, log, env: { HOME: home, XDG_STATE_HOME: xdg, SR_IMAGEFIRST_AUDIT_TEST_MODE: "1", SR_IMAGEFIRST_AUDIT_CLAUDE_BIN: bin, SR_IMAGEFIRST_AUDIT_SYSTEMCTL: sys } };
  };

  it("usage errors exit 2", () => {
    const h = tmp("sr-audit-cli-");
    for (const args of [[], ["a", "b"], ["--dry-run", "--dry-run", ID]]) expect(run(args, { HOME: h }).out).toEqual({ status: "refused", code: "USAGE" });
  });

  it("dry run: the plan, exit 0, no claude process; a real run prints codes, counts and the verdict only (no findings text)", () => {
    const h = homeWith();
    const dry = run([h.d.id, "--dry-run"], h.env);
    expect(dry.status).toBe(0);
    expect(dry.out).toMatchObject({ status: "planned", approval_id: h.d.id, bundle_sha256: h.d.bundleSha, calls: 0 });
    expect(readLog(h.log)).toEqual([]);
    const real = run([h.d.id], h.env);
    expect(real.status).toBe(0);
    expect(real.lines.length).toBe(1);
    expect(real.out).toMatchObject({ status: "completed", verdict: "show_owner", calls: 2 });
    expect(real.lines[0]).not.toMatch(/login|reason|problem|suggestion/);
    expect(existsSync(join(h.home, "sr-runs", "review-inbox", "audits", h.d.id, "audit.json"))).toBe(true);
    const again = run([h.d.id], h.env);
    expect(again).toMatchObject({ status: 2, out: { status: "refused", code: "AUDIT_EXISTS" } });
  });

  it("the fake binary and systemctl are ignored outside test mode; the dummy id needs --dummy", () => {
    const h = homeWith();
    const off = run([h.d.id, "--dry-run"], { ...h.env, SR_IMAGEFIRST_AUDIT_TEST_MODE: "0" });
    // the real /usr/bin/systemctl (absent, or no such unit here) cannot say the jail is idle → refused before anything
    expect(off.status).toBe(2);
    expect(["JAIL_STATE_UNKNOWN", "JAIL_ACTIVE"]).toContain(off.out?.code);
    expect(run([DUMMY_ID], h.env).out).toMatchObject({ status: "refused", code: "APPROVAL_ID_RESERVED" });
    expect(readLog(h.log)).toEqual([]);
  });

  it("a stopped audit exits 1 with the fixed code", () => {
    const h = homeWith({ mode: "quota" });
    const r = run([h.d.id], h.env);
    expect(r).toMatchObject({ status: 1, out: { status: "stopped", code: "CLAUDE_QUOTA" } });
  });
});
