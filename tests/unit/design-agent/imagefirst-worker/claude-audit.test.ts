import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { REASK_LINE, RUBRIC_SHA256 } from "@/lib/design-agent/imagefirst-worker/audit-rubric";
import { AuditRecord, deriveViewport } from "@/lib/design-agent/imagefirst-worker/audit-schema";
import { CLAUDE_AUTH_STATUS_ARGS, CLAUDE_PRINT_ARGS } from "@/lib/design-agent/imagefirst-worker/claude-cli";
import { AUDIT_LIMITS, AUDIT_TIER, auditIdCheck, AuditStop, auditTierOf, DUMMY_AUDIT_ID, loadAuditMaterial, runClaudeAudit, type ClaudeAuditOptions } from "@/lib/design-agent/imagefirst-worker/claude-audit";
import { checkRealApprovalId } from "@/lib/design-agent/imagefirst-worker/cycle";
import { verifyPreviews } from "@/lib/design-agent/imagefirst-worker/preview";
import { DUMMY_ID, DUMMY_RECORD, runReviewPoc } from "@/lib/design-agent/imagefirst-worker/review-poc";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { answerTemplate, cleanupTemps, copyDelivered, fakeClaude, ID, makeDelivered, photoLikeComposite, readLog, REPO, sha, tmp, treeHashes, type Delivered } from "./claude-audit-support";

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
type IxEntry = { file: string; kind: string; source: string; preview_sha256: string; bytes: number; width: number; height: number; tile?: { index: number } };
const indexOf = (d: Delivered) => JSON.parse(readFileSync(join(previewsDir(d), "INDEX.json"), "utf8")) as { previews: IxEntry[] };
const git = (...a: string[]) => spawnSync("git", a, { cwd: REPO, encoding: "utf8" }).stdout;
/** PR #311 review L7: the repository paths this change's code could ever write to (a fixed set; parallel tests elsewhere cannot flake it). */
const repoOwn = () => git("status", "--porcelain", "--untracked-files=all", "--", "lib/design-agent/imagefirst-worker", "scripts/sales-design-worker", "design-library", "docs/operations");
/** The composite's previews in send order: overview first, then the tiles. */
const inOrder = (ix: { previews: IxEntry[] }, src: string) => ix.previews.filter((p) => p.source === src).sort((a, b) => (a.kind === "overview" ? -1 : b.kind === "overview" ? 1 : (a.tile?.index ?? 0) - (b.tile?.index ?? 0)));

describe("Issue #302: the Claude CLI audit, happy path", () => {
  it("one call per viewport, exactly the verified preview bytes, the no-tools flags, no credential in the child, a valid record with the verdict computed in code", async () => {
    const s = setup();
    const repoBefore = repoOwn();
    const r = await runClaudeAudit(s.opts);
    expect(r).toMatchObject({ status: "completed", code: null, approval_id: s.d.id, bundle_sha256: s.d.bundleSha, verdict: "show_owner", calls: 2 });
    const log = readLog(s.log);
    expect(log.map((l) => l.bin)).toEqual(["auth", "claude", "claude"]);
    const calls = log.filter((l) => l.bin === "claude");
    expect(calls.map((c) => c.viewport)).toEqual(["desktop_1440", "mobile_390"]);
    // the decoded image bytes are the audit tier of the INDEX.json previews of each composite, overview first, then the
    // tiles in order: recomputed here from the preview files (same pixels and size, deterministic)
    const ix = indexOf(s.d);
    const pc = inOrder(ix, "composites/pc.png");
    const sp = inOrder(ix, "composites/sp.png");
    expect(pc.length).toBe(7); // 1440 × 9000 → 6 tiles + 1 overview
    const tierShas = async (list: IxEntry[]) => Promise.all(list.map(async (p) => sha((await auditTierOf(readFileSync(join(previewsDir(s.d), p.file)), p.width, p.height)).bytes)));
    expect(calls[0]!.shas).toEqual(await tierShas(pc));
    expect(calls[1]!.shas).toEqual(await tierShas(sp));
    for (const c of calls) {
      expect(c.argv).toEqual([...CLAUDE_PRINT_ARGS]);
      expect((c.argv as string[]).some((a) => /model/i.test(a))).toBe(false);
      expect(new Set(c.media as string[])).toEqual(new Set([AUDIT_TIER.mediaType]));
    }
    expect(log[0]!.argv).toEqual(["--setting-sources", "", "auth", "status"]);
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
    expect(rec.binding).toMatchObject({ approval_id: s.d.id, bundle_sha256: s.d.bundleSha, rubric_sha256: RUBRIC_SHA256, audit_tier: AUDIT_TIER.id, previews_index_sha256: sha(readFileSync(join(previewsDir(s.d), "INDEX.json"))) });
    // each image: the verified preview's SHA (INDEX.json) and the SHA of the audit-tier bytes that were sent
    const of = (vp: string) => rec.binding.images.filter((i) => i.viewport === vp);
    expect(of("desktop_1440").map((i) => i.preview_sha256)).toEqual(pc.map((p) => p.preview_sha256));
    expect(of("desktop_1440").map((i) => i.audit_sha256)).toEqual(calls[0]!.shas);
    expect(of("mobile_390").map((i) => i.preview_sha256)).toEqual(sp.map((p) => p.preview_sha256));
    expect(of("mobile_390").map((i) => i.audit_sha256)).toEqual(calls[1]!.shas);
    expect(rec.binding.images.every((i) => i.media_type === "image/jpeg" && i.preview_bytes > 0 && i.audit_bytes > 0)).toBe(true);
    const md = readFileSync(join(auditDir(s), "AUDIT.md"), "utf8");
    for (const i of rec.binding.images) expect(md).toContain(`\`${i.preview_sha256}\` | \`${i.audit_sha256}\``);
    // owner comment 7053442141: AUDIT.md names the rubric v2 and, per viewport, which examples' principles were used (with their source)
    expect(rec.binding.rubric_version).toBe("if-claude-audit-v2");
    expect(rec.schema).toBe("imagefirst_claude_audit_v2");
    expect(md).toContain("`if-claude-audit-v2`");
    expect(md.match(/Closeness to an example is not a criterion; imitating another shop's design, colours or layout is penalised\./g)).toHaveLength(2);
    expect(md).toContain("CP-003-pc (design-library/phase2f/references/success-references-v1.json)");
    expect(md).toContain("CP-003-sp (design-library/phase2f/references/success-references-v1.json)");
    expect(md).toContain("CP-001-concept (design-library/research/quality-pipeline/visual-reads/CP-001/concept.read.json)");
    expect(md).not.toMatch(/success_example_distance/);
    expect(rec.derived.desktop_1440).toEqual(deriveViewport(rec.viewports.desktop_1440!));
    expect(rec.auditor).toMatchObject({ via: "claude_cli_print_no_tools", model_reported: "fake-test-model", cli_version: "0.0.0-test", calls: 2, reasks: 0 });
    // private: 0700 directories, 0600 files; the one-use marker; AUDIT.md for the owner; nothing in the repository
    expect(statSync(auditDir(s)).mode & 0o777).toBe(0o700);
    expect(statSync(join(s.d.inbox, "audits")).mode & 0o777).toBe(0o700);
    for (const f of ["audit.json", "AUDIT.md"]) expect(statSync(join(auditDir(s), f)).mode & 0o777).toBe(0o600);
    expect(readdirSync(auditDir(s)).sort()).toEqual(["AUDIT.md", "audit.json"]);
    expect(readFileSync(join(auditDir(s), "AUDIT.md"), "utf8")).toMatch(/Advisory only\.[\s\S]*show_owner/);
    expect(readdirSync(markerDir(s))).toEqual([`${s.d.bundleSha}.${RUBRIC_SHA256}.used`]);
    expect(statSync(markerDir(s)).mode & 0o777).toBe(0o700);
    expect(repoOwn()).toBe(repoBefore);
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
    const planned = await runClaudeAudit(c.opts);
    expect(planned.status).toBe("planned");
    expect(planned.limits).toEqual(AUDIT_LIMITS);
    expect((await runClaudeAudit({ ...c.opts, limits: { maxImages: 9, maxBytes: 9 * 1024 * 1024 } })).limits).toEqual({ maxImages: 9, maxBytes: 9 * 1024 * 1024 });
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

describe("PR #311 review: the audit tier, swapped bytes, ownership seams, writes after the marker, the jail, the login", () => {
  it("M2: a realistic tall PC page (1440 × 16000, lossless ~2.5 MiB tiles) is over the cap as PNG but fits as the audit tier", async () => {
    const d = await makeDelivered({ id: "hoshigama-imagefirst-d3-20261120-02", pc: await photoLikeComposite(1440, 16000) });
    const home = tmp("sr-audit-tall-home-");
    const { bin, log } = fakeClaude(home, {});
    const opts: ClaudeAuditOptions = { approvalId: d.id, runsDir: d.runs, stateDir: d.state, material, claudeBin: bin, env: { PATH: process.env.PATH, HOME: home }, jailIdle: async () => true };
    const r = await runClaudeAudit({ ...opts, dryRun: true });
    const pcPlan = r.plan.find((p) => p.viewport === "desktop_1440")!;
    expect(pcPlan.images).toBe(12); // 11 tiles + 1 overview
    expect(pcPlan.preview_bytes).toBeGreaterThan(AUDIT_LIMITS.maxBytes); // the PNG previews alone would never fit one call
    expect(pcPlan.bytes).toBeLessThanOrEqual(AUDIT_LIMITS.maxBytes);
    expect(pcPlan.bytes).toBeLessThan(pcPlan.preview_bytes / 2);
    expect(readLog(log)).toEqual([]);
    // the tier is deterministic: the same preview gives the same bytes, at the same size
    const ix = indexOf(d);
    const tile = ix.previews.find((p) => p.kind === "tile")!;
    const png = readFileSync(join(previewsDir(d), tile.file));
    const a = await auditTierOf(png, tile.width, tile.height);
    expect(sha((await auditTierOf(png, tile.width, tile.height)).bytes)).toBe(sha(a.bytes));
    await expect(auditTierOf(png, tile.width + 1, tile.height)).rejects.toMatchObject({ code: "AUDIT_TIER_FAILED" });
    // and the real (fake) call goes through
    expect(await runClaudeAudit(opts)).toMatchObject({ status: "completed", calls: 2 });
  });

  it("M1: a preview swapped AFTER verifyPreviews returned is caught by the re-read (PREVIEW_SHA_MISMATCH), nothing spent", async () => {
    const s = setup();
    const tile = indexOf(s.d).previews.find((p) => p.kind === "tile")!;
    const other = indexOf(s.d).previews.find((p) => p.kind === "overview")!;
    s.opts.testSeams = {
      afterVerify: () => {
        // a valid PNG of ours, 0600, but other bytes than INDEX.json names
        const f = join(previewsDir(s.d), tile.file);
        rmSync(f);
        writeFileSync(f, readFileSync(join(previewsDir(s.d), other.file)), { mode: 0o600 });
      },
    };
    await refused(runClaudeAudit(s.opts), "PREVIEW_SHA_MISMATCH");
    nothingSpent(s);
  });

  it("L2: ownership checks: the runs directory's mode and owner, the record's mode, owner and link count", async () => {
    const uid = process.getuid!();
    const a = setup();
    chmodSync(a.d.runs, 0o755);
    await refused(runClaudeAudit(a.opts), "RUNS_DIR_UNSAFE");
    nothingSpent(a);
    const b = setup({}, { testSeams: { dirUid: uid + 1 } });
    await refused(runClaudeAudit(b.opts), "RUNS_DIR_UNSAFE");
    nothingSpent(b);
    const c = setup({}, { testSeams: { fileUid: uid + 1 } });
    await refused(runClaudeAudit(c.opts), "DELIVERY_RECORD_INVALID");
    nothingSpent(c);
    const e = setup();
    chmodSync(join(e.d.inbox, ".records", `${e.d.id}.json`), 0o644);
    await refused(runClaudeAudit(e.opts), "DELIVERY_RECORD_INVALID");
    nothingSpent(e);
    const f = setup();
    linkSync(join(f.d.inbox, ".records", `${f.d.id}.json`), join(f.d.work, "second-name.json"));
    await refused(runClaudeAudit(f.opts), "DELIVERY_RECORD_INVALID");
    nothingSpent(f);
  });

  it("L1 / L2: after the marker, an audit directory appearing under the final name is AUDIT_EXISTS — stopped and spent, never replaced", async () => {
    const s = setup();
    // an EMPTY directory: rename(2) would silently replace it, so only the explicit check stops it
    s.opts.testSeams = { beforeWrite: () => void mkdirSync(join(s.d.inbox, "audits", s.d.id), { recursive: true, mode: 0o700 }) };
    const r = await runClaudeAudit(s.opts);
    expect(r).toMatchObject({ status: "stopped", code: "AUDIT_EXISTS", calls: 2, dir: null });
    expect(readdirSync(auditDir(s))).toEqual([]);
    expect(readdirSync(markerDir(s)).length).toBe(1);
    expect(readdirSync(join(s.d.inbox, "audits"))).toEqual([s.d.id]); // no temporary directory left
  });

  it("L1 / L2: after the marker, an unsafe audits directory or a failed write is stopped (AUDIT_DIR_UNSAFE / AUDIT_WRITE_FAILED), never refused", async () => {
    const a = setup();
    a.opts.testSeams = { beforeWrite: () => void mkdirSync(join(a.d.inbox, "audits"), { mode: 0o755 }) };
    const ra = await runClaudeAudit(a.opts);
    expect(ra).toMatchObject({ status: "stopped", code: "AUDIT_DIR_UNSAFE", calls: 2 });
    const b = setup();
    b.opts.testSeams = {
      beforeWrite: () => {
        throw new Error("ENOSPC");
      },
    };
    expect(await runClaudeAudit(b.opts)).toMatchObject({ status: "stopped", code: "AUDIT_WRITE_FAILED", calls: 2, dir: null });
    expect(readdirSync(markerDir(b)).length).toBe(1);
  });

  it("L4: the jail is asked again before every call; started during the run → stopped (spent) with JAIL_ACTIVE", async () => {
    let asked = 0;
    // asked: at the start, right before the marker, before call 1 (idle), before call 2 (active)
    const s = setup({}, { jailIdle: async () => ++asked <= 3 });
    expect(await runClaudeAudit(s.opts)).toMatchObject({ status: "stopped", code: "JAIL_ACTIVE", calls: 1 });
    expect(readLog(s.log).filter((l) => l.bin === "claude").length).toBe(1);
    expect(readRecord(s).stop_code).toBe("JAIL_ACTIVE");
  });

  it("L-b: the jail started between the start and the marker → refused, nothing spent", async () => {
    for (const [late, code] of [[false, "JAIL_ACTIVE"], [null, "JAIL_STATE_UNKNOWN"]] as const) {
      let n = 0;
      const u = setup({}, { jailIdle: async () => (++n <= 1 ? true : late) });
      await refused(runClaudeAudit(u.opts), code);
      expect(readLog(u.log).map((l) => l.bin)).toEqual(["auth"]);
      expect(existsSync(markerDir(u))).toBe(false);
      expect(existsSync(join(u.d.inbox, "audits"))).toBe(false);
    }
  });

  it("L3 / M-a: only the claude.ai subscription login passes; a Console login (claude.ai + apiKeySource), a helper, a token or none is refused", async () => {
    const shapes = [
      ["console", "CLAUDE_API_KEY_AUTH"], ["api_key_helper", "CLAUDE_API_KEY_AUTH"], ["oauth_token", "CLAUDE_AUTH_METHOD_REFUSED"], ["third_party", "CLAUDE_AUTH_METHOD_REFUSED"], ["missing", "CLAUDE_AUTH_METHOD_REFUSED"],
      // L2: claude.ai through any provider but the first-party API, or none named
      ["provider-bedrock", "CLAUDE_AUTH_METHOD_REFUSED"], ["provider-vertex", "CLAUDE_AUTH_METHOD_REFUSED"], ["provider-foundry", "CLAUDE_AUTH_METHOD_REFUSED"], ["provider-missing", "CLAUDE_AUTH_METHOD_REFUSED"],
      // N1: loggedIn must be exactly true, and the exit code 0
      ["loggedin-string", "CLAUDE_NOT_SIGNED_IN"], ["exit1-json", "CLAUDE_NOT_SIGNED_IN"],
    ] as const;
    for (const [auth, code] of shapes) {
      const s = setup({ auth });
      await refused(runClaudeAudit(s.opts), code);
      expect(readLog(s.log).map((l) => l.bin), auth).toEqual(["auth"]);
      expect(existsSync(markerDir(s))).toBe(false);
    }
  });

  it("H1 / L1: `auth status` with the global --setting-sources \"\" before the subcommand; never an option after it", async () => {
    expect([...CLAUDE_AUTH_STATUS_ARGS]).toEqual(["--setting-sources", "", "auth", "status"]);
    const s = setup({ auth: "ok" }); // the real subscription shape
    expect((await runClaudeAudit(s.opts)).status).toBe("completed");
    expect(readLog(s.log)[0]!.argv).toEqual(["--setting-sources", "", "auth", "status"]);
    // the fake answers like the real CLI to an unknown option: exit 1, no JSON → never a pass
    const r = spawnSync(s.bin, ["auth", "status", "--setting-sources", ""], { encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: s.home } as unknown as NodeJS.ProcessEnv });
    expect([r.status, r.stdout]).toEqual([1, ""]);
  });

  it("L-d: per image, whether the preview is fully opaque; a non-opaque one is recorded and noted in AUDIT.md", async () => {
    const s = setup();
    expect((await runClaudeAudit(s.opts)).status).toBe("completed");
    expect(readRecord(s).binding.images.every((i) => i.opaque === true)).toBe(true);
    expect(readFileSync(join(auditDir(s), "AUDIT.md"), "utf8")).not.toContain("not fully opaque");
    // a PC composite with a half-transparent band: its previews keep the alpha (preview.ts), the tier fills it white
    const raw = Buffer.alloc(1440 * 4000 * 4, 0xc8);
    for (let i = 3; i < raw.length; i += 4) raw[i] = i >= 1440 * 900 * 4 && i < 1440 * 1500 * 4 ? 0x80 : 0xff; // opaque, rows 900–1500 half transparent
    const pc = await sharp(raw, { raw: { width: 1440, height: 4000, channels: 4 } }).png().toBuffer();
    const d = await makeDelivered({ id: "hoshigama-imagefirst-d3-20261120-03", pc });
    const home = tmp("sr-audit-alpha-home-");
    const { bin } = fakeClaude(home, {});
    const opts: ClaudeAuditOptions = { approvalId: d.id, runsDir: d.runs, stateDir: d.state, material, claudeBin: bin, env: { PATH: process.env.PATH, HOME: home }, jailIdle: async () => true };
    expect((await runClaudeAudit(opts)).status).toBe("completed");
    const rec = AuditRecord.parse(JSON.parse(readFileSync(join(d.inbox, "audits", d.id, "audit.json"), "utf8")));
    // 1440 × 4000 → overview + tiles rows 0–1568, 1504–3072, 2432–4000: only the overview and tile 1 cover rows 900–1500
    const pcImgs = rec.binding.images.filter((i) => i.viewport === "desktop_1440");
    expect(pcImgs.map((i) => [i.kind, i.y0, i.y1, i.opaque])).toEqual([["overview", 0, 4000, false], ["tile", 0, 1568, false], ["tile", 1504, 3072, true], ["tile", 2432, 4000, true]]);
    expect(rec.binding.images.filter((i) => i.viewport === "mobile_390").every((i) => i.opaque)).toBe(true);
    const md = readFileSync(join(d.inbox, "audits", d.id, "AUDIT.md"), "utf8");
    expect(md).toContain("| **no** |");
    expect(md).toContain("transparent areas were filled white for the audit");
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

describe("Issue #302: the CLI as a process (fakes only through the test entry under tests/)", () => {
  const CLI = join(REPO, "scripts/sales-design-worker/imagefirst-audit.ts");
  const ENTRY = join(REPO, "tests/unit/design-agent/imagefirst-worker/fixtures/audit-cli-entry.ts");
  /**
   * PR #311 fourth review L-1: every CLI process of these tests gets a PATH whose FIRST `claude` and `systemctl` are stubs
   * that only log and exit, so no test can ever start the host's real claude (the production entry resolves "claude"
   * through PATH; it reaches systemctl by its absolute path). Each spawn asserts afterwards that no stub was started.
   */
  const stubDir = tmp("sr-audit-stub-bin-");
  const stubLog = join(stubDir, "stub.log");
  for (const name of ["claude", "systemctl"]) writeFileSync(join(stubDir, name), `#!/bin/sh\necho "${name} $*" >> "${stubLog}"\nexit 97\n`, { mode: 0o755 });
  const spawnOut = (argv: string[], env: Record<string, string>) => {
    const r = spawnSync(process.execPath, ["--import", "tsx", ...argv], { cwd: REPO, encoding: "utf8", env: { ...env, PATH: `${stubDir}:${process.env.PATH ?? "/usr/bin:/bin"}` } as unknown as NodeJS.ProcessEnv, timeout: 100_000 });
    // read and clear per spawn, so one failure does not make every later spawn fail too (PR #311 fifth review N-2)
    const started = existsSync(stubLog);
    rmSync(stubLog, { force: true });
    expect(started, "a PATH claude / systemctl was started").toBe(false);
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
    const sysDir = tmp("sr-audit-sys-");
    const sys = join(sysDir, "systemctl");
    const sysLog = join(sysDir, "systemctl.log");
    // the fake systemctl records every start (PR #311 third review L3)
    writeFileSync(sys, `#!/bin/sh\necho "$@" >> "${sysLog}"\nif [ "$1" = show ]; then echo inactive; else echo disabled; fi\n`, { mode: 0o755 });
    const env = { HOME: home, XDG_STATE_HOME: xdg };
    return { d, home, bin, log, sys, sysLog, test: (args: string[]) => spawnOut([ENTRY, bin, sys, ...args], env), prod: (args: string[], extra: Record<string, string> = {}) => spawnOut([CLI, ...args], { ...env, ...extra }) };
  };

  it("usage errors exit 2 (the production entry)", () => {
    const h = tmp("sr-audit-cli-");
    for (const args of [[], ["a", "b"], ["--dry-run", "--dry-run", ID]]) expect(spawnOut([CLI, ...args], { HOME: h }).out).toEqual({ status: "refused", code: "USAGE" });
  });

  it("dry run: the plan per viewport, exit 0, no claude process; a real run prints codes, counts and the verdict only", () => {
    const h = homeWith();
    const dry = h.test([h.d.id, "--dry-run"]);
    expect(dry.status).toBe(0);
    expect(dry.out).toMatchObject({ status: "planned", approval_id: h.d.id, bundle_sha256: h.d.bundleSha, calls: 0, limits: AUDIT_LIMITS, tier: AUDIT_TIER.id });
    const plan = dry.out!.plan as { viewport: string; images: number; bytes: number; preview_bytes: number }[];
    expect(plan.map((p) => [p.viewport, p.images])).toEqual([["desktop_1440", 7], ["mobile_390", 4]]);
    expect(plan.every((p) => p.bytes > 0 && p.preview_bytes > 0)).toBe(true);
    expect(readLog(h.log)).toEqual([]);
    const real = h.test([h.d.id]);
    expect(real.status).toBe(0);
    expect(real.lines.length).toBe(1);
    expect(real.out).toMatchObject({ status: "completed", verdict: "show_owner", calls: 2 });
    expect(real.lines[0]).not.toMatch(/login|reason|problem|suggestion/);
    expect(existsSync(join(h.home, "sr-runs", "review-inbox", "audits", h.d.id, "audit.json"))).toBe(true);
    expect(h.test([h.d.id])).toMatchObject({ status: 2, out: { status: "refused", code: "AUDIT_EXISTS" } });
  });

  it("the production entry cannot be pointed at a fake claude or systemctl by the environment; the dummy id needs --dummy", () => {
    const h = homeWith();
    // whatever the host's real /usr/bin/systemctl answers (any exit code), the production entry never starts either fake
    // (a dry run only: it starts no claude at all, so no test can reach a real one; the PATH stubs would also catch it)
    const off = h.prod([h.d.id, "--dry-run"], { SR_IMAGEFIRST_AUDIT_TEST_MODE: "1", SR_IMAGEFIRST_AUDIT_CLAUDE_BIN: h.bin, SR_IMAGEFIRST_AUDIT_SYSTEMCTL: h.sys, CLAUDE_BIN: h.bin, SYSTEMCTL: h.sys });
    expect(off.out).not.toBeNull();
    expect(existsSync(h.sysLog)).toBe(false);
    expect(readLog(h.log)).toEqual([]);
    // the test entry does use them (so the logs above would have shown a start)
    expect(h.test([h.d.id, "--dry-run"]).status).toBe(0);
    expect(readFileSync(h.sysLog, "utf8")).toContain("ActiveState");
    expect(h.test([DUMMY_ID]).out).toMatchObject({ status: "refused", code: "APPROVAL_ID_RESERVED" });
    expect(readLog(h.log)).toEqual([]);
  });

  it("Issue #302 --check-auth-only: only `auth status` (no model call, no bundle, no marker); API key / signed out / jail refuse with exit 2", () => {
    const h = homeWith();
    const ok = h.test(["--check-auth-only"]);
    expect(ok).toMatchObject({ status: 0, out: { status: "auth_ok", code: null } });
    const calls = readLog(h.log);
    expect(calls.map((c) => c.bin)).toEqual(["auth"]);
    expect(calls[0]!.argv).toEqual(["--setting-sources", "", "auth", "status"]);
    expect(calls[0]!.forbidden).toEqual([]);
    expect(existsSync(join(h.d.state, "audits"))).toBe(false);
    expect(existsSync(join(h.home, "sr-runs", "review-inbox", "audits"))).toBe(false);
    for (const [mode, code] of [["console", "CLAUDE_API_KEY_AUTH"], ["apikey", "CLAUDE_API_KEY_AUTH"], ["signedout", "CLAUDE_NOT_SIGNED_IN"], ["provider-bedrock", "CLAUDE_AUTH_METHOD_REFUSED"]] as const) {
      const v = homeWith({ auth: mode });
      expect(v.test(["--check-auth-only"]), mode).toMatchObject({ status: 2, out: { status: "refused", code } });
      expect(readLog(v.log).filter((c) => c.bin === "claude"), mode).toEqual([]);
    }
    // the jail running or unreadable: refused before claude is even asked
    const j = homeWith();
    const sysDir = tmp("sr-audit-sys-active-");
    const active = join(sysDir, "systemctl");
    writeFileSync(active, `#!/bin/sh\nif [ "$1" = show ]; then echo active; else echo enabled; fi\n`, { mode: 0o755 });
    expect(spawnOut([ENTRY, j.bin, active, "--check-auth-only"], { HOME: j.home, XDG_STATE_HOME: join(j.home, ".local", "state") })).toMatchObject({ status: 2, out: { code: "JAIL_ACTIVE" } });
    expect(readLog(j.log)).toEqual([]);
    expect(h.test(["--check-auth-only", "--dry-run"])).toMatchObject({ status: 2, out: { code: "USAGE" } });
    // review L3: it runs from under the worker's state directory (as the audit), which must be a private one of ours;
    // a refusal carries only a status and a code (no approval_id label)
    const m = homeWith();
    const missing = spawnOut([ENTRY, m.bin, m.sys, "--check-auth-only"], { HOME: m.home, XDG_STATE_HOME: join(m.home, "no-such-state") });
    expect(missing).toMatchObject({ status: 2, out: { status: "refused", code: "STATE_DIR_UNSAFE" } });
    expect(Object.keys(missing.out!).sort()).toEqual(["code", "status"]);
    expect(readLog(m.log)).toEqual([]);
  });

  it("a stopped audit exits 1 with the fixed code", () => {
    const h = homeWith({ mode: "quota" });
    expect(h.test([h.d.id])).toMatchObject({ status: 1, out: { status: "stopped", code: "CLAUDE_QUOTA" } });
  });
});
